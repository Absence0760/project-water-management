// Issue #120 (141_alert_series_farms_short.sql): a data_stale rule per series
// an API key writes (a logger can go silent with no feed to notice), and the
// farms_short alert, which watches automatic publications only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app, asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { runTick } from '../jobs/runner.js';
import { outbox } from '../mail/transport.js';
import { DEFAULT_TIME_ZONE, localDate } from '../projects/timeZone.js';
import { autoPublish } from '../publish/autoPublish.js';
import { evaluateAlerts } from './evaluate.js';
import { SERIES_STALE_ALERT_DAYS } from './rules.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let viewer: User;
let farmer: User;
const created: string[] = [];

const tick = () => runTick({ feeds: false, reports: false, alerts: false });
const alertMails = (u: { email: string }, subject: string) => outbox.filter((m) => m.to === u.email && m.headers?.['List-Unsubscribe'] && m.subject === subject);
const putRules = (pid: string, list: Record<string, unknown>[], u: User = owner) => u.call('PUT', `/projects/${pid}/alert-rules`, { rules: list });
const isoDaysAgo = (n: number) => {
	const d = new Date(`${localDate(new Date(), DEFAULT_TIME_ZONE)}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() - n);
	return d.toISOString().slice(0, 10);
};

/** A project with an editor and a viewer; with `network`, two farms (the farmer linked to the first), a dry rain series and a first run. */
async function makeProject(name: string, { network = false } = {}): Promise<string> {
	const id = (await owner.call('POST', '/projects', { name })).body.project.id as string;
	created.push(id);
	expect((await owner.call('POST', `/projects/${id}/members`, { email: editor.email, role: 'editor' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${id}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	if (network) {
		// Node ids are the project's own (a node id is unique across projects).
		const outlet = node('Weir', null);
		const farms = [node('Farm One', outlet.id), node('Farm Two', outlet.id)];
		const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
		const model = { nodes: [outlet, ...farms], crops: [crop], cropAreas: farms.map((f) => ({ nodeId: f.id, cropId: crop.id, areaM2: 400_000 })), transfers: [] };
		expect((await owner.call('PUT', `/projects/${id}/model`, model)).status).toBe(200);
		expect((await owner.call('PATCH', `/projects/${id}`, { settings: { apanMm: monthly(200), ewrPragmaticM3PerDay: monthly(4000) } })).status).toBe(200);
		const rain = Array.from({ length: 400 }, (_, i) => (i % 23 === 0 ? 12 : 0));
		expect((await owner.call('PUT', `/projects/${id}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: rain })).status).toBe(200);
		expect((await owner.call('POST', `/projects/${id}/farmers`, { email: farmer.email, nodeIds: [farms[0]!.id] })).status).toBe(201);
	}
	return id;
}

/** A series a person adds (a key may only write into one that exists), and its id. */
async function addSeries(pid: string, name: string, startDate: string, values: (number | null)[]): Promise<string> {
	const res = await owner.call('PUT', `/projects/${pid}/series`, { kind: 'flow_logger_m3s', name, unit: 'm³/s', startDate, values });
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.id as string;
}

async function newKey(pid: string): Promise<string> {
	const res = await owner.call('POST', `/projects/${pid}/api-keys`, { name: 'Weir logger' });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.secret as string;
}

async function push(secret: string, name: string, startDate: string, values: (number | null)[]) {
	const r = await app.request('/ingest/v1/series/merge', {
		method: 'POST',
		headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
		body: JSON.stringify({ kind: 'flow_logger_m3s', name, unit: 'm³/s', startDate, values })
	});
	expect(r.status, await r.clone().text()).toBe(200);
}

interface RuleView {
	id: string | null;
	kind: string;
	feedId: string | null;
	seriesId: string | null;
	seriesName: string | null;
	seriesKeyFed: boolean | null;
	threshold: number;
	enabled: boolean;
	firing: boolean;
}
const seriesRules = async (pid: string) =>
	((await owner.call('GET', `/projects/${pid}/alert-rules`)).body.rules as RuleView[]).filter((r) => r.kind === 'data_stale' && r.seriesId !== null);
