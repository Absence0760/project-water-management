// The shared CHIRPS cell cache (208_chirps_cell_cache.sql, issue #482 part
// A): who may read and write chirps_cell_year (with positive controls), what
// chirps_cache_merge refuses, how it keeps final values over preliminary
// ones, and the feeds end to end through the production loop on the
// fixtures: a second feed over the same cells fetching nothing, a partial
// hit fetching only the missing cell, preliminary → final, and refused
// answers writing nothing.
//
// DB test files run one at a time; like feeds.db.test.ts this file removes
// every feed, feed job and cached cell after each test.
import { afterEach, describe, expect, it, vi } from 'vitest';

const { sent } = vi.hoisted(() => ({ sent: [] as unknown[] }));
vi.mock('../jobs/transport.js', async (orig) => ({
	...(await orig<typeof import('../jobs/transport.js')>()),
	sendToQueue: async (_url: string | undefined, _name: string, message: unknown) => void sent.push(message)
}));
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';
import { runTick } from '../jobs/runner.js';
import { parseFetchRequest } from '../jobs/transport.js';
import { CELL_VALUE_MAX_BITS, chcCell, encodeCellValue } from './cellCache.js';
import { runFetch } from './fetch.js';
import { FIXTURE_CELL, fixtureHttp } from './fixtures.js';
import { ingestResult } from './ingest.js';
import { acceptIngestResult } from './schedule.js';
import { feedForJob } from './store.js';

type User = Awaited<ReturnType<typeof signUp>>;

afterEach(async () => {
	sent.length = 0;
	feedOf.clear();
	vi.unstubAllEnvs();
	await asOwner('DELETE FROM data_feed');
	await asOwner(`DELETE FROM job WHERE kind IN ('feed_fetch', 'feed_ingest')`);
	await asOwner('DELETE FROM chirps_cell_year');
	await asOwner('DELETE FROM chirps_file');
	await asOwner('DELETE FROM chirps_cell_stale');
});

const tick = () => runTick({ feeds: false, reports: false, alerts: false });
const addDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const cell = () => ({ ...FIXTURE_CELL(), weight: 1 });
/** The fixture cell's neighbour to the east, still inside the fixtures' cover. */
const east = () => ({ lat: FIXTURE_CELL().lat, lon: Number((FIXTURE_CELL().lon + 0.05).toFixed(9)), weight: 1 });

async function project(owner: User, name = 'Cell cache') {
	return (await owner.call('POST', '/projects', { name })).body.project.id as string;
}
/** The CHIRPS feed each caller's merges below are for, by user and product (runningJob makes it). */
const feedOf = new Map<string, string>();
/**
 * A running data-feed job of `u` in `pid` for a CHIRPS feed of `product`
 * there (made by `creator`, an owner of `pid`): what chirps_cache_merge asks
 * of its caller. Queued as `u` (the job's trigger stamps the session's
 * user), then claimed.
 */
async function runningJob(u: User, pid: string, kind = 'feed_fetch', { product = 'sat', creator = u, feedId }: { product?: string; creator?: User; feedId?: string } = {}) {
	if (!feedId) {
		const r = await creator.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells: [cell()], product, startDate: '2024-01-01' }, targetName: `merge ${product} ${feedOf.size}` });
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		feedId = r.body.feed.id as string;
	}
	feedOf.set(`${u.id}:${product}`, feedId!);
	await asOwner(`DELETE FROM job WHERE kind = 'feed_fetch' AND payload->>'feedId' = $1 AND status = 'queued'`, [feedId]);
	const id = (
		await asOwner(
			`WITH me AS (SELECT set_config('app.current_user_id', $3::text, false))
			 INSERT INTO job (project_id, kind, acting_user_id, payload) SELECT $1::uuid, $2, $3::uuid, jsonb_build_object('feedId', $4::text) FROM me RETURNING id`,
			[pid, kind, u.id, feedId]
		)
	)[0].id as string;
	await asOwner(`UPDATE job SET status = 'running', locked_until = now() + interval '5 minutes', lease_token = gen_random_uuid(), started_at = now() WHERE id = $1`, [id]);
	return { jobId: id, feedId: feedId! };
}
/** chirps_cache_merge as `u`, for the feed runningJob gave `u` for the product in args[1] (or `feedId`). */
const merge = (u: User, args: unknown[], feedId = feedOf.get(`${u.id}:${args[1]}`) ?? '00000000-0000-4000-8000-000000000000') =>
	withUser(u.id, (db) => db.query<{ n: number }>('SELECT chirps_cache_merge($1, $2, $3, $4, $5, $6, $7, $8) AS n', [feedId, ...args]));
const cached = async (year = 2024) =>
	(await asOwner(
		`SELECT row_idx, col_idx, to_char(final_through, 'YYYY-MM-DD') AS ft, vals FROM chirps_cell_year WHERE origin = 'chc' AND product = 'sat' AND year = $1 ORDER BY row_idx, col_idx`,
		[year]
	)) as { row_idx: number; col_idx: number; ft: string; vals: (number | null)[] }[];
