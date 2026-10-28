// The mirror's grids and their D2 index maths (issue #604; docs/architecture.md
// § Our copy of the rain data). Pure: no store, no I/O.
//
// The copy holds the D1 region (10–41° E, 35.5–8° S) of each product on the
// product's own grid (PRODUCT_GRIDS): CHC's 0.05° grid for the CHIRPS products
// (620 columns × 550 rows, index [0, 0] the south-west cell centred at
// 35.475° S, 10.025° E), and a 0.1° grid for ERA5-Land and IMERG Late (310 ×
// 275, [0, 0] centred at 35.45° S, 10.05° E). Rows grow northwards, as in
// CHC's NetCDF, and columns eastwards. The cell cache (feeds/cellCache.ts)
// names cells on the global grid of the same step instead (row 0 at 60° N,
// column 0 at 180° W, rows growing southwards: 2400 × 7200 cells at 0.05°,
// 1200 × 3600 at 0.1°), so every index here is computed from origin and step
// in whole cells, never by matching float coordinates. Both global grids
// share their north-west corner, so 0.05° cell (r, c) lies in 0.1° cell
// (⌊r/2⌋, ⌊c/2⌋) (feeds/cellCache.ts productCell). A third grid (issue #620)
// holds C3S's seasonal forecasts at 1°, cell centres on whole degrees over D1
// snapped outward (SEASONAL_REGION: 29 rows × 32 columns, [0, 0] at 36° S,
// 10° E); the cell cache never reads it.
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { FeedFormatError } from '../feeds/errors.js';
import type { GridCell } from '../feeds/cellCache.js';

/** Degrees per cell, CHC's grid. */
export const MIRROR_STEP = 0.05;

/**
 * The array layouts: finals (year, doy, lat, lon) or daily (day, lat, lon), both read by arrays.ts;
 * and seasonal, C3S's (system | year, member, lead_day, lat, lon) group arrays (issue #620), which
 * nothing in the backend reads yet (#620 step 6–7).
 */
export type GridKind = 'finals' | 'daily' | 'seasonal';

/** What the copy holds a product on: its grid's step, its layout, and its first day. */
export interface ProductGrid {
	step: number;
	kind: GridKind;
	/** The product's first day upstream (ISO): the cache refuses an earlier day. None for a forecast issue. */
	firstDay?: string;
	/** The finals layout's year axis starts here (attrs.firstYear when the array is made); daily arrays carry attrs.firstDay. */
	firstYear?: number;
	/** The box the grid's cells tile, when it isn't D1 (MIRROR_REGION): the seasonal grid's (SEASONAL_REGION). */
	region?: Region;
}

/**
 * Every product of the copy, by its store path (a GEFS or ECMWF issue by its
 * prefix). The SQL side keeps the same table for the cell cache's products
 * (252_cache_products.sql mirror_product_first_day, mirror_product_step).
 *   rnl, sat     CHIRPS v3 finals, CHC's 0.05° grid (sat's year axis starts in 1981 too, its years before 1998 unwritten).
 *   prelim       CHIRPS v3 preliminary daily (sat only), 0.05°.
 *   era5l        ERA5-Land daily total precipitation (D15), finals layout, 0.1°, from 1950.
 *   imerg_late   IMERG Late V07 daily (D16), daily layout, 0.1°, from June 2000; a version per day in the manifest's files.
 *   gefs/<issue> the CHIRPS-GEFS forecast, 0.05°; ecmwf/<issue> the ECMWF ensemble forecast, 0.1° (R4-C).
 *   agera5_et0   AgERA5 v2.0 daily FAO-56 reference evapotranspiration (R5-E), finals layout, 0.1°, from 1979, mm/day.
 *   power_et0    FAO-56 reference evapotranspiration we compute from NASA POWER's daily meteorology (R5-E, the
 *                fallback), daily layout, 0.1° (each cell its nearest POWER point), a rolling window of recent days.
 * Neither ET₀ product enters the cell cache: an evaporation feed reads them in its own job (feeds/fromMirrorEt0.ts).
 */