const clearJobs = (pid: string) => asOwner(`DELETE FROM job WHERE project_id = $1`, [pid]);

beforeAll(async () => {
	[owner, editor, viewer, farmer] = (await Promise.all(['Iowner', 'Ieditor', 'Iviewer', 'Ifarmer'].map((n) => signUp(n)))) as [User, User, User, User];
}, 60_000);

afterAll(async () => {
	for (const pid of created) await clearJobs(pid);
});

describe('data_stale per ingest-key series (issue #120)', () => {
	it('lists a rule for a series an API key writes, off at the series default, and none for a hand-uploaded one', async () => {
		const pid = await makeProject('Logger list');
		const keyed = await addSeries(pid, 'Gauge', isoDaysAgo(20), [null]);
		const unnamed = await addSeries(pid, '', isoDaysAgo(20), [null]);
		await addSeries(pid, 'By hand', isoDaysAgo(20), Array(20).fill(1));
		// Positive control: before any key writes, no series rule at all.
		expect(await seriesRules(pid)).toEqual([]);
		const secret = await newKey(pid);
		await push(secret, 'Gauge', isoDaysAgo(5), [1, 1]);
		await push(secret, '', isoDaysAgo(5), [1]);
		// Named as the Data page names them: its name, else its kind's label.
		const got = await seriesRules(pid);
		expect(got.map((r) => [r.seriesId, r.seriesName, r.seriesKeyFed, r.threshold, r.enabled, r.id, r.feedId])).toEqual([
			[unnamed, 'Flow — logger', true, SERIES_STALE_ALERT_DAYS, false, null, null],
			[keyed, 'Gauge', true, SERIES_STALE_ALERT_DAYS, false, null, null]
		]);
	});

	it('refuses a hand-uploaded series, a feed and a series together, a series on another kind, and another project’s series', async () => {
		const pid = await makeProject('Logger refusals');
		const other = await makeProject('Logger elsewhere');
		const keyed = await addSeries(pid, 'Gauge', isoDaysAgo(20), [null]);
		const byHand = await addSeries(pid, 'By hand', isoDaysAgo(20), [1]);
		const theirs = await addSeries(other, 'Gauge', isoDaysAgo(20), [null]);
		await push(await newKey(pid), 'Gauge', isoDaysAgo(3), [1]);
		await push(await newKey(other), 'Gauge', isoDaysAgo(3), [1]);
		expect((await putRules(pid, [{ kind: 'data_stale', seriesId: byHand, threshold: 2, enabled: true }])).status).toBe(404);
		expect((await putRules(pid, [{ kind: 'data_stale', seriesId: theirs, threshold: 2, enabled: true }])).status).toBe(404);
		expect((await putRules(pid, [{ kind: 'data_stale', seriesId: keyed, feedId: crypto.randomUUID(), threshold: 2, enabled: true }])).status).toBe(400);
		expect((await putRules(pid, [{ kind: 'job_dead', seriesId: keyed, threshold: 1, enabled: true }])).status).toBe(400);
		// Past the route: the composite key refuses another project's series.
		await expect(
			withUser(owner.id, (db) => db.query(`INSERT INTO alert_rule (project_id, kind, series_id, threshold) VALUES ($1, 'data_stale', $2, 2)`, [pid, theirs]))
		).rejects.toMatchObject({ code: '23503' });
		// Positive control: its own key-fed series is fine; and a rule's series never changes.
		expect((await putRules(pid, [{ kind: 'data_stale', seriesId: keyed, threshold: 2, enabled: true }])).status).toBe(200);
		await expect(
			withUser(owner.id, (db) => db.query(`UPDATE alert_rule SET series_id = $2 WHERE project_id = $1 AND series_id IS NOT NULL`, [pid, byHand]))
		).rejects.toMatchObject({ code: '23514' });
		await clearJobs(pid);
		await clearJobs(other);
	});

	it('fires when the logger falls silent (by its last value, not its last stored day), mails the editors, and clears when readings resume', async () => {
		const pid = await makeProject('Logger silent');
		const sid = await addSeries(pid, 'Gauge', isoDaysAgo(30), [null]);
		const secret = await newKey(pid);
		// Readings up to 6 days ago, then blanks to yesterday: a dead sensor's blanks are not fresh data.
		await push(secret, 'Gauge', isoDaysAgo(10), [1, 1, 1, 1, 1, null, null, null, null, null]);
		const subject = 'API data behind — Logger silent';
		const before = { owner: alertMails(owner, subject).length, editor: alertMails(editor, subject).length };
		expect((await putRules(pid, [{ kind: 'data_stale', seriesId: sid, threshold: 2, enabled: true }])).status).toBe(200);
		await tick();
		const [rule] = await seriesRules(pid);
		expect(rule!.firing).toBe(true);
		// 6 days since the last value, past one (today's): 5 days late.
		const [ev] = await asOwner(`SELECT value, detail FROM alert_event WHERE rule_id = $1 AND state = 'firing'`, [rule!.id]);
		expect(ev.value).toBe(5);
		expect(ev.detail).toMatchObject({ seriesId: sid, series: true });
		const mail = alertMails(editor, subject).slice(before.editor);
		expect(mail).toHaveLength(1);
		expect(mail[0]!.text).toMatch(/Gauge: newest day .*, 5 days late/);
		expect(alertMails(owner, subject).length).toBe(before.owner + 1);
		// data_stale's audience is unchanged: editors and owners, never a viewer.
		expect(alertMails(viewer, subject)).toHaveLength(0);
		// The event names the series.
		const events = (await editor.call('GET', `/projects/${pid}/alert-events`)).body.events as { kind: string; seriesId: string | null; feedId: string | null }[];
		expect(events.find((e) => e.kind === 'data_stale')).toMatchObject({ seriesId: sid, feedId: null });
		// The logger comes back (yesterday's reading): the alert clears, and nothing more is sent.
		await push(secret, 'Gauge', isoDaysAgo(1), [1]);
		await clearJobs(pid);
		expect((await putRules(pid, [{ kind: 'data_stale', seriesId: sid, threshold: 2, enabled: true }])).status).toBe(200);
		await tick();
		expect((await seriesRules(pid))[0]!.firing).toBe(false);
		expect(alertMails(editor, subject).slice(before.editor)).toHaveLength(1);
		await clearJobs(pid);
	});

	it('a key-fed series gets its rule, on, once staleness alerts are on, and keeps it after a person writes over the key’s days (positive control: none while off)', async () => {
		const pid = await makeProject('Logger later');
		const first = await addSeries(pid, 'First', isoDaysAgo(20), [null]);
		const second = await addSeries(pid, 'Second', isoDaysAgo(20), [null]);
		const secret = await newKey(pid);
		await push(secret, 'First', isoDaysAgo(2), [1]);
		await push(secret, 'Second', isoDaysAgo(2), [1]);
		// Off: an evaluation makes no rule.
		await withUser(owner.id, (db) => evaluateAlerts(db, pid));
		expect((await seriesRules(pid)).every((r) => r.id === null)).toBe(true);
		// On for the first: the second shows on at once (what the next evaluation makes it; the editor saves every row),
		expect((await putRules(pid, [{ kind: 'data_stale', seriesId: first, threshold: 4, enabled: true }])).status).toBe(200);
		await asOwner(`DELETE FROM alert_rule WHERE project_id = $1 AND series_id = $2`, [pid, second]);
		expect((await seriesRules(pid)).map((r) => [r.seriesId, r.id !== null, r.enabled])).toEqual([
			[first, true, true],
			[second, false, true]
		]);
		// and the evaluation gives it its own rule at the default.
		await withUser(owner.id, (db) => evaluateAlerts(db, pid));
		expect((await seriesRules(pid)).map((r) => [r.seriesId, r.threshold, r.enabled, r.id !== null])).toEqual([
			[first, 4, true, true],
			[second, SERIES_STALE_ALERT_DAYS, true, true]
		]);
		// A person replaces the second series by hand: the key's days are released (053), the rule stays.
		expect((await owner.call('PUT', `/projects/${pid}/series`, { kind: 'flow_logger_m3s', name: 'Second', unit: 'm³/s', startDate: isoDaysAgo(20), values: [2] })).status).toBe(200);
		expect(await asOwner('SELECT 1 FROM series_key_days WHERE series_id = $1', [second])).toHaveLength(0);
		// …and is marked as no longer sent by a key.
		expect((await seriesRules(pid)).map((r) => [r.seriesId, r.seriesKeyFed])).toEqual([
			[first, true],
			[second, false]
		]);
		await clearJobs(pid);
	});
});

