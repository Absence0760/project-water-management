// Data feeds end to end on the fixtures (018_feeds.sql, feeds/*, the
// feed_fetch / feed_ingest handlers): RLS on data_feed with positive controls,
// the routes, a fetch merging into the series as the acting user, failures
// and health, the scheduler, the acting user losing the role, and the
// production path's ingest-results hand-off.
//
// DB test files run one at a time, so this file owns the data_feed table
// while it runs: afterEach removes every feed, so no other file's tick finds
// one due.
import { fitRecordStatus, type FitRecord } from '@water-management/engine';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

// FEED_FETCHER=sqs tests capture the fetch requests instead of sending them;
// every other test fetches inline and sends nothing.
const { sent } = vi.hoisted(() => ({ sent: [] as unknown[] }));
vi.mock('../jobs/transport.js', async (orig) => ({
	...(await orig<typeof import('../jobs/transport.js')>()),
	sendToQueue: async (_url: string | undefined, _name: string, message: unknown) => void sent.push(message)
}));
import { app, asOwner, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';
import { runTick } from '../jobs/runner.js';
import { CHIRPS_REVISION_DAYS, FEED_META_MAX_BYTES, utcToday } from './fetch.js';
import { FIXTURE_CELL } from './fixtures.js';
import { MAX_FEEDS, RUN_NOW_RATE, runNowWait } from './routes.js';
import { acceptIngestResult, scheduleDueFeeds } from './schedule.js';
import { ingestResult } from './ingest.js';
import { claimFeed, feedForJob, listDueFeeds, takeFeedFetch } from './store.js';

type User = Awaited<ReturnType<typeof signUp>>;

afterEach(async () => {
	sent.length = 0;
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	await asOwner('DELETE FROM data_feed');
	await asOwner(`DELETE FROM job WHERE kind IN ('feed_fetch', 'feed_ingest')`);
});

const cell = () => ({ ...FIXTURE_CELL(), weight: 1 });
const gefs = () => ({ source: 'chirps_gefs', config: { cells: [cell()] } });
const chirps = (over: Record<string, unknown> = {}) => ({ source: 'chirps', config: { cells: [cell()], startDate: addDays(-20) }, ...over });
const addDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
/** What a CHIRPS feed writes (the default, sat product): a series labelled so takes the feed's days without a confirmation. */
const V3 = { product: 'CHIRPS sat', productVersion: '3.0' };

async function project(owner: User, name = 'Feeds') {
	return (await owner.call('POST', '/projects', { name })).body.project.id as string;
}
async function member(owner: User, pid: string, u: User, role: 'viewer' | 'editor' | 'owner') {
	expect((await owner.call('POST', `/projects/${pid}/members`, { email: u.email, role })).status).toBe(201);
}
const feedRow = async (id: string) =>
	(await asOwner(
		`SELECT acting_user_id, created_by, last_attempt_at, last_success_at, to_char(last_data_date, 'YYYY-MM-DD') AS last_data_date, last_value,
			consecutive_failures, last_error, last_meta, last_scheduled_at FROM data_feed WHERE id = $1`,
		[id]
	))[0] as Record<string, unknown>;
const series = async (u: User, pid: string, kind: string) => {
	const list = (await u.call('GET', `/projects/${pid}/series`)).body.series as { id: string; kind: string }[];
	const meta = list.find((s) => s.kind === kind);
	return meta ? ((await u.call('GET', `/projects/${pid}/series/${meta.id}`)).body as { startDate: string; unit: string; values: (number | null)[] }) : null;
};
/** What a tick would claim: the listing, then each feed's claim as its acting user (the enqueue left out). */
async function claimDue(limit = 50, all = false) {
	const due = await withoutUser((db) => listDueFeeds(db, limit, all));
	const claimed: typeof due = [];
	for (const f of due) if (await withUser(f.actingUserId, (db) => claimFeed(db, f.id, all))) claimed.push(f);
	return claimed;
}
/**
 * Run what's queued, with no scheduling: feeds are scheduled explicitly, and
 * the alert and report schedulers would queue jobs for other files' leftover
 * rules and schedules, which the counts here would include (an
 * alerts.db.test.ts rule made "Run now" finish 2 jobs when that file ran first).
 * Jobs other files left pending are the same hazard: db-setup.ts fails the
 * file that leaves one, so the queue is empty when this file starts.
 */
const tick = () => runTick({ feeds: false, reports: false, alerts: false });

describe('data_feed RLS and the routes', () => {
	it('owners attach and change feeds; viewers read them with health; editors and strangers cannot write', async () => {
		const owner = await signUp('FeedOwner');
		const editor = await signUp('FeedEditor');
		const viewer = await signUp('FeedViewer');
		const stranger = await signUp('FeedStranger');
		const pid = await project(owner);
		await member(owner, pid, editor, 'editor');
		await member(owner, pid, viewer, 'viewer');

		const created = await owner.call('POST', `/projects/${pid}/feeds`, gefs());
		expect(created.status).toBe(201);
		expect(created.body.feed).toMatchObject({
			source: 'chirps_gefs',
			targetKind: 'rain_forecast_mm',
			targetName: '',
			enabled: true,
			schedule: 'daily',
			actingUser: 'FeedOwner',
			lastDataDate: null,
			consecutiveFailures: 0,
			health: { state: 'pending', stale: false }
		});
		const id = created.body.feed.id;

		// Positive control: the viewer reads it, and what the form offers.
		const list = await viewer.call('GET', `/projects/${pid}/feeds`);
		expect(list.status).toBe(200);
		expect(list.body.feeds.map((f: { id: string }) => f.id)).toEqual([id]);
		expect(list.body).toMatchObject({ mode: 'fixtures', canEdit: false, canRun: false, schedules: ['daily'] });
		expect(list.body.sources.map((s: { source: string }) => s.source)).toEqual(['chirps', 'chirps_gefs', 'dws']);
		expect((await owner.call('GET', `/projects/${pid}/feeds`)).body).toMatchObject({ canEdit: true, canRun: true });
		expect((await editor.call('GET', `/projects/${pid}/feeds`)).body).toMatchObject({ canEdit: false, canRun: true });

		expect((await stranger.call('GET', `/projects/${pid}/feeds`)).status).toBe(404);
		expect((await editor.call('POST', `/projects/${pid}/feeds`, chirps())).status).toBe(403);
		expect((await viewer.call('PATCH', `/projects/${pid}/feeds/${id}`, { enabled: false })).status).toBe(403);
		expect((await editor.call('DELETE', `/projects/${pid}/feeds/${id}`)).status).toBe(403);
		expect((await stranger.call('DELETE', `/projects/${pid}/feeds/${id}`)).status).toBe(404);

		// Underneath the routes, RLS says the same.
		expect((await withUser(stranger.id, (db) => db.query('SELECT id FROM data_feed WHERE id = $1', [id]))).rows).toHaveLength(0);
		await expect(
			withUser(editor.id, (db) => db.query(`INSERT INTO data_feed (project_id, source, config, target_kind) VALUES ($1, 'dws', '{"station":"X0H000"}', 'flow_observed_m3s')`, [pid]))
		).rejects.toMatchObject({ code: '42501' });
		expect((await withUser(editor.id, (db) => db.query('UPDATE data_feed SET enabled = false WHERE id = $1', [id]))).rowCount).toBe(0);
		expect((await withUser(editor.id, (db) => db.query('DELETE FROM data_feed WHERE id = $1', [id]))).rowCount).toBe(0);
		expect((await feedRow(id)).acting_user_id).toBe(owner.id);
	});

	it('an owner can’t forge health or the acting user; saving stamps the saver', async () => {
		const owner = await signUp('Forger');
		const other = await signUp('Other');
		const pid = await project(owner);
		const { rows } = await withUser(owner.id, (db) =>
			db.query(
				`INSERT INTO data_feed (project_id, source, config, target_kind, acting_user_id, created_by, last_success_at, last_data_date, consecutive_failures)
				 VALUES ($1, 'dws', '{"station":"X0H000"}', 'flow_observed_m3s', $2, $2, now(), '2030-01-01', 0) RETURNING id, acting_user_id, created_by, last_success_at, last_data_date`,
				[pid, other.id]
			)
		);
		expect(rows[0]).toMatchObject({ acting_user_id: owner.id, created_by: owner.id, last_success_at: null, last_data_date: null });
		const id = rows[0].id;
		await withUser(owner.id, (db) => db.query(`UPDATE data_feed SET last_success_at = now(), last_data_date = '2030-01-01', consecutive_failures = 0, last_error = 'x' WHERE id = $1`, [id]));
		expect(await feedRow(id)).toMatchObject({ last_success_at: null, last_data_date: null, last_error: null });
		// The health function checks the caller is an editor (a stranger is refused).
		await expect(withUser(other.id, (db) => db.query(`SELECT app_record_feed_result($1, true, '2030-01-01', 1, null, '{}')`, [id]))).rejects.toMatchObject({ code: '42501' });
	});

	it('validates input, refuses a second feed for one series (409), PATCHes a subset, and deletes', async () => {
		const owner = await signUp('Patcher');
		const pid = await project(owner);
		expect((await owner.call('POST', `/projects/${pid}/feeds`, { source: 'dws', config: { station: 'nope' } })).status).toBe(400);
		expect((await owner.call('POST', `/projects/${pid}/feeds`, { source: 'dws', config: { station: 'X0H000' }, targetKind: 'rain_chirps_mm' })).status).toBe(400);
		const a = await owner.call('POST', `/projects/${pid}/feeds`, { source: 'dws', config: { station: 'X0H000' } });
		expect(a.status).toBe(201);
		const dup = await owner.call('POST', `/projects/${pid}/feeds`, { source: 'dws', config: { station: 'X0H001' } });
		expect(dup.status).toBe(409);
		expect(dup.body.error).toBe('another feed already writes that series');
		// A different series of the same kind is fine.
		expect((await owner.call('POST', `/projects/${pid}/feeds`, { source: 'dws', config: { station: 'X0H001' }, targetName: 'Upper weir' })).status).toBe(201);

		const id = a.body.feed.id;
		// Daily only (111_feed_daily_only): hourly is a 400, on attach and on change.
		expect((await owner.call('POST', `/projects/${pid}/feeds`, { source: 'dws', config: { station: 'X0H002' }, targetName: 'Hourly', schedule: 'hourly' })).status).toBe(400);
		expect((await owner.call('PATCH', `/projects/${pid}/feeds/${id}`, { schedule: 'hourly' })).status).toBe(400);
		const off = await owner.call('PATCH', `/projects/${pid}/feeds/${id}`, { enabled: false, schedule: 'daily' });
		expect(off.status).toBe(200);
		expect(off.body.feed).toMatchObject({ enabled: false, schedule: 'daily', config: { station: 'X0H000' }, health: { state: 'disabled' } });
		// Changing the source needs a config for it.
		expect((await owner.call('PATCH', `/projects/${pid}/feeds/${id}`, { source: 'chirps' })).status).toBe(400);
		expect((await owner.call('PATCH', `/projects/${pid}/feeds/${id}`, { source: 'chirps', config: { cells: [cell()] } })).body.feed).toMatchObject({
			source: 'chirps',
			targetKind: 'rain_chirps_mm'
		});
		expect((await owner.call('PATCH', `/projects/${pid}/feeds/00000000-0000-4000-8000-000000000000`, { enabled: true })).status).toBe(404);
		expect((await owner.call('PATCH', `/projects/${pid}/feeds/not-a-uuid`, { enabled: true })).status).toBe(404);
		expect((await owner.call('DELETE', `/projects/${pid}/feeds/${id}`)).status).toBe(204);
		expect((await owner.call('DELETE', `/projects/${pid}/feeds/${id}`)).status).toBe(404);
	});
});

describe('feed routes across projects and roles', () => {
	it('a feed id from another project is 404 on every route, even to an owner of both (IDOR); the right project works (positive control)', async () => {
		const owner = await signUp('IdorOwner');
		const victim = await signUp('IdorVictim');
		const mine = await project(owner, 'Mine');
		const theirs = await project(victim, 'Theirs');
		const theirFeed = (await victim.call('POST', `/projects/${theirs}/feeds`, gefs())).body.feed.id as string;

		for (const [method, path, body] of [
			['PATCH', `/projects/${mine}/feeds/${theirFeed}`, { enabled: false }],
			['DELETE', `/projects/${mine}/feeds/${theirFeed}`, undefined],
			['POST', `/projects/${mine}/feeds/${theirFeed}/run-now`, undefined]
		] as const) {
			expect((await owner.call(method, path, body)).status, `${method} ${path}`).toBe(404);
		}
		expect((await owner.call('GET', `/projects/${mine}/feeds`)).body.feeds).toEqual([]);
		expect(await feedRow(theirFeed)).toMatchObject({ acting_user_id: victim.id, last_scheduled_at: null });
		expect((await asOwner(`SELECT count(*)::int AS n FROM job WHERE kind = 'feed_fetch' AND payload ->> 'feedId' = $1`, [theirFeed]))[0].n).toBe(0);

		// Even an owner of both projects can't move a feed from one to the other.
		await member(victim, theirs, owner, 'owner');
		expect((await owner.call('PATCH', `/projects/${mine}/feeds/${theirFeed}`, { enabled: false })).status).toBe(404);
		await withUser(owner.id, (db) => db.query('UPDATE data_feed SET project_id = $1 WHERE id = $2', [mine, theirFeed]));
		expect((await asOwner('SELECT project_id FROM data_feed WHERE id = $1', [theirFeed]))[0].project_id).toBe(theirs);
		// Positive control: through its own project it answers.
		expect((await owner.call('PATCH', `/projects/${theirs}/feeds/${theirFeed}`, { enabled: false })).status).toBe(200);
	});

	it('farmers are closed out of feeds (below viewer); "Run now" needs an editor', async () => {
		const owner = await signUp('RoleOwner');
		const editor = await signUp('RoleEditor');
		const viewer = await signUp('RoleViewer');
		const farmer = await signUp('RoleFarmer');
		const pid = await project(owner);
		await member(owner, pid, editor, 'editor');
		await member(owner, pid, viewer, 'viewer');
		await asOwner(`INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, 'farmer')`, [pid, farmer.id]);
		const id = (await owner.call('POST', `/projects/${pid}/feeds`, gefs())).body.feed.id as string;

		expect((await farmer.call('GET', `/projects/${pid}/feeds`)).status).toBe(403);
		expect((await withUser(farmer.id, (db) => db.query('SELECT id FROM data_feed WHERE project_id = $1', [pid]))).rows).toHaveLength(0);
		expect((await farmer.call('POST', `/projects/${pid}/feeds/${id}/run-now`)).status).toBe(403);
		expect((await viewer.call('POST', `/projects/${pid}/feeds/${id}/run-now`)).status).toBe(403);
		// Positive controls: the viewer reads it, the editor runs it.
		expect((await viewer.call('GET', `/projects/${pid}/feeds`)).body.feeds).toHaveLength(1);
		expect((await editor.call('POST', `/projects/${pid}/feeds/${id}/run-now`)).status).toBe(202);
	});

	it('the per-project feed cap holds under concurrent attaches', async () => {
		const owner = await signUp('CapOwner');
		const pid = await project(owner);
		const dws = (i: number) => ({ source: 'dws', config: { station: 'X0H000' }, targetName: `Gauge ${i}` });
		for (let i = 0; i < MAX_FEEDS - 2; i++) expect((await owner.call('POST', `/projects/${pid}/feeds`, dws(i))).status).toBe(201);
		const burst = await Promise.all(Array.from({ length: 8 }, (_, i) => owner.call('POST', `/projects/${pid}/feeds`, dws(100 + i))));
		expect(burst.filter((r) => r.status === 201)).toHaveLength(2);
		expect(burst.filter((r) => r.status === 409).every((r) => r.body.error === `a project can have at most ${MAX_FEEDS} feeds`)).toBe(true);
		expect((await asOwner('SELECT count(*)::int AS n FROM data_feed WHERE project_id = $1', [pid]))[0].n).toBe(MAX_FEEDS);
	});
});

describe('fetching (FEED_FETCHER=inline, FEED_SOURCE=fixtures)', () => {
	it('"Run now" queues a fetch; the tick merges the forecast into the series as the acting user and records health', async () => {
		const owner = await signUp('Runner');
		const editor = await signUp('RunEditor');
		const pid = await project(owner);
		await member(owner, pid, editor, 'editor');
		const id = (await owner.call('POST', `/projects/${pid}/feeds`, gefs())).body.feed.id;

		const run = await editor.call('POST', `/projects/${pid}/feeds/${id}/run-now`);
		expect(run.status).toBe(202);
		expect(run.body.job).toMatchObject({ kind: 'feed_fetch', status: 'queued', createdBy: 'RunEditor' });
		// One pending fetch per feed.
		expect((await owner.call('POST', `/projects/${pid}/feeds/${id}/run-now`)).body).toMatchObject({ created: false, job: { id: run.body.job.id } });

		expect((await tick()).done).toBe(1);
		const s = await series(owner, pid, 'rain_forecast_mm');
		expect(s).toMatchObject({ startDate: utcToday(), unit: 'mm' });
		expect(s!.values).toHaveLength(16);
		const feed = (await owner.call('GET', `/projects/${pid}/feeds`)).body.feeds[0];
		expect(feed).toMatchObject({ consecutiveFailures: 0, lastError: null, lastDataDate: addDays(15), health: { state: 'ok' } });
		expect(feed.lastValue).toBe(s!.values[15]);
		expect(feed.lastMeta).toMatchObject({ days: 16, issued: utcToday(), merged: 16 });
		expect((await owner.call('POST', `/projects/${pid}/feeds/${id}/run-now`)).status).toBe(202);
	});

	it('CHIRPS: never erases a day the source has no value for, and the newest date only moves forward', async () => {
		const owner = await signUp('Keeper');
		const pid = await project(owner);
		// A user-entered value on a day the fixture hasn't published yet (yesterday).
		const put = await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_chirps_mm', unit: 'mm', startDate: addDays(-1), values: [42], ...V3 });
		expect(put.status).toBe(200);
		const id = (await owner.call('POST', `/projects/${pid}/feeds`, chirps())).body.feed.id;
		await owner.call('POST', `/projects/${pid}/feeds/${id}/run-now`);
		await tick();
		const s = (await series(owner, pid, 'rain_chirps_mm'))!;
		expect(s.startDate).toBe(addDays(-20));
		// Published up to 3 days back (prelimLagDays), then the user's value two days on.
		expect(s.values.at(-1)).toBe(42);
		expect(s.values.at(-2)).toBeNull();
		expect(s.values.at(-4)).not.toBeNull();
		expect((await feedRow(id)).last_data_date).toBe(addDays(-3));
	});

	it('CHIRPS by bounding box: attaches, fetches the area mean into the series; a box over the limit is a 400 that says it', async () => {
		const owner = await signUp('Boxer');
		const pid = await project(owner);
		const big = await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { bbox: { south: -21, west: 25, north: -20, east: 26 } } });
		expect(big.status).toBe(400);
		expect(big.body.details[0]).toMatchObject({ path: ['config', 'bbox'], message: expect.stringMatching(/at most 100 of the 0\.05° grid cells in at most 25 rows/) });
		expect((await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells: [cell()], bbox: { south: -20.2, west: 25.1, north: -20.1, east: 25.2 } } })).status).toBe(400);

		// Leaving out sea cells is a box's option: listed cells stay strict.
		expect((await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells: [cell()], skipNoData: true } })).status).toBe(400);
		const bbox = { south: -20.2, west: 25.1, north: -20.1, east: 25.2 };
		const made = await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { bbox, startDate: addDays(-20) } });
		expect(made.status).toBe(201);
		expect(made.body.feed.config).toEqual({ bbox, startDate: addDays(-20) });
		await owner.call('POST', `/projects/${pid}/feeds/${made.body.feed.id}/run-now`);
		expect((await tick()).done).toBe(1);
		const s = (await series(owner, pid, 'rain_chirps_mm'))!;
		expect(s.startDate).toBe(addDays(-20));
		expect(s.values.filter((v) => v !== null).length).toBeGreaterThan(0);
		expect((await feedRow(made.body.feed.id))).toMatchObject({ consecutive_failures: 0, last_error: null, last_data_date: addDays(-3) });
	});

	it('a later fetch never re-reads before the feed’s startDate, where the series holds the owner’s own days', async () => {
		const owner = await signUp('Floor');
		const pid = await project(owner);
		// The owner's own rainfall before the feed takes over.
		expect((await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_chirps_mm', unit: 'mm', startDate: addDays(-30), values: [7, 7], ...V3 })).status).toBe(200);
		const id = (await owner.call('POST', `/projects/${pid}/feeds`, chirps())).body.feed.id;
		for (let i = 0; i < 2; i++) {
			// The second fetch has a newest day, so it re-reads revisions: not across startDate.
			await owner.call('POST', `/projects/${pid}/feeds/${id}/run-now`);
			expect((await tick()).done).toBe(1);
		}
		expect((await feedRow(id)).last_data_date).toBe(addDays(-3));
		const s = (await series(owner, pid, 'rain_chirps_mm'))!;
		expect(s.startDate).toBe(addDays(-30));
		expect(s.values.slice(0, 2)).toEqual([7, 7]);
		expect(s.values[10]).not.toBeNull(); // startDate (day -20) on is the feed's
	});

	it('a failed fetch records the reason, writes nothing, and the feed shows failing', async () => {
		const owner = await signUp('Failer');
		const pid = await project(owner);
		// The fixture grid's sea cell.
		const id = (await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps_gefs', config: { cells: [{ lat: -20.27, lon: 25.37 }] } })).body.feed.id;
		await owner.call('POST', `/projects/${pid}/feeds/${id}/run-now`);
		expect((await tick()).done).toBe(1); // the job did its work: record the failure
		expect(await series(owner, pid, 'rain_forecast_mm')).toBeNull();
		const feed = (await owner.call('GET', `/projects/${pid}/feeds`)).body.feeds[0];
		expect(feed).toMatchObject({ consecutiveFailures: 1, lastDataDate: null, health: { state: 'failing' } });
		expect(feed.lastError).toMatch(/^the source’s data could not be read: the grid has no data at -20.27, 25.37/);
		expect(feed.health.reason).toEqual({ code: 'failing', failures: 1, error: feed.lastError, newest: null });
		expect(feed.health).not.toHaveProperty('message');

		// Fixing the cell clears the failure (a new place) and the next fetch succeeds.
		await owner.call('PATCH', `/projects/${pid}/feeds/${id}`, { config: { cells: [cell()] } });
		expect(await feedRow(id)).toMatchObject({ consecutive_failures: 0, last_error: null });
		// The old place's fetch says nothing about the new one: waiting, not "ok, no data".
		expect((await owner.call('GET', `/projects/${pid}/feeds`)).body.feeds[0].health).toMatchObject({ state: 'pending', reason: { code: 'waiting' } });
		await owner.call('POST', `/projects/${pid}/feeds/${id}/run-now`);
		await tick();
		expect((await owner.call('GET', `/projects/${pid}/feeds`)).body.feeds[0].health.state).toBe('ok');
	});
});

describe('the scheduler', () => {
	it('claims due feeds once per interval, never a disabled one; p_all claims every enabled feed', async () => {
		const owner = await signUp('Scheduler');
		const pid = await project(owner);
		const on = (await owner.call('POST', `/projects/${pid}/feeds`, chirps())).body.feed.id;
		const off = (await owner.call('POST', `/projects/${pid}/feeds`, { ...chirps({ targetName: 'off' }), enabled: false })).body.feed.id;

		const first = await claimDue(50);
		expect(first.map((f) => f.id)).toEqual([on]);
		expect(first[0]).toMatchObject({ projectId: pid, actingUserId: owner.id });
		expect(await claimDue(50)).toEqual([]);
		expect((await claimDue(50, true)).map((f) => f.id)).toEqual([on]);
		expect((await feedRow(off)).last_scheduled_at).toBeNull();

		// A day later it is due again (with a minute's slack for the tick).
		await asOwner(`UPDATE data_feed SET last_scheduled_at = now() - interval '1 day' + interval '30 seconds' WHERE id = $1`, [on]);
		expect((await claimDue(50)).map((f) => f.id)).toEqual([on]);
		// A failing feed retries sooner than daily: 15 min after one failure.
		await asOwner(`UPDATE data_feed SET consecutive_failures = 1, last_scheduled_at = now() - interval '16 minutes' WHERE id = $1`, [on]);
		expect((await claimDue(50)).map((f) => f.id)).toEqual([on]);
		await expect(claimDue(0)).rejects.toMatchObject({ code: '22023' });
	});

	it('two ticks at once never claim the same feed (FOR UPDATE SKIP LOCKED), and a feed idle for days is claimed once, not once per missed day', async () => {
		const owner = await signUp('Racer');
		const pid = await project(owner);
		const ids: string[] = [];
		for (let i = 0; i < 6; i++) ids.push((await owner.call('POST', `/projects/${pid}/feeds`, { ...gefs(), targetName: `f${i}` })).body.feed.id);
		// The worker was down for five days.
		await asOwner(`UPDATE data_feed SET last_scheduled_at = now() - interval '5 days' WHERE project_id = $1`, [pid]);
		const [a, b] = await Promise.all([claimDue(50), claimDue(50)]);
		const claimed = [...a, ...b].map((f) => f.id);
		expect(claimed.sort()).toEqual([...ids].sort());
		expect(await claimDue(50)).toEqual([]);
	});

	it('the oldest-scheduled feeds go first when more are due than a tick takes', async () => {
		const owner = await signUp('Queue');
		const pid = await project(owner);
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) ids.push((await owner.call('POST', `/projects/${pid}/feeds`, { ...gefs(), targetName: `f${i}` })).body.feed.id);
		await asOwner(`UPDATE data_feed SET last_scheduled_at = now() - interval '2 days' WHERE id = $1`, [ids[0]]);
		await asOwner(`UPDATE data_feed SET last_scheduled_at = now() - interval '3 days' WHERE id = $1`, [ids[1]]);
		// ids[2] was never scheduled: first of all.
		expect((await claimDue(2)).map((f) => f.id)).toEqual([ids[2], ids[1]]);
		expect((await claimDue(2)).map((f) => f.id)).toEqual([ids[0]]);
	});

	it('a failing feed backs off 15 min × 2^(failures − 1), never beyond the day', async () => {
		const owner = await signUp('Backoff');
		const pid = await project(owner);
		const id = (await owner.call('POST', `/projects/${pid}/feeds`, chirps())).body.feed.id;
		const dueAfter = async (failures: number, minutesAgo: number) => {
			await asOwner(`UPDATE data_feed SET consecutive_failures = $2, last_scheduled_at = now() - make_interval(mins => $3) WHERE id = $1`, [id, failures, minutesAgo]);
			return (await claimDue(50)).length === 1;
		};
		// Three failures: an hour (a minute's slack for the tick).
		expect(await dueAfter(3, 55)).toBe(false);
		expect(await dueAfter(3, 60)).toBe(true);
		// Eight failures would be 32 h: capped at the day.
		expect(await dueAfter(8, 23 * 60)).toBe(false);
		expect(await dueAfter(8, 24 * 60)).toBe(true);
	});

	it('a daily CHIRPS-GEFS feed is due once the day’s 08:45 UTC has passed since it was last scheduled, in UTC whatever the session time zone (#33)', async () => {
		// The pure timing function, at fixed instants, in a session far from UTC
		// (UTC+14: its calendar day already differs from UTC's at 08:45 UTC).
		const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
		await client.connect();
		try {
			await client.query(`SET TimeZone = 'Pacific/Kiritimati'`);
			const due = async (source: string, schedule: string, failures: number, last: string | null, now: string) =>
				(await client.query<{ due: boolean }>('SELECT app_feed_is_due($1, $2, $3, $4, $5) AS due', [source, schedule, failures, last, now])).rows[0]!.due;
			// Fetched at 06:00 UTC (yesterday's issue): not due at 08:40, due at 08:45.
			expect(await due('chirps_gefs', 'daily', 0, '2026-03-01T06:00:00Z', '2026-03-01T08:40:00Z')).toBe(false);
			expect(await due('chirps_gefs', 'daily', 0, '2026-03-01T06:00:00Z', '2026-03-01T08:45:00Z')).toBe(true);
			// Fetched after today's issue: not due again until tomorrow's 08:45, however late today it is.
			expect(await due('chirps_gefs', 'daily', 0, '2026-03-01T08:46:00Z', '2026-03-01T23:59:00Z')).toBe(false);
			expect(await due('chirps_gefs', 'daily', 0, '2026-03-01T08:46:00Z', '2026-03-02T08:44:00Z')).toBe(false);
			expect(await due('chirps_gefs', 'daily', 0, '2026-03-01T08:46:00Z', '2026-03-02T08:45:00Z')).toBe(true);
			// Just after midnight UTC, the latest slot is yesterday's.
			expect(await due('chirps_gefs', 'daily', 0, '2026-03-01T08:50:00Z', '2026-03-02T00:10:00Z')).toBe(false);
			expect(await due('chirps_gefs', 'daily', 0, '2026-03-01T08:40:00Z', '2026-03-02T00:10:00Z')).toBe(true);
			// Never scheduled: due at once.
			expect(await due('chirps_gefs', 'daily', 0, null, '2026-03-01T03:00:00Z')).toBe(true);
			// Failing: the backoff still applies (one failure, 15 min).
			expect(await due('chirps_gefs', 'daily', 1, '2026-03-01T09:00:00Z', '2026-03-01T09:13:00Z')).toBe(false);
			expect(await due('chirps_gefs', 'daily', 1, '2026-03-01T09:00:00Z', '2026-03-01T09:14:00Z')).toBe(true);
			// Positive controls: other feeds keep the day-after rule.
			expect(await due('chirps', 'daily', 0, '2026-03-01T06:00:00Z', '2026-03-01T08:45:00Z')).toBe(false);
			expect(await due('chirps', 'daily', 0, '2026-03-01T06:00:00Z', '2026-03-02T05:59:00Z')).toBe(true);
			// No hourly interval any more (111): whatever p_schedule says, the day's rule holds.
			expect(await due('chirps', 'hourly', 0, '2026-03-01T06:00:00Z', '2026-03-01T07:30:00Z')).toBe(false);
			expect(await due('chirps_gefs', 'hourly', 0, '2026-03-01T06:00:00Z', '2026-03-01T08:40:00Z')).toBe(false);
			expect(await due('chirps_gefs', 'hourly', 0, '2026-03-01T06:00:00Z', '2026-03-01T08:45:00Z')).toBe(true);
		} finally {
			await client.end();
		}

		// And the scheduler uses it: a GEFS feed last scheduled just before the
		// latest 08:45 UTC is due; one scheduled since is not.
		const owner = await signUp('Gefs');
		const pid = await project(owner);
		const id = (await owner.call('POST', `/projects/${pid}/feeds`, gefs())).body.feed.id;
		const latestSlot = `(SELECT CASE WHEN s <= now() THEN s ELSE s - interval '1 day' END
			FROM (SELECT (date_trunc('day', now() AT TIME ZONE 'UTC') + interval '8 hours 45 minutes') AT TIME ZONE 'UTC' AS s) x)`;
		await asOwner(`UPDATE data_feed SET last_scheduled_at = ${latestSlot} - interval '1 minute' WHERE id = $1`, [id]);
		expect((await claimDue()).map((f) => f.id)).toEqual([id]);
		expect(await claimDue()).toEqual([]);
	});

	it('a feed is claimed only by its acting user (positive control: the acting user claims it)', async () => {
		const owner = await signUp('Claimer');
		const other = await signUp('NotActing');
		const pid = await project(owner);
		await member(owner, pid, other, 'owner');
		const id = (await owner.call('POST', `/projects/${pid}/feeds`, chirps())).body.feed.id;
		expect(await withUser(other.id, (db) => claimFeed(db, id))).toBe(false);
		expect(await withoutUser((db) => claimFeed(db, id))).toBe(false);
		expect((await feedRow(id)).last_scheduled_at).toBeNull();
		expect(await withUser(owner.id, (db) => claimFeed(db, id))).toBe(true);
		expect(await withUser(owner.id, (db) => claimFeed(db, id))).toBe(false); // claimed: not due until tomorrow
	});

	it('scheduling a feed whose fetch is already waiting ("Run now") adds no second job', async () => {
		const owner = await signUp('Dedupe');
		const pid = await project(owner);
		const id = (await owner.call('POST', `/projects/${pid}/feeds`, gefs())).body.feed.id;
		expect((await owner.call('POST', `/projects/${pid}/feeds/${id}/run-now`)).status).toBe(202);
		expect(await scheduleDueFeeds()).toEqual({ queued: 1, refused: 0 });
		expect((await asOwner(`SELECT count(*)::int AS n FROM job WHERE kind = 'feed_fetch' AND project_id = $1`, [pid]))[0].n).toBe(1);
	});

	it('a tick queues and runs due feeds end to end (dev:feeds:run is this with every feed)', async () => {
		const owner = await signUp('Ticker');
		const pid = await project(owner);
		const id = (await owner.call('POST', `/projects/${pid}/feeds`, { source: 'dws', config: { station: 'X0H000', startDate: addDays(-400) } })).body.feed.id;
		const r = await runTick({ allFeeds: true });
		expect(r.feeds).toEqual({ queued: 1, refused: 0 });
		expect(r.done).toBeGreaterThanOrEqual(1);
		const s = (await series(owner, pid, 'flow_observed_m3s'))!;
		expect(s.unit).toBe('m³/s'); // as the Data tab's upload writes it (frontend series/kinds.ts)
		expect(s.startDate).toBe(addDays(-400));
		expect((await feedRow(id)).last_data_date).toBe(addDays(-90));
	});

	it('when the acting owner lost the editor role: the feed shows failing and nothing is written (positive control: a new save runs as the saver)', async () => {
		const a = await signUp('OwnerA');
		const b = await signUp('OwnerB');
		const pid = await project(a);
		await member(a, pid, b, 'owner');
		const id = (await a.call('POST', `/projects/${pid}/feeds`, gefs())).body.feed.id;
		// A job A queued before losing the role fails closed too.
		const queued = await a.call('POST', `/projects/${pid}/feeds/${id}/run-now`);
		expect((await b.call('PATCH', `/projects/${pid}/members/${a.id}`, { role: 'viewer' })).status).toBe(200);
		await tick();
		const [job] = await asOwner('SELECT status, last_error FROM job WHERE id = $1', [queued.body.job.id]);
		expect(job).toMatchObject({ status: 'dead', last_error: 'the user who queued this job no longer has the editor role on the project' });

		expect(await scheduleDueFeeds()).toEqual({ queued: 0, refused: 1 });
		expect(await series(b, pid, 'rain_forecast_mm')).toBeNull();
		const feed = (await b.call('GET', `/projects/${pid}/feeds`)).body.feeds[0];
		expect(feed).toMatchObject({ actingUser: 'OwnerA', consecutiveFailures: 1, health: { state: 'failing' } });
		expect(feed.lastError).toMatch(/can no longer edit the project/);

		// B saves the feed: B is now its acting user, and it runs.
		await b.call('PATCH', `/projects/${pid}/feeds/${id}`, { enabled: true });
		expect((await feedRow(id)).acting_user_id).toBe(b.id);
		await asOwner('UPDATE data_feed SET last_scheduled_at = NULL WHERE id = $1', [id]);
		expect(await scheduleDueFeeds()).toEqual({ queued: 1, refused: 0 });
		await tick();
		expect((await series(b, pid, 'rain_forecast_mm'))!.values).toHaveLength(16);
	});

	it('an enqueue that fails partway through a tick leaves no feed claimed without a job (#32)', async () => {
		const owner = await signUp('Blip');
		const pid = await project(owner);
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) ids.push((await owner.call('POST', `/projects/${pid}/feeds`, chirps({ targetName: `f${i}` }))).body.feed.id);
		// A database blip on the second feed's job insert (not an RLS refusal).
		await asOwner(`CREATE FUNCTION test_job_blip() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
			BEGIN
				IF NEW.payload ->> 'feedId' = '${ids[1]}' THEN RAISE EXCEPTION 'blip' USING ERRCODE = '08006'; END IF;
				RETURN NEW;
			END $$`);
		await asOwner('CREATE TRIGGER test_job_blip BEFORE INSERT ON job FOR EACH ROW EXECUTE FUNCTION test_job_blip()');
		try {
			await expect(scheduleDueFeeds()).rejects.toMatchObject({ code: '08006' });
		} finally {
			await asOwner('DROP TRIGGER test_job_blip ON job; DROP FUNCTION test_job_blip()');
		}
		// Every feed either has its fetch queued or is still due.
		const jobs = async () =>
			(await asOwner(`SELECT payload ->> 'feedId' AS id FROM job WHERE kind = 'feed_fetch' AND project_id = $1`, [pid])).map((r) => r.id as string).sort();
		for (const id of ids) {
			const queued = (await jobs()).includes(id);
			expect(queued || (await feedRow(id)).last_scheduled_at === null, id).toBe(true);
		}
		expect(await jobs()).toEqual([ids[0], ids[2]].sort()); // the others weren't held up by the blip
		// The next tick queues what the blip missed, and nothing twice.
		expect(await scheduleDueFeeds()).toEqual({ queued: 1, refused: 0 });
		expect(await jobs()).toEqual([...ids].sort());
	});

	it('a feed whose acting user deleted their account is kept but skipped until an owner saves it', async () => {
		const a = await signUp('Leaver');
		const b = await signUp('Stayer');
		const pid = await project(b);
		await member(b, pid, a, 'owner');
		const id = (await a.call('POST', `/projects/${pid}/feeds`, gefs())).body.feed.id;
		await asOwner('DELETE FROM app_user WHERE id = $1', [a.id]);
		expect(await feedRow(id)).toMatchObject({ acting_user_id: null });
		expect(await claimDue(50)).toEqual([]);
		expect((await b.call('GET', `/projects/${pid}/feeds`)).body.feeds[0].actingUser).toBeNull();
	});
});