export const PRODUCT_GRIDS = {
	rnl: { step: 0.05, kind: 'finals', firstDay: '1981-01-01', firstYear: 1981 },
	sat: { step: 0.05, kind: 'finals', firstDay: '1998-01-01', firstYear: 1981 },
	prelim: { step: 0.05, kind: 'daily', firstDay: '1998-01-01' },
	era5l: { step: 0.1, kind: 'finals', firstDay: '1950-01-01', firstYear: 1950 },
	imerg_late: { step: 0.1, kind: 'daily', firstDay: '2000-06-01' },
	agera5_et0: { step: 0.1, kind: 'finals', firstDay: '1979-01-01', firstYear: 1979 },
	power_et0: { step: 0.1, kind: 'daily', firstDay: '1981-01-01' }
} as const satisfies Record<string, ProductGrid>;
export type GridProduct = keyof typeof PRODUCT_GRIDS;

const FORECAST_GRIDS: Record<string, ProductGrid> = {
	gefs: { step: 0.05, kind: 'daily' },
	ecmwf: { step: 0.1, kind: 'daily' }
};

/** C3S's seasonal forecasts (`c3s/<YYYY-MM>`) and hindcasts (`c3s-hc/<centre>-<system>/<MM>`), issue #620. */
const SEASONAL_PRODUCT = /^(c3s\/\d{4}-(0[1-9]|1[0-2])|c3s-hc\/[a-z_]+-\d+\/(0[1-9]|1[0-2]))$/;

/** The grid of `product` (a store path: `sat`, `era5l`, `gefs/2026-02-09`, `c3s/2026-10`, …), or null for one the copy doesn't hold. */
export function productGrid(product: string): ProductGrid | null {
	if (Object.hasOwn(PRODUCT_GRIDS, product)) return PRODUCT_GRIDS[product as GridProduct];
	if (SEASONAL_PRODUCT.test(product)) return SEASONAL_GRID;
	const m = /^(gefs|ecmwf)\/\d{4}-\d{2}-\d{2}$/.exec(product);
	return m ? FORECAST_GRIDS[m[1]!]! : null;
}

/** The step of `product`'s grid; a product the copy doesn't hold throws. */
export function productStep(product: string): number {
	const g = productGrid(product);
	if (!g) throw new RangeError(`the rain data copy holds no product ${product}`);
	return g.step;
}

/** The global grid of a step, as the cell cache names cells: rows from 60° N, columns from 180° W. */
export function globalSize(step: number): { rows: number; cols: number } {
	return { rows: Math.round(120 / step), cols: Math.round(360 / step) };
}

/** D1: the region the copy holds, in degrees. */
export interface Region {
	w: number;
	s: number;
	e: number;
	n: number;
}
export const MIRROR_REGION: Region = { w: 10, s: -35.5, e: 41, n: -8 };

/**
 * The seasonal grid's box (issue #620; ingest/grid.py seasonal_region): `region`'s
 * bounds snapped outward to whole multiples of `step`, which are the cells'
 * centres (C3S's 1° points sit on whole degrees), widened by half a cell each
 * way. D1 gives centres 36–8° S, 10–41° E: 29 rows × 32 columns in the box
 * 9.5–41.5° E, 36.5–7.5° S, so gridOf(SEASONAL_REGION, 1) puts [0, 0] at 36° S, 10° E.
 */
export function seasonalRegion(region: Region = MIRROR_REGION, step = 1): Region {
	const h = step / 2;
	return {
		w: round9(Math.floor(region.w / step) * step - h),
		s: round9(Math.floor(region.s / step) * step - h),
		e: round9(Math.ceil(region.e / step) * step + h),
		n: round9(Math.ceil(region.n / step) * step + h)
	};
}
export const SEASONAL_REGION: Region = seasonalRegion();

/** The third grid: C3S's 1° seasonal forecasts and hindcasts, on SEASONAL_REGION. */
const SEASONAL_GRID: ProductGrid = { step: 1, kind: 'seasonal', region: SEASONAL_REGION };

/** The grid attributes every mirror array carries, and every manifest. */
export interface MirrorGrid {
	origin: { lat: number; lon: number };
	step: number;
}

/** The centre of the south-west cell of `region`. */
export const gridOf = (region: Region, step = MIRROR_STEP): MirrorGrid => ({
	origin: { lat: round9(region.s + step / 2), lon: round9(region.w + step / 2) },
	step
});

/** Rows (south to north) and columns (west to east) of `region`, in whole cells. */
export function regionSize(region: Region, step = MIRROR_STEP): { rows: number; cols: number } {
	return { rows: Math.round((region.n - region.s) / step), cols: Math.round((region.e - region.w) / step) };
}

// A declaration, not a const: SEASONAL_REGION calls it while the module loads, above this line.
function round9(x: number): number {
	return Number(x.toFixed(9));
}

