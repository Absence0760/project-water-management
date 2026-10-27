// A CHIRPS-GEFS feed fetch read from our own copy (issue #604 R3-A;
// docs/architecture.md § Our copy of the rain data), when CHIRPS_SOURCE=mirror
// (mirror/source.ts chirpsSource: the default in dev, CI and e2e; production
// stays on chc until the cutover, R3-C).
//
// The fetcher's daily GEFS pass (ingest/gefs.ts) copies the newest complete
// issue into `gefs/<issue>` and lists it in `gefs/index.json`, and only a
// complete issue is ever listed. A `chirps_gefs` feed_fetch reads it in this
// job, whatever FEED_FETCHER says (no FetchRequest, no SQS round trip), with
// the rule the per-feed fetch keeps (sources/chirps.ts fetchGefs): today's
// issue, else yesterday's. Each day is the weighted mean of the feed's cells
// through the same arithmetic (chirps.ts meanOf: the same refusals, the same
// sea-cell policy for a box with skipNoData, the same rounding), and the
// answer is the FetchResult runFetch gives (fetch.ts, `chirps_gefs`: startDate
// the issue date, 16 values, meta days/issued/cellsUsed), merged by the same
// ingestResult. So a forecast read from the copy is the one read from CHC's
// files, value for value.
//
// When the copy holds neither today's nor yesterday's issue (no index yet, or
// the pass hasn't run since), the copy is behind, not the feed broken: like a
// CHIRPS fetch from a copy with no manifest (fromMirror.ts), the fetch writes
// nothing and records only that it looked (last_attempt_at), with no failure
// and no backoff; the series keeps the forecast it has. The operator's signal
// is the MirrorLagDays{Product=gefs} alarm. A cell outside the copy's region
// fails the fetch with a message naming the region.
//
// Fixtures mode (FEED_SOURCE=fixtures) re-dates the committed copy as
// fixtureHttp re-dates its files (feeds/fixtures.ts): the files issue a
// forecast every day, whose day d is pattern[d mod 17] (gefs-sample.json),
// whatever the issue. The committed copy holds two issues
// (scripts/gen-mirror-fixture.ts), whose 32 days hold every residue of 17, so
// today's issue is read day by day from a held day with the same residue, and
// a cell of the files' cover outside their grid from the copy's band south of
// it (fromMirror.ts fixtureSourceCell: the GEFS files share the CHIRPS ones'
// grid and cover). The feeds screens show the values the files gave.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import type { Db } from '../db/tx.js';
import { readGefsIndex, gefsProduct } from '../ingest/gefs.js';
import { feedFetcher } from '../jobs/transport.js';
import { type Block, DAILY_CHUNK, openDaily, readDailyBlock } from '../mirror/arrays.js';
import { cellsByChunk, MIRROR_REGION, type MirrorCell, mirrorCell } from '../mirror/grid.js';
import { readManifest } from '../mirror/manifest.js';
import { MirrorNotReadyError } from '../mirror/readCells.js';
import { mirrorStore } from '../mirror/source.js';
import type { MirrorStore } from '../mirror/store.js';
import { chcCell, type GridCell } from './cellCache.js';
import type { GridConfig } from './config.js';
import { FeedFormatError } from './errors.js';
import { fetchFailure, type FetchResult, type FetchWindow, gridRead } from './fetch.js';
import { fixtureSourceCell } from './fromMirror.js';
import { feedSourceMode } from './http.js';
import { ingestResult } from './ingest.js';
import { GEFS_DAYS, meanOf } from './sources/chirps.js';
import { beginFeedFetch, type FeedRow, recordFeedChecked, takeFeedFetch } from './store.js';

/** One issue's days at some cells: per day, per cell, the stored value (NaN for no data). */
export interface GefsCells {
	issued: string;
	values: number[][];
}

/** Reads the forecast a fetch on `today` uses, at `cells`; MirrorNotReadyError when the copy holds none it may use. */
export type GefsReader = (cells: readonly GridCell[], today: string) => Promise<GefsCells>;

const blockOf = (g: { y0: number; y1: number; x0: number; x1: number }): Block => ({ y0: g.y0, x0: g.x0, h: g.y1 - g.y0 + 1, w: g.x1 - g.x0 + 1 });

/** Days [d0, d1] of a held issue at mirror cells `at`: per day, per cell. */
async function readIssueDays(store: MirrorStore, issue: string, at: readonly MirrorCell[], d0: number, d1: number): Promise<number[][]> {
	const product = gefsProduct(issue);
	const manifest = await readManifest(store, product);
	const arr = await openDaily(store, product);
	// The index lists an issue only once its manifest is written; a listed issue without one is the copy's fault.
	if (!manifest || !arr) throw new MirrorNotReadyError(`the rain data copy lists the forecast issued ${issue} but doesn't hold it`);
	if (arr.firstDay !== issue || manifest.files.length !== GEFS_DAYS || arr.arr.shape[0]! < GEFS_DAYS) {
		throw new FeedFormatError(`the rain data copy's forecast issued ${issue} is not a whole issue`);
	}
	const out = Array.from({ length: d1 - d0 + 1 }, () => new Array<number>(at.length).fill(Number.NaN));
	for (const g of cellsByChunk(at, DAILY_CHUNK[1], DAILY_CHUNK[2])) {
		const block = blockOf(g);
		const got = await readDailyBlock(arr, d0, d1, block);
		for (let d = 0; d <= d1 - d0; d++) for (const c of g.cells) out[d]![c] = got.values[(d * block.h + (at[c]!.y - block.y0)) * block.w + (at[c]!.x - block.x0)]!;
	}
	return out;
}