const doy = (iso: string) => (Date.parse(iso) - Date.parse(`${iso.slice(0, 4)}-01-01`)) / 86_400_000;

describe('chirps_cell_year: shared reference data', () => {
	it('any signed-in session reads it, nobody without one; water_app can’t insert, change or delete a row, not even a project owner', async () => {
		const owner = await signUp('CacheOwner');
		const stranger = await signUp('CacheStranger');
		await asOwner(`INSERT INTO chirps_cell_year (origin, product, row_idx, col_idx, year, vals, final, final_through)
			VALUES ('chc', 'sat', 1600, 4100, 2024, array_fill(1::real, ARRAY[366]), array_fill(true, ARRAY[366]), '2024-12-31')`);
		// Positive control: any signed-in session, member of nothing, reads it. Only this row: the table is shared, so an earlier file's fetches may have filled others.
		const mine = `SELECT 1 FROM chirps_cell_year WHERE origin = 'chc' AND product = 'sat' AND row_idx = 1600 AND col_idx = 4100 AND year = 2024`;
		expect((await withUser(stranger.id, (db) => db.query(mine))).rows).toHaveLength(1);
		expect((await withoutUser((db) => db.query(mine))).rows).toHaveLength(0);
		for (const sql of [
			`INSERT INTO chirps_cell_year (origin, product, row_idx, col_idx, year, vals, final, final_through) VALUES ('chc', 'sat', 1, 1, 2024, array_fill(1::real, ARRAY[366]), array_fill(true, ARRAY[366]), '2024-12-31')`,
			`UPDATE chirps_cell_year SET vals[1] = 999`,
			`DELETE FROM chirps_cell_year`
		]) {
			await expect(withUser(owner.id, (db) => db.query(sql)), sql).rejects.toMatchObject({ code: '42501' });
		}
		expect((await cached())[0]!.vals[0]).toBe(1);
	});

	it('its own checks hold even for the schema owner: 366 values, a year the product has, final_through inside its year', async () => {
		const bad = [
			`(ARRAY[1]::real[], 2024, date '2024-12-31', 'sat')`,
			`(array_fill(1::real, ARRAY[366]), 1997, date '1997-12-31', 'sat')`,
			`(array_fill(1::real, ARRAY[366]), 2024, date '2025-01-01', 'sat')`,
			`(array_fill(1::real, ARRAY[366]), 1980, date '1980-12-31', 'rnl')`
		];
		for (const v of bad) {
			await expect(
				asOwner(`INSERT INTO chirps_cell_year (vals, year, final_through, product, origin, row_idx, col_idx, final) SELECT v.*, 'chc', 1, 1, array_fill(true, ARRAY[366]) FROM (VALUES ${v}) v`),
				v
			).rejects.toMatchObject({ code: '23514' });
		}
		// A day's finality for each of the 366 days, never NULL.
		await expect(
			asOwner(`INSERT INTO chirps_cell_year (origin, product, row_idx, col_idx, year, vals, final, final_through) VALUES ('chc', 'sat', 1, 1, 2024, array_fill(1::real, ARRAY[366]), ARRAY[true], '2024-12-31')`)
		).rejects.toMatchObject({ code: '23514' });
		// Positive control: rnl from 1981, and a final_through of the day before 1 January (its first day preliminary).
		await asOwner(`INSERT INTO chirps_cell_year (origin, product, row_idx, col_idx, year, vals, final, final_through) VALUES ('chc', 'rnl', 1, 1, 1981, array_fill(NULL::real, ARRAY[366]), array_fill(false, ARRAY[366]), '1980-12-31')`);
	});
});

