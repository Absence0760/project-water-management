// A CHIRPS feed fetch read from our own copy of CHIRPS (issue #604 R2-C,
// design D3; docs/architecture.md § Data feeds → The rain data copy), when
// CHIRPS_SOURCE=mirror (mirror/source.ts chirpsSource: the default in dev, CI
// and e2e; production stays on chc until the cutover, R3-C).
//
// The cell cache stays the hot store (208_chirps_cell_cache); only what fills
// it changes. The feed_fetch job plans as before (cellCache.ts planFetch), then
// reads the cells and days the cache lacks straight from the copy
// (mirror/readCells.ts), in the job, and merges them through
// chirps_cache_merge (feeds/ingest.ts fromCells) in the same transaction.
// There is no FetchRequest and no SQS round trip, whatever FEED_FETCHER says.
// One job reads one fetch window (fetch.ts fetchWindow, at most
// CHIRPS_MAX_DAYS = 120 days, so never more than a year: the copy is read
// inside the job's transaction, and this keeps it bounded); a backfill's next
// window follows in CACHED_NEXT_SECONDS, as when the cache held the window.
//
// What the copy doesn't hold:
//   * A day past its finals or preliminary days (or in a gap) reads as `-`:
//     not read, exactly as a day CHC hasn't published. The feed's other days
//     merge, and a later fetch reads the day once the copy has it.
//   * No manifest at all (MirrorNotReadyError): the copy is behind, not the
//     feed broken. The fetch writes nothing and records only that it looked
//     (last_attempt_at): no failure, so no backoff (242/243) and no change to
//     the feed's health, and its window doesn't move, so the next scheduled
//     fetch asks for the same days.
//   * A cell outside the copy's region (mirror/grid.ts MirrorOutsideRegionError)
//     is the feed's config: a failure naming the region, before anything is read.
//
// The re-check of cached finals (210) keeps only its re-reads: a day marked
// stale (a revision of the copy, 245 app_mirror_apply_revision) is read again
// from the copy and applied through chirps_recheck_apply. No file is HEADed:
// the copy's manifests say what changed. Each final read from the copy carries
// the tag MIRROR_TAG, so a cached final is never "untagged" and re-read for
// nothing.
//
// The cache origin follows FEED_SOURCE: `chc` for a live copy (values copied
// from CHC's own files, D10), `fixtures` for the committed synthetic copy.
//
// Fixtures mode (FEED_SOURCE=fixtures) re-dates the copy as fixtureHttp
// re-dates its files (feeds/fixtures.ts): the committed copy is fixed at
// 2026-02-09, but a feed in dev or e2e asks for days up to yesterday. A day is
// final, preliminary or unpublished by the fixture files' own lags from today
// (chirps-sample.json), and its values are read from a day of the copy of the
// same kind whose date is a whole number of the pattern's 14 days away, which
// holds the same values (fixtureDay). A cell of the files' cover outside their
// 8 × 6 grid repeats a grid cell with no sea, and is read from the copy's band
// south of the grid that holds that repeat (fixtureSourceCell;
// scripts/gen-mirror-fixture.ts). So the feeds screens show the values the
// files gave. FEED_FIXTURE_REWRITE doesn't reach the copy: a revision of the
// copy is a manifest's (mirror-tick, R2-D). A live copy is never shifted.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import type { Db } from '../db/tx.js';
import { feedFetcher } from '../jobs/transport.js';
import { type FinalsProduct, openDaily } from '../mirror/arrays.js';
import { MIRROR_REGION, mirrorCell } from '../mirror/grid.js';
import { finalsCoverage, readManifest } from '../mirror/manifest.js';
import { MirrorNotReadyError, readCells } from '../mirror/readCells.js';
import { mirrorStore } from '../mirror/source.js';
import type { MirrorStore } from '../mirror/store.js';
import { chcCell, type GridCell, planFetch, RECHECK_INTERVAL_DAYS, RECHECK_READ_DAYS, uniqueCells } from './cellCache.js';
import { type CacheOrigin, claimRecheck, readCellCache } from './cellCacheStore.js';
import { CHIRPS_PRODUCT_FIRST_DAY, chirpsProduct, type GridConfig, gridCells } from './config.js';
import { type CellsResult, fetchFailure, type FetchWindow } from './fetch.js';
import { feedSourceMode } from './http.js';
import { ingestResult } from './ingest.js';
import { DAY_FINAL_ONLY, DAY_READ, DAY_SKIP } from './sources/chirps.js';
import { beginFeedFetch, type FeedRow, recordFeedChecked, takeFeedFetch } from './store.js';

