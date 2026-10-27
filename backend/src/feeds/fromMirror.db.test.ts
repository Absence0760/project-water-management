// A CHIRPS feed fetch read from our own copy of CHIRPS (fromMirror.ts, issue
// #604 R2-C), end to end through the job queue: the fill, a copy that is
// behind (the days it holds fill, the rest wait, with no failure), no copy
// at all, a cell outside the copy's region, preliminary → final, one window
// per job, and FEED_FETCHER=sqs sending nothing to the fetcher.
//
// Most tests read a private copy of the committed fixture copy as a live copy
// (FEED_SOURCE=live, MIRROR_URL=file://…), so its days are its own and a test
// can hold it back or move it on; the last reads the committed copy in
// fixtures mode, re-dated to today, against the files it was made from.
//
// DB test files run one at a time; this one removes every feed, feed job and
// cached cell after each test.
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sent } = vi.hoisted(() => ({ sent: [] as unknown[] }));
vi.mock('../jobs/transport.js', async (orig) => ({
	...(await orig<typeof import('../jobs/transport.js')>()),
	sendToQueue: async (_url: string | undefined, _name: string, message: unknown) => void sent.push(message)
}));
import { MIRROR_FIXTURE_DIR } from '../../scripts/gen-mirror-fixture.js';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { runTick } from '../jobs/runner.js';
import { ensureFinals, openFinals, readFinalsBlock, writeFinalsYear } from '../mirror/arrays.js';
import { mirrorCell } from '../mirror/grid.js';
import { readManifest, writeManifest } from '../mirror/manifest.js';
import { readCells } from '../mirror/readCells.js';
import { openStore } from '../mirror/store.js';
import { chcCell, decodeCellValue } from './cellCache.js';
import { runFetch } from './fetch.js';
import { FIXTURE_CELL, fixtureHttp } from './fixtures.js';
import { MIRROR_TAG } from './fromMirror.js';

type User = Awaited<ReturnType<typeof signUp>>;

const tmp: string[] = [];
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));
afterEach(async () => {
	sent.length = 0;
	vi.unstubAllEnvs();
	await asOwner('DELETE FROM data_feed');
	await asOwner(`DELETE FROM job WHERE kind IN ('feed_fetch', 'feed_ingest')`);
	await asOwner('DELETE FROM chirps_cell_year');
	await asOwner('DELETE FROM chirps_file');
	await asOwner('DELETE FROM chirps_cell_stale');
	await asOwner('DELETE FROM chirps_revision');
});

/** A private copy of the committed fixture copy, read as a live copy: finals 2023–2025, preliminary sat days 2026-01-01 … 2026-02-06. */
function liveCopy() {
	const dir = mkdtempSync(join(tmpdir(), 'wm-mirror-'));
	tmp.push(dir);
	cpSync(MIRROR_FIXTURE_DIR, dir, { recursive: true });
	const url = pathToFileURL(`${dir}/`).href;
	vi.stubEnv('CHIRPS_SOURCE', 'mirror');
	vi.stubEnv('FEED_SOURCE', 'live');
	vi.stubEnv('MIRROR_URL', url);
	return openStore(url);
}
beforeEach(() => vi.stubEnv('CHIRPS_SOURCE', 'mirror'));

const tick = () => runTick({ feeds: false, reports: false, alerts: false });
const home = () => chcCell(FIXTURE_CELL().lat, FIXTURE_CELL().lon);
const add = (iso: string, n: number) => fromEpochDay(toEpochDay(iso) + n);