describe('chirps_cache_merge', () => {
	const at = (cells: [number, number][]) => [cells.map((c) => c[0]), cells.map((c) => c[1])];

	it('only a running data-feed job of the caller, still an editor of its project, may call it (positive control: one can)', async () => {
		const owner = await signUp('MergeOwner');
		const other = await signUp('MergeOther');
		const pid = await project(owner);
		const args = ['chc', 'sat', '2024-03-01', 'f', ...at([[1600, 4100]]), [1.5]];
		await expect(merge(owner, args)).rejects.toMatchObject({ code: '42501' });
		// Another person's running job doesn't count, even naming its feed.
		const theirs = await runningJob(other, await project(other, 'Other'));
		await expect(merge(owner, args, theirs.feedId)).rejects.toMatchObject({ code: '42501' });
		// A job of another kind doesn't either.
		const rerun = await runningJob(owner, pid, 'rerun');
		await expect(merge(owner, args)).rejects.toMatchObject({ code: '42501' });
		await asOwner('DELETE FROM job WHERE id = $1', [rerun.jobId]);
		// Nor a running job of another feed: the merge is for the feed whose job is running.
		const mine = await runningJob(owner, pid, 'feed_ingest');
		const another = (await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells: [cell()] }, targetName: 'another' })).body.feed.id as string;
		await expect(merge(owner, args, another)).rejects.toMatchObject({ code: '42501' });
		// Nor a feed of the other product: rnl values never land through a sat feed's job.
		await expect(merge(owner, ['chc', 'rnl', '2024-03-01', 'f', ...at([[1600, 4100]]), [1.5]], mine.feedId)).rejects.toMatchObject({ code: '42501' });
		// Nor a job whose lease ran out (its worker died).
		await asOwner(`UPDATE job SET locked_until = now() - interval '1 second' WHERE id = $1`, [mine.jobId]);
		await expect(merge(owner, args)).rejects.toMatchObject({ code: '42501' });
		await asOwner(`UPDATE job SET locked_until = now() + interval '5 minutes' WHERE id = $1`, [mine.jobId]);
		expect(await cached()).toEqual([]);
		expect((await merge(owner, args)).rows[0]!.n).toBe(1);
		expect((await cached())[0]).toMatchObject({ row_idx: 1600, col_idx: 4100, ft: '2024-12-31' });
		// An owner who is no longer an editor of the job's project: refused again.
		const owner2 = await signUp('MergeOwner2');
		const pid2 = await project(owner2, 'Demoted');
		await owner2.call('POST', `/projects/${pid2}/members`, { email: owner.email, role: 'viewer' });
		await asOwner(`DELETE FROM job WHERE acting_user_id = $1`, [owner.id]);
		await runningJob(owner, pid2, 'feed_fetch', { creator: owner2 });
		await expect(merge(owner, args)).rejects.toMatchObject({ code: '42501' });
	});

	it('refuses, whole, any value outside 0–2000 mm, a day CHIRPS can’t have, and a malformed fetch; writes nothing', async () => {
		const owner = await signUp('MergeChecks');
		const pid = await project(owner);
		await runningJob(owner, pid);
		await runningJob(owner, pid, 'feed_fetch', { product: 'rnl' });
		const one = at([[1600, 4100]]);
		const bad: [string, unknown[]][] = [
			['over 2000 mm', ['chc', 'sat', '2024-03-01', 'ff', ...one, [1, 2000.5]]],
			['negative', ['chc', 'sat', '2024-03-01', 'ff', ...one, [1, -0.5]]],
			['infinite', ['chc', 'sat', '2024-03-01', 'ff', ...one, [1, 'Infinity']]],
			['a day read without a value', ['chc', 'sat', '2024-03-01', 'ff', ...one, [1, null]]],
			['a value on a day not read', ['chc', 'sat', '2024-03-01', 'f-', ...one, [1, 2]]],
			['sat before 1998', ['chc', 'sat', '1997-12-31', 'ff', ...one, [1, 2]]],
			['rnl before 1981', ['chc', 'rnl', '1980-12-31', 'ff', ...one, [1, 2]]],
			['a day after today', ['chc', 'sat', addDays(0), 'ff', ...one, [1, 2]]],
			['a preliminary rnl value', ['chc', 'rnl', '2024-03-01', 'fp', ...one, [1, 2]]],
			['another origin', ['s3', 'sat', '2024-03-01', 'f', ...one, [1]]],
			['an unknown read mark', ['chc', 'sat', '2024-03-01', 'x', ...one, [1]]],
			['too few values', ['chc', 'sat', '2024-03-01', 'ff', ...one, [1]]],
			['a cell off the grid', ['chc', 'sat', '2024-03-01', 'f', [2400], [0], [1]]],
			['cells out of order', ['chc', 'sat', '2024-03-01', 'f', ...at([[1600, 4101], [1600, 4100]]), [1, 1]]],
			['a cell twice', ['chc', 'sat', '2024-03-01', 'f', ...at([[1600, 4100], [1600, 4100]]), [1, 1]]],
			['more than 366 days', ['chc', 'sat', '2023-01-01', 'f'.repeat(367), ...one, new Array(367).fill(1)]]
		];
		for (const [label, args] of bad) await expect(merge(owner, args), label).rejects.toMatchObject({ code: '23514' });
		// Another product than the feed's is refused before anything is read (no CHIRPS feed writes it).
		await expect(merge(owner, ['chc', 'gefs', '2024-03-01', 'f', ...one, [1]], feedOf.get(`${owner.id}:sat`))).rejects.toMatchObject({ code: '42501' });
		expect(await asOwner('SELECT 1 FROM chirps_cell_year')).toEqual([]);
		// Positive control: 0, 2000 and no data (NaN) are values.
		expect((await merge(owner, ['chc', 'sat', '2024-03-01', 'fff', ...one, [0, 2000, 'NaN']])).rows[0]!.n).toBe(3);
		const [r] = await cached();
		expect(r!.vals.slice(doy('2024-03-01'), doy('2024-03-01') + 3)).toEqual([0, 2000, Number.NaN]);
	});

	it('a final value lands on any day not final, never a preliminary one over a final nor a final over a different final; final_through is the day before the first preliminary value', async () => {
		const owner = await signUp('MergeFinals');
		await runningJob(owner, await project(owner));
		const one = at([[1600, 4100]]);
		// Preliminary values for 1–5 March: none final, so final_through is the day before the first, 29 February.
		expect((await merge(owner, ['chc', 'sat', '2024-03-01', 'ppppp', ...one, [9, 9, 9, 9, 9]])).rows[0]!.n).toBe(5);
		expect((await cached())[0]!.ft).toBe('2024-02-29');
		// Finals for 1–3 March replace them, and final_through moves to the 3rd.
		expect((await merge(owner, ['chc', 'sat', '2024-03-01', 'fff', ...one, [1, 2, 3]])).rows[0]!.n).toBe(3);
		let r = (await cached())[0]!;
		expect(r.ft).toBe('2024-03-03');
		expect([r.vals[doy('2024-03-01')], r.vals[doy('2024-03-04')]]).toEqual([1, 9]);
		// Preliminary values again for 1–5 March: the finals stay; 4 and 5 March, still preliminary, take the new ones.
		expect((await merge(owner, ['chc', 'sat', '2024-03-01', 'ppppp', ...one, [7, 7, 7, 8, 8]])).rows[0]!.n).toBe(2);
		r = (await cached())[0]!;
		expect(r.vals.slice(doy('2024-03-01'), doy('2024-03-01') + 5)).toEqual([1, 2, 3, 8, 8]);
		expect(r.ft).toBe('2024-03-03');
		// Their finals: none preliminary is left, so final_through is the year's end.
		await merge(owner, ['chc', 'sat', '2024-03-04', 'ff', ...one, [4, 5]]);
		expect((await cached())[0]!.ft).toBe('2024-12-31');
		// A final rewritten in place (CHC does) doesn't land here: the cached final stays, and its file goes first in the
		// re-check (checked_at NULL), the one path that replaces a final (210, chirps_recheck_apply; recheck.db.test.ts).
		await asOwner(`UPDATE chirps_file SET checked_at = now() WHERE origin = 'chc' AND product = 'sat' AND day = '2024-03-02'`);
		expect((await merge(owner, ['chc', 'sat', '2024-03-02', 'f', ...one, [2.5]])).rows[0]!.n).toBe(0);
		expect((await asOwner(`SELECT checked_at FROM chirps_file WHERE origin = 'chc' AND product = 'sat' AND day = '2024-03-02'`))[0].checked_at).toBeNull();
		// A preliminary value for an empty day before final_through (a gap in the archive) lands, and final_through steps back before it.
		await merge(owner, ['chc', 'sat', '2024-01-10', 'p', ...one, [6]]);
		expect((await cached())[0]!.ft).toBe('2024-01-09');
		// The same answer twice changes nothing.
		expect((await merge(owner, ['chc', 'sat', '2024-01-10', 'p', ...one, [6]])).rows[0]!.n).toBe(0);
		// Finality is per day: the March finals after that preliminary gap are still final, and a preliminary answer leaves them.
		expect((await merge(owner, ['chc', 'sat', '2024-03-01', 'ppppp', ...one, [9, 9, 9, 9, 9]])).rows[0]!.n).toBe(0);
		r = (await cached())[0]!;
		expect(r.vals.slice(doy('2024-03-01'), doy('2024-03-01') + 5)).toEqual([1, 2, 3, 4, 5]);
		// A final for the gap day ends it: final through the year's end again.
		await merge(owner, ['chc', 'sat', '2024-01-10', 'f', ...one, [5]]);
		expect((await cached())[0]!.ft).toBe('2024-12-31');
		// Finals published after a day still preliminary (a late final): each stays final.
		await merge(owner, ['chc', 'sat', '2024-05-01', 'p', ...one, [8]]);
		await merge(owner, ['chc', 'sat', '2024-05-02', 'ff', ...one, [1, 1]]);
		expect((await merge(owner, ['chc', 'sat', '2024-05-01', 'ppp', ...one, [7, 7, 7]])).rows[0]!.n).toBe(1);
		r = (await cached())[0]!;
		expect([r.ft, ...r.vals.slice(doy('2024-05-01'), doy('2024-05-01') + 3)]).toEqual(['2024-04-30', 7, 1, 1]);
	});

	it('two merges at once over shared cells neither deadlock nor lose a final: the final value wins whichever commits last', async () => {
		const a = await signUp('MergeA');
		const b = await signUp('MergeB');
		await runningJob(a, await project(a, 'A'));
		await runningJob(b, await project(b, 'B'));
		for (let round = 0; round < 5; round++) {
			await asOwner('DELETE FROM chirps_cell_year');
			// A writes finals over (1600, 4100–4101), B preliminary values over (1600, 4101–4102): they share 4101.
			await Promise.all([
				merge(a, ['chc', 'sat', '2024-03-01', 'ff', ...at([[1600, 4100], [1600, 4101]]), [1, 1, 2, 2]]),
				merge(b, ['chc', 'sat', '2024-03-01', 'pp', ...at([[1600, 4101], [1600, 4102]]), [9, 9, 9, 9]])
			]);
			const rows = await cached();
			expect(rows.map((r) => [r.col_idx, r.vals[doy('2024-03-01')], r.ft])).toEqual([
				[4100, 1, '2024-12-31'],
				[4101, 2, '2024-12-31'],
				[4102, 9, '2024-02-29']
			]);
		}
	});

	it('a fetch across a year end writes each year’s row, and no row for a year it read no day of', async () => {
		const owner = await signUp('MergeYears');
		await runningJob(owner, await project(owner));
		await merge(owner, ['chc', 'sat', '2023-12-30', 'ff--', ...at([[1600, 4100]]), [1, 2, null, null]]);
		expect((await asOwner('SELECT year FROM chirps_cell_year ORDER BY year')).map((r) => r.year)).toEqual([2023]);
		await merge(owner, ['chc', 'sat', '2023-12-31', 'ff', ...at([[1600, 4100]]), [2, 4]]);
		expect((await asOwner('SELECT year, vals[1] AS jan1, vals[365] AS dec31 FROM chirps_cell_year ORDER BY year'))).toEqual([
			{ year: 2023, jan1: null, dec31: 2 },
			{ year: 2024, jan1: 4, dec31: null }
		]);
	});
});

