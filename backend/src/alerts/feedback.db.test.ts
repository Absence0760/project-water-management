// "Was this useful?" on alert emails (147_alert_feedback, issue #74): the
// links the worker puts in each mail, the public answer, the editors'
// summary, who can read the rows, and retention. Every "cannot" check has a
// positive control.
//
// Events and deliveries are arranged as the schema owner (the fan-out is
// alerts.db.test.ts's); the worker's sendAlerts builds the mails.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anon, asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { hashToken } from '../auth/tokens.js';
import { withoutUser, withUser } from '../db/tx.js';
import { outbox, type Mail } from '../mail/transport.js';
import { sendAlerts } from './send.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let viewer: User;
let farmer: User;
let projectId: string;
let ruleId: string;
const outlet = node('Outlet', null);
const farm = node('Feedback farm', outlet.id);

const alertMailsTo = (u: { email: string }) => outbox.filter((m) => m.to === u.email && m.headers?.['List-Unsubscribe']);
/** The "Yes" link's token and answer, from the mail's text part. */
const feedbackIn = (m: Mail) => {
	const all = [...m.text.matchAll(/\/alerts\/feedback#t=([A-Za-z0-9_-]{43})&a=(yes|no)/g)];
	return { token: all[0]![1]!, answers: all.map((x) => x[2]) };
};
const rowsAs = async <T = Record<string, unknown>>(u: User, sql: string, params: unknown[] = []) =>
	withUser(u.id, async (db) => (await db.query<T & Record<string, unknown>>(sql, params)).rows);

/** A dam event on the farm, delivered to `u` now (`mode` immediate) or in a digest. */
async function delivered(u: User, mode: 'immediate' | 'daily_digest' = 'immediate'): Promise<string> {
	const [e] = await asOwner(`INSERT INTO alert_event (rule_id, project_id, state, value, detail) VALUES ($1, $2, 'cleared', 0.2, $3) RETURNING id`, [
		ruleId,
		projectId,
		JSON.stringify({ source: 'latest', pct: 0.2, date: '2023-02-01' })
	]);
	await asOwner(`INSERT INTO alert_delivery (event_id, user_id, project_id, mode, status) VALUES ($1, $2, $3, $4, $5)`, [
		e.id,
		u.id,
		projectId,
		mode,
		mode === 'immediate' ? 'pending' : 'digest'
	]);
	return e.id as string;
}

const answer = (body: Record<string, unknown>) => anon('POST', '/alerts/feedback', body);

beforeAll(async () => {
	[owner, editor, viewer, farmer] = (await Promise.all(['FBowner', 'FBeditor', 'FBviewer', 'FBfarmer'].map((n) => signUp(n)))) as [User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Feedback catchment' })).body.project.id;
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
	expect(
		(await owner.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 100_000 }], transfers: [] }))
			.status
	).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: editor.email, role: 'editor' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farm.id] })).status).toBe(201);
	[{ id: ruleId }] = await asOwner(`INSERT INTO alert_rule (project_id, kind, node_id, threshold) VALUES ($1, 'dam_below', $2, 0.5) RETURNING id`, [projectId, farm.id]);
}, 60_000);

afterAll(async () => {
	await asOwner('DELETE FROM alert_rule WHERE project_id = $1', [projectId]);
});

