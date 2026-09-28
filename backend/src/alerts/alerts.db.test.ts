// Email alerts (WP-2.13, 051_alerts.sql): recipients, farm scoping, the
// unsubscribe token, the daily cap and digest, the kill switch, and the
// one-mail-per-crossing rule, end to end through the job queue and the
// memory mail outbox. Every "cannot see" / "gets nothing" check has a
// positive control.
//
// The tests queue alert checks and run ticks; each leaves no job queued, so
// another file's tick never picks one up (jobs and feeds tests count them).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { anon, app, asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { hashToken } from '../auth/tokens.js';
import { withoutUser, withUser } from '../db/tx.js';
import { runTick } from '../jobs/runner.js';
import { outbox, type Mail } from '../mail/transport.js';
import { DEFAULT_TIME_ZONE, localDate } from '../projects/timeZone.js';
import { evaluateAlerts } from './evaluate.js';
import { DIGEST_CLAIM_LINES, DIGEST_MAX_LINES, sendAlerts } from './send.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let viewer: User;
let farmer: User; // Farm One
let farmer2: User; // Farm Two
let stranger: User;
let projectId: string;
const outlet = node('Weir', null);
const one = node('Farm One', outlet.id);
const two = node('Farm Two', outlet.id);
const three = node('Farm Three', outlet.id);
const farms = [one, two, three];
const FARM_NAMES = farms.map((f) => f.name);
/** The network's order (sort_order, then name). */
const FARM_ORDER = [...FARM_NAMES].sort();

