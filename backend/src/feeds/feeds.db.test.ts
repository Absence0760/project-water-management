// Data feeds end to end on the fixtures (018_feeds.sql, feeds/*, the
// feed_fetch / feed_ingest handlers): RLS on data_feed with positive controls,
// the routes, a fetch merging into the series as the acting user, failures
// and health, the scheduler, the acting user losing the role, and the
// production path's ingest-results hand-off.
//
// DB test files run one at a time, so this file owns the data_feed table
// while it runs: afterEach removes every feed, so no other file's tick finds
// one due.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';
import { enqueueJob } from '../jobs/queue.js';
import { runTick } from '../jobs/runner.js';
import { utcToday } from './fetch.js';
import { FIXTURE_CELL } from './fixtures.js';
import { acceptIngestResult, scheduleDueFeeds } from './schedule.js';
import { ingestResult } from './ingest.js';
import { claimDueFeeds, feedForJob } from './store.js';

type User = Awaited<ReturnType<typeof signUp>>;

afterEach(async () => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	await asOwner('DELETE FROM data_feed');
	await asOwner(`DELETE FROM job WHERE kind IN ('feed_fetch', 'feed_ingest')`);
});

const cell = () => ({ ...FIXTURE_CELL(), weight: 1 });
const gefs = () => ({ source: 'chirps_gefs', config: { cells: [cell()] } });
const chirps = (over: Record<string, unknown> = {}) => ({ source: 'chirps', config: { cells: [cell()], startDate: addDays(-20) }, ...over });
const addDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

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
/** Run what's queued, with no feed scheduling (the tests schedule explicitly). */
const tick = () => runTick({ feeds: false });

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
		expect(list.body).toMatchObject({ mode: 'fixtures', canEdit: false, canRun: false, schedules: ['daily', 'hourly'] });
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
		const off = await owner.call('PATCH', `/projects/${pid}/feeds/${id}`, { enabled: false, schedule: 'hourly' });
		expect(off.status).toBe(200);
		expect(off.body.feed).toMatchObject({ enabled: false, schedule: 'hourly', config: { station: 'X0H000' }, health: { state: 'disabled' } });
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
		const put = await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_chirps_mm', unit: 'mm', startDate: addDays(-1), values: [42] });
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

	it('a later fetch never re-reads before the feed’s startDate, where the series holds the owner’s own days', async () => {
		const owner = await signUp('Floor');
		const pid = await project(owner);
		// The owner's own rainfall before the feed takes over.
		expect((await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_chirps_mm', unit: 'mm', startDate: addDays(-30), values: [7, 7] })).status).toBe(200);
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
		expect(feed.health.message).toMatch(/^The last fetch failed: /);

		// Fixing the cell clears the failure (a new place) and the next fetch succeeds.
		await owner.call('PATCH', `/projects/${pid}/feeds/${id}`, { config: { cells: [cell()] } });
		expect(await feedRow(id)).toMatchObject({ consecutive_failures: 0, last_error: null });
		// The old place's fetch says nothing about the new one: waiting, not "ok, no data".
		expect((await owner.call('GET', `/projects/${pid}/feeds`)).body.feeds[0].health).toMatchObject({ state: 'pending', message: 'Waiting for its first fetch.' });
		await owner.call('POST', `/projects/${pid}/feeds/${id}/run-now`);
		await tick();
		expect((await owner.call('GET', `/projects/${pid}/feeds`)).body.feeds[0].health.state).toBe('ok');
	});
});