describe('the links in an alert email', () => {
	it('carry a Yes and a No link to the feedback page, plain links only (no image, no pixel), and make one unanswered row', async () => {
		const eventId = await delivered(farmer);
		await sendAlerts();
		const m = alertMailsTo(farmer).at(-1)!;
		expect(m.text).toContain('Was this alert useful?');
		const { token, answers } = feedbackIn(m);
		expect(answers).toEqual(['yes', 'no']);
		expect(m.html).toContain(`/alerts/feedback#t=${token}&amp;a=yes`);
		expect(m.html).toContain(`/alerts/feedback#t=${token}&amp;a=no`);
		// No tracking: no image of any kind, and no link that isn't the reader's own action.
		expect(m.html).not.toMatch(/<img\b/i);
		expect(m.html).not.toMatch(/url\(/i);
		const rows = await asOwner('SELECT kind, useful, answered_at, event_id FROM alert_feedback WHERE user_id = $1', [farmer.id]);
		expect(rows).toEqual([{ kind: 'dam_below', useful: null, answered_at: null, event_id: eventId }]);
	});

	it('a digest carries one pair of links, filed as the digest', async () => {
		await delivered(editor, 'daily_digest');
		await delivered(editor, 'daily_digest');
		await sendAlerts({ now: new Date(Date.now() + 24 * 3600_000) });
		const m = alertMailsTo(editor).at(-1)!;
		expect(m.text).toContain('Was this summary useful?');
		expect(feedbackIn(m).answers).toEqual(['yes', 'no']);
		const rows = await asOwner('SELECT kind, event_id FROM alert_feedback WHERE user_id = $1', [editor.id]);
		expect(rows).toHaveLength(1);
		expect(rows[0].kind).toBe('digest');
		// One of the digest's lines (its first, newest first).
		expect(rows[0].event_id).toBeTruthy();
	});

	it('a retried mail keeps the same link (the slot reuses its nonce)', async () => {
		const eventId = await delivered(viewer);
		// As the worker would: the delivery is being sent, the viewer builds it twice.
		await asOwner(`UPDATE alert_delivery SET status = 'sending' WHERE event_id = $1 AND user_id = $2`, [eventId, viewer.id]);
		const slot = (nonce: Buffer) =>
			rowsAs<{ n: Buffer }>(viewer, 'SELECT app_alert_answer_slot($1, false, $2, $3) AS n', [eventId, nonce, Buffer.alloc(32, nonce[0])]).then((r) => r[0]!.n);
		const a = await slot(Buffer.alloc(32, 1));
		const b = await slot(Buffer.alloc(32, 2));
		expect(b.equals(a)).toBe(true);
		await asOwner(`UPDATE alert_delivery SET status = 'sent' WHERE event_id = $1 AND user_id = $2`, [eventId, viewer.id]);
	});

	it('a slot only for the caller’s own delivery being sent (positive control above): not another person’s, not one already sent', async () => {
		const eventId = await delivered(farmer);
		// The farmer's delivery, asked for by the viewer: refused.
		await asOwner(`UPDATE alert_delivery SET status = 'sending' WHERE event_id = $1`, [eventId]);
		await expect(rowsAs(viewer, 'SELECT app_alert_answer_slot($1, false, $2, $3)', [eventId, Buffer.alloc(32, 3), Buffer.alloc(32, 4)])).rejects.toThrow(/no alert of yours/);
		await asOwner(`UPDATE alert_delivery SET status = 'sent' WHERE event_id = $1`, [eventId]);
		await expect(rowsAs(farmer, 'SELECT app_alert_answer_slot($1, false, $2, $3)', [eventId, Buffer.alloc(32, 5), Buffer.alloc(32, 6)])).rejects.toThrow(/no alert of yours/);
		// water_app can't write the table directly.
		await expect(
			rowsAs(farmer, `INSERT INTO alert_feedback (project_id, user_id, kind, nonce, token_hash) VALUES ($1, $2, 'dam_below', $3, $4)`, [projectId, farmer.id, Buffer.alloc(32, 7), Buffer.alloc(32, 8)])
		).rejects.toThrow(/permission denied/);
	});
});

describe('POST /alerts/feedback (public)', () => {
	it('records the answer and comment, says what it was about, and a second answer replaces the first', async () => {
		await delivered(farmer);
		await sendAlerts();
		const { token } = feedbackIn(alertMailsTo(farmer).at(-1)!);
		const res = await answer({ token, useful: false, comment: '  Too late to act on  ' });
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ kind: 'dam_below', project: { name: 'Feedback catchment' } });
		const row = async () => (await asOwner('SELECT useful, comment FROM alert_feedback WHERE token_hash = $1', [hashToken(token)]))[0];
		expect(await row()).toEqual({ useful: false, comment: 'Too late to act on' });
		expect((await answer({ token, useful: true })).status).toBe(200);
		expect(await row()).toEqual({ useful: true, comment: null });
	});

	it('refuses a tampered token, a non-token, a long comment and a missing answer', async () => {
		await delivered(farmer);
		await sendAlerts();
		const { token } = feedbackIn(alertMailsTo(farmer).at(-1)!);
		const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
		const gone = await answer({ token: flipped, useful: true });
		expect(gone.status).toBe(404);
		expect(gone.body.code).toBe('feedback_link_gone');
		expect((await answer({ token: 'x'.repeat(43), useful: true })).status).toBe(404);
		expect((await answer({ token, useful: true, comment: 'x'.repeat(501) })).status).toBe(400);
		expect((await answer({ token })).status).toBe(400);
		// Positive control: the same token, well formed, answers.
		expect((await answer({ token, useful: true, comment: 'x'.repeat(500) })).status).toBe(200);
	});

	it('refuses a link more than 30 days old (positive control: a fresh one answers)', async () => {
		await delivered(farmer);
		await sendAlerts();
		const { token } = feedbackIn(alertMailsTo(farmer).at(-1)!);
		await asOwner(`UPDATE alert_feedback SET sent_at = now() - interval '31 days' WHERE token_hash = $1`, [hashToken(token)]);
		expect((await answer({ token, useful: true })).status).toBe(404);
		await asOwner(`UPDATE alert_feedback SET sent_at = now() - interval '29 days' WHERE token_hash = $1`, [hashToken(token)]);
		expect((await answer({ token, useful: true })).status).toBe(200);
	});

	it('refuses the link of someone no longer a member (positive control: while a member, it answers)', async () => {
		const leaver = await signUp('FBleaver');
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: leaver.email, role: 'editor' })).status).toBe(201);
		await delivered(leaver);
		await delivered(leaver);
		await sendAlerts();
		const [a, b] = alertMailsTo(leaver).map((m) => feedbackIn(m).token);
		expect((await answer({ token: a, useful: true })).status).toBe(200);
		expect((await owner.call('DELETE', `/projects/${projectId}/members/${leaver.id}`)).status).toBeLessThan(300);
		expect((await answer({ token: b, useful: true })).status).toBe(404);
	});
});