/** A live copy: today's issue if held, else yesterday's (fetchGefs's rule). */
export const liveGefsReader =
	(store: MirrorStore): GefsReader =>
	async (cells, today) => {
		const at = cells.map((c) => mirrorCell(c, MIRROR_REGION));
		const held = (await readGefsIndex(store)) ?? [];
		const yesterday = fromEpochDay(toEpochDay(today) - 1);
		const issued = held.find((d) => d === today) ?? held.find((d) => d === yesterday);
		if (!issued) throw new MirrorNotReadyError(`the rain data copy holds no forecast issued ${yesterday} or ${today} yet`);
		return { issued, values: await readIssueDays(store, issued, at, 0, GEFS_DAYS - 1) };
	};

// --- Fixtures mode: the committed copy re-dated to today --------------------------------

let pattern: number | null = null;
/** The GEFS fixture pattern's length (gefs-sample.json), read on first use in fixtures mode only. */
const fixturePeriod = (): number =>
	(pattern ??= (JSON.parse(readFileSync(fileURLToPath(new URL('../../fixtures/feeds/gefs-sample.json', import.meta.url)), 'utf8')) as { pattern: number[] }).pattern.length);

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** The committed copy as the fixture files stand on `today`: today's issue, each day read from a held day with the same place in the pattern. */
export const fixtureGefsReader =
	(store: MirrorStore): GefsReader =>
	async (cells, today) => {
		// A cell outside the region is refused before anything is read, as on a live copy.
		for (const c of cells) mirrorCell(c, MIRROR_REGION);
		const period = fixturePeriod();
		const held = (await readGefsIndex(store)) ?? [];
		if (!held.length) throw new MirrorNotReadyError('the rain data copy holds no forecast yet');
		// Every held day by its place in the pattern (newest issue first, so its days win).
		const byResidue = new Map<number, { issue: string; d: number }>();
		for (const issue of held) for (let d = 0; d < GEFS_DAYS; d++) if (!byResidue.has(mod(toEpochDay(issue) + d, period))) byResidue.set(mod(toEpochDay(issue) + d, period), { issue, d });
		const sources = cells.map(fixtureSourceCell);
		const at = sources.map((c) => mirrorCell(c, MIRROR_REGION));
		const values: number[][] = [];
		for (let d = 0; d < GEFS_DAYS; d++) {
			const src = byResidue.get(mod(toEpochDay(today) + d, period));
			if (!src) throw new MirrorNotReadyError('the sample copy holds no forecast day for this point of the pattern');
			values.push((await readIssueDays(store, src.issue, at, src.d, src.d))[0]!);
		}
		return { issued: today, values };
	};

/** The reader for this process: the live copy as it is, or the committed one re-dated to `today`. */
export function gefsMirrorReader(store: MirrorStore = mirrorStore()): GefsReader {
	return feedSourceMode() === 'live' ? liveGefsReader(store) : fixtureGefsReader(store);
}

/**
 * The forecast of `config`'s cells from the copy, as runFetch answers a
 * `chirps_gefs` request: the issue's 16 days, each the weighted mean of the
 * cells (meanOf). Throws what fetchGefs would (a sea cell, an implausible
 * value), MirrorOutsideRegionError for a cell outside the copy, and
 * MirrorNotReadyError when the copy holds no issue the fetch may use.
 */
export async function forecastFromMirror(config: GridConfig, today: string, reader: GefsReader): Promise<Extract<FetchResult, { ok: true }>> {
	const { cells, noData, used } = gridRead(config);
	const grid = cells.map((c) => chcCell(c.lat, c.lon));
	const key = (g: GridCell) => `${g.row},${g.col}`;
	const unique = [...new Map(grid.map((g) => [key(g), g])).values()];
	const at = new Map(unique.map((g, i) => [key(g), i]));
	const r = await reader(unique, today);
	// NaN is no data, as readPoints answers null for the sea; the rest is the stored float32, as the file holds it.
	const atCell = (day: number[], g: GridCell) => {
		const v = day[at.get(key(g))!]!;
		return Number.isNaN(v) ? null : v;
	};
	const values = r.values.map((day) => meanOf(grid.map((g) => atCell(day, g)), cells, noData));
	return { ok: true, startDate: r.issued, values, meta: { days: values.length, issued: r.issued, ...used() } };
}

/** How a forecast fetch from the copy ended: merged (or failed, recorded on the feed), or the copy holds no issue yet. */
export type GefsMirrorOutcome = 'ingested' | 'not_ready';

/**
 * One CHIRPS-GEFS feed_fetch read from the copy and ingested, in the job's
 * transaction as its acting user (feed-fetch.ts, CHIRPS_SOURCE=mirror).
 */
export async function fetchGefsFromMirror(
	db: Db,
	feed: FeedRow,
	window: FetchWindow,
	opts: { jobId: string; today: string; reader?: GefsReader }
): Promise<GefsMirrorOutcome> {
	const config = feed.config as GridConfig;
	// In production this is the feed's newest fetch, so a late answer to an older one, sent to the fetcher before the
	// switch, is dropped (feed-ingest.ts), as fromMirror.ts does for CHIRPS.
	if (feedFetcher() === 'sqs') {
		await beginFeedFetch(db, feed.id, opts.jobId, window);
		await takeFeedFetch(db, feed.id, opts.jobId);
	}
	let result: FetchResult;
	try {
		result = await forecastFromMirror(config, opts.today, opts.reader ?? gefsMirrorReader());
	} catch (err) {
		if (err instanceof MirrorNotReadyError) {
			// The copy is behind, not the feed broken: nothing written, no failure counted, the forecast kept.
			await recordFeedChecked(db, feed.id);
			return 'not_ready';
		}
		result = fetchFailure(err, config);
	}
	await ingestResult(db, feed, result, window, { fetchJobId: opts.jobId });
	return 'ingested';
}
