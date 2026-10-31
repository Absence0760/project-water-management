// A daily reference evapotranspiration feed (`agera5_et0`) read from our copy
// (issue #604 R5-E; docs/architecture.md § Our copy of the rain data,
// docs/model.md §2.4a "Daily reference ET").
//
// There is no per-feed path to the CDS or to NASA POWER: the Python ingest
// job copies AgERA5 v2.0's daily FAO-56 reference ET for the region a month at
// a time (ingest/agera5.py, `agera5_et0`, finals layout, 0.1°), and the FAO-56
// ET₀ it computes from NASA POWER's daily meteorology for the newest days
// (ingest/nasapower.py, `power_et0`, daily layout, 0.1°, a rolling window).
// Every `agera5_et0` feed_fetch reads that copy in this job, whatever
// CHIRPS_SOURCE or FEED_FETCHER say. Neither product enters the cell cache: a
// window is at most a year (fetch.ts ET0_MAX_DAYS), one read per year chunk.
//
// Which product a day comes from: AgERA5 when its copy holds the day (from
// the earliest month its files hold through finalThrough, agera5Coverage) and
// some cell of the feed has a value; else NASA POWER when its copy holds the
// day (a file names it, through prelimThrough) and some cell has a value;
// else nothing (the day is left out, not 0). AgERA5 is about a week behind
// and copied a month at a time, so the last few weeks are POWER's until
// AgERA5's month lands; the feed's 75-day re-read (ET0_REVISION_DAYS) then
// replaces them, since a feed's merge replaces the days it wrote itself.
//
// A day's value is the weighted mean of the 0.1° cells holding the feed's
// cells (each feed cell's centre, with its weight), leaving out cells with no
// value (the sea) and renormalising, to 0.01 mm. A value outside 0–30 mm/day
// is refused as a corrupt copy. The fetch's meta counts the days from each
// product (agera5Days, powerDays) and how far AgERA5 reached (agera5Through),
// and its dayProducts names each day's product, which the ingest records
// with the days it writes (time_series.feed_agera5_days / feed_power_days,
// 292_feed_et0_product_days) for a run's credits (runs/execute.ts et0FeedDays).
//
// When the copy holds neither product yet, the copy is behind, not the feed
// broken: nothing is written and the fetch records only that it looked, as
// for ECMWF; the operator's signal is MirrorLagDays. A cell outside the
// region fails the fetch with a message naming the region.
//
// Fixtures mode (FEED_SOURCE=fixtures, dev, CI and e2e): the committed copy
// (backend/fixtures/mirror/, scripts/et0-fixture.ts) holds invented values over
// a 4 × 4 block of 0.1° cells as the copy stood on MIRROR_FIXTURE.today; every
// day is read shifted by today − that day, and a cell anywhere maps onto the
// block by its position modulo 4, so a feed anywhere in the region reads
// offline and its newest days come from POWER, as in production.
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import type { Db } from '../db/tx.js';
import { feedFetcher } from '../jobs/transport.js';
import { type DailyArray, type FinalsArray, openDaily, openFinals, readDailyBlock, readFinalsBlock } from '../mirror/arrays.js';
import { doyIndex, dayIndex, MIRROR_REGION, MirrorOutsideRegionError, regionSize } from '../mirror/grid.js';
import { agera5Coverage, powerHeldDays, readManifest } from '../mirror/manifest.js';
import { MirrorNotReadyError } from '../mirror/readCells.js';
import { mirrorStore } from '../mirror/source.js';
import type { MirrorStore } from '../mirror/store.js';
import type { GridConfig } from './config.js';
import { FeedFormatError } from './errors.js';
import { type Et0DayProduct, fetchFailure, type FetchResult, type FetchWindow, gridRead } from './fetch.js';
import { feedSourceMode } from './http.js';
import { ingestResult } from './ingest.js';
import { beginFeedFetch, type FeedRow, recordFeedChecked, takeFeedFetch } from './store.js';

/** The ET₀ products' grid step, degrees. */
export const ET0_STEP = 0.1;
const SIZE = regionSize(MIRROR_REGION, ET0_STEP);
/** The most a day's reference ET may be (mm); more is a corrupt copy, not weather (FAO-56 values rarely pass 15). */
export const ET0_MAX_MM = 30;

/** A cell of the copy's 0.1° grid: y north from the region's south edge, x east from its west edge. */
export interface Et0Cell {
	y: number;
	x: number;
}

/** The 0.1° cell holding a point; MirrorOutsideRegionError outside the region. */
export function et0Cell(lat: number, lon: number): Et0Cell {
	const y = Math.floor((lat - MIRROR_REGION.s) / ET0_STEP + 1e-9);
	const x = Math.floor((lon - MIRROR_REGION.w) / ET0_STEP + 1e-9);
	if (y < 0 || y >= SIZE.rows || x < 0 || x >= SIZE.cols) throw new MirrorOutsideRegionError(lat, lon, MIRROR_REGION);
	return { y, x };
}