describe('GET /projects/:id/alert-feedback (editors)', () => {
	it('counts answers per kind and lists comments, never who gave them; viewers and farmers may not (positive control: the editor)', async () => {
		const res = await editor.call('GET', `/projects/${projectId}/alert-feedback`);
		expect(res.status).toBe(200);
		const dam = res.body.kinds.find((k: { kind: string }) => k.kind === 'dam_below');
		expect(dam.yes).toBeGreaterThanOrEqual(1);
		expect(res.body.comments.length).toBeGreaterThanOrEqual(1);
		expect(Object.keys(res.body.comments[0]).sort()).toEqual(['answeredAt', 'comment', 'kind', 'useful']);
		// No person in the answer: no id, name or address of anyone who answered.
		const text = JSON.stringify(res.body);
		for (const u of [farmer, viewer, editor]) {
			expect(text).not.toContain(u.id);
			expect(text).not.toContain(u.email);
		}
		expect((await viewer.call('GET', `/projects/${projectId}/alert-feedback`)).status).toBe(403);
		expect((await farmer.call('GET', `/projects/${projectId}/alert-feedback`)).status).toBe(403);
	});

	it('RLS: an editor reads the project’s rows, a person their own, a viewer or farmer nobody else’s', async () => {
		const total = (await asOwner('SELECT count(*)::int AS n FROM alert_feedback WHERE project_id = $1', [projectId]))[0].n;
		expect((await rowsAs<{ n: number }>(editor, 'SELECT count(*)::int AS n FROM alert_feedback WHERE project_id = $1', [projectId]))[0]!.n).toBe(total);
		const mine = await rowsAs<{ user_id: string }>(farmer, 'SELECT user_id FROM alert_feedback WHERE project_id = $1', [projectId]);
		expect(mine.length).toBeGreaterThan(0);
		expect(new Set(mine.map((r) => r.user_id))).toEqual(new Set([farmer.id]));
		const theirs = await rowsAs<{ user_id: string }>(viewer, 'SELECT user_id FROM alert_feedback WHERE project_id = $1', [projectId]);
		expect(theirs.every((r) => r.user_id === viewer.id)).toBe(true);
	});

	it('is in the person’s own data export, without the token’s hash or nonce', async () => {
		const res = await farmer.call('GET', '/auth/me/export');
		expect(res.status).toBe(200);
		expect(res.body.alertFeedback.length).toBeGreaterThan(0);
		expect(Object.keys(res.body.alertFeedback[0]).sort()).toEqual(['answeredAt', 'comment', 'kind', 'projectId', 'sentAt', 'useful']);
	});
});