/** The file tag of a final read from the copy (210 chirps_file.tag): known, so the re-check never reads it again unasked. */
export const MIRROR_TAG = 'mirror';

/** Which cell cache rows a read from the copy fills: chc for a live copy, fixtures for the committed one. */
export const mirrorOrigin = (): CacheOrigin => (feedSourceMode() === 'live' ? 'chc' : 'fixtures');

/** A feed's cells over a window as the copy holds them: one `f`/`p`/`-` per day, and per cell its encoded values (null on a `-` day). */
interface Read {
	read: string;
	values: (number | null)[][];
}

type Reader = (cells: readonly GridCell[], window: FetchWindow, plan: string) => Promise<Read>;

/** A live copy: its own dates and cells. */
const liveReader =
	(store: MirrorStore, product: FinalsProduct): Reader =>
	async (cells, window, plan) => {
		const r = await readCells(store, product, cells, window, { plan });
		return { read: r.cells.read, values: r.cells.values };
	};

// --- Fixtures mode: the committed copy re-dated to today --------------------------------

/** The fixture files' layout and lags (backend/fixtures/feeds/chirps-sample.json), as fixtures.ts serves them. */
interface FixtureSample {
	grid: { originLon: number; originLat: number; scale: number; width: number; height: number };
	cover: { originLon: number; originLat: number; width: number; height: number };
	pattern: number[];
	finalLagDays?: number;
	prelimLagDays?: number;
	rnlLagDays?: number;
}
// Read on first use, in fixtures mode only, and not through fixtures.ts, which reads its files as it loads: a Lambda
// bundle reaches this module but never reads the fixtures (a live process never re-dates).
let sample: FixtureSample | null = null;
const fixtureSample = (): FixtureSample =>
	(sample ??= JSON.parse(readFileSync(fileURLToPath(new URL('../../fixtures/feeds/chirps-sample.json', import.meta.url)), 'utf8')) as FixtureSample);