// Rule 7: the days since a series' last value count to the project's today, never UTC's or the server's.
describe('a series’ staleness by the project’s local day', () => {
	const zone = process.env.TZ;
	afterAll(() => {
		process.env.TZ = zone;
	});

	it.each(['Pacific/Kiritimati', 'Pacific/Pago_Pago'])('counts days to the project’s today at 23:30 UTC (server TZ %s; positive control: a UTC project)', async (tz) => {
		process.env.TZ = tz;
		const pid = await makeProject(`Logger local day ${tz}`);
		// The last value on 22 September. 23:30 UTC on the 25th is the 26th in South Africa: 3 days late there (26 − 22 − today's 1), 2 in UTC.
		const sid = await addSeries(pid, 'Gauge', '2026-09-20', [1, 1, 1, null]);
		await asOwner(`INSERT INTO alert_rule (project_id, kind, series_id, threshold) VALUES ($1, 'data_stale', $2, 2)`, [pid, sid]);
		const now = new Date('2026-09-25T23:30:00Z');
		const event = async () =>
			(await asOwner(`SELECT state, value FROM alert_event WHERE project_id = $1 AND kind = 'data_stale' ORDER BY opened_at DESC LIMIT 1`, [pid]))[0] as
				| { state: string; value: number }
				| undefined;
		// Positive control first: a UTC project is still on the 25th, 2 days late, not past the level.
		await asOwner(`UPDATE project SET time_zone = 'UTC' WHERE id = $1`, [pid]);
		await withUser(owner.id, (db) => evaluateAlerts(db, pid, { now }));
		expect(await event()).toBeUndefined();
		// South African (the default): the 26th, 3 days late, fires.
		await asOwner(`UPDATE project SET time_zone = DEFAULT WHERE id = $1`, [pid]);
		await withUser(owner.id, (db) => evaluateAlerts(db, pid, { now }));
		expect(await event()).toEqual({ state: 'firing', value: 3 });
		await asOwner(`DELETE FROM alert_delivery WHERE project_id = $1`, [pid]);
		await clearJobs(pid);
	});
});