describe('retention (app_purge_alert_answers)', () => {
	it('drops unanswered rows after 30 days and answers after 365, and keeps the rest (positive control); the worker only', async () => {
		const [stale] = await asOwner(
			`INSERT INTO alert_feedback (project_id, user_id, kind, nonce, token_hash, sent_at) VALUES ($1, $2, 'dam_below', $3, $4, now() - interval '31 days') RETURNING id`,
			[projectId, farmer.id, Buffer.alloc(32, 11), Buffer.alloc(32, 12)]
		);
		const [old] = await asOwner(
			`INSERT INTO alert_feedback (project_id, user_id, kind, nonce, token_hash, sent_at, useful, answered_at) VALUES ($1, $2, 'dam_below', $3, $4, now() - interval '400 days', true, now() - interval '366 days') RETURNING id`,
			[projectId, farmer.id, Buffer.alloc(32, 13), Buffer.alloc(32, 14)]
		);
		const [kept] = await asOwner(
			`INSERT INTO alert_feedback (project_id, user_id, kind, nonce, token_hash, sent_at, useful, answered_at) VALUES ($1, $2, 'dam_below', $3, $4, now() - interval '300 days', false, now() - interval '300 days') RETURNING id`,
			[projectId, farmer.id, Buffer.alloc(32, 15), Buffer.alloc(32, 16)]
		);
		await expect(rowsAs(editor, 'SELECT app_purge_alert_answers()')).rejects.toThrow(/only the worker/);
		const n = await withoutUser(async (db) => (await db.query<{ n: number }>('SELECT app_purge_alert_answers() AS n')).rows[0]!.n);
		expect(n).toBeGreaterThanOrEqual(2);
		const left = (await asOwner('SELECT id FROM alert_feedback WHERE id = ANY($1::uuid[])', [[stale.id, old.id, kept.id]])).map((r: { id: string }) => r.id);
		expect(left).toEqual([kept.id]);
	});

	it('an answer outlives its purged alert (event_id set null), and goes with the account', async () => {
		const temp = await signUp('FBtemp');
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: temp.email, role: 'editor' })).status).toBe(201);
		const eventId = await delivered(temp);
		await sendAlerts();
		const { token } = feedbackIn(alertMailsTo(temp).at(-1)!);
		expect((await answer({ token, useful: true })).status).toBe(200);
		await asOwner('DELETE FROM alert_event WHERE id = $1', [eventId]);
		expect((await asOwner('SELECT event_id, useful FROM alert_feedback WHERE user_id = $1', [temp.id]))[0]).toEqual({ event_id: null, useful: true });
		await asOwner('DELETE FROM app_user WHERE id = $1', [temp.id]);
		expect(await asOwner('SELECT 1 FROM alert_feedback WHERE user_id = $1', [temp.id])).toEqual([]);
	});
});
