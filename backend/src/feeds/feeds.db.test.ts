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
import { FETCH_META_MAX_BYTES, utcToday } from './fetch.js';
import { FIXTURE_CELL } from './fixtures.js';
import { acceptIngestResult, scheduleDueFeeds } from './schedule.js';
import { claimDueFeeds } from './store.js';

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

	it('a result whose meta passes the key and length limits but not the column’s 4 KB is refused as invalid, not a failing job', async () => {
		const o = await fetchJob();
		// 20 keys of 40 characters and values of 100, each character two bytes in UTF-8: ~5.7 KB of JSON.
		const meta = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`${String(i).padStart(2, '0')}${'é'.repeat(38)}`, 'é'.repeat(100)]));
		await acceptIngestResult(msg(o, { ...result, meta }));
		await tick();
		expect(await series(o.owner, o.pid, 'rain_chirps_mm')).toBeNull();
		expect(await feedRow(o.feedId)).toMatchObject({ consecutive_failures: 1, last_error: 'the fetcher’s answer was not valid, so nothing was written' });
		expect((await asOwner(`SELECT status FROM job WHERE kind = 'feed_ingest' AND project_id = $1`, [o.pid]))[0].status).toBe('done');
	});

	it('the largest meta FetchResult accepts fits the column, with the merged count added (positive control)', async () => {
		const o = await fetchJob();
		// 20 keys of 40 characters, values of two-byte characters as long as the byte limit allows.
		const fill = (n: number) => Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`${String(i).padStart(2, '0')}${'k'.repeat(38)}`, 'é'.repeat(n)]));
		let n = 100;
		while (new TextEncoder().encode(JSON.stringify(fill(n))).length > FETCH_META_MAX_BYTES) n--;
		const meta = fill(n);
		expect(new TextEncoder().encode(JSON.stringify(meta)).length).toBeLessThanOrEqual(FETCH_META_MAX_BYTES);
		expect(new TextEncoder().encode(JSON.stringify(meta)).length).toBeGreaterThan(FETCH_META_MAX_BYTES - 100);
		await acceptIngestResult(msg(o, { ...result, meta }));
		await tick();
		expect(await feedRow(o.feedId)).toMatchObject({ consecutive_failures: 0, last_data_date: '2026-01-03' });
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