async function feed(owner: User, config: Record<string, unknown>) {
	const pid = (await owner.call('POST', '/projects', { name: 'From the copy' })).body.project.id as string;
	const r = await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config });
	expect(r.status, JSON.stringify(r.body)).toBe(201);
	const feedId = r.body.feed.id as string;
	await owner.call('POST', `/projects/${pid}/feeds/${feedId}/run-now`);
	return { pid, feedId };
}
const series = async (u: User, pid: string) => {
	const list = (await u.call('GET', `/projects/${pid}/series`)).body.series as { id: string; kind: string }[];
	const meta = list.find((s) => s.kind === 'rain_chirps_mm');
	return meta ? ((await u.call('GET', `/projects/${pid}/series/${meta.id}`)).body as { startDate: string; values: (number | null)[] }) : null;
};
const feedRow = async (id: string) =>
	(await asOwner('SELECT consecutive_failures, last_error, last_meta, last_attempt_at, fetch_job_id, to_char(last_data_date, $2) AS last_data_date FROM data_feed WHERE id = $1', [id, 'YYYY-MM-DD']))[0] as {
		consecutive_failures: number;
		last_error: string | null;
		last_meta: Record<string, unknown> | null;
		last_attempt_at: Date | null;
		fetch_job_id: string | null;
		last_data_date: string | null;
	};
/** Seconds until the feed's queued next fetch (a backfill's next window), or undefined when none is queued. */
const nextIn = async (feedId: string) =>
	(await asOwner(`SELECT ceil(extract(epoch FROM run_after - now()))::int AS s FROM job WHERE kind = 'feed_fetch' AND status = 'queued' AND payload->>'feedId' = $1`, [feedId]))[0]?.s as
		| number
		| undefined;
/** Run the queued fetch now. */
async function runNext(feedId: string) {
	await asOwner(`UPDATE job SET run_after = now() WHERE kind = 'feed_fetch' AND status = 'queued' AND payload->>'feedId' = $1`, [feedId]);
	expect((await tick()).done).toBe(1);
}
/** The cache's days of a cell-year: how many hold a value, and how many of those are final. */
const cachedDays = async (origin: string, product: string, year: number) =>
	(
		await asOwner(
			`SELECT count(v) FILTER (WHERE v IS NOT NULL)::int AS held, count(*) FILTER (WHERE v IS NOT NULL AND f)::int AS final
			 FROM chirps_cell_year r, unnest(r.vals, r.final) AS x(v, f) WHERE origin = $1 AND product = $2 AND year = $3 AND row_idx = $4 AND col_idx = $5`,
			[origin, product, year, home().row, home().col]
		)
	)[0] as { held: number; final: number };
/** The copy's own values of the fixture cell, as the series takes them (one cell, weight 1: the day is the cell's value, to 0.01 mm, meanOf). */
async function copyValues(store: ReturnType<typeof openStore>, product: 'sat' | 'rnl', start: string, end: string) {
	const r = await readCells(store, product, [home()], { start, end });
	return { read: r.cells.read, values: r.cells.values[0]!.map((v) => (v === null ? null : Math.round(decodeCellValue(v)! * 100) / 100)) };
}