describe('the production hand-off (FEED_FETCHER=sqs: fetch-requests → fetcher → ingest-results → feed_ingest)', () => {
	type FetchMsg = { fetchJobId: string; feedId: string; feedVersion: string; request: { start: string; end: string } };
	/** Run the queued feed_fetch the production way: it records its window on the feed and sends the request (captured). */
	async function runFetchJob(): Promise<FetchMsg> {
		vi.stubEnv('FEED_FETCHER', 'sqs');
		vi.stubEnv('FETCH_REQUESTS_QUEUE_URL', 'https://sqs.test/fetch-requests');
		sent.length = 0;
		expect((await tick()).done).toBe(1);
		vi.unstubAllEnvs();
		expect(sent).toHaveLength(1);
		return sent[0] as FetchMsg;
	}
	async function fetchJob(over: Record<string, unknown> = {}) {
		const owner = await signUp('Ingester');
		const pid = await project(owner);
		const feedId = (await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells: [cell()] }, ...over })).body.feed.id as string;
		await owner.call('POST', `/projects/${pid}/feeds/${feedId}/run-now`);
		const m = await runFetchJob();
		return { owner, pid, feedId, jobId: m.fetchJobId, version: m.feedVersion, window: { start: m.request.start, end: m.request.end } };
	}
	/** Days from the first the fetch asked for. */
	const result = (o: { window: { start: string } }, values: (number | null)[] = [1.5, null, 2.5]) => ({ ok: true, startDate: o.window.start, values, meta: { days: values.length } });
	const msg = (o: { feedId: string; jobId: string; version: string }, r: unknown) => ({ v: 1 as const, type: 'ingest' as const, fetchJobId: o.jobId, feedId: o.feedId, feedVersion: o.version, result: r });
	const plus = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

	it('queues a feed_ingest job as the fetch job’s user, which merges the days and records how far it read', async () => {
		const o = await fetchJob();
		expect(o.window).toEqual({ start: addDays(-60), end: addDays(-1) });
		expect(await acceptIngestResult(msg(o, result(o)))).toBe('queued');
		// A redelivered message while the first waits is the same job.
		expect(await acceptIngestResult(msg(o, result(o)))).toBe('queued');
		expect((await asOwner(`SELECT count(*)::int AS n FROM job WHERE kind = 'feed_ingest' AND project_id = $1`, [o.pid]))[0].n).toBe(1);
		await tick();
		expect((await series(o.owner, o.pid, 'rain_chirps_mm'))!.values).toEqual([1.5, null, 2.5]);
		expect(await feedRow(o.feedId)).toMatchObject({ last_data_date: plus(o.window.start, 2), last_value: 2.5, consecutive_failures: 0, last_meta: { through: o.window.end } });
	});

	it('refuses a message that names another feed’s job, or no job', async () => {
		const o = await fetchJob();
		const p = await fetchJob();
		expect(await acceptIngestResult(msg({ ...o, feedId: p.feedId }, result(o)))).toBe('unknown_fetch');
		expect(await acceptIngestResult(msg({ ...o, jobId: '00000000-0000-4000-8000-000000000000' }, result(o)))).toBe('unknown_fetch');
	});

	it('records an invalid result as a failed fetch, writing nothing', async () => {
		const o = await fetchJob();
		await acceptIngestResult(msg(o, { ok: true, startDate: o.window.start, values: [-5], meta: {} }));
		await tick();
		expect(await series(o.owner, o.pid, 'rain_chirps_mm')).toBeNull();
		expect(await feedRow(o.feedId)).toMatchObject({ consecutive_failures: 1, last_error: 'the fetcher’s answer was not valid, so nothing was written' });
	});

	it('a result whose meta passes the key and length limits but not the column’s 4 KB is refused as invalid, not a failing job', async () => {
		const o = await fetchJob();
		// 20 keys of 40 characters and values of 100, each character two bytes in UTF-8: ~5.7 KB of JSON.
		const meta = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`${String(i).padStart(2, '0')}${'é'.repeat(38)}`, 'é'.repeat(100)]));
		await acceptIngestResult(msg(o, { ...result(o), meta }));
		await tick();
		expect(await series(o.owner, o.pid, 'rain_chirps_mm')).toBeNull();
		expect(await feedRow(o.feedId)).toMatchObject({ consecutive_failures: 1, last_error: 'the fetcher’s answer was not valid, so nothing was written' });
		expect((await asOwner(`SELECT status FROM job WHERE kind = 'feed_ingest' AND project_id = $1`, [o.pid]))[0].status).toBe('done');
	});

	it('the largest meta FetchResult accepts fits the column, with the merged count and how far it read added (positive control)', async () => {
		const o = await fetchJob();
		// 20 keys of 40 characters, values of two-byte characters as long as the byte limit allows.
		const fill = (n: number) => Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`${String(i).padStart(2, '0')}${'k'.repeat(38)}`, 'é'.repeat(n)]));
		let n = 100;
		while (new TextEncoder().encode(JSON.stringify(fill(n))).length > FEED_META_MAX_BYTES) n--;
		const meta = fill(n);
		expect(new TextEncoder().encode(JSON.stringify(meta)).length).toBeLessThanOrEqual(FEED_META_MAX_BYTES);
		expect(new TextEncoder().encode(JSON.stringify(meta)).length).toBeGreaterThan(FEED_META_MAX_BYTES - 100);
		await acceptIngestResult(msg(o, { ...result(o), meta }));
		await tick();
		expect(await feedRow(o.feedId)).toMatchObject({ consecutive_failures: 0, last_data_date: plus(o.window.start, 2), last_meta: { through: o.window.end } });
	});

	it('drops a result for a feed saved with new settings since the fetch', async () => {
		const o = await fetchJob();
		await acceptIngestResult(msg(o, result(o)));
		await o.owner.call('PATCH', `/projects/${o.pid}/feeds/${o.feedId}`, { config: { cells: [cell(), cell()] } });
		await tick();
		expect(await series(o.owner, o.pid, 'rain_chirps_mm')).toBeNull();
		expect(await feedRow(o.feedId)).toMatchObject({ last_attempt_at: null });
	});

	// Issue #31: ingest-results can redeliver and reorder.
	it('drops a late answer to an older fetch once a newer fetch has been sent, whatever order the answers come in', async () => {
		const o = await fetchJob();
		await o.owner.call('POST', `/projects/${o.pid}/feeds/${o.feedId}/run-now`);
		const newer = await runFetchJob();
		expect(newer.fetchJobId).not.toBe(o.jobId);

		// The newer fetch's answer (final values), then the older one's (preliminary, higher).
		await acceptIngestResult(msg({ ...o, jobId: newer.fetchJobId }, result(o, [5, 5, 5])));
		await tick();
		const applied = await feedRow(o.feedId);
		await acceptIngestResult(msg(o, result(o, [9, 9, 9])));
		await tick();
		expect((await series(o.owner, o.pid, 'rain_chirps_mm'))!.values).toEqual([5, 5, 5]);
		// Nor does it touch the feed's health.
		expect(await feedRow(o.feedId)).toEqual(applied);

		// The other order: an older fetch's answer arriving before the newer one's is dropped too.
		await o.owner.call('POST', `/projects/${o.pid}/feeds/${o.feedId}/run-now`);
		const third = await runFetchJob();
		await o.owner.call('POST', `/projects/${o.pid}/feeds/${o.feedId}/run-now`);
		const fourth = await runFetchJob();
		await acceptIngestResult(msg({ ...o, jobId: third.fetchJobId }, result(o, [1, 1, 1])));
		await tick();
		expect((await series(o.owner, o.pid, 'rain_chirps_mm'))!.values).toEqual([5, 5, 5]);
		// Positive control: the newest fetch's answer applies.
		await acceptIngestResult(msg({ ...o, jobId: fourth.fetchJobId }, result(o, [6, 6, 6])));
		await tick();
		expect((await series(o.owner, o.pid, 'rain_chirps_mm'))!.values).toEqual([6, 6, 6]);
	});

	it('applies an answer once: a redelivery after it was applied changes nothing, not even the attempt time', async () => {
		const o = await fetchJob();
		await acceptIngestResult(msg(o, result(o, [2, 2])));
		await tick();
		const applied = await feedRow(o.feedId);
		// The owner corrects a day after the answer was applied.
		await o.owner.call('PUT', `/projects/${o.pid}/series`, { kind: 'rain_chirps_mm', unit: 'mm', startDate: o.window.start, values: [7, 7] });
		// The same message again, after the first feed_ingest finished (so not deduplicated as pending).
		expect(await acceptIngestResult(msg(o, result(o, [2, 2])))).toBe('queued');
		await tick();
		expect(await feedRow(o.feedId)).toEqual(applied);
		expect((await series(o.owner, o.pid, 'rain_chirps_mm'))!.values).toEqual([7, 7]);
	});

	it('refuses an answer with days outside the window the fetch asked for: a failed fetch, nothing written', async () => {
		for (const [label, startDate, values] of [
			['a day before the window', addDays(-61), [1, 1]],
			// Today is a day CHIRPS could have (latestDay), but the fetch asked only up to yesterday.
			['a day after the window', addDays(-2), [1, 1, 1]]
		] as const) {
			const o = await fetchJob();
			await acceptIngestResult(msg(o, { ok: true, startDate, values: [...values], meta: { days: values.length } }));
			await tick();
			expect(await series(o.owner, o.pid, 'rain_chirps_mm'), label).toBeNull();
			expect(await feedRow(o.feedId), label).toMatchObject({
				consecutive_failures: 1,
				last_data_date: null,
				last_error: `the fetcher’s answer had days outside ${o.window.start} to ${o.window.end}, the days it was asked for, so nothing was written`
			});
		}
		// Positive control: the window's own first and last days.
		const o = await fetchJob();
		await acceptIngestResult(msg(o, { ok: true, startDate: o.window.start, values: new Array(60).fill(1), meta: { days: 60 } }));
		await tick();
		expect(await feedRow(o.feedId)).toMatchObject({ consecutive_failures: 0, last_data_date: o.window.end });
	});

	// Issue #69: a final CHIRPS value is never revised, so the next window starts after the final days.
	it('keeps the answer’s final marker, and the next fetch starts after it (positive control: without one it re-reads 50 days)', async () => {
		const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
		const o = await fetchJob();
		await acceptIngestResult(msg(o, { ...result(o, values), meta: { days: 10, finalThrough: plus(o.window.start, 4) } }));
		await tick();
		expect((await feedRow(o.feedId)).last_meta).toMatchObject({ through: o.window.end, finalThrough: plus(o.window.start, 4) });
		await o.owner.call('POST', `/projects/${o.pid}/feeds/${o.feedId}/run-now`);
		const next = await runFetchJob();
		// It says which of those days the feed holds (the newest), so their preliminary values aren't read again.
		expect(next.request).toEqual(expect.objectContaining({ start: plus(o.window.start, 5), end: o.window.end, heldThrough: plus(o.window.start, 9) }));
		// That fetch finds nothing final: the marker it started after stands.
		await acceptIngestResult(msg({ ...o, jobId: next.fetchJobId }, { ok: true, startDate: next.request.start, values: [6, 7], meta: { days: 2 } }));
		await tick();
		expect((await feedRow(o.feedId)).last_meta).toMatchObject({ finalThrough: plus(o.window.start, 4) });

		const p = await fetchJob();
		await acceptIngestResult(msg(p, result(p, values)));
		await tick();
		expect((await feedRow(p.feedId)).last_meta).not.toHaveProperty('finalThrough');
		await p.owner.call('POST', `/projects/${p.pid}/feeds/${p.feedId}/run-now`);
		expect((await runFetchJob()).request).toMatchObject({ start: plus(p.window.start, 9 - CHIRPS_REVISION_DAYS), end: p.window.end });
	});

	it('ignores a forged final marker: a day past the answer’s values, before the window, or over a gap is never stored', async () => {
		for (const forged of [(o: { window: { start: string; end: string } }) => o.window.end, (o: { window: { start: string } }) => plus(o.window.start, -1), (o: { window: { start: string } }) => plus(o.window.start, 3)]) {
			const o = await fetchJob();
			// Four values and a gap on the fourth day: no claim past the third day holds.
			await acceptIngestResult(msg(o, { ...result(o, [1, 2, 3, null, 5]), meta: { days: 5, finalThrough: forged(o) } }));
			await tick();
			const row = await feedRow(o.feedId);
			expect(row).toMatchObject({ consecutive_failures: 0, last_data_date: plus(o.window.start, 4) });
			expect(row.last_meta).not.toHaveProperty('finalThrough');
			await o.owner.call('POST', `/projects/${o.pid}/feeds/${o.feedId}/run-now`);
			// The re-read as without a marker, from the newest day.
			expect((await runFetchJob()).request.start).toBe(plus(o.window.start, 4 - CHIRPS_REVISION_DAYS));
		}
	});

	it('on the fixtures: the first fetch marks the final days, the next reads only after them, and a new place starts again', async () => {
		const owner = await signUp('Finals');
		const pid = await project(owner);
		const feedId = (await owner.call('POST', `/projects/${pid}/feeds`, chirps({ config: { cells: [cell()], startDate: addDays(-60) } }))).body.feed.id as string;
		await owner.call('POST', `/projects/${pid}/feeds/${feedId}/run-now`);
		expect((await tick()).done).toBe(1); // inline, from the fixtures: final up to 40 days back, preliminary to 3
		expect(await feedRow(feedId)).toMatchObject({ last_data_date: addDays(-3), last_meta: { finalThrough: addDays(-40), prelimDays: 37 } });
		const before = (await series(owner, pid, 'rain_chirps_mm'))!;
		// The next inline fetch reads nothing it holds: the preliminary days stay as they are, still counted, and the newest day stands.
		await owner.call('POST', `/projects/${pid}/feeds/${feedId}/run-now`);
		expect((await tick()).done).toBe(1);
		expect(await series(owner, pid, 'rain_chirps_mm')).toEqual(before);
		expect(await feedRow(feedId)).toMatchObject({ consecutive_failures: 0, last_data_date: addDays(-3), last_meta: { days: 0, prelimDays: 37, finalThrough: addDays(-40) } });
		await owner.call('POST', `/projects/${pid}/feeds/${feedId}/run-now`);
		expect((await runFetchJob()).request).toMatchObject({ start: addDays(-39), end: addDays(-1), heldThrough: addDays(-3) });
		// Another place: the marker says nothing about it (data_feed_stamp clears last_meta).
		await owner.call('PATCH', `/projects/${pid}/feeds/${feedId}`, { config: { cells: [cell(), cell()], startDate: addDays(-60) } });
		expect((await feedRow(feedId)).last_meta).toBeNull();
		await owner.call('POST', `/projects/${pid}/feeds/${feedId}/run-now`);
		expect((await runFetchJob()).request).toMatchObject({ start: addDays(-60), end: addDays(-1) });
	});

	it('a hole in the series inside what the feed read is read again and filled: held days end at the first empty one', async () => {
		const owner = await signUp('Holes');
		const pid = await project(owner);
		const feedId = (await owner.call('POST', `/projects/${pid}/feeds`, chirps({ config: { cells: [cell()], startDate: addDays(-60) } }))).body.feed.id as string;
		await owner.call('POST', `/projects/${pid}/feeds/${feedId}/run-now`);
		expect((await tick()).done).toBe(1);
		const full = (await series(owner, pid, 'rain_chirps_mm'))!;
		// Day -20 (preliminary on the fixtures) loses its value: the newest day is still -3, but -20 isn't held.
		const i = 40;
		expect(full.startDate).toBe(addDays(-60));
		expect(full.values[i]).not.toBeNull();
		await asOwner(`UPDATE time_series SET "values"[$2] = NULL WHERE project_id = $1 AND kind = 'rain_chirps_mm'`, [pid, i + 1]);
		await owner.call('POST', `/projects/${pid}/feeds/${feedId}/run-now`);
		expect((await runFetchJob()).request).toMatchObject({ start: addDays(-39), heldThrough: addDays(-21) });
		// The inline fetch reads it again from the preliminary product and fills it.
		await owner.call('POST', `/projects/${pid}/feeds/${feedId}/run-now`);
		expect((await tick()).done).toBe(1);
		expect((await series(owner, pid, 'rain_chirps_mm'))!.values).toEqual(full.values);
		expect(await feedRow(feedId)).toMatchObject({ last_data_date: addDays(-3), last_meta: { prelimDays: 37, finalThrough: addDays(-40) } });
	});

	it('an rnl feed never sends heldThrough: it has no preliminary days (positive control: a sat feed holding the same days does)', async () => {
		for (const product of ['rnl', 'sat'] as const) {
			const o = await fetchJob({ config: { cells: [cell()], product } });
			// The first day final: the next window starts on the second, which the series holds.
			await acceptIngestResult(msg(o, { ...result(o, [1, 2, 3]), meta: { days: 3, finalThrough: o.window.start } }));
			await tick();
			await o.owner.call('POST', `/projects/${o.pid}/feeds/${o.feedId}/run-now`);
			const next = await runFetchJob();
			expect(next.request.start).toBe(plus(o.window.start, 1));
			if (product === 'rnl') expect(next.request).not.toHaveProperty('heldThrough');
			else expect(next.request).toMatchObject({ heldThrough: plus(o.window.start, 2) });
		}
	});

	it('while a confirmed replacement stages, the held days are the stage’s; once the live series stops conflicting, the live series’', async () => {
		const owner = await signUp('StageHeld');
		const pid = await project(owner);
		await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_chirps_mm', unit: 'mm', startDate: addDays(-150), values: [1, 2, 3], product: 'CHIRPS', productVersion: '2.0' });
		const feedId = (await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells: [cell()] }, replaceSeries: true })).body.feed.id as string;
		await owner.call('POST', `/projects/${pid}/feeds/${feedId}/run-now`);
		expect((await tick()).done).toBe(1); // window 1 (120 days) staged, inline from the fixtures
		await owner.call('POST', `/projects/${pid}/feeds/${feedId}/run-now`);
		// The live series holds v2.0 there, but the answer goes to the stage, which holds every day through -31.
		expect((await runFetchJob()).request).toMatchObject({ start: addDays(-39), heldThrough: addDays(-31) });
		// The live series emptied: it no longer conflicts, so the ingest merges into it, and it holds none of those days.
		await asOwner(`UPDATE time_series SET "values" = array_fill(NULL::double precision, ARRAY[3]) WHERE project_id = $1 AND kind = 'rain_chirps_mm'`, [pid]);
		await owner.call('POST', `/projects/${pid}/feeds/${feedId}/run-now`);
		expect((await runFetchJob()).request).not.toHaveProperty('heldThrough');
	});

	// Issue #29: a DWS backfill starting before the station's record re-read the same empty window forever.
	it('an empty answer records how far it read, so the next fetch moves past the empty stretch', async () => {
		const o = await fetchJob({ source: 'dws', config: { station: 'X0H000', startDate: '1960-01-01' }, targetKind: 'flow_observed_m3s' });
		expect(o.window).toEqual({ start: '1960-01-01', end: '1979-12-26' });
		// Nothing before the station opened.
		await acceptIngestResult(msg(o, { ok: true, startDate: null, values: [], meta: { days: 0, gaps: 0 } }));
		await tick();
		expect(await feedRow(o.feedId)).toMatchObject({ last_data_date: null, consecutive_failures: 0, last_meta: { through: '1979-12-26' } });
		await o.owner.call('POST', `/projects/${o.pid}/feeds/${o.feedId}/run-now`);
		// A year of overlap before the last day read, not back to 1960.
		expect((await runFetchJob()).request).toMatchObject({ start: '1978-12-27', end: '1998-12-21' });
	});

	it('a startDate in the future asks for no days: the fetch still goes out, an empty answer is fine and any day is refused', async () => {
		const o = await fetchJob({ config: { cells: [cell()], startDate: addDays(10) } });
		expect(o.window).toEqual({ start: addDays(10), end: addDays(-1) });
		await acceptIngestResult(msg(o, { ok: true, startDate: null, values: [], meta: { days: 0 } }));
		await tick();
		expect(await feedRow(o.feedId)).toMatchObject({ consecutive_failures: 0, last_error: null, last_meta: { days: 0, merged: 0 } });
		await o.owner.call('POST', `/projects/${o.pid}/feeds/${o.feedId}/run-now`);
		const next = await runFetchJob();
		await acceptIngestResult(msg({ ...o, jobId: next.fetchJobId }, { ok: true, startDate: addDays(-2), values: [1], meta: { days: 1 } }));
		await tick();
		expect(await series(o.owner, o.pid, 'rain_chirps_mm')).toBeNull();
		expect(await feedRow(o.feedId)).toMatchObject({ consecutive_failures: 1 });
	});

	it('only the running fetch job of that feed, as its user, can record a window; an owner can’t write one directly', async () => {
		const o = await fetchJob();
		const other = await signUp('NotAMember');
		const begin = (uid: string) => withUser(uid, (db) => db.query(`SELECT app_begin_feed_fetch($1, $2, '2026-01-01', '2026-01-02')`, [o.feedId, o.jobId]));
		// The fetch job has finished: it isn't running any more.
		await expect(begin(o.owner.id)).rejects.toMatchObject({ code: '42501' });
		await expect(begin(other.id)).rejects.toMatchObject({ code: '42501' });
		await expect(withUser(other.id, (db) => db.query('SELECT * FROM app_take_feed_fetch($1, $2)', [o.feedId, o.jobId]))).rejects.toMatchObject({ code: '42501' });
		await withUser(o.owner.id, (db) => db.query(`UPDATE data_feed SET fetch_job_id = gen_random_uuid(), fetch_start = '1900-01-01', fetch_end = '2100-01-01' WHERE id = $1`, [o.feedId]));
		const row = (await asOwner(`SELECT fetch_job_id, to_char(fetch_start, 'YYYY-MM-DD') AS s, to_char(fetch_end, 'YYYY-MM-DD') AS e FROM data_feed WHERE id = $1`, [o.feedId]))[0];
		// Positive control: what the fetch job recorded stands.
		expect(row).toEqual({ fetch_job_id: o.jobId, s: o.window.start, e: o.window.end });
	});

	it('two ingests of one answer at once: the second waits for the first, then finds it applied', async () => {
		const o = await fetchJob();
		let taken!: () => void;
		let commit!: () => void;
		const firstHasTaken = new Promise<void>((r) => (taken = r));
		const firstMayCommit = new Promise<void>((r) => (commit = r));
		const first = withUser(o.owner.id, async (db) => {
			const w = await takeFeedFetch(db, o.feedId, o.jobId);
			taken();
			await firstMayCommit;
			return w;
		});
		await firstHasTaken;
		let secondDone = false;
		const second = withUser(o.owner.id, (db) => takeFeedFetch(db, o.feedId, o.jobId)).finally(() => (secondDone = true));
		const waiting = async () => (await asOwner('SELECT 1 FROM pg_locks WHERE NOT granted')).length > 0;
		await expect.poll(async () => secondDone || (await waiting()), { timeout: 10_000 }).toBe(true);
		commit();
		expect(await first).toEqual(o.window);
		expect(await second).toBeNull();
	});
});