/** Each day's value at each cell (NaN = no value), and which days each product holds. */
export interface Et0Read {
	/** values[product][day][cell]; a day the product doesn't hold is all NaN. */
	agera5: number[][];
	power: number[][];
	/** The newest day AgERA5's copy holds (null when none). */
	agera5Through: string | null;
}

/** Reads `cells` over the window's days (ISO, inclusive) from the copy. MirrorNotReadyError when it holds neither product. */
export type Et0Reader = (cells: readonly Et0Cell[], window: FetchWindow) => Promise<Et0Read>;

/** The bounding block of some cells, and each cell's offset in it. */
function blockOf(cells: readonly Et0Cell[]) {
	const y0 = Math.min(...cells.map((c) => c.y));
	const x0 = Math.min(...cells.map((c) => c.x));
	const block = { y0, x0, h: Math.max(...cells.map((c) => c.y)) - y0 + 1, w: Math.max(...cells.map((c) => c.x)) - x0 + 1 };
	return { block, at: cells.map((c) => (c.y - y0) * block.w + (c.x - x0)) };
}

const nanDays = (n: number, cells: number) => Array.from({ length: n }, () => new Array<number>(cells).fill(Number.NaN));

/** The live copy's reader. */
export const liveEt0Reader =
	(store: MirrorStore): Et0Reader =>
	async (cells, window) => {
		const s = toEpochDay(window.start);
		const n = toEpochDay(window.end) - s + 1;
		const days = Array.from({ length: n }, (_, i) => fromEpochDay(s + i));
		const agera5 = nanDays(n, cells.length);
		const power = nanDays(n, cells.length);
		const [am, pm] = await Promise.all([readManifest(store, 'agera5_et0'), readManifest(store, 'power_et0')]);
		const fa: FinalsArray | null = am ? await openFinals(store, 'agera5_et0') : null;
		const da: DailyArray | null = pm ? await openDaily(store, 'power_et0') : null;
		if (!fa && !da) throw new MirrorNotReadyError('the data copy holds no reference evapotranspiration yet (AgERA5 or NASA POWER)');
		const { block, at } = blockOf(cells);
		const area = block.h * block.w;

		// AgERA5: the days its month requests hold, through finalThrough, one read per year.
		const held = am ? agera5Coverage(am.files) : null;
		const through = am?.finalThrough ?? null;
		const agera5Through = held && through ? (through < held.through ? through : held.through) : null;
		if (fa && held && agera5Through) {
			const years = new Map<number, number[]>();
			days.forEach((d, i) => {
				if (d < held.from || d > agera5Through) return;
				const y = Number(d.slice(0, 4));
				(years.get(y) ?? years.set(y, []).get(y)!).push(i);
			});
			for (const [year, idx] of years) {
				const doy0 = doyIndex(days[idx[0]!]!);
				const got = await readFinalsBlock(fa, year, doy0, doyIndex(days[idx.at(-1)!]!), block);
				for (const i of idx) {
					const d = doyIndex(days[i]!) - doy0;
					agera5[i] = at.map((k) => got.values[d * area + k]!);
				}
			}
		}

		// NASA POWER: the days its files name, through prelimThrough, one read over the run of them.
		if (da && pm?.prelimThrough) {
			const named = powerHeldDays(pm.files);
			const idx = days.map((_, i) => i).filter((i) => named.has(days[i]!) && days[i]! <= pm.prelimThrough! && days[i]! >= da.firstDay);
			if (idx.length) {
				const d0 = dayIndex(da.firstDay, days[idx[0]!]!);
				const got = await readDailyBlock(da, d0, dayIndex(da.firstDay, days[idx.at(-1)!]!), block);
				for (const i of idx) {
					const d = dayIndex(da.firstDay, days[i]!) - d0;
					power[i] = at.map((k) => got.values[d * area + k]!);
				}
			}
		}
		return { agera5, power, agera5Through };
	};

/** The committed fixture's block and the day it was made (scripts/et0-fixture.ts writes it). */
export const ET0_FIXTURE = { today: '2026-02-09', block: { y0: 152, x0: 150, h: 4, w: 4 } } as const;

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** The committed copy, every day shifted to the day it was made and every cell read from the fixture block (see the header). */
export const fixtureEt0Reader =
	(store: MirrorStore, today: string): Et0Reader =>
	async (cells, window) => {
		const shift = toEpochDay(today) - toEpochDay(ET0_FIXTURE.today);
		const b = ET0_FIXTURE.block;
		const at = cells.map((c) => ({ y: b.y0 + mod(c.y - b.y0, b.h), x: b.x0 + mod(c.x - b.x0, b.w) }));
		const r = await liveEt0Reader(store)(at, { start: fromEpochDay(toEpochDay(window.start) - shift), end: fromEpochDay(toEpochDay(window.end) - shift) });
		return { ...r, agera5Through: r.agera5Through && fromEpochDay(toEpochDay(r.agera5Through) + shift) };
	};