const tick = () => runTick({ feeds: false, reports: false, alerts: false });
/** Today where the test projects are (their default zone, 058): the day the evaluator counts to. */
const localToday = () => localDate(new Date(), DEFAULT_TIME_ZONE);
/** Alert mails only (they carry List-Unsubscribe), not the sign-up confirmations. */
const mailsTo = (u: { email: string }) => outbox.filter((m) => m.to === u.email && m.headers?.['List-Unsubscribe']);
const tokenIn = (m: Mail) => m.text.match(/\/alerts\/unsubscribe#t=([A-Za-z0-9_-]{43})/)![1]!;
const rules = (u: User, list: { kind: string; nodeId?: string | null; feedId?: string | null; threshold: number; enabled: boolean }[], pid = projectId) =>
	u.call('PUT', `/projects/${pid}/alert-rules`, { rules: list });
const damRules = (threshold: number, enabled = true) => farms.map((f) => ({ kind: 'dam_below', nodeId: f.id, threshold, enabled }));
const rowsAs = async <T = Record<string, unknown>>(u: User, sql: string, params: unknown[] = []) =>
	withUser(u.id, async (db) => (await db.query<T & Record<string, unknown>>(sql, params)).rows);

async function makeProject(u: User, name: string, sharedIds = false) {
	const id = (await u.call('POST', '/projects', { name })).body.project.id as string;
	const ids = new Map<string, string>([outlet, ...farms].map((x) => [x.id, sharedIds ? x.id : crypto.randomUUID()]));
	const remap = (v: string | null) => (v === null ? null : ids.get(v)!);
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
	const model = {
		nodes: [outlet, ...farms].map((n) => ({ ...n, id: remap(n.id), downstreamNodeId: remap(n.downstreamNodeId) })),
		crops: [crop],
		cropAreas: farms.map((f, i) => ({ nodeId: remap(f.id), cropId: crop.id, areaM2: 400_000 + 100_000 * i })),
		transfers: []
	};
	expect((await u.call('PUT', `/projects/${id}/model`, model)).status).toBe(200);
	expect((await u.call('PATCH', `/projects/${id}`, { settings: { apanMm: monthly(200), ewrPragmaticM3PerDay: monthly(4000) } })).status).toBe(200);
	// Dry: the dams run down (well under the 99 % the tests alert at, and over 6 %).
	const rain = Array.from({ length: 500 }, (_, i) => (i % 23 === 0 ? 12 : 0));
	expect((await u.call('PUT', `/projects/${id}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: rain })).status).toBe(200);
	const run = await u.call('POST', `/projects/${id}/runs`, { label: 'r' });
	expect(run.status).toBe(201);
	return { id, runId: run.body.run.id as string };
}

/** No alert check left queued for another file's tick; and no firing state carried between tests. */
async function reset(pid = projectId) {
	await asOwner(`DELETE FROM job WHERE project_id = $1 AND kind = 'alert_eval'`, [pid]);
	await asOwner('DELETE FROM alert_rule WHERE project_id = $1', [pid]);
	await asOwner('DELETE FROM alert_subscription WHERE project_id = $1', [pid]);
}

beforeAll(async () => {
	[owner, editor, viewer, farmer, farmer2, stranger] = (await Promise.all(['Aowner', 'Aeditor', 'Aviewer', 'Afarmer', 'Afarmertwo', 'Astranger'].map((n) => signUp(n)))) as [
		User,
		User,
		User,
		User,
		User,
		User
	];
	({ id: projectId } = await makeProject(owner, 'Alerts', true));
	const runId = (await owner.call('GET', `/projects/${projectId}/runs`)).body.runs[0].id;
	expect((await owner.call('POST', `/projects/${projectId}/publication`, { runId })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: editor.email, role: 'editor' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [one.id] })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer2.email, nodeIds: [two.id] })).status).toBe(201);
}, 60_000);

afterAll(async () => {
	vi.unstubAllEnvs();
	await asOwner(`DELETE FROM job WHERE kind = 'alert_eval' AND project_id = $1`, [projectId]);
});

describe('alerts are opt-in per project', () => {
	it('publishing queues no alert check while every rule is off; switching one on queues one (positive control)', async () => {
		await reset();
		const pending = async () => (await asOwner(`SELECT count(*)::int AS n FROM job WHERE project_id = $1 AND kind = 'alert_eval' AND status = 'queued'`, [projectId]))[0].n;
		const runId = (await owner.call('POST', `/projects/${projectId}/runs`, { label: 'again' })).body.run.id;
		expect((await owner.call('POST', `/projects/${projectId}/publication`, { runId })).status).toBe(201);
		expect(await pending()).toBe(0);
		expect((await rules(editor, damRules(0.99))).status).toBe(200);
		expect(await pending()).toBe(1);
		await reset();
	});

	it('lists every kind and farm for an editor, unsaved ones off at their defaults; viewers and farmers may not', async () => {
		await reset();
		const res = await editor.call('GET', `/projects/${projectId}/alert-rules`);
		expect(res.status).toBe(200);
		expect(res.body.rules.filter((r: { kind: string }) => r.kind === 'dam_below').map((r: { nodeName: string }) => r.nodeName)).toEqual(FARM_ORDER);
		expect(res.body.rules.every((r: { enabled: boolean; id: string | null }) => !r.enabled && r.id === null)).toBe(true);
		expect(res.body.rules.find((r: { kind: string }) => r.kind === 'ewr_forecast_fail').threshold).toBe(3);
		expect((await viewer.call('GET', `/projects/${projectId}/alert-rules`)).status).toBe(403);
		expect((await farmer.call('GET', `/projects/${projectId}/alert-rules`)).status).toBe(403);
		expect((await viewer.call('PUT', `/projects/${projectId}/alert-rules`, { rules: damRules(0.5) })).status).toBe(403);
		expect((await stranger.call('GET', `/projects/${projectId}/alert-rules`)).status).toBe(404);
	});

	it('refuses a threshold outside its kind’s range, and a dam rule without its farm', async () => {
		expect((await rules(editor, [{ kind: 'dam_below', nodeId: one.id, threshold: 30, enabled: true }])).status).toBe(400);
		expect((await rules(editor, [{ kind: 'dam_below', threshold: 0.3, enabled: true }])).status).toBe(400);
		expect((await rules(editor, [{ kind: 'ewr_forecast_fail', threshold: 2.5, enabled: true }])).status).toBe(400);
		expect((await rules(editor, [{ kind: 'dam_below', nodeId: crypto.randomUUID(), threshold: 0.3, enabled: true }])).status).toBe(404);
	});
});

describe('recipients (app_alert_recipients)', () => {
	const recipients = (u: User | null, kind: string, nodeId: string | null) =>
		u
			? rowsAs<{ user_id: string }>(u, 'SELECT user_id FROM app_alert_recipients($1, $2, $3)', [projectId, kind, nodeId]).then((r) => r.map((x) => x.user_id))
			: withoutUser(async (db) => (await db.query<{ user_id: string }>('SELECT user_id FROM app_alert_recipients($1, $2, $3)', [projectId, kind, nodeId])).rows.map((x) => x.user_id));

	it('a dam alert goes to that farm’s farmer and the editors and owners, never a neighbour, a viewer (opt-in) or a stranger', async () => {
		await reset();
		const got = await recipients(editor, 'dam_below', one.id);
		// Positive control: the farm's own farmer, the editor and the owner.
		expect(got).toEqual(expect.arrayContaining([farmer.id, editor.id, owner.id]));
		for (const u of [farmer2, viewer, stranger]) expect(got).not.toContain(u.id);
		// The other farm: the other farmer.
		expect(await recipients(editor, 'dam_below', two.id)).toContain(farmer2.id);
		expect(await recipients(editor, 'dam_below', two.id)).not.toContain(farmer.id);
	});

	it('a farmer gets restriction notices and nothing catchment-wide (EWR forecast, stale data)', async () => {
		expect(await recipients(editor, 'restriction_published', null)).toEqual(expect.arrayContaining([farmer.id, farmer2.id, viewer.id, editor.id, owner.id]));
		for (const kind of ['ewr_forecast_fail', 'data_stale', 'job_dead', 'feed_failing']) {
			const got = await recipients(editor, kind, null);
			expect(got, kind).not.toContain(farmer.id);
		}
		// job_dead is the owners' by default; editors opt in.
		expect(await recipients(editor, 'job_dead', null)).toEqual([owner.id]);
	});

	it('answers an editor or the worker’s own context, and nobody else', async () => {
		expect(await recipients(null, 'dam_below', one.id)).toContain(farmer.id);
		expect(await recipients(farmer, 'dam_below', one.id)).toEqual([]);
		expect(await recipients(viewer, 'dam_below', one.id)).toEqual([]);
	});

	it('a viewer who opts in gets dam alerts; anyone who turns a kind off drops out', async () => {
		expect((await viewer.call('PUT', `/me/alerts/${projectId}`, { items: [{ kind: 'dam_below', mode: 'immediate' }] })).status).toBe(200);
		// The WUA chooses once for every farm (a per-farm row would be a choice the page can't show).
		expect((await viewer.call('PUT', `/me/alerts/${projectId}`, { items: [{ kind: 'dam_below', nodeId: one.id, mode: 'off' }] })).status).toBe(400);
		expect(await recipients(editor, 'dam_below', one.id)).toContain(viewer.id);
		expect((await editor.call('PUT', `/me/alerts/${projectId}`, { items: [{ kind: 'dam_below', mode: 'off' }] })).status).toBe(200);
		expect(await recipients(editor, 'dam_below', one.id)).not.toContain(editor.id);
		// Muting the project ('all' off) removes every kind.
		expect((await farmer.call('PUT', `/me/alerts/${projectId}`, { items: [{ kind: 'all', mode: 'off' }] })).status).toBe(200);
		expect(await recipients(editor, 'restriction_published', null)).not.toContain(farmer.id);
		await reset();
	});

	it('a removed member stops being a recipient at once (positive control: while a member, they are one)', async () => {
		const { id: pid } = await makeProject(owner, 'Alerts removal');
		const leaver = await signUp('Aleaver');
		expect((await owner.call('POST', `/projects/${pid}/members`, { email: leaver.email, role: 'editor' })).status).toBe(201);
		const got = () => rowsAs<{ user_id: string }>(owner, 'SELECT user_id FROM app_alert_recipients($1, $2, NULL)', [pid, 'data_stale']).then((r) => r.map((x) => x.user_id));
		expect(await got()).toContain(leaver.id);
		expect((await owner.call('DELETE', `/projects/${pid}/members/${leaver.id}`)).status).toBeLessThan(300);
		expect(await got()).not.toContain(leaver.id);
	});
});

describe('subscriptions: own rows only, a farmer only for their own farm', () => {
	it('a farmer can choose for their farm and not a neighbour’s (RLS and the route); positive control first', async () => {
		await reset();
		expect((await farmer.call('PUT', `/me/alerts/${projectId}`, { items: [{ kind: 'dam_below', nodeId: one.id, mode: 'daily_digest' }] })).status).toBe(200);
		expect((await farmer.call('PUT', `/me/alerts/${projectId}`, { items: [{ kind: 'dam_below', nodeId: two.id, mode: 'off' }] })).status).toBe(404);
		// Straight past the route: RLS refuses the row.
		await expect(
			withUser(farmer.id, (db) =>
				db.query(`INSERT INTO alert_subscription (user_id, project_id, kind, node_id, mode, unsubscribe_nonce) VALUES ($1, $2, 'dam_below', $3, 'off', $4)`, [
					farmer.id,
					projectId,
					two.id,
					Buffer.alloc(32, 1)
				])
			)
		).rejects.toMatchObject({ code: '42501' });
		// Nor for someone else.
		await expect(
			withUser(farmer.id, (db) =>
				db.query(`INSERT INTO alert_subscription (user_id, project_id, kind, mode, unsubscribe_nonce) VALUES ($1, $2, 'restriction_published', 'off', $3)`, [
					farmer2.id,
					projectId,
					Buffer.alloc(32, 2)
				])
			)
		).rejects.toMatchObject({ code: '42501' });
		// A farmer can't pick a kind their role never gets.
		expect((await farmer.call('PUT', `/me/alerts/${projectId}`, { items: [{ kind: 'ewr_forecast_fail', mode: 'immediate' }] })).status).toBe(400);
		// Each sees only their own rows.
		expect((await rowsAs(farmer2, 'SELECT 1 FROM alert_subscription WHERE project_id = $1', [projectId])).length).toBe(0);
		expect((await rowsAs(farmer, 'SELECT 1 FROM alert_subscription WHERE project_id = $1', [projectId])).length).toBe(1);
	});

	it('GET /me/alerts shows a farmer their farm’s dam alert and the notice, a viewer the WUA kinds, and never an applicant’s project', async () => {
		const f = (await farmer.call('GET', '/me/alerts')).body.projects.find((p: { id: string }) => p.id === projectId);
		expect(f.role).toBe('farmer');
		expect(f.choices.map((c: { kind: string; nodeName: string | null; mode: string }) => [c.kind, c.nodeName, c.mode])).toEqual([
			['dam_below', 'Farm One', 'daily_digest'],
			['restriction_published', null, 'immediate']
		]);
		// No rule for the farm yet: no level (issue #51).
		expect(f.choices.map((c: { threshold: number | null }) => c.threshold)).toEqual([null, null]);
		expect((await rules(editor, [{ kind: 'dam_below', nodeId: one.id, threshold: 0.35, enabled: true }])).status).toBe(200);
		const withRule = (await farmer.call('GET', '/me/alerts')).body.projects.find((p: { id: string }) => p.id === projectId);
		expect(withRule.choices.map((c: { kind: string; ruleOn: boolean; threshold: number | null }) => [c.kind, c.ruleOn, c.threshold])).toEqual([
			['dam_below', true, 0.35],
			['restriction_published', false, null]
		]);
		const v = (await viewer.call('GET', '/me/alerts')).body.projects.find((p: { id: string }) => p.id === projectId);
		// The WUA's kind-wide dam choice carries no level (it is per farm).
		expect(v.choices.find((c: { kind: string }) => c.kind === 'dam_below').threshold).toBeNull();
		expect(v.choices.map((c: { kind: string; mode: string }) => [c.kind, c.mode])).toEqual([
			['dam_below', 'off'],
			['ewr_forecast_fail', 'off'],
			['restriction_published', 'immediate']
		]);
		expect((await stranger.call('GET', '/me/alerts')).body.projects.find((p: { id: string }) => p.id === projectId)).toBeUndefined();
		expect((await stranger.call('PUT', `/me/alerts/${projectId}`, { items: [{ kind: 'dam_below', mode: 'off' }] })).status).toBe(404);
		expect((await app.request('/me/alerts')).status).toBe(401);
		await reset();
	});
});

describe('a dam alert end to end', () => {
	it('mails each farmer about their own farm only, once per crossing, with a one-click unsubscribe', async () => {
		await reset();
		const before = outbox.length;
		expect((await rules(editor, damRules(0.99))).status).toBe(200);
		await tick();
		const mine = mailsTo(farmer);
		expect(mine.length).toBe(1);
		const m = mine[0]!;
		expect(m.subject).toContain('Farm One');
		// The neighbour-name scan: nothing of another farm in the farmer's mail.
		for (const other of FARM_NAMES.filter((n) => n !== 'Farm One')) {
			expect(m.text).not.toContain(other);
			expect(m.html).not.toContain(other);
		}
		expect(m.text).toMatch(/It is not a measurement of your dam and not an instruction\./);
		expect(m.headers?.['List-Unsubscribe']).toMatch(/^<http:\/\/localhost:7777\/api\/alerts\/unsubscribe\?token=[A-Za-z0-9_-]{43}>$/);
		expect(m.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
		expect(mailsTo(farmer2).map((x) => x.subject)).toEqual([expect.stringContaining('Farm Two')]);
		expect(mailsTo(farmer2)[0]!.text).not.toContain('Farm One');
		// The WUA: a mail per farm for the editor and the owner; the viewer didn't opt in.
		expect(mailsTo(editor).length).toBe(3);
		// The staff's liability line is about the WUA's figures and a member's dam, not "your dam".
		for (const x of mailsTo(editor)) {
			expect(x.text).toMatch(/It is not a measurement of the dam and not an instruction\. Only a notice from the WUA or from DWS is a restriction\./);
			expect(x.text).not.toContain('your dam');
		}
		expect(mailsTo(viewer).length).toBe(0);
		expect(mailsTo(stranger).length).toBe(0);
		// The same figure next time: still firing, no second mail.
		const sent = outbox.length;
		expect(sent - before).toBe(8);
		expect((await rules(editor, damRules(0.99))).status).toBe(200);
		await tick();
		expect(outbox.length).toBe(sent);
		// A farmer sees their own farm's firing alert, not a neighbour's; the viewer sees all three.
		const theirs = (await farmer.call('GET', `/projects/${projectId}/alert-events`)).body.events;
		expect(theirs.map((e: { nodeName: string }) => e.nodeName)).toEqual(['Farm One']);
		expect((await viewer.call('GET', `/projects/${projectId}/alert-events`)).body.events).toHaveLength(3);
	});

	it('re-arms only after the dam recovers past threshold + margin, then mails again on the next crossing', async () => {
		const n = mailsTo(farmer).length;
		// Down to 1 %: the dam is far above 1 % + 5 points, so each alert clears.
		expect((await rules(editor, damRules(0.01))).status).toBe(200);
		await tick();
		expect((await rowsAs(editor, `SELECT count(*)::int AS n FROM alert_event WHERE project_id = $1 AND state = 'firing'`, [projectId]))[0]!.n).toBe(0);
		expect(mailsTo(farmer).length).toBe(n);
		// Back up: a new crossing, a new event, a new mail.
		expect((await rules(editor, damRules(0.99))).status).toBe(200);
		await tick();
		expect(mailsTo(farmer).length).toBe(n + 1);
		expect((await rowsAs(editor, `SELECT count(*)::int AS n FROM alert_event WHERE project_id = $1 AND node_id = $2`, [projectId, one.id]))[0]!.n).toBe(2);
	});

	it('checks the recipient’s access again at send time: a farmer removed after the event gets nothing (positive control: the other farmer does)', async () => {
		expect((await rules(editor, damRules(0.01))).status).toBe(200);
		await tick();
		expect((await rules(editor, damRules(0.99))).status).toBe(200);
		// Evaluate (fan out) but don't send yet: run the job alone.
		await asOwner(`UPDATE job SET run_after = now() WHERE project_id = $1 AND kind = 'alert_eval'`, [projectId]);
		const { evaluateAlerts } = await import('./evaluate.js');
		await withUser(editor.id, (db) => evaluateAlerts(db, projectId));
		await asOwner(`DELETE FROM job WHERE project_id = $1 AND kind = 'alert_eval'`, [projectId]);
		const pending = await asOwner(`SELECT user_id FROM alert_delivery WHERE project_id = $1 AND status = 'pending'`, [projectId]);
		expect(pending.map((r) => r.user_id)).toEqual(expect.arrayContaining([farmer.id, farmer2.id]));
		const a = mailsTo(farmer).length;
		const b = mailsTo(farmer2).length;
		expect((await owner.call('DELETE', `/projects/${projectId}/members/${farmer2.id}`)).status).toBeLessThan(300);
		await sendAlerts();
		expect(mailsTo(farmer).length).toBe(a + 1);
		expect(mailsTo(farmer2).length).toBe(b);
		const [skipped] = await asOwner(`SELECT status, reason FROM alert_delivery WHERE project_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1`, [projectId, farmer2.id]);
		expect(skipped.status).toBe('skipped');
		// Back for the rest of the file.
		expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer2.email, nodeIds: [two.id] })).status).toBe(201);
	});

	it('makes one delivery per event and person, ever', async () => {
		const [e] = await asOwner(`SELECT id FROM alert_event WHERE project_id = $1 AND node_id = $2 AND state = 'firing'`, [projectId, one.id]);
		const made = await withUser(editor.id, async (db) => (await db.query<{ n: number }>('SELECT app_alert_fan_out($1) AS n', [e.id])).rows[0]!.n);
		expect(made).toBe(0);
		await expect(asOwner(`INSERT INTO alert_delivery (event_id, user_id, project_id, mode) VALUES ($1, $2, $3, 'immediate')`, [e.id, farmer.id, projectId])).rejects.toMatchObject({
			code: '23505'
		});
		// Only an editor fans out.
		await expect(withUser(viewer.id, (db) => db.query('SELECT app_alert_fan_out($1)', [e.id]))).rejects.toMatchObject({ code: '42501' });
		await reset();
	});
});

describe('one-click unsubscribe', () => {
	let token: string;

	beforeAll(async () => {
		await reset();
		expect((await rules(editor, damRules(0.99))).status).toBe(200);
		await tick();
		token = tokenIn(mailsTo(farmer).at(-1)!);
	});

	const myMode = () => rowsAs<{ mode: string }>(farmer, 'SELECT app_alert_my_mode($1, $2, $3) AS mode', [projectId, 'dam_below', one.id]).then((r) => r[0]!.mode);

	it('a valid token turns that one alert off without signing in, and says what it was', async () => {
		expect(await myMode()).toBe('immediate');
		const res = await anon('POST', '/alerts/unsubscribe', { token });
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ kind: 'dam_below', project: { name: 'Alerts' }, farm: 'Farm One' });
		expect(await myMode()).toBe('off');
		// The notice alert is untouched.
		expect((await rowsAs<{ mode: string }>(farmer, 'SELECT app_alert_my_mode($1, $2, NULL) AS mode', [projectId, 'restriction_published']))[0]!.mode).toBe('immediate');
		// A mail client sending it again is harmless.
		expect((await anon('POST', '/alerts/unsubscribe', { token })).status).toBe(200);
	});

	it('refuses a tampered token, and one that is not a token at all', async () => {
		const flipped = token.slice(0, -1) + (token.at(-1) === 'A' ? 'B' : 'A');
		expect((await anon('POST', '/alerts/unsubscribe', { token: flipped })).status).toBe(404);
		expect((await anon('POST', '/alerts/unsubscribe', { token: 'x'.repeat(43) })).status).toBe(404);
		expect((await anon('POST', '/alerts/unsubscribe', { token: '' })).status).toBe(404);
		expect((await anon('POST', '/alerts/unsubscribe', {})).status).toBe(400);
	});

	it('refuses a replayed token once the person turned the alert back on (a new nonce), and the next mail carries a new one', async () => {
		expect((await farmer.call('PUT', `/me/alerts/${projectId}`, { items: [{ kind: 'dam_below', nodeId: one.id, mode: 'immediate' }] })).status).toBe(200);
		expect(await myMode()).toBe('immediate');
		expect((await anon('POST', '/alerts/unsubscribe', { token })).status).toBe(404);
		expect(await myMode()).toBe('immediate');
		// The next crossing's mail has a fresh, working token.
		expect((await rules(editor, damRules(0.01))).status).toBe(200);
		await tick();
		expect((await rules(editor, damRules(0.99))).status).toBe(200);
		await tick();
		const fresh = tokenIn(mailsTo(farmer).at(-1)!);
		expect(fresh).not.toBe(token);
		token = fresh;
	});

	it('accepts the RFC 8058 one-click form post (no Origin, token in the query): 204', async () => {
		const res = await app.request(`/alerts/unsubscribe?token=${token}`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: 'List-Unsubscribe=One-Click'
		});
		expect(res.status).toBe(204);
		expect(await myMode()).toBe('off');
	});

	it('refuses the token of someone who is no longer a member (it expired with their access)', async () => {
		const leaverProject = await makeProject(owner, 'Alerts leaver');
		const leaver = await signUp('Aunsub');
		expect((await owner.call('POST', `/projects/${leaverProject.id}/members`, { email: leaver.email, role: 'editor' })).status).toBe(201);
		// Arrange a token for their data_stale subscription (the worker's format).
		const { newSubscriptionSecret, unsubscribeToken } = await import('./tokens.js');
		const { nonce, hash } = newSubscriptionSecret('test-only-alerts-secret-000000000000000');
		await asOwner(
			`INSERT INTO alert_subscription (user_id, project_id, kind, mode, unsubscribe_nonce, unsubscribe_hash) VALUES ($1, $2, 'data_stale', 'immediate', $3, $4)`,
			[leaver.id, leaverProject.id, nonce, hash]
		);
		const t = unsubscribeToken(nonce, 'test-only-alerts-secret-000000000000000');
		expect(hashToken(t).equals(hash)).toBe(true);
		expect((await owner.call('DELETE', `/projects/${leaverProject.id}/members/${leaver.id}`)).status).toBeLessThan(300);
		expect((await anon('POST', '/alerts/unsubscribe', { token: t })).status).toBe(404);
		await reset();
	});
});

describe('the daily cap and the digest', () => {
	it('sends at most 5 immediate alert mails a day; the rest go in the next 06:00 digest, one email per project', async () => {
		await reset();
		// Arrange 7 opened events for the editor (as the schema owner: the cap is what's under test).
		const [rule] = await asOwner(`INSERT INTO alert_rule (project_id, kind, node_id, threshold) VALUES ($1, 'dam_below', $2, 0.5) RETURNING id`, [projectId, one.id]);
		const lone = await signUp('Acapped');
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: lone.email, role: 'editor' })).status).toBe(201);
		for (let i = 0; i < 7; i++) {
			const [e] = await asOwner(
				`INSERT INTO alert_event (rule_id, project_id, state, value, detail) VALUES ($1, $2, 'cleared', 0.2, $3) RETURNING id`,
				[rule.id, projectId, JSON.stringify({ source: 'latest', pct: 0.2 + i / 100, date: '2023-02-01' })]
			);
			await asOwner(`INSERT INTO alert_delivery (event_id, user_id, project_id, mode) VALUES ($1, $2, $3, 'immediate')`, [e.id, lone.id, projectId]);
		}
		await sendAlerts();
		expect(mailsTo(lone).length).toBe(5);
		const states = await asOwner(`SELECT status, count(*)::int AS n FROM alert_delivery WHERE user_id = $1 GROUP BY status ORDER BY status`, [lone.id]);
		expect(states).toEqual([
			{ status: 'digest', n: 2 },
			{ status: 'sent', n: 5 }
		]);
		// Before 06:00 nothing more goes; at the next 06:00 SAST, one digest with both.
		await sendAlerts();
		expect(mailsTo(lone).length).toBe(5);
		await sendAlerts({ now: new Date(Date.now() + 24 * 3600_000) });
		const mails = mailsTo(lone);
		expect(mails.length).toBe(6);
		const digest = mails.at(-1)!;
		expect(digest.subject).toBe('Your alerts for Alerts — Water Management');
		expect(digest.text.match(/Dam low on Farm One/g)).toHaveLength(2);
		// Positive control for the line limit below: a small digest writes every line, and no "more".
		expect(digest.text).not.toContain('more alerts');
		expect(digest.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
		expect(await asOwner(`SELECT DISTINCT status, via FROM alert_delivery WHERE user_id = $1 AND via = 'digest'`, [lone.id])).toEqual([{ status: 'sent', via: 'digest' }]);
		// The digest's one-click mutes the whole project for them.
		const t = tokenIn(digest);
		expect((await anon('POST', '/alerts/unsubscribe', { token: t })).body.kind).toBe('all');
		expect((await rowsAs<{ mode: string | null }>(lone, 'SELECT app_alert_my_mode($1, $2, NULL) AS mode', [projectId, 'data_stale']))[0]!.mode).toBeNull();
		await reset();
	});
});

describe('the digest’s size limit', () => {
	/** `n` cleared dam events for one editor, each a digest line queued an hour apart (newest last), as the schema owner. */
	async function queueDigest(n: number) {
		const u = await signUp('Adigest');
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role: 'editor' })).status).toBe(201);
		const [rule] = await asOwner(`INSERT INTO alert_rule (project_id, kind, node_id, threshold) VALUES ($1, 'dam_below', $2, 0.5) RETURNING id`, [projectId, one.id]);
		await asOwner(
			`WITH e AS (
				INSERT INTO alert_event (rule_id, project_id, state, value, detail)
				SELECT $1, $2, 'cleared', 0.2, jsonb_build_object('source', 'latest', 'pct', 0.2, 'date', '2023-02-01', 'i', i) FROM generate_series(1, $4::int) i
				RETURNING id, (detail->>'i')::int AS i
			)
			INSERT INTO alert_delivery (event_id, user_id, project_id, mode, status, created_at)
			SELECT e.id, $3, $2, 'daily_digest', 'digest', now() - make_interval(hours => $4::int - e.i + 1) FROM e`,
			[rule.id, projectId, u.id, n]
		);
		return u;
	}
	const statuses = (u: { id: string }) =>
		asOwner(`SELECT status, reason, count(*)::int AS n FROM alert_delivery WHERE user_id = $1 GROUP BY status, reason ORDER BY status, reason`, [u.id]);
	const tomorrow = () => new Date(Date.now() + 24 * 3600_000);

	it('writes at most 20 lines and “…and 80 more” for 100 queued, marks all 100 sent, and sends nothing for them again', async () => {
		await reset();
		const u = await queueDigest(100);
		await sendAlerts({ now: tomorrow() });
		const mails = mailsTo(u);
		expect(mails).toHaveLength(1);
		expect(mails[0]!.text.match(/Dam low on Farm One:/g)).toHaveLength(DIGEST_MAX_LINES);
		expect(mails[0]!.text).toContain('…and 80 more alerts. Open the catchment to see them all.');
		expect(await statuses(u)).toEqual([{ status: 'sent', reason: null, n: 100 }]);
		await sendAlerts({ now: tomorrow() });
		expect(mailsTo(u)).toHaveLength(1);
		await reset();
	});

	it('claims at most 200 lines a person; older ones are skipped as over the limit, never sent later', async () => {
		await reset();
		const u = await queueDigest(230);
		await sendAlerts({ now: tomorrow() });
		const mails = mailsTo(u);
		expect(mails).toHaveLength(1);
		expect(mails[0]!.text).toContain(`…and ${DIGEST_CLAIM_LINES - DIGEST_MAX_LINES} more alerts.`);
		expect(await statuses(u)).toEqual([
			{ status: 'sent', reason: null, n: DIGEST_CLAIM_LINES },
			{ status: 'skipped', reason: 'over the digest limit', n: 30 }
		]);
		// The newest were kept: every skipped line is older than every sent one.
		const [{ ok }] = await asOwner(
			`SELECT max(created_at) FILTER (WHERE status = 'skipped') < min(created_at) FILTER (WHERE status = 'sent') AS ok FROM alert_delivery WHERE user_id = $1`,
			[u.id]
		);
		expect(ok).toBe(true);
		await sendAlerts({ now: tomorrow() });
		expect(mailsTo(u)).toHaveLength(1);
		await reset();
	});
});

describe('the kill switch', () => {
	it('with ALERTS_ENABLED=false events still open, but nothing is queued or sent, and waiting deliveries are dropped (positive control first)', async () => {
		await reset();
		vi.stubEnv('ALERTS_ENABLED', 'false');
		const before = outbox.length;
		// A delivery that was already waiting when the switch went off.
		const [rule] = await asOwner(`INSERT INTO alert_rule (project_id, kind, threshold) VALUES ($1, 'job_dead', 1) RETURNING id`, [projectId]);
		const [e] = await asOwner(`INSERT INTO alert_event (rule_id, project_id, state, value, detail) VALUES ($1, $2, 'cleared', 1, '{"count":1}') RETURNING id`, [rule.id, projectId]);
		await asOwner(`INSERT INTO alert_delivery (event_id, user_id, project_id, mode) VALUES ($1, $2, $3, 'immediate')`, [e.id, owner.id, projectId]);
		expect((await rules(editor, damRules(0.99))).status).toBe(200);
		await tick();
		expect(outbox.length).toBe(before);
		expect((await asOwner(`SELECT count(*)::int AS n FROM alert_event WHERE project_id = $1 AND state = 'firing'`, [projectId]))[0].n).toBe(3);
		expect(await asOwner(`SELECT status, reason FROM alert_delivery WHERE event_id = $1`, [e.id])).toEqual([
			{ status: 'skipped', reason: 'alerts switched off (ALERTS_ENABLED=false)' }
		]);
		expect((await asOwner(`SELECT count(*)::int AS n FROM alert_delivery WHERE project_id = $1 AND status IN ('pending', 'digest')`, [projectId]))[0].n).toBe(0);
		// Switched back on: the next crossing mails again.
		vi.unstubAllEnvs();
		expect((await rules(editor, damRules(0.01))).status).toBe(200);
		await tick();
		expect((await rules(editor, damRules(0.99))).status).toBe(200);
		await tick();
		expect(mailsTo(farmer).length).toBeGreaterThan(0);
		expect(outbox.length).toBeGreaterThan(before);
		await reset();
	});
});

describe('the restriction notice', () => {
	it('mails farmers and viewers when the WUA sets a restriction, in the notice’s language where there is one, and again when it is lifted', async () => {
		await reset();
		expect((await farmer.call('PATCH', '/auth/me', { locale: 'af' })).status).toBe(200);
		expect((await rules(editor, [{ kind: 'restriction_published', threshold: 0, enabled: true }])).status).toBe(200);
		await tick();
		const pub = (await owner.call('GET', `/projects/${projectId}/publication`)).body.current;
		const f0 = mailsTo(farmer).length;
		const v0 = mailsTo(viewer).length;
		const res = await editor.call('PATCH', `/projects/${projectId}/publication/${pub.id}`, {
			restriction: { level: 'restricted', pct: 20, notice: { en: 'Irrigate at night only.', af: 'Besproei net snags.' } }
		});
		expect(res.status).toBe(200);
		await tick();
		const fm = mailsTo(farmer).at(-1)!;
		expect(mailsTo(farmer).length).toBe(f0 + 1);
		expect(fm.text).toContain('Besproei net snags.');
		// The farmer reads Afrikaans: the WUA's own Afrikaans notice inside Afrikaans words, marked lang="af".
		expect(fm.html).toContain('<html lang="af">');
		expect(fm.subject).toBe('Nuwe beperkingskennisgewing — Alerts');
		expect(mailsTo(viewer).at(-1)!.text).toContain('Irrigate at night only.');
		expect(mailsTo(viewer).length).toBe(v0 + 1);
		// The same notice again: nothing new.
		expect((await editor.call('PATCH', `/projects/${projectId}/publication/${pub.id}`, { restriction: { level: 'restricted', pct: 20, notice: { en: 'Irrigate at night only.', af: 'Besproei net snags.' } } })).status).toBe(200);
		await tick();
		expect(mailsTo(farmer).length).toBe(f0 + 1);
		// Lifted.
		expect((await editor.call('PATCH', `/projects/${projectId}/publication/${pub.id}`, { restriction: { level: 'none', pct: null, notice: {} } })).status).toBe(200);
		await tick();
		expect(mailsTo(farmer).at(-1)!.subject).toBe('Beperking opgehef — Alerts');
		expect((await farmer.call('PATCH', '/auth/me', { locale: null })).status).toBe(200);
		await reset();
	});
});

describe('after an automatic run', () => {
	it('the auto re-run queues an alert check, which runs in the same tick (positive control: none while alerts are off)', async () => {
		const { id: pid } = await makeProject(owner, 'Alerts auto');
		expect((await owner.call('PATCH', `/projects/${pid}`, { settings: { autoRun: { enabled: true, debounceMinutes: 0 } } })).status).toBe(200);
		const evals = async () => (await asOwner(`SELECT status FROM job WHERE project_id = $1 AND kind = 'alert_eval'`, [pid])).map((r) => r.status);
		const autoRun = () => withUser(owner.id, (db) => db.query(`INSERT INTO job (project_id, kind, payload, dedupe_key) VALUES ($1, 'rerun', '{"trigger":"auto","cause":"series"}', 'rerun')`, [pid]));
		await autoRun();
		await tick();
		expect(await evals()).toEqual([]);
		expect((await rules(owner, [{ kind: 'job_dead', threshold: 1, enabled: true }], pid)).status).toBe(200);
		await asOwner(`DELETE FROM job WHERE project_id = $1 AND kind = 'alert_eval'`, [pid]);
		await autoRun();
		await tick();
		expect(await evals()).toEqual(['done']);
		await asOwner(`DELETE FROM job WHERE project_id = $1`, [pid]);
	});
});

describe('scheduled checks: data going stale, failing feeds', () => {
	it('the tick queues a check for a project with a data_stale rule on, as an editor, and mails the owners and editors about a late feed', async () => {
		await reset();
		const { id: pid } = await makeProject(owner, 'Alerts stale');
		const [feed] = await asOwner(
			`INSERT INTO data_feed (project_id, source, config, target_kind, target_name, acting_user_id, created_by, last_attempt_at, last_success_at, last_data_date, consecutive_failures)
			 VALUES ($1, 'dws', '{"station":"X0H000"}', 'flow_observed_m3s', 'gauge', $2, $2, now(), now(), $3::date - 250, 0) RETURNING id`,
			[pid, owner.id, localToday()]
		);
		expect((await rules(owner, [{ kind: 'data_stale', feedId: feed.id, threshold: 3, enabled: true }], pid)).status).toBe(200);
		await asOwner(`DELETE FROM job WHERE project_id = $1 AND kind = 'alert_eval'`, [pid]);
		// The worker's context queues it (the regular tick's schedule step).
		const queued = await withoutUser(async (db) => (await db.query<{ n: number }>("SELECT app_alert_schedule($1, interval '0', 1) AS n", [pid])).rows[0]!.n);
		expect(queued).toBe(1);
		const [job] = await asOwner(`SELECT acting_user_id FROM job WHERE project_id = $1 AND kind = 'alert_eval' AND status = 'queued'`, [pid]);
		expect(job.acting_user_id).toBe(owner.id);
		// A signed-in user can't use the scheduler.
		await expect(withUser(owner.id, (db) => db.query("SELECT app_alert_schedule($1, interval '0', 1)", [pid]))).rejects.toMatchObject({ code: '42501' });
		await tick();
		const m = mailsTo(owner).at(-1)!;
		expect(m.subject).toBe('Data feed behind — Alerts stale');
		expect(m.text).toMatch(/DWS gauge flow \(gauge\): newest day .*, 10 days late/);
		await asOwner(`DELETE FROM job WHERE project_id = $1 AND kind = 'alert_eval'`, [pid]);
	});
});

describe('per-feed staleness levels (057 feed_id)', () => {
	/** A feed whose newest day is `ago` days old (as the schema owner: the feed's health is not what's under test). */
	const feed = async (pid: string, source: 'dws' | 'chirps', name: string, ago: number, enabled = true) =>
		(
			await asOwner(
				`INSERT INTO data_feed (project_id, source, config, target_kind, target_name, enabled, acting_user_id, created_by, last_attempt_at, last_success_at, last_data_date)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $7, now(), now(), $9::date - $8::int) RETURNING id`,
				[pid, source, source === 'dws' ? { station: 'X0H000' } : { cells: [{ lat: -33, lon: 19 }] }, source === 'dws' ? 'flow_observed_m3s' : 'rain_chirps_mm', name, enabled, owner.id, ago, localToday()]
			)
		)[0].id as string;
	const staleRules = async (pid: string) =>
		(await owner.call('GET', `/projects/${pid}/alert-rules`)).body.rules.filter((r: { kind: string }) => r.kind === 'data_stale') as {
			id: string | null;
			feedId: string;
			feedName: string;
			threshold: number;
			enabled: boolean;
			firing: boolean;
		}[];
	const staleMails = (pid: string) => mailsTo(owner).filter((m) => m.subject === `Data feed behind — ${pid}`);

	it('lists one data_stale rule per feed, off, at its source’s default level; the other kinds stay one per catchment', async () => {
		const { id: pid } = await makeProject(owner, 'Stale defaults');
		const gauge = await feed(pid, 'dws', 'gauge', 0);
		const rain = await feed(pid, 'chirps', 'Upper', 0);
		const got = await staleRules(pid);
		expect(got.map((r) => [r.feedId, r.feedName, r.threshold, r.enabled, r.id])).toEqual([
			[rain, 'CHIRPS daily rainfall (Upper)', 3, false, null],
			[gauge, 'DWS gauge flow (gauge)', 30, false, null]
		]);
		const all = (await owner.call('GET', `/projects/${pid}/alert-rules`)).body.rules as { kind: string; feedId: string | null }[];
		expect(all.filter((r) => r.kind === 'ewr_forecast_fail')).toHaveLength(1);
		expect(all.filter((r) => r.kind !== 'data_stale').every((r) => r.feedId === null)).toBe(true);
	});

	it('refuses a data_stale rule without its feed, a feed on another kind, and another project’s feed', async () => {
		const { id: pid } = await makeProject(owner, 'Stale refusals');
		const { id: otherPid } = await makeProject(owner, 'Stale elsewhere');
		const mine = await feed(pid, 'dws', 'gauge', 0);
		const theirs = await feed(otherPid, 'dws', 'gauge', 0);
		expect((await rules(owner, [{ kind: 'data_stale', threshold: 3, enabled: true }], pid)).status).toBe(400);
		expect((await rules(owner, [{ kind: 'feed_failing', feedId: mine, threshold: 3, enabled: true }], pid)).status).toBe(400);
		expect((await rules(owner, [{ kind: 'data_stale', feedId: theirs, threshold: 3, enabled: true }], pid)).status).toBe(404);
		// Straight past the route: the trigger refuses another project's feed too.
		await expect(
			withUser(owner.id, (db) => db.query(`INSERT INTO alert_rule (project_id, kind, feed_id, threshold) VALUES ($1, 'data_stale', $2, 3)`, [pid, theirs]))
		).rejects.toMatchObject({ code: '23503' });
		// Positive control: its own feed is fine, and a rule's feed never changes.
		expect((await rules(owner, [{ kind: 'data_stale', feedId: mine, threshold: 3, enabled: true }], pid)).status).toBe(200);
		const another = await feed(pid, 'chirps', 'Other', 0);
		await expect(withUser(owner.id, (db) => db.query(`UPDATE alert_rule SET feed_id = $2 WHERE project_id = $1 AND kind = 'data_stale'`, [pid, another]))).rejects.toMatchObject({
			code: '23514'
		});
		await asOwner(`DELETE FROM job WHERE project_id IN ($1, $2) AND kind = 'alert_eval'`, [pid, otherPid]);
	});

	it('each feed fires at its own level, past its own usual delay, and the mail names that feed only', async () => {
		const { id: pid } = await makeProject(owner, 'Stale levels');
		// DWS: 250 days old = 10 past its 240-day delay. CHIRPS: 17 days old = 5 past its 12.
		const gauge = await feed(pid, 'dws', 'gauge', 250);
		const rain = await feed(pid, 'chirps', 'Upper', 17);
		const before = staleMails('Stale levels').length;
		// The gauge at its default (30 days) is fine; the rain at 3 is late.
		expect(
			(
				await rules(
					owner,
					[
						{ kind: 'data_stale', feedId: gauge, threshold: 30, enabled: true },
						{ kind: 'data_stale', feedId: rain, threshold: 3, enabled: true }
					],
					pid
				)
			).status
		).toBe(200);
		await tick();
		let got = await staleRules(pid);
		expect(got.map((r) => [r.feedName, r.firing])).toEqual([
			['CHIRPS daily rainfall (Upper)', true],
			['DWS gauge flow (gauge)', false]
		]);
		const first = staleMails('Stale levels').slice(before);
		expect(first).toHaveLength(1);
		expect(first[0]!.text).toMatch(/CHIRPS daily rainfall \(Upper\): newest day .*, 5 days late/);
		expect(first[0]!.text).not.toContain('DWS gauge flow');
		// Lower the gauge's level under its lateness: it fires on its own, with its own mail.
		expect((await rules(owner, [{ kind: 'data_stale', feedId: gauge, threshold: 5, enabled: true }], pid)).status).toBe(200);
		await tick();
		got = await staleRules(pid);
		expect(got.every((r) => r.firing)).toBe(true);
		const second = staleMails('Stale levels').slice(before + 1);
		expect(second).toHaveLength(1);
		expect(second[0]!.text).toMatch(/DWS gauge flow \(gauge\): newest day .*, 10 days late/);
		expect(second[0]!.text).not.toContain('CHIRPS');
		// The events say which feed.
		const events = (await owner.call('GET', `/projects/${pid}/alert-events`)).body.events as { kind: string; feedId: string | null }[];
		expect(events.filter((e) => e.kind === 'data_stale').map((e) => e.feedId).sort()).toEqual([gauge, rain].sort());
		// A feed switched off clears its alert (no value), and the other keeps firing.
		await asOwner('UPDATE data_feed SET enabled = false WHERE id = $1', [rain]);
		await asOwner(`DELETE FROM job WHERE project_id = $1 AND kind = 'alert_eval'`, [pid]);
		expect((await rules(owner, [{ kind: 'data_stale', feedId: gauge, threshold: 5, enabled: true }], pid)).status).toBe(200);
		await tick();
		expect((await staleRules(pid)).map((r) => [r.feedName, r.firing])).toEqual([
			['CHIRPS daily rainfall (Upper)', false],
			['DWS gauge flow (gauge)', true]
		]);
		await asOwner(`DELETE FROM job WHERE project_id = $1`, [pid]);
	});

	it('a feed added once staleness alerts are on gets its own rule, on, at its source’s default (positive control: none while they are off)', async () => {
		const { id: pid } = await makeProject(owner, 'Stale later');
		const gauge = await feed(pid, 'dws', 'gauge', 0);
		const { evaluateAlerts } = await import('./evaluate.js');
		// Off: a new feed gets no rule.
		await feed(pid, 'chirps', 'Early', 0);
		await withUser(owner.id, (db) => evaluateAlerts(db, pid));
		expect((await staleRules(pid)).every((r) => r.id === null)).toBe(true);
		// On for the gauge: the next feed gets a rule at CHIRPS's 3 days, and so does the earlier one.
		expect((await rules(owner, [{ kind: 'data_stale', feedId: gauge, threshold: 20, enabled: true }], pid)).status).toBe(200);
		await feed(pid, 'chirps', 'Later', 0);
		await withUser(owner.id, (db) => evaluateAlerts(db, pid));
		expect((await staleRules(pid)).map((r) => [r.feedName, r.threshold, r.enabled, r.id !== null])).toEqual([
			['CHIRPS daily rainfall (Early)', 3, true, true],
			['CHIRPS daily rainfall (Later)', 3, true, true],
			['DWS gauge flow (gauge)', 20, true, true]
		]);
		await asOwner(`DELETE FROM job WHERE project_id = $1`, [pid]);
	});
});

// The project's own day (058 time_zone, 059): the evaluator's "today", a
// forecast's madeOn, and the digest's 06:00 are where the catchment is, never
// UTC's or the server's. 23:30 UTC is already the next day in South Africa.
describe('the project’s local day', () => {
	const zone = process.env.TZ;
	afterAll(() => {
		process.env.TZ = zone;
	});

	it.each(['Pacific/Kiritimati', 'Pacific/Pago_Pago'])('data_stale counts days late to the project’s today at 23:30 UTC (server TZ %s; positive control: a UTC project)', async (tz) => {
		process.env.TZ = tz;
		const { id: pid } = await makeProject(owner, `Local day ${tz}`);
		// 23:30 UTC on 25 September is 01:30 on the 26th in South Africa.
		const now = new Date('2026-09-25T23:30:00Z');
		// A DWS feed whose newest day is 243 days before the 26th: 3 days past its 240-day delay there, 2 in UTC's reckoning.
		const [f] = await asOwner(
			`INSERT INTO data_feed (project_id, source, config, target_kind, target_name, acting_user_id, created_by, last_attempt_at, last_success_at, last_data_date)
			 VALUES ($1, 'dws', '{"station":"X0H000"}', 'flow_observed_m3s', 'gauge', $2, $2, now(), now(), date '2026-09-26' - 243) RETURNING id`,
			[pid, owner.id]
		);
		// Threshold 2: fires past 2 days late.
		await asOwner(`INSERT INTO alert_rule (project_id, kind, feed_id, threshold) VALUES ($1, 'data_stale', $2, 2)`, [pid, f.id]);
		const event = async () =>
			(await asOwner(`SELECT state, value FROM alert_event WHERE project_id = $1 AND kind = 'data_stale' ORDER BY opened_at DESC LIMIT 1`, [pid]))[0] as
				| { state: string; value: number }
				| undefined;
		// Positive control first: in a UTC project it is still the 25th, 2 days late, not past the level.
		await asOwner(`UPDATE project SET time_zone = 'UTC' WHERE id = $1`, [pid]);
		await withUser(owner.id, (db) => evaluateAlerts(db, pid, { now }));
		expect(await event()).toBeUndefined();
		// South African (the default): the 26th, 3 days late, fires.
		await asOwner(`UPDATE project SET time_zone = DEFAULT WHERE id = $1`, [pid]);
		await withUser(owner.id, (db) => evaluateAlerts(db, pid, { now }));
		expect(await event()).toEqual({ state: 'firing', value: 3 });
		// Hysteresis follows the same count: UTC's 2 days late is not below the level (data_stale re-arms under it), so it keeps firing and follows the figure.
		await asOwner(`UPDATE project SET time_zone = 'UTC' WHERE id = $1`, [pid]);
		await withUser(owner.id, (db) => evaluateAlerts(db, pid, { now }));
		expect(await event()).toEqual({ state: 'firing', value: 2 });
		await asOwner(`DELETE FROM job WHERE project_id = $1`, [pid]);
		await asOwner(`DELETE FROM alert_delivery WHERE project_id = $1`, [pid]);
	});

	it('an EWR forecast is dated, and still current, by the project’s day (positive control: a UTC project)', async () => {
		const { id: pid, runId } = await makeProject(owner, 'Local forecast');
		// A forecast run made at 22:30 UTC on the 25th: 00:30 on the 26th in South Africa.
		const setForecast = (to: string) =>
			asOwner(`UPDATE model_run SET trigger = 'forecast', created_at = '2026-09-25T22:30:00Z', summary = jsonb_set(summary, '{forecast}', $2::jsonb) WHERE id = $1`, [
				runId,
				JSON.stringify({ from: '2026-09-12', to, days: 14, outletEwrDaysAtRisk: 5, perFarm: [] })
			]);
		await asOwner(`INSERT INTO alert_rule (project_id, kind, threshold) VALUES ($1, 'ewr_forecast_fail', 3)`, [pid]);
		const evaluate = async (tz: string) => {
			await asOwner('DELETE FROM alert_event WHERE project_id = $1', [pid]);
			await asOwner(`UPDATE project SET time_zone = $2 WHERE id = $1`, [pid, tz]);
			await withUser(owner.id, (db) => evaluateAlerts(db, pid, { now: new Date('2026-09-25T23:40:00Z') }));
			const rows = await asOwner(`SELECT state, detail->>'madeOn' AS "madeOn" FROM alert_event WHERE project_id = $1 AND kind = 'ewr_forecast_fail'`, [pid]);
			return rows[0] as { state: string; madeOn: string } | undefined;
		};
		// Current in both: made on the 25th in UTC, on the 26th in South Africa.
		await setForecast('2026-09-26');
		expect(await evaluate('UTC')).toEqual({ state: 'firing', madeOn: '2026-09-25' });
		expect(await evaluate('Africa/Johannesburg')).toEqual({ state: 'firing', madeOn: '2026-09-26' });
		// A forecast that ends on the 25th is past at 23:40 UTC in South Africa (the 26th there)…
		await setForecast('2026-09-25');
		expect(await evaluate('Africa/Johannesburg')).toBeUndefined();
		// …positive control: still current in a UTC project.
		expect(await evaluate('UTC')).toEqual({ state: 'firing', madeOn: '2026-09-25' });
		await asOwner(`DELETE FROM job WHERE project_id = $1`, [pid]);
		await asOwner(`DELETE FROM alert_event WHERE project_id = $1`, [pid]);
	});

	it('alert_digest_start is 06:00 in the given zone, whatever the session’s time zone; an unknown zone falls back to South Africa', async () => {
		for (const session of ['UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
			const at = async (instant: string, tz: string) =>
				(
					(await asOwner(
						`SELECT set_config('TimeZone', $3, true), to_char(alert_digest_start($1::timestamptz, $2) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') AS s`,
						[instant, tz, session]
					)) as { s: string }[]
				)[0]!.s;
			// 06:00 SAST is 04:00 UTC; a minute before it is still the previous digest day.
			expect(await at('2026-09-26T10:00:00Z', 'Africa/Johannesburg')).toBe('2026-09-26T04:00');
			expect(await at('2026-09-26T03:59:00Z', 'Africa/Johannesburg')).toBe('2026-09-25T04:00');
			expect(await at('2026-09-26T04:00:00Z', 'Africa/Johannesburg')).toBe('2026-09-26T04:00');
			// 23:30 UTC on the 31st is 01:30 SAST on 1 November: still October's digest day there.
			expect(await at('2026-10-31T23:30:00Z', 'Africa/Johannesburg')).toBe('2026-10-31T04:00');
			// UTC+14 and UTC−11: 06:00 there.
			expect(await at('2026-09-26T10:00:00Z', 'Pacific/Kiritimati')).toBe('2026-09-25T16:00'); // 00:00 on the 27th there
			expect(await at('2026-09-26T10:00:00Z', 'Pacific/Pago_Pago')).toBe('2026-09-25T17:00'); // 23:00 on the 25th there
			// A zone Postgres doesn't know: South Africa's, never an error.
			expect(await at('2026-09-26T10:00:00Z', 'Not/A_Zone')).toBe('2026-09-26T04:00');
		}
		expect(await asOwner(`SELECT app_time_zone('Not/A_Zone') AS a, app_time_zone('Pacific/Kiritimati') AS b, app_time_zone(NULL) AS c`)).toEqual([
			{ a: 'Africa/Johannesburg', b: 'Pacific/Kiritimati', c: 'Africa/Johannesburg' }
		]);
	});

	it('the digest goes out after 06:00 in each project’s zone: due in South Africa, not yet in Kiritimati (positive control: later it is)', async () => {
		const { id: sa } = await makeProject(owner, 'Digest SA');
		const { id: kiri } = await makeProject(owner, 'Digest Kiritimati');
		await asOwner(`UPDATE project SET time_zone = 'Pacific/Kiritimati' WHERE id = $1`, [kiri]);
		const u = await signUp('Adigestzone');
		for (const pid of [sa, kiri]) {
			expect((await owner.call('POST', `/projects/${pid}/members`, { email: u.email, role: 'editor' })).status).toBe(201);
			// An EWR forecast alert: an editor gets it by default (job_dead is off for editors).
			const [rule] = await asOwner(`INSERT INTO alert_rule (project_id, kind, threshold) VALUES ($1, 'ewr_forecast_fail', 3) RETURNING id`, [pid]);
			const [e] = await asOwner(`INSERT INTO alert_event (rule_id, project_id, state, value, detail) VALUES ($1, $2, 'cleared', 5, '{"days":5,"of":14,"from":"2026-09-12","to":"2026-09-25","madeOn":"2026-09-11"}') RETURNING id`, [rule.id, pid]);
			// Queued at 05:30 SAST on the 26th = 03:30 UTC = 17:30 on the 26th in Kiritimati.
			await asOwner(`INSERT INTO alert_delivery (event_id, user_id, project_id, mode, status, created_at) VALUES ($1, $2, $3, 'daily_digest', 'digest', '2026-09-26T03:30:00Z')`, [
				e.id,
				u.id,
				pid
			]);
		}
		const status = async (pid: string) => (await asOwner(`SELECT status FROM alert_delivery WHERE user_id = $1 AND project_id = $2`, [u.id, pid]))[0].status;
		// 06:30 SAST (04:30 UTC): South Africa's 06:00 has passed; Kiritimati's (16:00 UTC on the 25th) was before the line was queued.
		await sendAlerts({ now: new Date('2026-09-26T04:30:00Z') });
		expect(await status(sa)).toBe('sent');
		expect(await status(kiri)).toBe('digest');
		expect(mailsTo(u).map((m) => m.subject)).toEqual(['Your alerts for Digest SA — Water Management']);
		// 06:00 on the 27th in Kiritimati (16:00 UTC on the 26th): now it goes.
		await sendAlerts({ now: new Date('2026-09-26T16:00:00Z') });
		expect(await status(kiri)).toBe('sent');
		expect(mailsTo(u).map((m) => m.subject)).toEqual(['Your alerts for Digest SA — Water Management', 'Your alerts for Digest Kiritimati — Water Management']);
	});

	it('the daily cap counts since 06:00 in the project’s zone', async () => {
		const { id: kiri } = await makeProject(owner, 'Cap Kiritimati');
		await asOwner(`UPDATE project SET time_zone = 'Pacific/Kiritimati' WHERE id = $1`, [kiri]);
		const u = await signUp('Acapzone');
		expect((await owner.call('POST', `/projects/${kiri}/members`, { email: u.email, role: 'editor' })).status).toBe(201);
		const [rule] = await asOwner(`INSERT INTO alert_rule (project_id, kind, threshold) VALUES ($1, 'ewr_forecast_fail', 3) RETURNING id`, [kiri]);
		const event = async () =>
			(await asOwner(`INSERT INTO alert_event (rule_id, project_id, state, value, detail) VALUES ($1, $2, 'cleared', 5, '{"days":5,"of":14,"from":"2026-09-12","to":"2026-09-25","madeOn":"2026-09-11"}') RETURNING id`, [rule.id, kiri]))[0].id as string;
		// Five immediate mails sent at 10:00 UTC today: after 06:00 in South Africa, but in Kiritimati (UTC+14) that is
		// 00:00 local, before its 06:00, so in the previous digest day there.
		const today = new Date().toISOString().slice(0, 10);
		for (let i = 0; i < 5; i++)
			await asOwner(
				`INSERT INTO alert_delivery (event_id, user_id, project_id, mode, status, via, claimed_at, sent_at) VALUES ($1, $2, $3, 'immediate', 'sent', 'immediate', $4, $4)`,
				[await event(), u.id, kiri, `${today}T10:00:00Z`]
			);
		await asOwner(`INSERT INTO alert_delivery (event_id, user_id, project_id, mode) VALUES ($1, $2, $3, 'immediate')`, [await event(), u.id, kiri]);
		const pending = async () => (await asOwner(`SELECT status, reason FROM alert_delivery WHERE user_id = $1 AND status NOT IN ('sent')`, [u.id]));
		// 18:00 UTC = 08:00 on the next day in Kiritimati: a new digest day there, so the sixth mail goes now.
		await sendAlerts({ now: new Date(`${today}T18:00:00Z`) });
		expect(await pending()).toEqual([]);
		// Positive control: one more at 15:00 UTC (05:00 Kiritimati, the same digest day as the five) waits for the digest.
		await asOwner(`INSERT INTO alert_delivery (event_id, user_id, project_id, mode) VALUES ($1, $2, $3, 'immediate')`, [await event(), u.id, kiri]);
		await asOwner(`UPDATE alert_delivery SET claimed_at = $2 WHERE user_id = $1 AND via = 'immediate' AND claimed_at > $2`, [u.id, `${today}T10:00:00Z`]);
		await sendAlerts({ now: new Date(`${today}T15:00:00Z`) });
		expect(await pending()).toEqual([{ status: 'digest', reason: 'over the daily cap' }]);
	});
});