describe('a CHIRPS feed reads our copy (CHIRPS_SOURCE=mirror)', () => {
	it('fills from the copy in the job, one window per job, the next window in seconds; the cache is chc and tagged as the copy’s', async () => {
		const store = liveCopy();
		const owner = await signUp('MirrorFill');
		const f = await feed(owner, { cells: [{ ...FIXTURE_CELL(), weight: 1 }], product: 'rnl', startDate: '2024-01-01' });
		expect((await tick()).done).toBe(1);
		// Nothing went to the fetcher; the job merged and computed the days itself.
		expect(sent).toEqual([]);
		expect((await asOwner(`SELECT count(*)::int AS n FROM job WHERE kind = 'feed_ingest'`))[0].n).toBe(0);
		const want = await copyValues(store, 'rnl', '2024-01-01', '2024-04-29');
		expect(want.read).toBe('f'.repeat(120));
		const got = (await series(owner, f.pid))!;
		expect(got.startDate).toBe('2024-01-01');
		expect(got.values).toEqual(want.values);
		expect(await feedRow(f.feedId)).toMatchObject({
			consecutive_failures: 0,
			last_error: null,
			last_meta: { days: 120, daysRead: 120, cellDaysRead: 120, finalThrough: '2024-04-29', through: '2024-04-29', product: 'rnl' }
		});
		// One window per job: the cache holds only that window's 120 days of 2024, as the copy's finals, as origin chc.
		expect(await cachedDays('chc', 'rnl', 2024)).toEqual({ held: 120, final: 120 });
		expect(await cachedDays('fixtures', 'rnl', 2024)).toEqual({ held: 0, final: 0 });
		const tags = (await asOwner(`SELECT DISTINCT tag FROM chirps_file WHERE origin = 'chc' AND product = 'rnl'`)) as { tag: string }[];
		expect(tags).toEqual([{ tag: MIRROR_TAG }]);
		// The backfill goes on in seconds (CACHED_NEXT_SECONDS), not a minute: nothing was asked of CHC.
		expect(await nextIn(f.feedId)).toBeLessThanOrEqual(5);
		await runNext(f.feedId);
		expect(await cachedDays('chc', 'rnl', 2024)).toEqual({ held: 240, final: 240 });
		expect((await feedRow(f.feedId)).last_meta).toMatchObject({ through: '2024-08-27', daysRead: 120 });
	});

	it('with FEED_FETCHER=sqs sends no FetchRequest: it reads the copy itself, and counts as the feed’s newest fetch', async () => {
		liveCopy();
		vi.stubEnv('FEED_FETCHER', 'sqs');
		vi.stubEnv('FETCH_REQUESTS_QUEUE_URL', 'https://sqs.test/fetch-requests');
		const owner = await signUp('MirrorSqs');
		const f = await feed(owner, { cells: [{ ...FIXTURE_CELL(), weight: 1 }], product: 'sat', startDate: '2025-06-01' });
		expect((await tick()).done).toBe(1);
		expect(sent).toEqual([]);
		expect((await series(owner, f.pid))!.values).toHaveLength(120);
		expect(await feedRow(f.feedId)).toMatchObject({ consecutive_failures: 0, last_error: null, fetch_job_id: null, last_meta: { daysRead: 120 } });
	});

	it('a copy that is behind: the days it holds fill, the rest wait unread, with no failure and no backoff, and fill once the copy has them', async () => {
		const store = liveCopy();
		// The copy's sat finals stop on 20 December; its preliminary days start in January: 21–31 December is a gap.
		const m = (await readManifest(store, 'sat'))!;
		await writeManifest(store, { ...m, finalThrough: '2025-12-20' });
		const owner = await signUp('MirrorBehind');
		const f = await feed(owner, { cells: [{ ...FIXTURE_CELL(), weight: 1 }], product: 'sat', startDate: '2025-11-01' });
		expect((await tick()).done).toBe(1);
		const got = (await series(owner, f.pid))!;
		// 2025-11-01 … 2026-02-06: 50 final days, 11 not held, 37 preliminary; nothing after.
		expect(got.values).toHaveLength(98);
		expect(got.values.slice(0, 50).every((v) => v !== null)).toBe(true);
		expect(got.values.slice(50, 61).every((v) => v === null)).toBe(true);
		expect(got.values.slice(61).every((v) => v !== null)).toBe(true);
		const row = await feedRow(f.feedId);
		expect(row).toMatchObject({ consecutive_failures: 0, last_error: null, last_data_date: '2026-02-06', last_meta: { finalThrough: '2025-12-20', prelimDays: 37, daysRead: 87 } });
		expect(await cachedDays('chc', 'sat', 2025)).toEqual({ held: 50, final: 50 });

		// The copy catches up: the next fetch (from the day after the feed's finals) reads the rest of December.
		await writeManifest(store, m);
		await runNext(f.feedId);
		const after = (await series(owner, f.pid))!;
		expect(after.values.slice(0, 61)).toEqual((await copyValues(store, 'sat', '2025-11-01', '2025-12-31')).values);
		expect(await feedRow(f.feedId)).toMatchObject({ consecutive_failures: 0, last_error: null, last_meta: { finalThrough: '2025-12-31' } });
		expect(await cachedDays('chc', 'sat', 2025)).toEqual({ held: 61, final: 61 });
	});

	it('no copy yet: nothing written and no failure recorded, only the attempt; the window stays where it was', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'wm-mirror-empty-'));
		tmp.push(dir);
		vi.stubEnv('FEED_SOURCE', 'live');
		vi.stubEnv('MIRROR_URL', pathToFileURL(`${dir}/`).href);
		const owner = await signUp('MirrorNotReady');
		const f = await feed(owner, { cells: [{ ...FIXTURE_CELL(), weight: 1 }], product: 'sat', startDate: '2025-06-01' });
		expect((await tick()).done).toBe(1);
		expect(await series(owner, f.pid)).toBeNull();
		const row = await feedRow(f.feedId);
		expect(row).toMatchObject({ consecutive_failures: 0, last_error: null, last_meta: null, last_data_date: null });
		expect(row.last_attempt_at).not.toBeNull();
		// No next window queued: the scheduler tries again on the feed's schedule, from the same start.
		expect(await nextIn(f.feedId)).toBeUndefined();
		expect(sent).toEqual([]);
	});

	it('refuses a cell outside the copy’s region, naming the region, as a failure of the feed’s config; nothing is read or cached', async () => {
		liveCopy();
		const owner = await signUp('MirrorOutside');
		const f = await feed(owner, { cells: [{ lat: -5, lon: 30, weight: 1 }], product: 'sat', startDate: '2025-06-01' });
		expect((await tick()).done).toBe(1);
		const row = await feedRow(f.feedId);
		expect(row.consecutive_failures).toBe(1);
		expect(row.last_error).toContain('the point -5.025, 30.025 is outside the region the rain data copy holds (10–41° E, 8–35.5° S)');
		expect((await asOwner('SELECT count(*)::int AS n FROM chirps_cell_year'))[0].n).toBe(0);
		expect(await series(owner, f.pid)).toBeNull();
	});

	it('a stale day (a revision of the copy) is read again from the copy and replaces the cached final, logged, and the series follows', async () => {
		const store = liveCopy();
		const owner = await signUp('MirrorStale');
		const f = await feed(owner, { cells: [{ ...FIXTURE_CELL(), weight: 1 }], product: 'rnl', startDate: '2024-01-01' });
		expect((await tick()).done).toBe(1);
		const before = (await series(owner, f.pid))!;
		// The copy's 10 February 2024 changes at the fixture cell, and the day is marked stale (as app_mirror_apply_revision does).
		const at = mirrorCell(home());
		const block = { y0: at.y, x0: at.x, h: 1, w: 1 };
		const finals = (await openFinals(store, 'rnl'))!;
		const year = (await readFinalsBlock(finals, 2024, 0, 365, block)).values.slice();
		year[40] = 7.75;
		await writeFinalsYear(finals, 2024, block, year);
		// Marked before the fetch job that re-reads it was queued (246's race rule keeps a mark made after: that job may have read before it).
		await asOwner(
			`INSERT INTO chirps_cell_stale (origin, product, row_idx, col_idx, day, marked_at) VALUES ('chc', 'rnl', $1, $2, '2024-02-10', now() - interval '1 hour')`,
			[home().row, home().col]
		);

		await runNext(f.feedId);
		const after = (await series(owner, f.pid))!;
		expect(after.values[40]).toBe(7.75);
		expect(after.values.slice(0, 40)).toEqual(before.values.slice(0, 40));
		const logged = (await asOwner(`SELECT to_char(day, 'YYYY-MM-DD') AS day, cells_changed, tag_after FROM chirps_revision WHERE origin = 'chc' AND product = 'rnl'`)) as unknown[];
		expect(logged).toEqual([{ day: '2024-02-10', cells_changed: 1, tag_after: MIRROR_TAG }]);
		expect((await asOwner('SELECT count(*)::int AS n FROM chirps_cell_stale'))[0].n).toBe(0);
		expect((await feedRow(f.feedId)).last_meta).toMatchObject({ recheckDaysRead: 1, filesChecked: 0 });
	});

	it('preliminary → final: a day read preliminary is replaced by the final once the copy has it, in the cache and the series', async () => {
		const store = liveCopy();
		const owner = await signUp('MirrorPrelim');
		const f = await feed(owner, { cells: [{ ...FIXTURE_CELL(), weight: 1 }], product: 'sat', startDate: '2025-12-15' });
		expect((await tick()).done).toBe(1);
		// 2025-12-15 … 2026-02-06: 17 final days, then 37 preliminary.
		const before = (await series(owner, f.pid))!;
		expect(before.values).toHaveLength(54);
		expect((await feedRow(f.feedId)).last_meta).toMatchObject({ prelimDays: 37 });
		expect(await cachedDays('chc', 'sat', 2026)).toEqual({ held: 37, final: 0 });

		// The copy's January 2026 finals land: 2.5 mm a day at the fixture cell.
		const at = mirrorCell(home());
		const block = { y0: at.y, x0: at.x, h: 1, w: 1 };
		const values = new Float32Array(366).fill(Number.NaN);
		values.fill(2.5, 0, 31);
		await writeFinalsYear(await ensureFinals(store, 'sat', 2026), 2026, block, values);
		const m = (await readManifest(store, 'sat'))!;
		const january = { ...m.files.at(-1)!, url: m.files.at(-1)!.url.replace('2025.12', '2026.01') };
		await writeManifest(store, { ...m, years: { ...m.years, last: 2026 }, finalThrough: '2026-01-31', files: [...m.files, january] });

		await runNext(f.feedId);
		const after = (await series(owner, f.pid))!;
		expect(after.values.slice(17, 48)).toEqual(new Array(31).fill(2.5));
		// December's finals and February's preliminary days stay as they were.
		expect(after.values.slice(0, 17)).toEqual(before.values.slice(0, 17));
		expect(after.values.slice(48)).toEqual(before.values.slice(48));
		expect(await feedRow(f.feedId)).toMatchObject({ consecutive_failures: 0, last_meta: { finalThrough: '2026-01-31', prelimDays: 6 } });
		expect(await cachedDays('chc', 'sat', 2026)).toEqual({ held: 37, final: 31 });
	});

	it('fixtures mode: the committed copy, re-dated to today, gives the feed the days reading the fixture files gives it', async () => {
		// FEED_SOURCE unset: fixtures, and MIRROR_URL unset: the committed copy.
		const today = new Date().toISOString().slice(0, 10);
		const start = add(today, -60);
		const config = { cells: [{ ...FIXTURE_CELL(), weight: 1 }, { lat: -33.7, lon: 21.3, weight: 3 }], product: 'sat', startDate: start };
		const owner = await signUp('MirrorFixtures');
		const f = await feed(owner, config);
		expect((await tick()).done).toBe(1);
		const direct = await runFetch({ source: 'chirps', config: config as never, start, end: add(today, -1), today }, fixtureHttp());
		expect(direct.ok && 'values' in direct).toBe(true);
		const d = direct as { startDate: string; values: number[]; meta: Record<string, unknown> };
		const got = (await series(owner, f.pid))!;
		expect(got.startDate).toBe(d.startDate);
		expect(got.values).toEqual(d.values);
		expect((await feedRow(f.feedId)).last_meta).toMatchObject({ finalThrough: d.meta.finalThrough, prelimDays: d.meta.prelimDays });
		// The committed copy fills the fixtures rows, never chc.
		expect((await asOwner(`SELECT count(*)::int AS n FROM chirps_cell_year WHERE origin = 'chc'`))[0].n).toBe(0);
		expect((await asOwner(`SELECT count(*)::int AS n FROM chirps_cell_year WHERE origin = 'fixtures'`))[0].n).toBeGreaterThan(0);
	});
});