describe('ingest: how a fetch result becomes the series (feeds/ingest.ts → series/merge.ts mergeSeries)', () => {
	const WIDE = { start: '1850-01-01', end: utcToday() };
	/** A feed of a fresh project; `ingest` applies a result as the job does, as its acting user. */
	async function setup(name: string, over: Record<string, unknown> = {}) {
		const owner = await signUp(name);
		const pid = await project(owner);
		const id = (await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells: [cell()] }, ...over })).body.feed.id as string;
		// A window wide enough for every day these tests write; the window check has its own tests.
		const ingest = (raw: unknown, window = WIDE) => withUser(owner.id, async (db) => ingestResult(db, (await feedForJob(db, pid, id))!, raw, window));
		return { owner, pid, id, ingest };
	}
	const ok = (startDate: string, values: (number | null)[], meta: Record<string, string | number> = { days: values.length }) => ({ ok: true, startDate, values, meta });
	const seriesMeta = async (u: User, pid: string, kind: string) =>
		((await u.call('GET', `/projects/${pid}/series`)).body.series as { kind: string; name: string; updatedAt: string }[]).find((s) => s.kind === kind && s.name === '');

	it('is idempotent: the same result twice leaves the values and the series’ updatedAt as they were', async () => {
		const { owner, pid, id, ingest } = await setup('Twice');
		expect(await ingest(ok('2026-01-01', [1, null, 3]))).toEqual({ merged: 2, lastDate: '2026-01-03' });
		const first = (await seriesMeta(owner, pid, 'rain_chirps_mm'))!;
		const health = await feedRow(id);
		expect(await ingest(ok('2026-01-01', [1, null, 3]))).toEqual({ merged: 2, lastDate: '2026-01-03' });
		// updatedAt means "the values last changed" (the Runs tab's "new data since the last run"), so
		// re-reading an unchanged window, which CHIRPS does every day (its revision window), must not bump it.
		expect(await seriesMeta(owner, pid, 'rain_chirps_mm')).toEqual(first);
		expect((await series(owner, pid, 'rain_chirps_mm'))!.values).toEqual([1, null, 3]);
		// The fetch itself still counts: its attempt is recorded.
		const again = await feedRow(id);
		expect(again).toMatchObject({ last_data_date: '2026-01-03', last_value: 3, consecutive_failures: 0 });
		expect((again.last_attempt_at as Date).getTime()).toBeGreaterThan((health.last_attempt_at as Date).getTime());
		// Positive control: a revised value changes the series and its updatedAt.
		await ingest(ok('2026-01-02', [2]));
		expect((await seriesMeta(owner, pid, 'rain_chirps_mm'))!.updatedAt > first.updatedAt).toBe(true);
		expect((await series(owner, pid, 'rain_chirps_mm'))!.values).toEqual([1, 2, 3]);
	});

	it('a coastal box (skipNoData): a later fetch with another count of cells with data is refused and writes nothing; the same count merges', async () => {
		// Four cells, one of them the fixture's sea.
		const bbox = { south: -20.3, west: 25.3, north: -20.2, east: 25.4 };
		const { owner, pid, id, ingest } = await setup('Coast', { config: { bbox, skipNoData: true } });
		expect(await ingest(ok('2026-01-01', [1, 2], { days: 2, cellsUsed: 3 }))).toEqual({ merged: 2, lastDate: '2026-01-02' });
		expect((await feedRow(id)).last_meta).toMatchObject({ cellsUsed: 3 });
		// An empty answer read no day: the count carries forward.
		await ingest({ ok: true, startDate: null, values: [], meta: { days: 0 } });
		expect((await feedRow(id)).last_meta).toMatchObject({ cellsUsed: 3 });
		// Positive control: the same count merges.
		expect(await ingest(ok('2026-01-03', [3], { days: 1, cellsUsed: 3 }))).toEqual({ merged: 1, lastDate: '2026-01-03' });

		// A land cell lost its data between fetches: refused, nothing written, the count kept.
		expect(await ingest(ok('2026-01-04', [9], { days: 1, cellsUsed: 2 }))).toEqual({ merged: 0, lastDate: null });
		const refused = await feedRow(id);
		expect(refused).toMatchObject({ consecutive_failures: 1, last_data_date: '2026-01-03', last_meta: expect.objectContaining({ cellsUsed: 3 }) });
		expect(refused.last_error).toMatch(/data in 2 of the box’s cells, not 3 as before, so nothing was written.*save the box again/);
		expect((await series(owner, pid, 'rain_chirps_mm'))!.values).toEqual([1, 2, 3]);
		// A count the box can't have, or none with days, is an invalid answer.
		expect(await ingest(ok('2026-01-04', [9], { days: 1, cellsUsed: 5 }))).toEqual({ merged: 0, lastDate: null });
		expect(await ingest(ok('2026-01-04', [9], { days: 1 }))).toEqual({ merged: 0, lastDate: null });
		expect((await feedRow(id)).last_error).toBe('the fetcher’s answer was not valid, so nothing was written');

		// Saving the box again resets the count (data_feed_stamp clears last_meta on a config change): the way out.
		expect((await owner.call('PATCH', `/projects/${pid}/feeds/${id}`, { config: { bbox: { ...bbox, north: -20.21 }, skipNoData: true } })).status).toBe(200);
		expect((await feedRow(id)).last_meta).toBeNull();
		expect(await ingest(ok('2026-01-04', [4], { days: 1, cellsUsed: 2 }))).toEqual({ merged: 1, lastDate: '2026-01-04' });
		expect((await feedRow(id)).last_meta).toMatchObject({ cellsUsed: 2 });
	});

	it('records no cellsUsed for a feed that doesn’t leave out sea cells, whatever the fetcher says', async () => {
		const { id, ingest } = await setup('NoCount');
		await ingest(ok('2026-01-01', [1], { days: 1, cellsUsed: 7 }));
		expect((await feedRow(id)).last_meta).not.toHaveProperty('cellsUsed');
	});

	it('writes nothing when the transaction fails after the merge: the merge and the health commit together', async () => {
		const { owner, pid, id, ingest } = await setup('Atomic');
		await expect(
			withUser(owner.id, async (db) => {
				await ingestResult(db, (await feedForJob(db, pid, id))!, ok('2026-01-01', [1, 2]), WIDE);
				throw new Error('the job failed after the merge');
			})
		).rejects.toThrow('the job failed after the merge');
		expect(await series(owner, pid, 'rain_chirps_mm')).toBeNull();
		expect(await feedRow(id)).toMatchObject({ last_attempt_at: null, last_data_date: null });
		// Positive control: the same ingest, committed, writes both.
		await ingest(ok('2026-01-01', [1, 2]));
		expect((await series(owner, pid, 'rain_chirps_mm'))!.values).toEqual([1, 2]);
		expect(await feedRow(id)).toMatchObject({ last_data_date: '2026-01-02' });
	});

	it('a merge the series can’t take (past 60 000 days) is a recorded failure that leaves the series whole', async () => {
		const { owner, pid, id, ingest } = await setup('TooLong');
		expect((await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_chirps_mm', unit: 'mm', startDate: '1850-01-01', values: [7], ...V3 })).status).toBe(200);
		expect(await ingest(ok('2026-01-01', [1]))).toEqual({ merged: 0, lastDate: null });
		expect(await series(owner, pid, 'rain_chirps_mm')).toMatchObject({ startDate: '1850-01-01', values: [7] });
		expect(await feedRow(id)).toMatchObject({
			consecutive_failures: 1,
			last_data_date: null,
			last_error: 'the series could not take the new days: series would exceed 60000 days'
		});
	});

	it('a result the database would refuse (meta too many bytes, a NUL) is recorded as invalid, not a job that dies retrying', async () => {
		const { owner, pid, id, ingest } = await setup('Bytes');
		// Within the per-field limits (20 keys of 40 and values of 100 characters) but in 3-byte
		// characters: ~8.5 KB of JSON against last_meta's 4 KB CHECK.
		const wide = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`${i}`.padEnd(40, '€'), ''.padEnd(100, '€')]));
		await ingest(ok('2026-01-01', [1], wide));
		expect(await series(owner, pid, 'rain_chirps_mm')).toBeNull();
		expect(await feedRow(id)).toMatchObject({ consecutive_failures: 1, last_error: 'the fetcher’s answer was not valid, so nothing was written' });
		// Postgres refuses U+0000 in text and in jsonb.
		await ingest(ok('2026-01-01', [1], { note: 'a\u0000b' }));
		await ingest({ ok: false, error: 'bad\u0000byte' });
		expect(await series(owner, pid, 'rain_chirps_mm')).toBeNull();
		expect(await feedRow(id)).toMatchObject({ consecutive_failures: 3, last_error: 'the fetcher’s answer was not valid, so nothing was written' });
		// Positive control: an ordinary result goes through.
		await ingest(ok('2026-01-01', [1], { days: 1, issued: '2026-01-01' }));
		expect((await series(owner, pid, 'rain_chirps_mm'))!.values).toEqual([1]);
	});

	/** The feed-days columns (031_feed_days) of a project's default-named series of `kind`. */
	const feedDaysOf = async (pid: string, kind: string) =>
		(await asOwner(`SELECT feed_id, feed_days::text AS feed_days FROM time_series WHERE project_id = $1 AND kind = $2 AND name = ''`, [pid, kind]))[0] as {
			feed_id: string | null;
			feed_days: string | null;
		};
	/** Run `fn` under time zones either side of UTC (rule 7): the days are calendar dates, never shifted. */
	async function inZones(fn: () => Promise<void>) {
		const tz = process.env.TZ;
		try {
			for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
				process.env.TZ = zone; // UTC+14, UTC-11
				await fn();
			}
		} finally {
			process.env.TZ = tz;
		}
	}

	it('user-entered days: the feed keeps the user’s values and fills only empty days (#30), a gap never erases one, another series is untouched', async () => {
		// Until 031_feed_days a feed replaced the user's value on every day it fetched.
		const { owner, pid, id, ingest } = await setup('UserData');
		await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_chirps_mm', unit: 'mm', startDate: '2026-01-01', values: [10, null, 30, 40], ...V3 });
		// (Labelled the feed's own version, so the version guard lets the feed write here: 032.)
		// The user's own record under another name: a feed writes only the series it targets.
		await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_chirps_mm', name: 'My gauge', unit: 'mm', startDate: '2026-01-01', values: [5, 5, 5] });
		expect(await ingest(ok('2025-12-31', [0, 1, 2, 3, null, 5]))).toEqual({ merged: 3, lastDate: '2026-01-05' });
		expect(await series(owner, pid, 'rain_chirps_mm')).toMatchObject({ startDate: '2025-12-31', values: [0, 10, 2, 30, 40, 5] });
		// Only the days it wrote are the feed's.
		expect(await feedDaysOf(pid, 'rain_chirps_mm')).toEqual({ feed_id: id, feed_days: '{[2025-12-31,2026-01-01),[2026-01-02,2026-01-03),[2026-01-05,2026-01-06)}' });
		expect((await feedRow(id)).last_meta).toMatchObject({ days: 6, merged: 3, kept: 2 });
		// And the panel says so.
		expect((await owner.call('GET', `/projects/${pid}/feeds`)).body.feeds[0].lastMeta).toMatchObject({ kept: 2 });
		// A second fetch still keeps them.
		expect(await ingest(ok('2026-01-01', [7, 7, 7]))).toEqual({ merged: 1, lastDate: '2026-01-03' });
		expect((await series(owner, pid, 'rain_chirps_mm'))!.values).toEqual([0, 10, 7, 30, 40, 5]);
		const list = (await owner.call('GET', `/projects/${pid}/series`)).body.series as { id: string; name: string }[];
		const mine = list.find((s) => s.name === 'My gauge')!;
		expect((await owner.call('GET', `/projects/${pid}/series/${mine.id}`)).body).toMatchObject({ startDate: '2026-01-01', values: [5, 5, 5] });
	});

	it('its own days: final replaces preliminary, a re-fetch revises, a gap keeps the day (positive control for #30)', async () => {
		const { owner, pid, id, ingest } = await setup('Revise');
		expect(await ingest(ok('2026-01-01', [1, 2, 3], { days: 3, prelimDays: 3 }))).toEqual({ merged: 3, lastDate: '2026-01-03' });
		expect(await ingest(ok('2026-01-01', [1.5, null, 3.5], { days: 3, prelimDays: 0 }))).toEqual({ merged: 2, lastDate: '2026-01-03' });
		expect((await series(owner, pid, 'rain_chirps_mm'))!.values).toEqual([1.5, 2, 3.5]);
		expect((await feedRow(id)).last_meta).toMatchObject({ merged: 2, kept: 0 });
		// The gap's day is still the feed's: a later revision replaces it.
		expect(await ingest(ok('2026-01-02', [2.5]))).toEqual({ merged: 1, lastDate: '2026-01-02' });
		expect((await series(owner, pid, 'rain_chirps_mm'))!.values).toEqual([1.5, 2.5, 3.5]);
		expect(await feedDaysOf(pid, 'rain_chirps_mm')).toEqual({ feed_id: id, feed_days: '{[2026-01-01,2026-01-04)}' });
	});

	it('a user’s upload over the feed’s days wins from then on, even with the same value, whatever the time zone', async () => {
		await inZones(async () => {
			const { owner, pid, id, ingest } = await setup('UserWins');
			await ingest(ok('2026-01-01', [1, 2, 3, 4]));
			// A merge of one day, the same value as the feed's on another.
			expect((await owner.call('POST', `/projects/${pid}/series/merge`, { kind: 'rain_chirps_mm', unit: 'mm', startDate: '2026-01-02', values: [20, 3] })).status).toBe(200);
			expect(await feedDaysOf(pid, 'rain_chirps_mm')).toEqual({ feed_id: id, feed_days: '{[2026-01-01,2026-01-02),[2026-01-04,2026-01-05)}' });
			expect(await ingest(ok('2026-01-01', [9, 9, 9, 9]))).toEqual({ merged: 2, lastDate: '2026-01-04' });
			expect((await series(owner, pid, 'rain_chirps_mm'))!.values).toEqual([9, 20, 3, 9]);
			expect((await feedRow(id)).last_meta).toMatchObject({ merged: 2, kept: 2 });
			// Replacing the whole series makes every day the user's. (Said to be the feed's own
			// version: a PUT that doesn't say records none, and the feed would then refuse it, 032.)
			expect(
				(await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_chirps_mm', unit: 'mm', startDate: '2026-01-01', values: [5, 5, 5, 5], ...V3 })).status
			).toBe(200);
			expect(await feedDaysOf(pid, 'rain_chirps_mm')).toEqual({ feed_id: null, feed_days: null });
			expect(await ingest(ok('2026-01-01', [8, 8, 8, 8, 8]))).toEqual({ merged: 1, lastDate: '2026-01-05' });
			expect((await series(owner, pid, 'rain_chirps_mm'))!.values).toEqual([5, 5, 5, 5, 8]);
		});
	});

	it('writes the source’s unit and the exact days whatever the server’s time zone, keeping the user’s day', async () => {
		await inZones(async () => {
			const { owner, pid, id, ingest } = await setup('Zoned', { source: 'dws', config: { station: 'X0H000' } });
			await owner.call('PUT', `/projects/${pid}/series`, { kind: 'flow_observed_m3s', unit: 'm3/s', startDate: '2026-03-01', values: [9] });
			expect(await ingest(ok('2026-02-27', [1.25, null, 2.5, null]))).toEqual({ merged: 1, lastDate: '2026-03-01' });
			expect(await series(owner, pid, 'flow_observed_m3s')).toMatchObject({ startDate: '2026-02-27', unit: 'm³/s', values: [1.25, null, 9, null] });
			// last_value is the source's newest value, whether or not the series kept its own.
			expect(await feedRow(id)).toMatchObject({ last_data_date: '2026-03-01', last_value: 2.5, last_meta: { kept: 1 } });
		});
	});

	it('removing a feed keeps the days it wrote (as the remove dialog says), as ordinary data the next feed keeps', async () => {
		const { owner, pid, id, ingest } = await setup('Remover');
		await ingest(ok('2026-01-01', [1, 2]));
		expect((await feedDaysOf(pid, 'rain_chirps_mm')).feed_id).toBe(id);
		expect((await owner.call('DELETE', `/projects/${pid}/feeds/${id}`)).status).toBe(204);
		expect(await series(owner, pid, 'rain_chirps_mm')).toMatchObject({ startDate: '2026-01-01', values: [1, 2] });
		expect(await feedDaysOf(pid, 'rain_chirps_mm')).toEqual({ feed_id: null, feed_days: null });
		// A new feed on the same series fills after them and keeps them.
		const next = (await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells: [cell()] } })).body.feed.id as string;
		expect(await withUser(owner.id, async (db) => ingestResult(db, (await feedForJob(db, pid, next))!, ok('2026-01-01', [7, 7, 7]), WIDE))).toEqual({
			merged: 1,
			lastDate: '2026-01-03'
		});
		expect((await series(owner, pid, 'rain_chirps_mm'))!.values).toEqual([1, 2, 7]);
	});

	it('re-targeting a feed hands its days in the old series back; it writes the new one as its own', async () => {
		const { owner, pid, id, ingest } = await setup('Retarget');
		await ingest(ok('2026-01-01', [1, 2]));
		expect((await owner.call('PATCH', `/projects/${pid}/feeds/${id}`, { targetName: 'CHIRPS' })).status).toBe(200);
		expect(await feedDaysOf(pid, 'rain_chirps_mm')).toEqual({ feed_id: null, feed_days: null });
		// Positive control: saving without a new target keeps them.
		const { id: id2, pid: pid2, ingest: ingest2, owner: owner2 } = await setup('NoRetarget');
		await ingest2(ok('2026-01-01', [1, 2]));
		expect((await owner2.call('PATCH', `/projects/${pid2}/feeds/${id2}`, { enabled: false })).status).toBe(200);
		expect((await feedDaysOf(pid2, 'rain_chirps_mm')).feed_id).toBe(id2);
		// The re-targeted feed writes its new series and owns those days.
		await ingest(ok('2026-01-01', [3]));
		const [row] = await asOwner(`SELECT feed_id, feed_days::text AS feed_days FROM time_series WHERE project_id = $1 AND name = 'CHIRPS'`, [pid]);
		expect(row).toEqual({ feed_id: id, feed_days: '{[2026-01-01,2026-01-02)}' });
	});

	it('the series list marks a fed series with its feed and how many days are still the feed’s (the Data tab’s mark); none is null', async () => {
		const { owner, pid, ingest } = await setup('Marked');
		const viewer = await signUp('MarkViewer');
		await member(owner, pid, viewer, 'viewer');
		await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_chirps_mm', name: 'My gauge', unit: 'mm', startDate: '2026-01-01', values: [5, 5] });
		const listed = async (u: User, name = '') =>
			((await u.call('GET', `/projects/${pid}/series`)).body.series as { name: string; feed: unknown }[]).find((s) => s.name === name)!.feed;
		// A gap is no day of the feed's: three of the four.
		await ingest(ok('2026-01-01', [1, null, 3, 4]));
		expect(await listed(owner)).toEqual({ source: 'chirps', days: 3 });
		// Any viewer reads it (data_feed_select), and a single series' GET carries it too.
		expect(await listed(viewer)).toEqual({ source: 'chirps', days: 3 });
		const fedId = ((await owner.call('GET', `/projects/${pid}/series`)).body.series as { id: string; name: string }[]).find((s) => s.name === '')!.id;
		expect((await viewer.call('GET', `/projects/${pid}/series/${fedId}`)).body.feed).toEqual({ source: 'chirps', days: 3 });
		// No feed wrote the user's own series.
		expect(await listed(owner, 'My gauge')).toBeNull();
		// A user's merge takes the days it sends; the count follows.
		expect((await owner.call('POST', `/projects/${pid}/series/merge`, { kind: 'rain_chirps_mm', unit: 'mm', startDate: '2026-01-03', values: [30] })).status).toBe(200);
		expect(await listed(owner)).toEqual({ source: 'chirps', days: 2 });
		// An API key can't read data_feed (below viewer): its merge answer says null rather than failing,
		// and the key's day is not the feed's (positive control: the owner still sees the feed's two).
		const secret = (await owner.call('POST', `/projects/${pid}/api-keys`, { name: 'Logger' })).body.secret as string;
		const r = await app.request('/ingest/v1/series/merge', {
			method: 'POST',
			headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
			body: JSON.stringify({ kind: 'rain_chirps_mm', unit: 'mm', startDate: '2026-01-06', values: [6] })
		});
		const answer = (await r.json()) as { series: { feed: unknown; rebuilding: boolean } };
		expect(r.status, JSON.stringify(answer)).toBe(200);
		expect(answer.series).toMatchObject({ feed: null, rebuilding: false });
		expect(await listed(owner)).toEqual({ source: 'chirps', days: 2 });
		// Once the user has written over every day the feed wrote, no day is its own: no mark.
		expect((await owner.call('POST', `/projects/${pid}/series/merge`, { kind: 'rain_chirps_mm', unit: 'mm', startDate: '2026-01-01', values: [10, null, null, 40] })).status).toBe(200);
		expect(await feedDaysOf(pid, 'rain_chirps_mm')).toEqual({ feed_id: null, feed_days: null });
		expect(await listed(owner)).toBeNull();
	});

	it('a feed’s days are only ever a feed of the same project (composite foreign key)', async () => {
		const { pid, ingest } = await setup('SameProject');
		const { id: other } = await setup('OtherProject');
		await ingest(ok('2026-01-01', [1]));
		await expect(asOwner(`UPDATE time_series SET feed_id = $2 WHERE project_id = $1`, [pid, other])).rejects.toThrow(/time_series_feed_fkey/);
	});

	it('refuses an answer with days the source can’t have yet, which would otherwise pin the newest date in the future', async () => {
		const { owner, pid, id, ingest } = await setup('Future');
		await ingest(ok(addDays(-2), [1, 2]));
		// Today and tomorrow: tomorrow can't exist yet.
		expect(await ingest(ok(addDays(0), [3, 4]))).toEqual({ merged: 0, lastDate: null });
		expect(await series(owner, pid, 'rain_chirps_mm')).toMatchObject({ startDate: addDays(-2), values: [1, 2] });
		expect(await feedRow(id)).toMatchObject({
			last_data_date: addDays(-1),
			consecutive_failures: 1,
			last_error: `the fetcher’s answer had days after ${utcToday()}, so nothing was written`
		});
		// Positive control: up to today is fine.
		expect(await ingest(ok(addDays(-1), [3, 4]))).toEqual({ merged: 2, lastDate: addDays(0) });
		expect(await feedRow(id)).toMatchObject({ last_data_date: addDays(0), consecutive_failures: 0 });
	});

	it('a forecast may reach its sixteenth day, not a day further', async () => {
		const { owner, pid, id, ingest } = await setup('Horizon', gefs());
		// A whole issue dated tomorrow (a wrong clock) reaches a day past today's sixteenth.
		expect(await ingest(ok(addDays(1), new Array(16).fill(1), { days: 16, issued: addDays(1) }))).toEqual({ merged: 0, lastDate: null });
		expect(await series(owner, pid, 'rain_forecast_mm')).toBeNull();
		expect((await feedRow(id)).last_error).toBe(`the fetcher’s answer had days after ${addDays(15)}, so nothing was written`);
		expect(await ingest(ok(utcToday(), new Array(16).fill(1), { days: 16, issued: utcToday() }))).toEqual({ merged: 16, lastDate: addDays(15) });
	});

	it('an empty window (the source had nothing) is a success that writes nothing and keeps the newest date', async () => {
		const { owner, pid, id, ingest } = await setup('Empty');
		await ingest(ok('2026-01-01', [1, 2]));
		expect(await ingest({ ok: true, startDate: null, values: [], meta: { days: 0 } })).toEqual({ merged: 0, lastDate: null });
		expect(await ingest(ok('2026-01-05', [null, null]))).toEqual({ merged: 0, lastDate: null });
		expect(await series(owner, pid, 'rain_chirps_mm')).toMatchObject({ startDate: '2026-01-01', values: [1, 2] });
		expect(await feedRow(id)).toMatchObject({ last_data_date: '2026-01-02', last_value: 2, consecutive_failures: 0, last_error: null, last_meta: { days: 2, merged: 0 } });
		// An older window never moves the newest date back.
		await ingest(ok('2025-12-01', [4]));
		expect(await feedRow(id)).toMatchObject({ last_data_date: '2026-01-02', last_value: 2 });
	});
});

