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
//
// Other products of our copy share the cache (252_cache_products.sql): ERA5-
// Land (`era5l`) and IMERG Late (`imerg_late`), each on its own 0.1° grid.
// A row's cell is a cell of its product's global grid (productCell): a
// feed's cells are 0.05° CHIRPS cells, and each maps to the 0.1° cell that
// contains it. The weighting is the feed's, cell by cell: a 0.1° cell holding
// several of the feed's 0.05° cells counts once for each, with each one's
// weight (seriesFromCache), so it weighs the sum of their weights, which is
// the area of the feed's footprint inside it.
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { productStep } from '../mirror/grid.js';
import { CHIRPS_CELL_DEG, type ChirpsDailyProduct, type WeightedCell } from './config.js';
import { DAY_FINAL_ONLY, DAY_READ, DAY_SKIP, type GridDays, meanOf, type NoDataPolicy } from './sources/chirps.js';
import { pixelOf } from './sources/tiff.js';

/** The CHC grid: 60° S – 60° N, 180° W – 180° E, in 0.05° cells. */
export const CHC_ROWS = 2400;
export const CHC_COLS = 7200;
const CHC_GRID = { width: CHC_COLS, height: CHC_ROWS, originLon: -180, originLat: 60, scaleLon: CHIRPS_CELL_DEG, scaleLat: CHIRPS_CELL_DEG };

/** One cell of a global grid (CHC's 0.05° one unless a product says otherwise). */
export interface GridCell {
	row: number;
	col: number;
}

/** The products the cell cache keeps (252): CHIRPS's two finals, and the 0.1° rain products of our copy. */
export const CACHE_PRODUCTS = ['sat', 'rnl', 'era5l', 'imerg_late'] as const;
export type CacheProduct = ChirpsDailyProduct | 'era5l' | 'imerg_late';

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

/**
 * The cell of `product`'s global grid holding a point: chcCell for a CHIRPS
 * product; for a coarser grid, the cell holding the point's CHC cell (both
 * grids share their north-west corner and the step is a whole number of CHC
 * cells, so the 0.05° cell (r, c) lies in the 0.1° cell (⌊r/2⌋, ⌊c/2⌋)), so a
 * point on a 0.1° edge goes the way its 0.05° cell does.
 */
export function productCell(product: CacheProduct, lat: number, lon: number): GridCell {
	const c = chcCell(lat, lon);
	const k = Math.round(productStep(product) / CHIRPS_CELL_DEG);
	return k === 1 ? c : { row: Math.floor(c.row / k), col: Math.floor(c.col / k) };
}

const round9 = (x: number) => Number(x.toFixed(9));
/** A cell's centre: what the fetcher reads it at, so any grid on the 0.05° lattice (the fixtures' too) gives that cell. */
export const cellCentre = (c: GridCell) => gridCellCentre(c, CHIRPS_CELL_DEG);
/** The centre of a cell of the global grid of `step` (a product's: grid.ts productStep). */
export const gridCellCentre = (c: GridCell, step: number) => ({ lat: round9(60 - (c.row + 0.5) * step), lon: round9(-180 + (c.col + 0.5) * step) });

const byRowCol = (a: GridCell, b: GridCell) => a.row - b.row || a.col - b.col;

/** A feed's cells as cells of `product`'s grid (CHC's by default), each once, by row then column: the order the cache's merge locks them in. */
export function uniqueCells(cells: readonly { lat: number; lon: number }[], product: CacheProduct = 'sat'): GridCell[] {
	const seen = new Map<string, GridCell>();
	for (const c of cells) {
		const g = productCell(product, c.lat, c.lon);
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
 * A feed's days over `window`, from the cache of `product` (its CHIRPS
 * product, or `era5l` / `imerg_late`, each cell read at its productCell): each day the weighted mean of
 * the feed's own cells (in its config's order, with its weights) by gridMean's
 * arithmetic (sources/chirps.ts meanOf), so the refusals (a listed sea cell),
 * the sea mask (skipNoData) and the rounding are the ones a fetch from the
 * files had. A day any cell lacks is null, a day any cell holds only as
 * preliminary is preliminary, and the rest is fetchChirps' shape: trailing
 * empty days dropped, `finalThrough` the leading run of final days.
 */
export function seriesFromCache(
	cells: readonly WeightedCell[],
	view: CacheView,
	window: { start: string; end: string },
	noData?: NoDataPolicy,
	product: CacheProduct = 'sat'
): GridDays {
	// Each of the feed's cells, with its own weight, reads its product cell: on a coarser grid several read the same one.
	const keys = cells.map((c) => productCell(product, c.lat, c.lon));
	// cellDay's reading, a year at a time: each cell's row looked up once a year, not once a day, so a whole
	// record (27,000 days over 100 cells, the Data tab's double mass) costs array reads, not string keys.
	const s = toEpochDay(window.start);
	const n = Math.max(0, toEpochDay(window.end) - s + 1);
	const got: { v: number | null; prelim: boolean }[] = new Array(n);
	const vals: (number | null)[] = new Array(keys.length);
	// The window's own first year, even when it holds no days (an end before its start: a startDate in the
	// future): a made-up year 0 is no ISO date, and toEpochDay refuses it.
	let year = Number(window.start.slice(0, 4));
	let y0 = toEpochDay(`${year}-01-01`);
	let y1 = toEpochDay(`${year + 1}-01-01`);
	let rows = keys.map((k) => view.get(viewKey(k, year)));
	for (let t = 0; t < n; t++) {
		const e = s + t;
		if (e >= y1) {
			year++;
			y0 = y1;
			y1 = toEpochDay(`${year + 1}-01-01`);
			rows = keys.map((k) => view.get(viewKey(k, year)));
		}
		const i = e - y0;
		let missing = false;
		let prelim = false;
		for (let c = 0; c < rows.length; c++) {
			const row = rows[c];
			const v = row ? (row.vals[i] ?? null) : null;
			if (v === null) {
				missing = true;
				break;
			}
			if (row!.final[i] !== true) prelim = true;
			vals[c] = Number.isNaN(v) ? null : v;
		}
		got[t] = missing ? { v: null, prelim: false } : { v: meanOf(vals, cells, noData), prelim };
	}
	let last = got.length - 1;
	while (last >= 0 && got[last]!.v === null) last--;
	const kept = got.slice(0, last + 1);
	let final = 0;
	while (final < kept.length && kept[final]!.v !== null && !kept[final]!.prelim) final++;
	const out: GridDays = { startDate: window.start, values: kept.map((g) => g.v), prelimDays: kept.filter((g) => g.v !== null && g.prelim).length };
	if (final > 0) out.finalThrough = fromEpochDay(s + final - 1);
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