/** The reader for this process: the live copy, or the committed one shifted to today. */
export function et0MirrorReader(today: string, store: MirrorStore = mirrorStore()): Et0Reader {
	return feedSourceMode() === 'live' ? liveEt0Reader(store) : fixtureEt0Reader(store, today);
}

/** One day's weighted mean over the cells that have a value, to 0.01 mm; null when none has one. */
function dayMean(values: readonly number[], weights: readonly number[], day: string, product: string): number | null {
	let sum = 0;
	let w = 0;
	values.forEach((v, i) => {
		if (Number.isNaN(v)) return;
		if (!(v >= 0 && v <= ET0_MAX_MM)) throw new FeedFormatError(`the data copy has an implausible reference evapotranspiration of ${v} mm on ${day} (${product})`);
		sum += v * weights[i]!;
		w += weights[i]!;
	});
	return w > 0 ? Math.round((sum / w) * 100) / 100 : null;
}

/**
 * The reference ET of `config`'s cells over `window` from the copy, as a
 * fetch answers: one value a day from the window's start (null where neither
 * product holds the day), AgERA5's where it has one, else NASA POWER's, and
 * which of them each day's value is (dayProducts).
 */
export async function et0FromMirror(config: GridConfig, window: FetchWindow, reader: Et0Reader): Promise<Extract<FetchResult, { ok: true }>> {
	const { cells } = gridRead(config);
	const grid = cells.map((c) => et0Cell(c.lat, c.lon));
	const key = (g: Et0Cell) => `${g.y},${g.x}`;
	const unique = [...new Map(grid.map((g) => [key(g), g])).values()];
	const index = new Map(unique.map((g, i) => [key(g), i]));
	// Each 0.1° cell's weight: the sum of the feed's cells (and their weights) inside it.
	const weights = new Array<number>(unique.length).fill(0);
	grid.forEach((g, i) => (weights[index.get(key(g))!]! += cells[i]!.weight));
	const r = await reader(unique, window);
	const s = toEpochDay(window.start);
	let agera5Days = 0;
	let powerDays = 0;
	const products: (Et0DayProduct | null)[] = [];
	const values = r.agera5.map((dayA, i) => {
		const day = fromEpochDay(s + i);
		const a = dayMean(dayA, weights, day, 'AgERA5');
		if (a !== null) {
			agera5Days++;
			products.push('agera5_et0');
			return a;
		}
		const p = dayMean(r.power[i]!, weights, day, 'NASA POWER');
		if (p !== null) powerDays++;
		products.push(p === null ? null : 'power_et0');
		return p;
	});
	// Trailing days with no value are not sent: the feed's newest day is the newest with a value.
	let last = values.length - 1;
	while (last >= 0 && values[last] === null) last--;
	let first = 0;
	while (first <= last && values[first] === null) first++;
	const meta = { days: agera5Days + powerDays, agera5Days, powerDays, ...(r.agera5Through ? { agera5Through: r.agera5Through } : {}) };
	if (first > last) return { ok: true, startDate: null, values: [], meta };
	return { ok: true, startDate: fromEpochDay(s + first), values: values.slice(first, last + 1), meta, dayProducts: products.slice(first, last + 1) };
}

/** How a fetch from the copy ended: merged (or failed, recorded on the feed), or the copy holds no reference ET yet. */
export type Et0MirrorOutcome = 'ingested' | 'not_ready';

/** One reference ET feed_fetch read from the copy and ingested, in the job's transaction as its acting user (feed-fetch.ts). */
export async function fetchEt0FromMirror(db: Db, feed: FeedRow, window: FetchWindow, opts: { jobId: string; today: string; reader?: Et0Reader }): Promise<Et0MirrorOutcome> {
	const config = feed.config as GridConfig;
	// As fromMirrorEcmwf.ts: in production this is the feed's newest fetch, so a stray older answer is dropped.
	if (feedFetcher() === 'sqs') {
		await beginFeedFetch(db, feed.id, opts.jobId, window);
		await takeFeedFetch(db, feed.id, opts.jobId);
	}
	let result: FetchResult;
	try {
		result = await et0FromMirror(config, window, opts.reader ?? et0MirrorReader(opts.today));
	} catch (err) {
		if (err instanceof MirrorNotReadyError) {
			await recordFeedChecked(db, feed.id);
			return 'not_ready';
		}
		result = fetchFailure(err, config);
	}
	await ingestResult(db, feed, result, window, { fetchJobId: opts.jobId });
	return 'ingested';
}
