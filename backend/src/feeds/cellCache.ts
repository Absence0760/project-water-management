// The shared CHIRPS cell cache, its pure side (208_chirps_cell_cache.sql,
// issue #482 part A; docs/architecture.md § Data feeds → The CHIRPS cell
// cache). No database here: the fetcher Lambda reaches this module too
// (lambda-fetcher.test.ts), and feeds/cellCacheStore.ts reads and writes the
// table.
//
// A CHIRPS feed no longer reads its days for itself. Its cells are cells of
// the one global 0.05° grid (row 0 at 60° N, column 0 at 180° W), and each
// cell's days are kept once for every project, by product, as a year of
// float32 values per row. A fetch works out which of its cells' days the
// cache lacks or holds only as preliminary (planFetch), the fetcher reads
// just those cells' values (sources/chirps.ts fetchChirpsCells), the worker
// merges them into the cache, and the feed's days are its weighted mean
// computed from the cache (seriesFromCache), with gridMean's own arithmetic.
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { CHIRPS_CELL_DEG, type WeightedCell } from './config.js';
import { DAY_FINAL_ONLY, DAY_READ, DAY_SKIP, type GridDays, meanOf, type NoDataPolicy } from './sources/chirps.js';
import { pixelOf } from './sources/tiff.js';

/** The CHC grid: 60° S – 60° N, 180° W – 180° E, in 0.05° cells. */
export const CHC_ROWS = 2400;
export const CHC_COLS = 7200;
const CHC_GRID = { width: CHC_COLS, height: CHC_ROWS, originLon: -180, originLat: 60, scaleLon: CHIRPS_CELL_DEG, scaleLat: CHIRPS_CELL_DEG };

/** One cell of the CHC grid. */
export interface GridCell {
	row: number;
	col: number;
}

/**
 * The CHC cell holding a point, by the same rule the reader uses on the real
 * files (sources/tiff.ts pixelOf, with the scale snapped to 0.05°): a point on
 * a cell edge belongs to the cell east / south of it. Throws for a point off
 * the grid, which a feed's config never holds (feeds/config.ts Lat, Lon).
 */
export function chcCell(lat: number, lon: number): GridCell {
	const px = pixelOf(CHC_GRID, lat, lon);
	if (!px) throw new Error(`the point ${lat}, ${lon} is outside the CHIRPS grid`);
	return px;
}

const round9 = (x: number) => Number(x.toFixed(9));
/** A cell's centre: what the fetcher reads it at, so any grid on the 0.05° lattice (the fixtures' too) gives that cell. */
export const cellCentre = (c: GridCell) => ({ lat: round9(60 - (c.row + 0.5) * CHIRPS_CELL_DEG), lon: round9(-180 + (c.col + 0.5) * CHIRPS_CELL_DEG) });

const byRowCol = (a: GridCell, b: GridCell) => a.row - b.row || a.col - b.col;

/** A feed's cells as grid cells, each once, by row then column: the order the cache's merge locks them in. */
export function uniqueCells(cells: readonly { lat: number; lon: number }[]): GridCell[] {
	const seen = new Map<string, GridCell>();
	for (const c of cells) {
		const g = chcCell(c.lat, c.lon);
		seen.set(`${g.row},${g.col}`, g);
	}
	return [...seen.values()].sort(byRowCol);
}

/** One cached cell-year: 366 values from 1 January (null = not fetched, NaN = no data), and whether each came from the final file. */
export interface CachedYear {
	vals: (number | null)[];
	final: boolean[];
}

/** The cache rows a fetch read, by `row,col,year`. */
export type CacheView = Map<string, CachedYear>;
export const viewKey = (c: GridCell, year: number) => `${c.row},${c.col},${year}`;

/** A cell's day in the cache: its value (NaN = no data) or null, and whether it is final. */
export function cellDay(view: CacheView, cell: GridCell, day: string): { v: number | null; final: boolean } {
	const year = Number(day.slice(0, 4));
	const row = view.get(viewKey(cell, year));
	if (!row) return { v: null, final: false };
	const i = toEpochDay(day) - toEpochDay(`${year}-01-01`);
	const v = row.vals[i] ?? null;
	return { v, final: v !== null && row.final[i] === true };
}

/** The years a window spans, first and last. */
export const windowYears = (w: { start: string; end: string }): [number, number] => [Number(w.start.slice(0, 4)), Number(w.end.slice(0, 4))];

const windowDays = (w: { start: string; end: string }) => {
	const s = toEpochDay(w.start);
	return Array.from({ length: Math.max(0, toEpochDay(w.end) - s + 1) }, (_, i) => fromEpochDay(s + i));
};

/** What a fetch asks the fetcher for: the cells to read, and one DAY_* character per day of the window. */
export interface FetchPlan {
	cells: GridCell[];
	plan: string;
}