describe('feeds through the cell cache (FEED_FETCHER=sqs, the fetcher answering from the fixtures)', () => {
	type FetchMsg = { fetchJobId: string; feedId: string; feedVersion: string; request: { start: string; end: string; cells?: { cells: [number, number][]; plan: string } } };
	/** Run the queued feed_fetch the production way and return what it sent, if anything. */
	async function fetchJob(): Promise<FetchMsg | null> {
		vi.stubEnv('FEED_FETCHER', 'sqs');
		vi.stubEnv('FETCH_REQUESTS_QUEUE_URL', 'https://sqs.test/fetch-requests');
		sent.length = 0;
		expect((await tick()).done).toBe(1);
		vi.unstubAllEnvs();
		return (sent[0] as FetchMsg | undefined) ?? null;
	}
	/** Answer a request as the fetcher Lambda would (parsed off the queue, read from the fixture files), or with `result`. */
	async function answer(m: FetchMsg, result?: unknown) {
		const req = parseFetchRequest(JSON.stringify(m));
		if (!req) throw new Error('the fetcher would refuse the request');
		const r = result ?? (await runFetch(req.request, fixtureHttp()));
		expect(await acceptIngestResult({ v: 1, type: 'ingest', fetchJobId: m.fetchJobId, feedId: m.feedId, feedVersion: m.feedVersion, result: r })).toBe('queued');
		expect((await tick()).done).toBe(1);
	}
	async function feed(owner: User, config: Record<string, unknown>) {
		const pid = await project(owner);
		const r = await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config });
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		const feedId = r.body.feed.id as string;
		await owner.call('POST', `/projects/${pid}/feeds/${feedId}/run-now`);
		return { pid, feedId };
	}
	const values = async (u: User, pid: string) => {
		const list = (await u.call('GET', `/projects/${pid}/series`)).body.series as { id: string; kind: string }[];
		const meta = list.find((s) => s.kind === 'rain_chirps_mm');
		return meta ? ((await u.call('GET', `/projects/${pid}/series/${meta.id}`)).body as { startDate: string; values: (number | null)[] }) : null;
	};
	const feedMeta = async (id: string) => (await asOwner('SELECT consecutive_failures, last_error, last_meta FROM data_feed WHERE id = $1', [id]))[0] as Record<string, unknown>;
	const home = () => chcCell(FIXTURE_CELL().lat, FIXTURE_CELL().lon);
	/** Seconds until the feed's queued next fetch (a backfill's next window). */
	const nextIn = async (feedId: string) =>
		(await asOwner(`SELECT ceil(extract(epoch FROM run_after - now()))::int AS s FROM job WHERE kind = 'feed_fetch' AND status = 'queued' AND payload->>'feedId' = $1`, [feedId]))[0]
			?.s as number;

	it('a second project’s feed over the same cells fetches nothing (a cache hit), and gets the same days', async () => {
		// 2000-01-01 + 119 days, rnl: every day final, long published.
		const config = { cells: [cell()], product: 'rnl', startDate: '2000-01-01' };
		const a = await signUp('FirstProject');
		const fa = await feed(a, config);
		const m = (await fetchJob())!;
		expect(m.request).toMatchObject({ start: '2000-01-01', end: '2000-04-29', cells: { cells: [[home().row, home().col]], plan: '0'.repeat(120) } });
		await answer(m);
		const first = (await values(a, fa.pid))!;
		expect(first.values).toHaveLength(120);
		expect((await feedMeta(fa.feedId)).last_meta).toMatchObject({ days: 120, cellDaysRead: 120, finalThrough: '2000-04-29' });
		// The backfill goes on: a window that read the source waits a minute (BACKFILL_NEXT_SECONDS).
		expect(await nextIn(fa.feedId)).toBeGreaterThan(50);

		const b = await signUp('SecondProject');
		const fb = await feed(b, config);
		// Nothing to read: no request goes out, and the days are computed from the cache in the fetch job itself.
		expect(await fetchJob()).toBeNull();
		expect((await values(b, fb.pid))!.values).toEqual(first.values);
		expect(await feedMeta(fb.feedId)).toMatchObject({ consecutive_failures: 0, last_meta: { days: 120, cellDaysRead: 0, daysRead: 0, finalThrough: '2000-04-29', through: '2000-04-29' } });
		// That counted as its newest fetch: nothing is waiting for an answer.
		expect((await asOwner('SELECT fetch_job_id FROM data_feed WHERE id = $1', [fb.feedId]))[0].fetch_job_id).toBeNull();
		// It asked the source for nothing, so its backfill goes on in seconds (CACHED_NEXT_SECONDS), not a minute.
		expect(await nextIn(fb.feedId)).toBeLessThanOrEqual(5);
	});

	it('a partial hit reads only the cell the cache lacks, and the mean is the one reading both from the files gives', async () => {
		const config = { cells: [cell()], product: 'rnl', startDate: '2000-01-01' };
		const a = await signUp('PartialFirst');
		await feed(a, config);
		await answer((await fetchJob())!);

		const both = { cells: [cell(), { ...east(), weight: 3 }], product: 'rnl', startDate: '2000-01-01' };
		const b = await signUp('PartialSecond');
		const fb = await feed(b, both);
		const m = (await fetchJob())!;
		const e = chcCell(east().lat, east().lon);
		expect(m.request.cells).toEqual({ cells: [[e.row, e.col]], plan: '0'.repeat(120) });
		await answer(m);
		const direct = await runFetch({ source: 'chirps', config: both as never, start: '2000-01-01', end: '2000-04-29', today: addDays(0) }, fixtureHttp());
		expect(direct.ok && 'values' in direct).toBe(true);
		expect((await values(b, fb.pid))!.values).toEqual((direct as { values: number[] }).values);
		expect((await feedMeta(fb.feedId)).last_meta).toMatchObject({ days: 120, cellDaysRead: 120 });
	});

	it('preliminary → final: a held preliminary day asks only for its final file, and the final replaces it in the cache and the series', async () => {
		const u = await signUp('PrelimFinal');
		// The start date is the floor of every window, so each fetch here asks for the same 60 days.
		const f = await feed(u, { cells: [cell()], startDate: addDays(-60) });
		const m = (await fetchJob())!;
		expect(m.request).toMatchObject({ start: addDays(-60), end: addDays(-1), cells: { plan: '0'.repeat(60) } });
		const cells: [number, number][] = [[home().row, home().col]];
		const reply = (msg: FetchMsg, read: string, mm: (number | null)[]) => ({
			ok: true,
			cells: { product: 'sat', startDate: msg.request.start, read, cells, values: [mm.map(encodeCellValue)] },
			meta: {}
		});
		// The first ten days preliminary at 3 mm, the rest not out yet.
		await answer(m, reply(m, `${'p'.repeat(10)}${'-'.repeat(50)}`, [...new Array(10).fill(3), ...new Array(50).fill(null)]));
		expect((await values(u, f.pid))!.values).toEqual(new Array(10).fill(3));
		expect((await feedMeta(f.feedId)).last_meta).toMatchObject({ prelimDays: 10 });
		expect((await feedMeta(f.feedId)).last_meta).not.toHaveProperty('finalThrough');

		await u.call('POST', `/projects/${f.pid}/feeds/${f.feedId}/run-now`);
		const next = (await fetchJob())!;
		// The ten held days need only their final files; the rest are read.
		expect(next.request).toMatchObject({ start: addDays(-60), cells: { plan: `${'2'.repeat(10)}${'0'.repeat(50)}` } });
		await answer(next, reply(next, `${'f'.repeat(10)}${'-'.repeat(50)}`, [...new Array(10).fill(2), ...new Array(50).fill(null)]));
		expect((await values(u, f.pid))!.values).toEqual(new Array(10).fill(2));
		expect((await feedMeta(f.feedId)).last_meta).toMatchObject({ prelimDays: 0, finalThrough: addDays(-51) });

		// The next window starts after the final days (#69); the function test above shows a preliminary value never replaces them.
		await u.call('POST', `/projects/${f.pid}/feeds/${f.feedId}/run-now`);
		expect((await fetchJob())!.request).toMatchObject({ start: addDays(-50), cells: { plan: '0'.repeat(50) } });
		// In the cache: the ten days final at 2 mm, and no preliminary value left, so each row final through its year's end.
		for (let d = -60; d < -50; d++) {
			const day = addDays(d);
			const [r] = await asOwner(
				`SELECT vals[$2] AS v, to_char(final_through, 'MM-DD') AS ft FROM chirps_cell_year WHERE origin = 'chc' AND product = 'sat' AND year = $1`,
				[Number(day.slice(0, 4)), doy(day) + 1]
			);
			expect(r, day).toEqual({ v: 2, ft: '12-31' });
		}
	});

	it('refuses an answer with a value past 2000 mm, a cell the feed doesn’t read, or another product: nothing is cached or written', async () => {
		const u = await signUp('BadAnswers');
		const f = await feed(u, { cells: [cell()] });
		const cells: [number, number][] = [[home().row, home().col]];
		const e = chcCell(east().lat, east().lon);
		for (const [label, over] of [
			['a value past 2000 mm', { values: [[CELL_VALUE_MAX_BITS + 1]] }],
			['a cell the feed doesn’t read', { cells: [[e.row, e.col]] }],
			['the other product', { product: 'rnl', read: 'f' }]
		] as const) {
			await u.call('POST', `/projects/${f.pid}/feeds/${f.feedId}/run-now`);
			const m = (await fetchJob())!;
			await answer(m, { ok: true, cells: { product: 'sat', startDate: m.request.start, read: 'p', cells, values: [[encodeCellValue(1)]], ...over }, meta: {} });
			expect(await feedMeta(f.feedId), label).toMatchObject({ last_error: 'the fetcher’s answer was not valid, so nothing was written' });
		}
		// Days outside the window it asked for, or after the newest CHIRPS can have: refused whole, with the window's own messages.
		await u.call('POST', `/projects/${f.pid}/feeds/${f.feedId}/run-now`);
		const m = (await fetchJob())!;
		const before = new Date(Date.parse(m.request.start) - 86_400_000).toISOString().slice(0, 10);
		await answer(m, { ok: true, cells: { product: 'sat', startDate: before, read: 'pp', cells, values: [[encodeCellValue(1), encodeCellValue(1)]] }, meta: {} });
		expect((await feedMeta(f.feedId)).last_error).toBe(`the fetcher’s answer had days outside ${m.request.start} to ${m.request.end}, the days it was asked for, so nothing was written`);
		await u.call('POST', `/projects/${f.pid}/feeds/${f.feedId}/run-now`);
		const n = (await fetchJob())!;
		await answer(n, { ok: true, cells: { product: 'sat', startDate: addDays(0), read: 'pp', cells, values: [[encodeCellValue(1), encodeCellValue(1)]] }, meta: {} });
		expect((await feedMeta(f.feedId)).last_error).toBe(`the fetcher’s answer had days after ${addDays(0)}, so nothing was written`);
		expect(await asOwner('SELECT 1 FROM chirps_cell_year')).toEqual([]);
		expect(await values(u, f.pid)).toBeNull();
	});

	it('merges an answer whatever order its cells come in (the lock order is the worker’s), each cell’s values its own', async () => {
		const u = await signUp('CellOrder');
		const f = await feed(u, { cells: [cell(), east()], startDate: addDays(-3) });
		const m = (await fetchJob())!;
		const e = chcCell(east().lat, east().lon);
		const days = m.request.cells!.plan.length;
		const row = (mm: number) => new Array(days).fill(encodeCellValue(mm));
		// East first, then home: the reverse of (row, column) order.
		await answer(m, { ok: true, cells: { product: 'sat', startDate: m.request.start, read: 'p'.repeat(days), cells: [[e.row, e.col], [home().row, home().col]], values: [row(4), row(2)] }, meta: {} });
		expect((await cached(Number(m.request.start.slice(0, 4)))).map((r) => [r.col_idx, r.vals[doy(m.request.start)]])).toEqual([
			[home().col, 2],
			[e.col, 4]
		]);
		expect((await values(u, f.pid))!.values[0]).toBe(3);
	});

	it('a late answer to a fetch sent before a cache-only fetch is dropped: the cache-only fetch was the feed’s newest', async () => {
		const config = { cells: [cell()], product: 'rnl', startDate: '2000-01-01' };
		const y = await signUp('LateY');
		const fy = await feed(y, config);
		// Y's first fetch goes out while the cache is empty; its answer is still on the way.
		const inFlight = (await fetchJob())!;
		// Another project fills the cache for the same cell and days.
		const x = await signUp('LateX');
		await feed(x, config);
		await answer((await fetchJob())!);
		// Y again: nothing to read, so no request, and the days from the cache.
		await y.call('POST', `/projects/${fy.pid}/feeds/${fy.feedId}/run-now`);
		expect(await fetchJob()).toBeNull();
		const after = await asOwner('SELECT last_attempt_at, last_meta FROM data_feed WHERE id = $1', [fy.feedId]);
		// The old answer arrives: it names a real fetch job, so it is queued, and then dropped without touching the feed.
		await answer(inFlight, { ok: true, cells: { product: 'rnl', startDate: '2000-01-01', read: 'f', cells: [[home().row, home().col]], values: [[encodeCellValue(99)]] }, meta: {} });
		expect(await asOwner('SELECT last_attempt_at, last_meta FROM data_feed WHERE id = $1', [fy.feedId])).toEqual(after);
		expect((await cached(2000)).length).toBe(0); // sat rows: none; the rnl row keeps its value
		expect((await asOwner(`SELECT vals[1] AS v FROM chirps_cell_year WHERE product = 'rnl' AND year = 2000`))[0].v).not.toBe(99);
	});

	it('a listed sea cell, or a box over the sea that doesn’t leave it out, fails through the cache as it did reading the files', async () => {
		const u = await signUp('SeaCells');
		const f = await feed(u, { cells: [{ lat: -20.27, lon: 25.37, weight: 1 }], startDate: addDays(-45) });
		await answer((await fetchJob())!);
		expect(await feedMeta(f.feedId)).toMatchObject({ consecutive_failures: 1, last_error: expect.stringMatching(/no data at -20.27, 25.37/) });
		expect(await values(u, f.pid)).toBeNull();
		const v = await signUp('SeaBox');
		const g = await feed(v, { bbox: { south: -20.3, west: 25.35, north: -20.25, east: 25.4 }, startDate: addDays(-45) });
		await answer((await fetchJob())!);
		expect(await feedMeta(g.feedId)).toMatchObject({ consecutive_failures: 1, last_error: expect.stringMatching(/inside the bounding box: shrink the box to the land/) });
	});

	it('an answer the merge function refuses is rolled back to before it and recorded as a failed fetch, not a job that dies retrying', async () => {
		const u = await signUp('RefusedMerge');
		const f = await feed(u, { cells: [cell()] });
		await asOwner(`DELETE FROM job WHERE kind = 'feed_fetch'`);
		await runningJob(u, f.pid, 'feed_fetch', { feedId: f.feedId });
		// A window before sat begins (no feed asks for one: this is the function's own check, under the ingest's).
		const window = { start: '1997-12-30', end: '1998-01-02' };
		const cells: [number, number][] = [[home().row, home().col]];
		await withUser(u.id, async (db) => {
			const row = (await feedForJob(db, f.pid, f.feedId))!;
			await ingestResult(db, row, { ok: true, cells: { product: 'sat', startDate: window.start, read: 'ffff', cells, values: [[1, 1, 1, 1].map(encodeCellValue)] }, meta: {} }, window, { origin: 'chc' });
		});
		expect(await feedMeta(f.feedId)).toMatchObject({ consecutive_failures: 1, last_error: 'the fetcher’s answer was not valid, so nothing was written' });
		expect(await asOwner('SELECT 1 FROM chirps_cell_year')).toEqual([]);
	});

	it('values from the fixtures are never served to a live feed: the cache keeps each origin apart', async () => {
		const u = await signUp('Origins');
		const f = await feed(u, { cells: [cell()], product: 'rnl', startDate: '2000-01-01' });
		// Inline, on the fixtures (the local default).
		expect((await tick()).done).toBe(1);
		expect((await asOwner('SELECT DISTINCT origin FROM chirps_cell_year')).map((r) => r.origin)).toEqual(['fixtures']);
		await u.call('PATCH', `/projects/${f.pid}/feeds/${f.feedId}`, { config: { cells: [cell()], product: 'rnl', startDate: '2000-01-01', staleAfterDays: 30 } });
		await u.call('POST', `/projects/${f.pid}/feeds/${f.feedId}/run-now`);
		// Production's path reads the live cache, which holds none of it: every day is read.
		expect((await fetchJob())!.request.cells!.plan).toBe('0'.repeat(120));
		// Positive control: the inline path on the fixtures reads them again, and has nothing to fetch.
		await u.call('POST', `/projects/${f.pid}/feeds/${f.feedId}/run-now`);
		await asOwner(`DELETE FROM job WHERE kind = 'feed_fetch'`);
		await u.call('PATCH', `/projects/${f.pid}/feeds/${f.feedId}`, { config: { cells: [cell()], product: 'rnl', startDate: '2000-01-01' } });
		await u.call('POST', `/projects/${f.pid}/feeds/${f.feedId}/run-now`);
		expect((await tick()).done).toBe(1);
		expect(await feedMeta(f.feedId)).toMatchObject({ consecutive_failures: 0, last_meta: { days: 120, cellDaysRead: 0 } });
	});
});