/** The global grids, as feeds/cellCache.ts names cells: their north-west corner (every step's). */
const CHC_TOP = 60;
const CHC_LEFT = -180;

/**
 * A cell the region doesn't hold: a feed outside the D1 box. A FeedFormatError,
 * so the feed shows the message rather than retrying: asking again won't help
 * until the region grows (issue #604 "What makes this hard" 8).
 */
export class MirrorOutsideRegionError extends FeedFormatError {
	constructor(lat: number, lon: number, region: Region) {
		super(
			`the point ${lat}, ${lon} is outside the region the rain data copy holds (${region.w}–${region.e}° E, ${-region.n}–${-region.s}° S): feeds there are not supported yet`
		);
	}
}

/** The mirror's (y, x) of a global grid cell: y counted north from the region's south edge, x east from its west edge. */
export interface MirrorCell {
	y: number;
	x: number;
}

/**
 * The mirror cell of a cell of the global grid of `step` (feeds/cellCache.ts
 * chcCell at 0.05°, productCell for another product), or a
 * MirrorOutsideRegionError for a cell the region doesn't hold. Whole-cell
 * arithmetic: the offsets are rounded once from origin and step.
 */
export function mirrorCell(cell: GridCell, region: Region = MIRROR_REGION, step = MIRROR_STEP): MirrorCell {
	const { rows, cols } = regionSize(region, step);
	// The CHC row of the region's southernmost cell, and the CHC column of its westernmost.
	const southRow = Math.round((CHC_TOP - region.s) / step) - 1;
	const westCol = Math.round((region.w - CHC_LEFT) / step);
	const y = southRow - cell.row;
	const x = cell.col - westCol;
	if (y < 0 || y >= rows || x < 0 || x >= cols) {
		const lat = round9(CHC_TOP - (cell.row + 0.5) * step);
		const lon = round9(CHC_LEFT + (cell.col + 0.5) * step);
		throw new MirrorOutsideRegionError(lat, lon, region);
	}
	return { y, x };
}

/** The inverse of mirrorCell: the global grid cell (of `step`) of a mirror (y, x). */
export function chcCellOf(m: MirrorCell, region: Region = MIRROR_REGION, step = MIRROR_STEP): GridCell {
	const southRow = Math.round((CHC_TOP - region.s) / step) - 1;
	const westCol = Math.round((region.w - CHC_LEFT) / step);
	return { row: southRow - m.y, col: m.x + westCol };
}

/** Whether `year` has a 29 February. */
export const isLeapYear = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** The finals layout's day-of-year index of an ISO date: days since 1 January, 0–365 (365 only in a leap year). */
export const doyIndex = (iso: string) => toEpochDay(iso) - toEpochDay(`${iso.slice(0, 4)}-01-01`);

/** The date of a day-of-year index in `year`, or null for index 365 of a year with no such day. */
export function dateOfDoy(year: number, doy: number): string | null {
	if (doy < 0 || doy > 365 || (doy === 365 && !isLeapYear(year))) return null;
	return fromEpochDay(toEpochDay(`${year}-01-01`) + doy);
}

/** The daily layout's day index of an ISO date: days since the array's `firstDay`. */
export const dayIndex = (firstDay: string, iso: string) => toEpochDay(iso) - toEpochDay(firstDay);

/** The chunk holding index `i` along an axis chunked by `size`, and `i`'s place in it. */
export const chunkOf = (i: number, size: number) => ({ chunk: Math.floor(i / size), offset: i % size });

/**
 * The cells' chunks along (y, x) for a chunk shape (ch, cw), each with the
 * bounding box (inclusive) of the cells it holds: one read per chunk, never a
 * box across the region between scattered cells.
 */
export function cellsByChunk(cells: readonly MirrorCell[], ch: number, cw: number): { y0: number; y1: number; x0: number; x1: number; cells: number[] }[] {
	const groups = new Map<string, { y0: number; y1: number; x0: number; x1: number; cells: number[] }>();
	cells.forEach((c, i) => {
		const key = `${Math.floor(c.y / ch)},${Math.floor(c.x / cw)}`;
		const g = groups.get(key);
		if (!g) groups.set(key, { y0: c.y, y1: c.y, x0: c.x, x1: c.x, cells: [i] });
		else {
			g.y0 = Math.min(g.y0, c.y);
			g.y1 = Math.max(g.y1, c.y);
			g.x0 = Math.min(g.x0, c.x);
			g.x1 = Math.max(g.x1, c.x);
			g.cells.push(i);
		}
	});
	return [...groups.values()];
}