describe('the scheduler', () => {
	it('claims due feeds once per interval, never a disabled one; p_all claims every enabled feed', async () => {
		const owner = await signUp('Scheduler');
		const pid = await project(owner);
		const on = (await owner.call('POST', `/projects/${pid}/feeds`, gefs())).body.feed.id;
		const off = (await owner.call('POST', `/projects/${pid}/feeds`, { ...chirps(), enabled: false })).body.feed.id;

		const first = await withoutUser((db) => claimDueFeeds(db, 50));
		expect(first.map((f) => f.id)).toEqual([on]);
		expect(first[0]).toMatchObject({ projectId: pid, actingUserId: owner.id });
		expect(await withoutUser((db) => claimDueFeeds(db, 50))).toEqual([]);
		expect((await withoutUser((db) => claimDueFeeds(db, 50, true))).map((f) => f.id)).toEqual([on]);
		expect((await feedRow(off)).last_scheduled_at).toBeNull();

		// A day later it is due again (with a minute's slack for the tick).
		await asOwner(`UPDATE data_feed SET last_scheduled_at = now() - interval '1 day' + interval '30 seconds' WHERE id = $1`, [on]);
		expect((await withoutUser((db) => claimDueFeeds(db, 50))).map((f) => f.id)).toEqual([on]);
		// Hourly feeds, an hour later.
		await owner.call('PATCH', `/projects/${pid}/feeds/${on}`, { schedule: 'hourly' });
		await asOwner(`UPDATE data_feed SET last_scheduled_at = now() - interval '61 minutes' WHERE id = $1`, [on]);
		expect((await withoutUser((db) => claimDueFeeds(db, 50))).map((f) => f.id)).toEqual([on]);
		// A failing feed retries sooner than daily: 15 min after one failure.
		await owner.call('PATCH', `/projects/${pid}/feeds/${on}`, { schedule: 'daily' });
		await asOwner(`UPDATE data_feed SET consecutive_failures = 1, last_scheduled_at = now() - interval '16 minutes' WHERE id = $1`, [on]);
		expect((await withoutUser((db) => claimDueFeeds(db, 50))).map((f) => f.id)).toEqual([on]);
		await expect(withoutUser((db) => claimDueFeeds(db, 0))).rejects.toMatchObject({ code: '22023' });
	});

	it('two ticks at once never claim the same feed (FOR UPDATE SKIP LOCKED), and a feed idle for days is claimed once, not once per missed day', async () => {
		const owner = await signUp('Racer');
		const pid = await project(owner);
		const ids: string[] = [];
		for (let i = 0; i < 6; i++) ids.push((await owner.call('POST', `/projects/${pid}/feeds`, { ...gefs(), targetName: `f${i}` })).body.feed.id);
		// The worker was down for five days.
		await asOwner(`UPDATE data_feed SET last_scheduled_at = now() - interval '5 days' WHERE project_id = $1`, [pid]);
		const [a, b] = await Promise.all([withoutUser((db) => claimDueFeeds(db, 50)), withoutUser((db) => claimDueFeeds(db, 50))]);
		const claimed = [...a, ...b].map((f) => f.id);
		expect(claimed.sort()).toEqual([...ids].sort());
		expect(await withoutUser((db) => claimDueFeeds(db, 50))).toEqual([]);
	});

	it('the oldest-scheduled feeds go first when more are due than a tick takes', async () => {
		const owner = await signUp('Queue');
		const pid = await project(owner);
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) ids.push((await owner.call('POST', `/projects/${pid}/feeds`, { ...gefs(), targetName: `f${i}` })).body.feed.id);
		await asOwner(`UPDATE data_feed SET last_scheduled_at = now() - interval '2 days' WHERE id = $1`, [ids[0]]);
		await asOwner(`UPDATE data_feed SET last_scheduled_at = now() - interval '3 days' WHERE id = $1`, [ids[1]]);
		// ids[2] was never scheduled: first of all.
		expect((await withoutUser((db) => claimDueFeeds(db, 2))).map((f) => f.id)).toEqual([ids[2], ids[1]]);
		expect((await withoutUser((db) => claimDueFeeds(db, 2))).map((f) => f.id)).toEqual([ids[0]]);
	});

	it('a failing feed backs off 15 min × 2^(failures − 1), never beyond its own interval', async () => {
		const owner = await signUp('Backoff');
		const pid = await project(owner);
		const id = (await owner.call('POST', `/projects/${pid}/feeds`, gefs())).body.feed.id;
		const dueAfter = async (failures: number, minutesAgo: number) => {
			await asOwner(`UPDATE data_feed SET consecutive_failures = $2, last_scheduled_at = now() - make_interval(mins => $3) WHERE id = $1`, [id, failures, minutesAgo]);
			return (await withoutUser((db) => claimDueFeeds(db, 50))).length === 1;
		};
		// Three failures: an hour (a minute's slack for the tick).
		expect(await dueAfter(3, 55)).toBe(false);
		expect(await dueAfter(3, 60)).toBe(true);
		// Eight failures would be 32 h: capped at the day.
		expect(await dueAfter(8, 23 * 60)).toBe(false);
		expect(await dueAfter(8, 24 * 60)).toBe(true);
		// An hourly feed's cap is its hour.
		await owner.call('PATCH', `/projects/${pid}/feeds/${id}`, { schedule: 'hourly' });
		expect(await dueAfter(5, 50)).toBe(false);
		expect(await dueAfter(5, 60)).toBe(true);
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

	it('a feed whose acting user deleted their account is kept but skipped until an owner saves it', async () => {
		const a = await signUp('Leaver');
		const b = await signUp('Stayer');
		const pid = await project(b);
		await member(b, pid, a, 'owner');
		const id = (await a.call('POST', `/projects/${pid}/feeds`, gefs())).body.feed.id;
		await asOwner('DELETE FROM app_user WHERE id = $1', [a.id]);
		expect(await feedRow(id)).toMatchObject({ acting_user_id: null });
		expect(await withoutUser((db) => claimDueFeeds(db, 50))).toEqual([]);
		expect((await b.call('GET', `/projects/${pid}/feeds`)).body.feeds[0].actingUser).toBeNull();
	});
});

describe('the production hand-off (ingest-results → feed_ingest)', () => {
	const result = { ok: true, startDate: '2026-01-01', values: [1.5, null, 2.5], meta: { days: 3 } };

	async function fetchJob() {
		const owner = await signUp('Ingester');
		const pid = await project(owner);
		const feed = (await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells: [cell()] } })).body.feed;
		const version = (await asOwner(`SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS v FROM data_feed WHERE id = $1`, [feed.id]))[0].v as string;
		const { job } = await withUser(owner.id, (db) => enqueueJob(db, { projectId: pid, kind: 'feed_fetch', payload: { feedId: feed.id }, delaySeconds: 3600 }));
		return { owner, pid, feedId: feed.id as string, jobId: job.id, version };
	}
	const msg = (o: { feedId: string; jobId: string; version: string }, r: unknown = result) => ({ v: 1 as const, type: 'ingest' as const, fetchJobId: o.jobId, feedId: o.feedId, feedVersion: o.version, result: r });

	it('queues a feed_ingest job as the fetch job’s user, which merges the days', async () => {
		const o = await fetchJob();
		expect(await acceptIngestResult(msg(o))).toBe('queued');
		// A redelivered message while the first waits is the same job.
		expect(await acceptIngestResult(msg(o))).toBe('queued');
		expect((await asOwner(`SELECT count(*)::int AS n FROM job WHERE kind = 'feed_ingest' AND project_id = $1`, [o.pid]))[0].n).toBe(1);
		await tick();
		expect((await series(o.owner, o.pid, 'rain_chirps_mm'))!.values).toEqual([1.5, null, 2.5]);
		expect(await feedRow(o.feedId)).toMatchObject({ last_data_date: '2026-01-03', last_value: 2.5, consecutive_failures: 0 });
	});

	it('refuses a message that names another feed’s job, or no job', async () => {
		const o = await fetchJob();
		const p = await fetchJob();
		expect(await acceptIngestResult(msg({ ...o, feedId: p.feedId }))).toBe('unknown_fetch');
		expect(await acceptIngestResult(msg({ ...o, jobId: '00000000-0000-4000-8000-000000000000' }))).toBe('unknown_fetch');
	});

	it('records an invalid result as a failed fetch, writing nothing', async () => {
		const o = await fetchJob();
		await acceptIngestResult(msg(o, { ok: true, startDate: '2026-01-01', values: [-5], meta: {} }));
		await tick();
		expect(await series(o.owner, o.pid, 'rain_chirps_mm')).toBeNull();
		expect(await feedRow(o.feedId)).toMatchObject({ consecutive_failures: 1, last_error: 'the fetcher’s answer was not valid, so nothing was written' });
	});

	it('drops a result for a feed saved with new settings since the fetch', async () => {
		const o = await fetchJob();
		await acceptIngestResult(msg(o));
		await o.owner.call('PATCH', `/projects/${o.pid}/feeds/${o.feedId}`, { config: { cells: [cell(), cell()] } });
		await tick();
		expect(await series(o.owner, o.pid, 'rain_chirps_mm')).toBeNull();
		expect(await feedRow(o.feedId)).toMatchObject({ last_attempt_at: null });
	});
});