/** What the fixture files publish for `day` on `today`: `f` final, `p` preliminary (sat only), `-` nothing (fixtures.ts fixtureHttp). */
export function fixtureKind(product: FinalsProduct, day: string, today: string): 'f' | 'p' | '-' {
	const s = fixtureSample();
	const d = toEpochDay(day);
	const t = toEpochDay(today);
	if (day < CHIRPS_PRODUCT_FIRST_DAY[product]) return '-';
	if (d <= t - ((product === 'rnl' ? s.rnlLagDays : s.finalLagDays) ?? 40)) return 'f';
	if (product === 'sat' && d <= t - (s.prelimLagDays ?? 3)) return 'p';
	return '-';
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/**
 * The cell of the committed copy holding `cell`'s fixture values: itself
 * inside the files' 8 × 6 grid or outside their cover (where the copy, like
 * the files, has no data); else the land cell repeating it in the band of the
 * grid's size just south of the grid (fixtures.ts coverValue: a cover cell
 * outside the grid repeats grid cell (row mod 6, column mod 8), with no sea).
 */
export function fixtureSourceCell(cell: GridCell): GridCell {
	const s = fixtureSample();
	const half = s.grid.scale / 2;
	const g0 = chcCell(s.grid.originLat - half, s.grid.originLon + half);
	const c0 = chcCell(s.cover.originLat - half, s.cover.originLon + half);
	const r = cell.row - g0.row;
	const c = cell.col - g0.col;
	const inCover = cell.row >= c0.row && cell.row < c0.row + s.cover.height && cell.col >= c0.col && cell.col < c0.col + s.cover.width;
	const inGrid = r >= 0 && r < s.grid.height && c >= 0 && c < s.grid.width;
	if (!inCover || inGrid) return cell;
	return { row: g0.row + s.grid.height + mod(r, s.grid.height), col: g0.col + mod(c, s.grid.width) };
}

/**
 * The day of the copy whose values `day` takes: within [lo, hi] (the copy's
 * days of that kind), a multiple of the pattern's length away. `shift` is the
 * window's: its last day of the kind lands on hi or within a pattern before
 * it, so the window's days map onto consecutive days of the copy (one read);
 * a day that would fall before lo moves on by whole patterns.
 */
function fixtureDay(day: string, shift: number, lo: number, period: number): number {
	let d = toEpochDay(day) - shift;
	if (d < lo) d += period * Math.ceil((lo - d) / period);
	return d;
}

/** The committed copy read as the fixture files stand on `today`: each day's kind from their lags, its values from a day of the copy of that kind. */
function fixtureReader(store: MirrorStore, product: FinalsProduct, today: string): Reader {
	const period = fixtureSample().pattern.length;
	return async (cells, window, plan) => {
		const n = toEpochDay(window.end) - toEpochDay(window.start) + 1;
		const days = Array.from({ length: n }, (_, i) => fromEpochDay(toEpochDay(window.start) + i));
		// A cell outside the region is refused before anything is read, as on a live copy.
		for (const c of cells) mirrorCell(c, MIRROR_REGION);
		const kinds = days.map((day, i) => {
			if (plan[i] === DAY_SKIP) return '-';
			const k = fixtureKind(product, day, today);
			return k === 'p' && plan[i] === DAY_FINAL_ONLY ? '-' : k;
		});

		// The copy's days of each kind, from its manifests.
		const finals = await readManifest(store, product);
		if (!finals) throw new MirrorNotReadyError(`the rain data copy has no ${product} data yet`);
		const held = finalsCoverage(finals.files);
		const ranges: Record<'f' | 'p', [number, number] | null> = {
			f: held && finals.finalThrough ? [toEpochDay(held.from), toEpochDay(finals.finalThrough)] : null,
			p: null
		};
		if (product === 'sat' && kinds.includes('p')) {
			const pm = await readManifest(store, 'prelim');
			const arr = pm?.prelimThrough ? await openDaily(store, 'prelim') : null;
			if (pm?.prelimThrough && arr) ranges.p = [toEpochDay(arr.firstDay), toEpochDay(pm.prelimThrough)];
		}

		// Each requested day's day of the copy, then runs of consecutive ones of one kind.
		const src = days.map(() => -1);
		for (const kind of ['f', 'p'] as const) {
			const range = ranges[kind];
			const idx = kinds.flatMap((k, i) => (k === kind ? [i] : []));
			if (!range || !idx.length) continue;
			const last = toEpochDay(days[idx.at(-1)!]!);
			const shift = period * Math.ceil((last - range[1]) / period);
			for (const i of idx) src[i] = fixtureDay(days[i]!, shift, range[0], period);
		}

		// The copy's cells, each once.
		const keyOf = (c: GridCell) => `${c.row},${c.col}`;
		const sources = cells.map(fixtureSourceCell);
		const unique = [...new Map(sources.map((c) => [keyOf(c), c])).values()];
		const at = new Map(unique.map((c, i) => [keyOf(c), i]));

		const read = days.map(() => '-');
		const values = cells.map(() => new Array<number | null>(n).fill(null));
		for (let i = 0; i < n; ) {
			if (src[i]! < 0) {
				i++;
				continue;
			}
			let j = i + 1;
			while (j < n && kinds[j] === kinds[i] && src[j] === src[j - 1]! + 1) j++;
			const kind = kinds[i] as 'f' | 'p';
			const r = await readCells(store, product, unique, { start: fromEpochDay(src[i]!), end: fromEpochDay(src[j - 1]!) }, { plan: (kind === 'f' ? DAY_FINAL_ONLY : DAY_READ).repeat(j - i) });
			for (let d = i; d < j; d++) {
				if (r.cells.read[d - i] !== kind) continue;
				read[d] = kind;
				cells.forEach((_, c) => (values[c]![d] = r.cells.values[at.get(keyOf(sources[c]!))!]![d - i]!));
			}
			i = j;
		}
		return { read: read.join(''), values };
	};
}

/** The reader for this process: the live copy as it is, or the committed one re-dated to `today`. */
export function mirrorReader(product: FinalsProduct, today: string, store: MirrorStore = mirrorStore()): Reader {
	return feedSourceMode() === 'live' ? liveReader(store, product) : fixtureReader(store, product, today);
}

// --- The fetch -------------------------------------------------------------------------------

/** How a fetch from the copy ended: merged (or failed, recorded on the feed), or the copy isn't ready (nothing recorded but the attempt). */
export type MirrorFetchOutcome = 'ingested' | 'not_ready';

/**
 * One CHIRPS feed_fetch read from the copy and ingested, in the job's
 * transaction as its acting user: plan against the cache, claim the stale
 * days to read again, read both from the copy, and merge through the ingest's
 * cell-cache path. `jobId` is the running feed_fetch job (the cache's merge
 * and the re-check take values only from it).
 */
export async function fetchFromMirror(db: Db, feed: FeedRow, window: FetchWindow, opts: { jobId: string; today: string; reader?: Reader }): Promise<MirrorFetchOutcome> {
	const config = feed.config as GridConfig;
	const product = chirpsProduct(config);
	const origin = mirrorOrigin();
	// In production this is the feed's newest fetch, so a late answer to an older one, sent to the fetcher before the
	// switch, is dropped (feed-ingest.ts). First, as the cache path does: the feed row before the cache rows.
	if (feedFetcher() === 'sqs') {
		await beginFeedFetch(db, feed.id, opts.jobId, window);
		await takeFeedFetch(db, feed.id, opts.jobId);
	}
	let cells: GridCell[];
	try {
		cells = uniqueCells(gridCells(config));
		// A cell outside the copy's region: the feed's config, refused before anything is read.
		for (const c of cells) mirrorCell(c, MIRROR_REGION);
	} catch (err) {
		await ingestResult(db, feed, fetchFailure(err, config), window, { origin });
		return 'ingested';
	}
	const plan = planFetch(cells, await readCellCache(db, origin, product, cells, window), window);
	// Only the re-reads of the re-check: a stale day (a revision of the copy) is read again. No HEADs: the manifests say what changed.
	const recheck = await claimRecheck(db, feed.id, origin, product, cells, { heads: 0, reads: RECHECK_READ_DAYS, intervalDays: RECHECK_INTERVAL_DAYS });
	const empty: CellsResult = { ok: true, cells: { product, startDate: window.start, read: '', cells: [], values: [] }, meta: { product } };
	let answer: CellsResult = empty;
	try {
		const reader = opts.reader ?? mirrorReader(product, opts.today);
		if (plan) {
			const r = await reader(plan.cells, window, plan.plan);
			answer = {
				ok: true,
				cells: {
					product,
					startDate: window.start,
					read: r.read,
					cells: plan.cells.map((c) => [c.row, c.col]),
					values: r.values,
					tags: [...r.read].map((k) => (k === 'f' ? MIRROR_TAG : null))
				},
				meta: { product }
			};
		}
		if (recheck?.read.length) {
			const read: NonNullable<CellsResult['recheck']>['read'] = [];
			for (const day of recheck.read) {
				// The feed's cells, in the order the re-check lists them (ingest.ts fromCells): a final, or nothing to replace it with.
				const r = await reader(cells, { start: day, end: day }, DAY_FINAL_ONLY);
				read.push(r.read === 'f' ? { day, tag: MIRROR_TAG, values: r.values.map((row) => row[0]!) } : { day, tag: null, values: null });
			}
			answer = { ...answer, recheck: { head: [], read } };
		}
	} catch (err) {
		if (err instanceof MirrorNotReadyError) {
			// The copy is behind, not the feed broken: nothing written, no failure counted, the same window next time.
			await recordFeedChecked(db, feed.id);
			return 'not_ready';
		}
		await ingestResult(db, feed, fetchFailure(err, config), window, { origin });
		return 'ingested';
	}
	// cacheOnly: nothing was asked of CHC, so a backfill's next window follows in CACHED_NEXT_SECONDS.
	await ingestResult(db, feed, answer, window, { origin, cacheOnly: true, fetchJobId: opts.jobId });
	return 'ingested';
}