describe('farms_short: automatic publications only (issue #120)', () => {
	const subject = (name: string) => `Hydrological units short of water — ${name}`;
	/** The current publication's stored shortfall counts, as the schema owner (what the run gives isn't what's under test). */
	const setRecent = (pid: string, farmsShort7: number) =>
		asOwner(`UPDATE run_publication SET catchment_view = jsonb_set(catchment_view, '{recent}', $2::jsonb) WHERE project_id = $1 AND superseded_at IS NULL`, [
			pid,
			JSON.stringify({ to: isoDaysAgo(1), from7: isoDaysAgo(7), from30: isoDaysAgo(30), farmsShort7, farmsShort30: farmsShort7 })
		]);
	const current = async (pid: string) => (await asOwner(`SELECT id, auto FROM run_publication WHERE project_id = $1 AND superseded_at IS NULL`, [pid]))[0] as { id: string; auto: boolean };
	const newRun = async (pid: string) => {
		const res = await owner.call('POST', `/projects/${pid}/runs`, { label: 'next' });
		expect(res.status).toBe(201);
		return res.body.run.id as string;
	};
	const firing = async (pid: string) => (await asOwner(`SELECT value, detail FROM alert_event WHERE project_id = $1 AND kind = 'farms_short' AND state = 'firing'`, [pid]))[0];

	it('an auto run’s publication is marked automatic; a person’s is not', async () => {
		const pid = await makeProject('Short marking', { network: true });
		expect((await owner.call('POST', `/projects/${pid}/publication`, { runId: await newRun(pid) })).status).toBe(201);
		expect((await current(pid)).auto).toBe(false);
		const runId = await newRun(pid);
		expect(await withUser(owner.id, (db) => autoPublish(db, pid, runId))).toMatchObject({ published: true });
		expect((await current(pid)).auto).toBe(true);
		// water_app may not rewrite the flag.
		await expect(withUser(owner.id, (db) => db.query('UPDATE run_publication SET auto = false WHERE project_id = $1', [pid]))).rejects.toMatchObject({ code: '42501' });
		await clearJobs(pid);
	});

	it('stays quiet on a person’s publication; fires on an automatic one with the counts only, to editors and owners; clears when a person publishes', async () => {
		const name = 'Short alerts';
		const pid = await makeProject(name, { network: true });
		expect((await owner.call('POST', `/projects/${pid}/publication`, { runId: await newRun(pid) })).status).toBe(201);
		await setRecent(pid, 2);
		const before = { owner: alertMails(owner, subject(name)).length, editor: alertMails(editor, subject(name)).length };
		expect((await putRules(pid, [{ kind: 'farms_short', threshold: 1, enabled: true }], editor)).status).toBe(200);
		await tick();
		// A person's publication: no value, no alert.
		expect(await firing(pid)).toBeUndefined();
		// Positive control: the same counts on an automatic publication fire.
		const runId = await newRun(pid);
		expect(await withUser(owner.id, (db) => autoPublish(db, pid, runId))).toMatchObject({ published: true });
		await setRecent(pid, 2);
		await clearJobs(pid);
		expect((await putRules(pid, [{ kind: 'farms_short', threshold: 1, enabled: true }], editor)).status).toBe(200);
		await tick();
		const ev = await firing(pid);
		expect(ev.value).toBe(2);
		expect(ev.detail).toMatchObject({ publicationId: (await current(pid)).id, farmsShort7: 2, of: 2 });
		const mail = alertMails(editor, subject(name)).slice(before.editor);
		expect(mail).toHaveLength(1);
		expect(mail[0]!.text).toContain('Hydrological units short of water on at least one day from');
		expect(mail[0]!.text).toContain(': 2 of 2.');
		// Counts only: no farm is named.
		for (const f of ['Farm One', 'Farm Two']) expect(mail[0]!.text).not.toContain(f);
		expect(alertMails(owner, subject(name)).length).toBe(before.owner + 1);
		// Staff only: the farmer never, a viewer only by choice.
		expect(alertMails(farmer, subject(name))).toHaveLength(0);
		expect(alertMails(viewer, subject(name))).toHaveLength(0);
		// A person publishes over it: the WUA has acted; the alert clears, without a mail.
		expect((await owner.call('POST', `/projects/${pid}/publication`, { runId: await newRun(pid) })).status).toBe(201);
		await setRecent(pid, 2);
		await tick();
		expect(await firing(pid)).toBeUndefined();
		expect(alertMails(editor, subject(name)).slice(before.editor)).toHaveLength(1);
		await clearJobs(pid);
	});

	it('gives farms_short to editors and owners, viewers by choice, and never a farmer (app_alert_recipients)', async () => {
		const pid = await makeProject('Short audience', { network: true });
		const who = async () =>
			(await withUser(owner.id, async (db) => (await db.query<{ user_id: string }>(`SELECT user_id FROM app_alert_recipients($1, 'farms_short', NULL)`, [pid])).rows))
				.map((r) => r.user_id)
				.sort();
		expect(await who()).toEqual([owner.id, editor.id].sort());
		expect((await viewer.call('PUT', `/me/alerts/${pid}`, { items: [{ kind: 'farms_short', mode: 'immediate' }] })).status).toBe(200);
		expect(await who()).toEqual([owner.id, editor.id, viewer.id].sort());
		expect((await farmer.call('PUT', `/me/alerts/${pid}`, { items: [{ kind: 'farms_short', mode: 'immediate' }] })).status).toBe(400);
		await clearJobs(pid);
	});
});