describe('ingest: how a fetch result becomes the series (feeds/ingest.ts → series/merge.ts mergeInto)', () => {
	/** A feed of a fresh project; `ingest` applies a result as the job does, as its acting user. */
	async function setup(name: string, over: Record<string, unknown> = {}) {
		const owner = await signUp(name);
		const pid = await project(owner);
		const id = (await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells: [cell()] }, ...over })).body.feed.id as string;
		const ingest = (raw: unknown) => withUser(owner.id, async (db) => ingestResult(db, (await feedForJob(db, pid, id))!, raw));
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

	it('writes nothing when the transaction fails after the merge: the merge and the health commit together', async () => {
		const { owner, pid, id, ingest } = await setup('Atomic');
		await expect(
			withUser(owner.id, async (db) => {
				await ingestResult(db, (await feedForJob(db, pid, id))!, ok('2026-01-01', [1, 2]));
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
		expect((await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_chirps_mm', unit: 'mm', startDate: '1850-01-01', values: [7] })).status).toBe(200);
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

	it('user-entered days: the source’s value replaces the user’s on the same day (the feed owns its series), a gap never erases one, another series is untouched', async () => {
		const { owner, pid, ingest } = await setup('UserData');
		await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_chirps_mm', unit: 'mm', startDate: '2026-01-01', values: [10, 20, 30] });
		// The user's own record under another name: a feed writes only the series it targets.
		await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_chirps_mm', name: 'My gauge', unit: 'mm', startDate: '2026-01-01', values: [5, 5, 5] });
		await ingest(ok('2025-12-31', [0, 1, null, 3, 4]));
		expect(await series(owner, pid, 'rain_chirps_mm')).toMatchObject({ startDate: '2025-12-31', values: [0, 1, 20, 3, 4] });
		const list = (await owner.call('GET', `/projects/${pid}/series`)).body.series as { id: string; name: string }[];
		const mine = list.find((s) => s.name === 'My gauge')!;
		expect((await owner.call('GET', `/projects/${pid}/series/${mine.id}`)).body).toMatchObject({ startDate: '2026-01-01', values: [5, 5, 5] });
	});

	it('writes the source’s unit and the exact days whatever the server’s time zone', async () => {
		const tz = process.env.TZ;
		try {
			for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
				process.env.TZ = zone; // UTC+14, UTC-11
				const { owner, pid, id, ingest } = await setup('Zoned', { source: 'dws', config: { station: 'X0H000' } });
				await owner.call('PUT', `/projects/${pid}/series`, { kind: 'flow_observed_m3s', unit: 'm3/s', startDate: '2026-03-01', values: [9] });
				expect(await ingest(ok('2026-02-27', [1.25, null, 2.5, null]))).toEqual({ merged: 2, lastDate: '2026-03-01' });
				expect(await series(owner, pid, 'flow_observed_m3s')).toMatchObject({ startDate: '2026-02-27', unit: 'm³/s', values: [1.25, null, 2.5, null] });
				expect(await feedRow(id)).toMatchObject({ last_data_date: '2026-03-01', last_value: 2.5 });
			}
		} finally {
			process.env.TZ = tz;
		}
	});

	it('removing a feed keeps the days it wrote (as the remove dialog says)', async () => {
		const { owner, pid, id, ingest } = await setup('Remover');
		await ingest(ok('2026-01-01', [1, 2]));
		expect((await owner.call('DELETE', `/projects/${pid}/feeds/${id}`)).status).toBe(204);
		expect(await series(owner, pid, 'rain_chirps_mm')).toMatchObject({ startDate: '2026-01-01', values: [1, 2] });
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