// Issue #40 part c: a CHIRPS feed writes one product and version (CHIRPS sat
// v3.0 by default), and never splices it onto a series holding another.
describe('the CHIRPS version guard (032_series_provenance)', () => {
	const V2 = { product: 'CHIRPS', productVersion: '2.0' };
	/** A project whose CHIRPS series holds three days of v2.0, as a b023 import leaves it. */
	async function withV2(name: string) {
		const owner = await signUp(name);
		const pid = await project(owner);
		const put = await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_chirps_mm', unit: 'mm', startDate: '2001-01-01', values: [1, 2, 3], ...V2 });
		expect(put.body).toMatchObject({ product: 'CHIRPS', productVersion: '2.0' });
		return { owner, pid, seriesId: put.body.id as string };
	}
	const chirpsLabel = async (pid: string) =>
		(await asOwner(`SELECT product, product_version FROM time_series WHERE project_id = $1 AND kind = 'rain_chirps_mm' AND name = ''`, [pid]))[0];

	it('a new feed labels the series it creates with what it writes', async () => {
		const owner = await signUp('Labeller');
		const pid = await project(owner);
		const id = (await owner.call('POST', `/projects/${pid}/feeds`, chirps())).body.feed.id;
		await owner.call('POST', `/projects/${pid}/feeds/${id}/run-now`);
		await tick();
		expect(await chirpsLabel(pid)).toEqual({ product: 'CHIRPS sat', product_version: '3.0' });
		// Caught up (its window reached yesterday): no next window is queued.
		expect(await asOwner(`SELECT id FROM job WHERE kind = 'feed_fetch' AND payload->>'feedId' = $1 AND status = 'queued'`, [id])).toEqual([]);
		const feed = (await owner.call('GET', `/projects/${pid}/feeds`)).body.feeds[0];
		expect(feed).toMatchObject({ writes: { product: 'CHIRPS sat', version: '3.0' }, series: { filled: true }, versionConflict: false, replaceFrom: null });
	});

	it('refuses to attach a feed to a series of another version, or an unrecorded one, without a confirmation; nothing is created', async () => {
		const { owner, pid } = await withV2('Refuser');
		const res = await owner.call('POST', `/projects/${pid}/feeds`, chirps());
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/^the series holds CHIRPS v2\.0 rainfall and this feed writes CHIRPS sat v3\.0/);
		expect(res.body.details).toMatchObject({ code: 'series_version', holds: { product: 'CHIRPS', version: '2.0' }, writes: { product: 'CHIRPS sat', version: '3.0' } });
		expect((await owner.call('GET', `/projects/${pid}/feeds`)).body.feeds).toEqual([]);
		// The rnl product is another forcing too, not a fix for it.
		expect((await owner.call('POST', `/projects/${pid}/feeds`, chirps({ config: { cells: [cell()], product: 'rnl' } }))).status).toBe(409);
		// An unrecorded version with values is asked about as well …
		expect((await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_chirps_mm', name: 'Old', unit: 'mm', startDate: '2001-01-01', values: [1] })).status).toBe(200);
		const unrecorded = await owner.call('POST', `/projects/${pid}/feeds`, chirps({ targetName: 'Old' }));
		expect(unrecorded.status).toBe(409);
		expect(unrecorded.body.error).toMatch(/holds an unrecorded version rainfall/);
		// … and positive controls: a series of the same version, an empty one, and another name all attach.
		expect((await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_chirps_mm', name: 'Same', unit: 'mm', startDate: '2001-01-01', values: [1], ...V3 })).status).toBe(200);
		expect((await owner.call('POST', `/projects/${pid}/feeds`, chirps({ targetName: 'Same' }))).status).toBe(201);
		expect((await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_chirps_mm', name: 'Blank', unit: 'mm', startDate: '2001-01-01', values: [null] })).status).toBe(200);
		expect((await owner.call('POST', `/projects/${pid}/feeds`, chirps({ targetName: 'Blank' }))).status).toBe(201);
		expect((await owner.call('POST', `/projects/${pid}/feeds`, chirps({ targetName: 'CHIRPS v3' }))).status).toBe(201);
		// A person saying what the unrecorded one is (PATCH …/series/:id) is enough when it matches.
		const old = ((await owner.call('GET', `/projects/${pid}/series`)).body.series as { id: string; name: string }[]).find((s) => s.name === 'Old')!;
		expect((await owner.call('PATCH', `/projects/${pid}/series/${old.id}`, V3)).body).toMatchObject({ product: 'CHIRPS sat', productVersion: '3.0' });
		expect((await owner.call('POST', `/projects/${pid}/feeds`, chirps({ targetName: 'Old' }))).status).toBe(201);
	});

	it('refuses every fetch into a series that became another version after the feed attached: nothing written, the failure says why', async () => {
		const owner = await signUp('LateV2');
		const pid = await project(owner);
		const id = (await owner.call('POST', `/projects/${pid}/feeds`, chirps())).body.feed.id;
		// The workbook's v2 column arrives after the feed was set up.
		await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_chirps_mm', unit: 'mm', startDate: '2001-01-01', values: [1, 2, 3], ...V2 });
		await owner.call('POST', `/projects/${pid}/feeds/${id}/run-now`);
		expect((await tick()).done).toBe(1);
		expect(await series(owner, pid, 'rain_chirps_mm')).toMatchObject({ startDate: '2001-01-01', values: [1, 2, 3] });
		expect(await chirpsLabel(pid)).toEqual({ product: 'CHIRPS', product_version: '2.0' });
		expect(await feedRow(id)).toMatchObject({
			consecutive_failures: 1,
			last_data_date: null,
			last_error:
				'the series holds CHIRPS v2.0 rainfall and this feed writes CHIRPS sat v3.0, so nothing was written: an owner must confirm replacing the series, or point the feed at another one'
		});
		const feed = (await owner.call('GET', `/projects/${pid}/feeds`)).body.feeds[0];
		expect(feed).toMatchObject({ versionConflict: true, replaceFrom: null, series: { filled: true, provenance: { product: 'CHIRPS', version: '2.0' } } });
		// A save that doesn't touch where or what the feed writes is still allowed (and still refused at fetch time).
		expect((await owner.call('PATCH', `/projects/${pid}/feeds/${id}`, { enabled: true })).status).toBe(200);
	});

	it('a replacement is a full backfill: a start date after the series’ first day is refused, and none gets that day', async () => {
		const { owner, pid } = await withV2('Backfill');
		const later = await owner.call('POST', `/projects/${pid}/feeds`, { ...chirps(), replaceSeries: true });
		expect(later.status).toBe(409);
		expect(later.body).toMatchObject({ error: expect.stringMatching(/start date must be 2001-01-01 or earlier/), details: { code: 'series_backfill', firstDay: '2001-01-01' } });
		const confirm = await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells: [cell()] }, replaceSeries: true });
		expect(confirm.status).toBe(201);
		expect(confirm.body.feed).toMatchObject({ versionConflict: true, replaceFrom: 'CHIRPS/2.0', config: { startDate: '2001-01-01' } });
	});

	it('the confirmed path is staged: runs keep the whole old series while it backfills, then it swaps in atomically, kept as a restorable revision, and flags the fit', async () => {
		const owner = await signUp('Replacer');
		const pid = await project(owner);
		// A v2 record from 150 days ago: the backfill takes two windows (120 days, then the rest to yesterday).
		const first = addDays(-150);
		const put = await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_chirps_mm', unit: 'mm', startDate: first, values: [1, 2, 3], ...V2 });
		const seriesId = put.body.id as string;
		const id = (await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells: [cell()] }, replaceSeries: true })).body.feed.id;
		await owner.call('POST', `/projects/${pid}/feeds/${id}/run-now`);
		expect((await tick()).done).toBe(1);

		// Window 1 is staged. The live series, its label, and what a run would read are all the old record, whole.
		expect(await series(owner, pid, 'rain_chirps_mm')).toMatchObject({ startDate: first, values: [1, 2, 3] });
		expect(await chirpsLabel(pid)).toEqual({ product: 'CHIRPS', product_version: '2.0' });
		const during = (await owner.call('GET', `/projects/${pid}/model-input`)).body.input;
		expect(during.series.rain_chirps_mm).toEqual({
			startDate: first,
			values: [1, 2, 3],
			provenance: { product: 'CHIRPS', version: '2.0' },
			// The upload's source and given unit (107): none said, in mm.
			origin: { source: null, unit: 'mm', factor: 1 }
		});
		const [stage] = await asOwner(`SELECT to_char(start_date, 'YYYY-MM-DD') AS start, cardinality("values") AS n, product, product_version FROM feed_stage WHERE feed_id = $1`, [id]);
		expect(stage).toEqual({ start: first, n: 120, product: 'CHIRPS sat', product_version: '3.0' });
		// Progress is visible, on the feed and on the series, and says it is rebuilding, not "old data".
		const feed = (await owner.call('GET', `/projects/${pid}/feeds`)).body.feeds[0];
		expect(feed).toMatchObject({
			versionConflict: true,
			replaceFrom: 'CHIRPS/2.0',
			rebuilding: { startDate: first, through: addDays(-31) },
			health: { state: 'pending', reason: { code: 'rebuilding', from: first, through: addDays(-31) } },
			// The staged days are final up to 40 days back (the fixtures), so window 2 starts after them (#69).
			lastMeta: { staged: 120, finalThrough: addDays(-40) }
		});
		const listed = (await owner.call('GET', `/projects/${pid}/series`)).body.series[0];
		expect(listed).toMatchObject({ kind: 'rain_chirps_mm', rebuilding: true, product: 'CHIRPS' });
		// No revision or series event yet: nothing has changed in the series.
		expect(await asOwner(`SELECT id FROM series_revision WHERE project_id = $1 AND reason = 'feed_replace'`, [pid])).toEqual([]);
		// The backfill goes on a window at a time (a minute apart), not a window a day; Run now pulls it forward.
		const pending = () => asOwner(`SELECT run_after > now() AS later FROM job WHERE kind = 'feed_fetch' AND payload->>'feedId' = $1 AND status = 'queued'`, [id]);
		expect(await pending()).toEqual([{ later: true }]);
		const again = await owner.call('POST', `/projects/${pid}/feeds/${id}/run-now`);
		expect(again).toMatchObject({ status: 200, body: { created: false } });
		expect(await pending()).toEqual([{ later: false }]);
		expect((await tick()).done).toBe(1);

		// Window 2 reached yesterday: the stage swapped in whole, in its version, and is gone.
		const s = (await series(owner, pid, 'rain_chirps_mm'))!;
		expect(s.startDate).toBe(first);
		expect(s.values.length).toBeGreaterThanOrEqual(147);
		expect(s.values.slice(0, 120).every((v) => v !== null)).toBe(true);
		expect(await chirpsLabel(pid)).toEqual({ product: 'CHIRPS sat', product_version: '3.0' });
		expect(await asOwner('SELECT feed_id FROM feed_stage WHERE feed_id = $1', [id])).toEqual([]);
		expect((await asOwner('SELECT replace_series_from FROM data_feed WHERE id = $1', [id]))[0]).toEqual({ replace_series_from: null });
		// Every day of the swapped-in record is the feed's own (031_feed_days), so its later re-reads still revise them.
		const [days] = await asOwner(`SELECT feed_id, feed_days::text AS feed_days FROM time_series WHERE project_id = $1 AND kind = 'rain_chirps_mm' AND name = ''`, [pid]);
		expect(days).toEqual({ feed_id: id, feed_days: `{[${first},${addDays(-150 + s.values.length)})}` });
		expect(await feedRow(id)).toMatchObject({ consecutive_failures: 0, last_error: null, last_data_date: addDays(-3), last_meta: { replaced: 'CHIRPS v2.0', finalThrough: addDays(-40) } });
		expect(await pending()).toEqual([]);
		expect((await owner.call('GET', `/projects/${pid}/feeds`)).body.feeds[0]).toMatchObject({ versionConflict: false, replaceFrom: null, rebuilding: null });
		expect((await owner.call('GET', `/projects/${pid}/series`)).body.series[0]).toMatchObject({ rebuilding: false });
		// The v2 values are kept, with their label, as one feed_replace revision, and the history says so.
		const revs = await asOwner(`SELECT id, reason, product, product_version, "values" FROM series_revision WHERE project_id = $1 ORDER BY id DESC`, [pid]);
		expect(revs[0]).toMatchObject({ reason: 'feed_replace', product: 'CHIRPS', product_version: '2.0', values: [1, 2, 3] });
		const [ev] = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'series.replaced' ORDER BY id DESC LIMIT 1`, [pid]);
		expect(ev.subject).toMatchObject({ feedId: id, source: 'chirps', provenance: { from: 'CHIRPS v2.0', to: 'CHIRPS sat v3.0' } });

		// The refit: the live input carries the new label, which fitRecordStatus compares with the one a fit recorded.
		const live = (await owner.call('GET', `/projects/${pid}/model-input`)).body.input;
		expect(live.series.rain_chirps_mm.provenance).toEqual({ product: 'CHIRPS sat', version: '3.0' });
		// And the feed as the replaced record's source (107_series_source.sql).
		expect(live.series.rain_chirps_mm.origin).toEqual({ source: 'CHIRPS daily rainfall data feed', unit: 'mm', factor: 1 });
		// Only the fields fitRecordStatus reads: a fit made under these settings, on the v2.0 series.
		const fit = {
			model: 'gr4j',
			free: [],
			params: {},
			calibrationStart: null,
			calibrationEnd: null,
			exclusions: [],
			flowKind: 'flow_observed_m3s',
			forcing: { panCoefficient: live.settings.panCoefficient, apanMm: live.settings.apanMm, chirpsSource: { product: 'CHIRPS', version: '2.0' } }
		} as unknown as FitRecord;
		expect(fitRecordStatus(live.settings, fit, { chirpsSource: live.series.rain_chirps_mm.provenance })).toMatchObject({ chirpsSourceChanged: true, forcingChanged: true });
		expect(fitRecordStatus(live.settings, fit, { chirpsSource: { product: 'CHIRPS', version: '2.0' } })).toMatchObject({ chirpsSourceChanged: false, forcingChanged: false });
		// Restoring the kept values brings their label back with them (and the feed would refuse to write again).
		expect((await owner.call('POST', `/projects/${pid}/series/${seriesId}/revisions/${revs[0].id}/restore`, {})).status).toBe(200);
		expect(await chirpsLabel(pid)).toEqual({ product: 'CHIRPS', product_version: '2.0' });
		expect(await series(owner, pid, 'rain_chirps_mm')).toMatchObject({ startDate: first, values: [1, 2, 3] });
		expect((await owner.call('GET', `/projects/${pid}/feeds`)).body.feeds[0]).toMatchObject({ versionConflict: true });
	});

	it('withdrawing a pending replacement, or re-targeting the feed, discards its stage and leaves the series as it was', async () => {
		const owner = await signUp('Withdraw');
		const pid = await project(owner);
		const first = addDays(-150);
		await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_chirps_mm', unit: 'mm', startDate: first, values: [1, 2, 3], ...V2 });
		const confirm = { source: 'chirps', config: { cells: [cell()] }, replaceSeries: true };
		const id = (await owner.call('POST', `/projects/${pid}/feeds`, confirm)).body.feed.id;
		const stage = () => asOwner('SELECT feed_id FROM feed_stage WHERE feed_id = $1', [id]);
		const stageOnce = async () => {
			await owner.call('POST', `/projects/${pid}/feeds/${id}/run-now`);
			expect((await tick()).done).toBe(1);
			expect(await stage()).toHaveLength(1);
		};
		await stageOnce();
		// A save that doesn't touch the confirmation or the target keeps the stage …
		expect((await owner.call('PATCH', `/projects/${pid}/feeds/${id}`, { enabled: true })).body.feed).toMatchObject({ replaceFrom: 'CHIRPS/2.0' });
		expect(await stage()).toHaveLength(1);
		// … withdrawing (replaceSeries: false) discards it.
		expect((await owner.call('PATCH', `/projects/${pid}/feeds/${id}`, { replaceSeries: false })).body.feed).toMatchObject({ replaceFrom: null, rebuilding: null, versionConflict: true });
		expect(await stage()).toEqual([]);
		expect(await series(owner, pid, 'rain_chirps_mm')).toMatchObject({ startDate: first, values: [1, 2, 3] });
		// Confirmed again, staged again; then re-targeting discards it too.
		await asOwner(`DELETE FROM job WHERE kind = 'feed_fetch'`);
		expect((await owner.call('PATCH', `/projects/${pid}/feeds/${id}`, { replaceSeries: true })).status).toBe(200);
		await stageOnce();
		expect((await owner.call('PATCH', `/projects/${pid}/feeds/${id}`, { targetName: 'Elsewhere' })).body.feed).toMatchObject({ replaceFrom: null, rebuilding: null });
		expect(await stage()).toEqual([]);
		expect(await series(owner, pid, 'rain_chirps_mm')).toMatchObject({ startDate: first, values: [1, 2, 3] });
		// Removing the feed takes a stage with it (cascade).
		await owner.call('PATCH', `/projects/${pid}/feeds/${id}`, { targetName: '', replaceSeries: true });
		await asOwner(`DELETE FROM job WHERE kind = 'feed_fetch'`);
		await stageOnce();
		expect((await owner.call('DELETE', `/projects/${pid}/feeds/${id}`)).status).toBe(204);
		expect(await stage()).toEqual([]);
	});

	it('feed_stage RLS: viewers read a stage, strangers and viewers can’t write one, and a stage can’t name another project’s feed', async () => {
		const owner = await signUp('StageOwner');
		const viewer = await signUp('StageViewer');
		const stranger = await signUp('StageStranger');
		const pid = await project(owner);
		const other = await project(stranger, 'Other');
		await member(owner, pid, viewer, 'viewer');
		const id = (await owner.call('POST', `/projects/${pid}/feeds`, chirps())).body.feed.id;
		const insert = (uid: string, projectId: string) =>
			withUser(uid, (db) =>
				db.query(`INSERT INTO feed_stage (feed_id, project_id, start_date, "values", product, product_version, replace_from) VALUES ($1, $2, '2020-01-01', '{1}', 'CHIRPS sat', '3.0', '')`, [id, projectId])
			);
		await expect(insert(viewer.id, pid)).rejects.toMatchObject({ code: '42501' });
		await expect(insert(stranger.id, other)).rejects.toMatchObject({ code: '42501' });
		// Positive control: the owner (an editor) writes it; the viewer reads it; the stranger doesn't.
		await insert(owner.id, pid);
		expect((await withUser(viewer.id, (db) => db.query('SELECT feed_id FROM feed_stage WHERE feed_id = $1', [id]))).rows).toHaveLength(1);
		expect((await withUser(stranger.id, (db) => db.query('SELECT feed_id FROM feed_stage WHERE feed_id = $1', [id]))).rows).toHaveLength(0);
		expect((await withUser(viewer.id, (db) => db.query('DELETE FROM feed_stage WHERE feed_id = $1', [id]))).rowCount).toBe(0);
	});

	it('a confirmation names what the series held: a series relabelled since is refused again, and re-targeting drops it', async () => {
		const { owner, pid, seriesId } = await withV2('Specific');
		const id = (await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells: [cell()] }, replaceSeries: true })).body.feed.id;
		// Someone says the series is the rnl product after all: not what the owner agreed to replace.
		expect((await owner.call('PATCH', `/projects/${pid}/series/${seriesId}`, { product: 'CHIRPS rnl', productVersion: '3.0' })).status).toBe(200);
		await owner.call('POST', `/projects/${pid}/feeds/${id}/run-now`);
		await tick();
		expect(await series(owner, pid, 'rain_chirps_mm')).toMatchObject({ values: [1, 2, 3] });
		expect((await feedRow(id)).last_error).toMatch(/^the series holds CHIRPS rnl v3\.0 rainfall/);
		// A confirmation against the series as it now stands works (PATCH replaceSeries) …
		expect((await owner.call('PATCH', `/projects/${pid}/feeds/${id}`, { replaceSeries: true })).body.feed).toMatchObject({ replaceFrom: 'CHIRPS rnl/3.0' });
		// … and re-targeting the feed drops it: it named the old target's contents.
		expect((await owner.call('PATCH', `/projects/${pid}/feeds/${id}`, { targetName: 'Elsewhere' })).body.feed).toMatchObject({ replaceFrom: null });
	});

	it('a series reaching before 1998 is replaced only by the rnl product, end to end', async () => {
		const owner = await signUp('Pre98');
		const pid = await project(owner);
		await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_chirps_mm', unit: 'mm', startDate: '1990-06-01', values: [null, 1, 2], ...V2 });
		const sat = await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells: [cell()] }, replaceSeries: true });
		expect(sat.status).toBe(409);
		expect(sat.body.error).toMatch(/starts on 1990-06-02, before CHIRPS v3’s sat product begins \(1998-01-01\).*use the rnl product/);
		const rnl = await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells: [cell()], product: 'rnl' }, replaceSeries: true });
		expect(rnl.status).toBe(201);
		// From the first day with a value.
		expect(rnl.body.feed).toMatchObject({ config: { product: 'rnl', startDate: '1990-06-02' }, writes: { product: 'CHIRPS rnl', version: '3.0' } });
	});

	it('an rnl feed reads the rnl product from 1981, and is another forcing than sat: switching product asks again', async () => {
		const owner = await signUp('Rnl');
		const pid = await project(owner);
		const res = await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells: [cell()], startDate: '1985-01-01', product: 'rnl' } });
		expect(res.status).toBe(201);
		expect(res.body.feed.writes).toEqual({ product: 'CHIRPS rnl', version: '3.0' });
		const id = res.body.feed.id;
		await owner.call('POST', `/projects/${pid}/feeds/${id}/run-now`);
		expect((await tick()).done).toBe(1);
		const s = (await series(owner, pid, 'rain_chirps_mm'))!;
		expect(s.startDate).toBe('1985-01-01');
		expect(s.values.every((v) => v !== null)).toBe(true);
		expect(await chirpsLabel(pid)).toEqual({ product: 'CHIRPS rnl', product_version: '3.0' });
		expect((await feedRow(id)).last_meta).toMatchObject({ product: 'rnl', prelimDays: 0 });
		// sat can't reach 1985, and switching the product is a version question like any other.
		expect((await owner.call('PATCH', `/projects/${pid}/feeds/${id}`, { config: { cells: [cell()], startDate: '1985-01-01', product: 'sat' } })).status).toBe(400);
		expect((await owner.call('PATCH', `/projects/${pid}/feeds/${id}`, { config: { cells: [cell()], startDate: addDays(-20) } })).status).toBe(409);
	});
});

describe('daily only, and the "Run now" limit (111_feed_daily_only)', () => {
	const MIGRATION = readFileSync(new URL('../../migrations/111_feed_daily_only.sql', import.meta.url), 'utf8');
	/** Press "Run now" with the raw response, for its Retry-After. */
	const press = async (u: User, pid: string, id: string) => {
		const r = await app.request(`/projects/${pid}/feeds/${id}/run-now`, { method: 'POST', headers: { cookie: u.cookie, origin: 'http://localhost:7777' } });
		return { status: r.status, retryAfter: r.headers.get('retry-after'), body: (await r.json()) as Record<string, any> };
	};
	const pending = (id: string) => asOwner(`SELECT id FROM job WHERE kind = 'feed_fetch' AND payload->>'feedId' = $1 AND status IN ('queued', 'failed')`, [id]);
	/** The fetch ran (or went): the next press queues a new one. */
	const clearJobs = (id: string) => asOwner(`DELETE FROM job WHERE kind = 'feed_fetch' AND payload->>'feedId' = $1`, [id]);
	/** The pending fetch waits (a backfill's next window): the next press pulls it forward. */
	const delay = (id: string) => asOwner(`UPDATE job SET run_after = now() + interval '1 minute' WHERE kind = 'feed_fetch' AND payload->>'feedId' = $1`, [id]);

	it('a feed takes 6 presses that queue or pull a fetch, then answers 429 with Retry-After and queues nothing; presses onto a due fetch take none', async () => {
		expect(RUN_NOW_RATE).toEqual({ capacity: 6, refillSeconds: 600 });
		const owner = await signUp('Presser');
		const editor = await signUp('PressEditor');
		const pid = await project(owner);
		await member(owner, pid, editor, 'editor');
		const id = (await owner.call('POST', `/projects/${pid}/feeds`, gefs())).body.feed.id;
		const other = (await owner.call('POST', `/projects/${pid}/feeds`, { ...gefs(), targetName: 'other' })).body.feed.id;

		for (let i = 0; i < RUN_NOW_RATE.capacity; i++) {
			// Alternate: a press that queues (202), and one that pulls a waiting fetch forward (200); both count.
			const pull = i % 2 === 1;
			if (pull) await delay(id);
			else await clearJobs(id);
			const r = await press(i < 3 ? owner : editor, pid, id);
			expect(r.status, `press ${i + 1}`).toBe(pull ? 200 : 202);
			// A press while that fetch is already due dedupes onto it and takes nothing, however many.
			for (let k = 0; k < 3; k++) expect((await press(owner, pid, id)).status).toBe(200);
		}
		// The seventh that would queue: refused, and the enqueue rolled back.
		await clearJobs(id);
		const refused = await press(editor, pid, id);
		expect(refused.status).toBe(429);
		expect(refused.body.error).toMatch(/^“Run now” was used too often for this feed \(6 fetches, then one every 10 minutes\): try again in \d+ minutes?, or let it run on its daily schedule$/);
		const wait = refused.body.details.retryAfter as number;
		expect(wait).toBeGreaterThan(0);
		expect(wait).toBeLessThanOrEqual(RUN_NOW_RATE.refillSeconds);
		expect(refused.retryAfter).toBe(String(wait));
		expect(await pending(id)).toEqual([]);
		// Positive control: the bucket is per feed.
		expect((await press(owner, pid, other)).status).toBe(202);
		// A pull is refused too, and leaves the fetch waiting: one press back queues a fetch, which then waits.
		await asOwner(`UPDATE data_feed_run_now SET tokens = 1, refilled_at = clock_timestamp() WHERE feed_id = $1`, [id]);
		expect((await press(owner, pid, id)).status).toBe(202);
		await delay(id);
		expect((await press(owner, pid, id)).status).toBe(429);
		expect(await asOwner(`SELECT run_after > now() AS later FROM job WHERE kind = 'feed_fetch' AND payload->>'feedId' = $1`, [id])).toEqual([{ later: true }]);
		// A refused press takes nothing either: the bucket is still empty, not in debt.
		const [row] = await asOwner('SELECT tokens FROM data_feed_run_now WHERE feed_id = $1', [id]);
		expect(row.tokens).toBeLessThan(1);
		expect(row.tokens).toBeGreaterThanOrEqual(0);
	});

	it('refills one press every 10 minutes, up to 6', async () => {
		const owner = await signUp('Refill');
		const pid = await project(owner);
		const id = (await owner.call('POST', `/projects/${pid}/feeds`, gefs())).body.feed.id;
		expect((await press(owner, pid, id)).status).toBe(202);
		// Empty since 9 minutes ago: not yet, and the wait says about a minute.
		await clearJobs(id);
		await asOwner(`UPDATE data_feed_run_now SET tokens = 0, refilled_at = clock_timestamp() - interval '9 minutes' WHERE feed_id = $1`, [id]);
		const early = await press(owner, pid, id);
		expect(early.status).toBe(429);
		expect(early.body.details.retryAfter).toBeGreaterThan(55);
		expect(early.body.details.retryAfter).toBeLessThanOrEqual(60);
		expect(early.body.error).toContain('try again in 1 minute,');
		// Ten minutes: one press back.
		await asOwner(`UPDATE data_feed_run_now SET tokens = 0, refilled_at = clock_timestamp() - interval '10 minutes' WHERE feed_id = $1`, [id]);
		expect((await press(owner, pid, id)).status).toBe(202);
		await clearJobs(id);
		expect((await press(owner, pid, id)).status).toBe(429);
		// A day idle fills it to 6, not 144.
		await asOwner(`UPDATE data_feed_run_now SET tokens = 0, refilled_at = clock_timestamp() - interval '1 day' WHERE feed_id = $1`, [id]);
		for (let i = 0; i < 6; i++) {
			await clearJobs(id);
			expect((await press(owner, pid, id)).status, `press ${i + 1}`).toBe(202);
		}
		await clearJobs(id);
		expect((await press(owner, pid, id)).status).toBe(429);
	});

	it('the wait reads in whole minutes, rounded up', () => {
		expect(runNowWait(1)).toBe('1 minute');
		expect(runNowWait(60)).toBe('1 minute');
		expect(runNowWait(61)).toBe('2 minutes');
		expect(runNowWait(600)).toBe('10 minutes');
	});

	it('only an editor of the feed’s project takes a press; nobody reads or writes the bucket directly', async () => {
		const owner = await signUp('BucketOwner');
		const editor = await signUp('BucketEditor');
		const viewer = await signUp('BucketViewer');
		const farmer = await signUp('BucketFarmer');
		const stranger = await signUp('BucketStranger');
		const pid = await project(owner);
		await member(owner, pid, editor, 'editor');
		await member(owner, pid, viewer, 'viewer');
		await asOwner(`INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, 'farmer')`, [pid, farmer.id]);
		const id = (await owner.call('POST', `/projects/${pid}/feeds`, gefs())).body.feed.id;
		const take = (u: User) => withUser(u.id, (db) => db.query<{ wait: number }>('SELECT app_feed_take_run_now($1, 6, 600) AS wait', [id]));
		for (const u of [viewer, farmer, stranger]) await expect(take(u)).rejects.toMatchObject({ code: '42501' });
		await expect(withUser(editor.id, (db) => db.query('SELECT app_feed_take_run_now($1, 6, 600)', ['00000000-0000-4000-8000-000000000000']))).rejects.toMatchObject({ code: '42501' });
		// Positive control: the editor takes one.
		expect((await take(editor)).rows[0]!.wait).toBe(0);
		// Bounds on what the backend passes.
		await expect(withUser(editor.id, (db) => db.query('SELECT app_feed_take_run_now($1, 0, 600)', [id]))).rejects.toMatchObject({ code: '22023' });
		await expect(withUser(editor.id, (db) => db.query('SELECT app_feed_take_run_now($1, 6, 0)', [id]))).rejects.toMatchObject({ code: '22023' });
		// The bucket row exists (positive control), but water_app sees none of it and can't refill it, even as the owner.
		expect(await asOwner('SELECT tokens FROM data_feed_run_now WHERE feed_id = $1', [id])).toEqual([{ tokens: 5 }]);
		expect((await withUser(owner.id, (db) => db.query('SELECT * FROM data_feed_run_now'))).rows).toEqual([]);
		expect((await withUser(owner.id, (db) => db.query('UPDATE data_feed_run_now SET tokens = 6 WHERE feed_id = $1', [id]))).rowCount).toBe(0);
		await expect(withUser(owner.id, (db) => db.query('DELETE FROM data_feed_run_now WHERE feed_id = $1', [id]))).resolves.toMatchObject({ rowCount: 0 });
		await expect(
			withUser(owner.id, (db) => db.query(`INSERT INTO data_feed_run_now (feed_id, tokens, refilled_at) VALUES ('00000000-0000-4000-8000-000000000001', 6, now())`))
		).rejects.toMatchObject({ code: '42501' });
		// Removing the feed removes its bucket.
		expect((await owner.call('DELETE', `/projects/${pid}/feeds/${id}`)).status).toBe(204);
		expect(await asOwner('SELECT tokens FROM data_feed_run_now WHERE feed_id = $1', [id])).toEqual([]);
	});

	it('the table holds only daily feeds, and the migration turned hourly ones daily without touching their health or acting user', async () => {
		const owner = await signUp('DailyOnly');
		const pid = await project(owner);
		const id = (await owner.call('POST', `/projects/${pid}/feeds`, chirps())).body.feed.id;
		await expect(asOwner(`UPDATE data_feed SET schedule = 'hourly' WHERE id = $1`, [id])).rejects.toMatchObject({ code: '23514' });
		// The migration's UPDATE, as the owner role on the real table (its data_feed_stamp
		// trigger included), with the old CHECK back for the length of a rolled-back transaction.
		const update = MIGRATION.match(/UPDATE data_feed SET schedule = 'daily' WHERE schedule = 'hourly';/)?.[0];
		expect(update).toBeDefined();
		await asOwner(`UPDATE data_feed SET consecutive_failures = 2, last_scheduled_at = '2026-03-01T06:00:00Z' WHERE id = $1`, [id]);
		const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
		await client.connect();
		try {
			await client.query('BEGIN');
			await client.query(`ALTER TABLE data_feed DROP CONSTRAINT data_feed_schedule_check`);
			await client.query(`ALTER TABLE data_feed ADD CONSTRAINT data_feed_schedule_check CHECK (schedule IN ('daily', 'hourly'))`);
			await client.query(`UPDATE data_feed SET schedule = 'hourly' WHERE id = $1`, [id]);
			await client.query(update!);
			const { rows } = await client.query(`SELECT schedule, consecutive_failures, last_scheduled_at, acting_user_id FROM data_feed WHERE id = $1`, [id]);
			expect(rows).toEqual([{ schedule: 'daily', consecutive_failures: 2, last_scheduled_at: new Date('2026-03-01T06:00:00Z'), acting_user_id: owner.id }]);
		} finally {
			await client.query('ROLLBACK');
			await client.end();
		}
	});
});