/**
 * What the fetcher must read for `cells` over `window`, given the cache:
 * a day every cell holds final is skipped; a day every cell holds, some only
 * as preliminary, is read from its final file only (a preliminary value is
 * published once, so there is nothing new to read until the final); any
 * other day is read. Only the cells not final on every day are read. Null
 * when there is nothing to read: the feed's days come from the cache alone.
 */
export function planFetch(cells: readonly GridCell[], view: CacheView, window: { start: string; end: string }): FetchPlan | null {
	const days = windowDays(window);
	const unfinished = new Set<GridCell>();
	let plan = '';
	for (const day of days) {
		let allFinal = true;
		let allHeld = true;
		for (const c of cells) {
			const cd = cellDay(view, c, day);
			if (!cd.final) {
				allFinal = false;
				unfinished.add(c);
			}
			if (cd.v === null) allHeld = false;
		}
		plan += allFinal ? DAY_SKIP : allHeld ? DAY_FINAL_ONLY : DAY_READ;
	}
	if (!unfinished.size) return null;
	return { cells: cells.filter((c) => unfinished.has(c)), plan };
}

/**
 * A feed's days over `window`, from the cache: each day the weighted mean of
 * the feed's own cells (in its config's order, with its weights) by gridMean's
 * arithmetic (sources/chirps.ts meanOf), so the refusals (a listed sea cell),
 * the sea mask (skipNoData) and the rounding are the ones a fetch from the
 * files had. A day any cell lacks is null, a day any cell holds only as
 * preliminary is preliminary, and the rest is fetchChirps' shape: trailing
 * empty days dropped, `finalThrough` the leading run of final days.
 */
export function seriesFromCache(cells: readonly WeightedCell[], view: CacheView, window: { start: string; end: string }, noData?: NoDataPolicy): GridDays {
	const keys = cells.map((c) => chcCell(c.lat, c.lon));
	const days = windowDays(window);
	const got = days.map((day) => {
		const cds = keys.map((k) => cellDay(view, k, day));
		if (cds.some((cd) => cd.v === null)) return { v: null, prelim: false };
		const v = meanOf(
			cds.map((cd) => (Number.isNaN(cd.v) ? null : cd.v)),
			cells,
			noData
		);
		return { v, prelim: cds.some((cd) => !cd.final) };
	});
	let last = got.length - 1;
	while (last >= 0 && got[last]!.v === null) last--;
	const kept = got.slice(0, last + 1);
	let final = 0;
	while (final < kept.length && kept[final]!.v !== null && !kept[final]!.prelim) final++;
	const out: GridDays = { startDate: window.start, values: kept.map((g) => g.v), prelimDays: kept.filter((g) => g.v !== null && g.prelim).length };
	if (final > 0) out.finalThrough = days[final - 1]!;
	return out;
}

/**
 * A cell value as the fetcher's answer carries it in JSON, which has no NaN
 * and prints a small decimal long: the float32's bit pattern, an integer of
 * at most ten digits that gives back the exact value the file held, so a day
 * computed from the cache is the number gridMean computed from the file. A
 * value from 0 to 2000 mm is a pattern from 0 to CELL_VALUE_MAX_BITS (the
 * order of non-negative floats is their patterns' order); -0 travels as 0.
 * -1 is no data (the sea); null stays null (the day wasn't read).
 */
export const CELL_VALUE_MAX_BITS = 0x44fa0000;
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
export function encodeCellValue(v: number | null): number | null {
	if (v === null) return null;
	if (Number.isNaN(v)) return -1;
	f32[0] = v === 0 ? 0 : v;
	return u32[0]!;
}
export function decodeCellValue(v: number | null): number | null {
	if (v === null) return null;
	if (v === -1) return Number.NaN;
	u32[0] = v;
	return f32[0]!;
}

/**
 * The re-check of cached finals CHC rewrites in place (210_chirps_final_recheck,
 * docs/architecture.md § Data feeds → Re-checking finals), per CHIRPS feed
 * fetch: at most RECHECK_HEAD_DAYS final files HEADed (only when the feed is
 * caught up, so a backfill's windows don't carry them), each not within
 * RECHECK_INTERVAL_DAYS of its last check, oldest checked first; and at most
 * RECHECK_READ_DAYS days read again for the feed's cells (its stale days, then
 * files whose tag isn't known). chirps_recheck_claim holds the same bounds.
 */
export const RECHECK_HEAD_DAYS = 40;
export const RECHECK_READ_DAYS = 10;
export const RECHECK_INTERVAL_DAYS = 90;
/** The most revised days one ingest recomputes into the feed's series (feeds/ingest.ts refreshRevisedDays); the rest go next fetch. */
export const REVISION_REFRESH_DAYS = 400;
