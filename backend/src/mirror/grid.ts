// The mirror's grid and its D2 index maths (issue #604; docs/architecture.md
// § Data feeds → The mirror). Pure: no store, no I/O.
//
// The copy holds the D1 region of CHC's global 0.05° grid: 10–41° E,
// 35.5–8° S, 620 columns × 550 rows. Index [0, 0] is the south-west cell
// (centre 35.475° S, 10.025° E); rows grow northwards, as in CHC's NetCDF,
// and columns eastwards. The cell cache (feeds/cellCache.ts) names cells on
// the global grid instead (row 0 at 60° N, column 0 at 180° W, rows growing
// southwards), so every index here is computed from origin and step in whole
// cells, never by matching float coordinates.
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { FeedFormatError } from '../feeds/errors.js';
import type { GridCell } from '../feeds/cellCache.js';

/** Degrees per cell, CHC's grid. */
export const MIRROR_STEP = 0.05;

/** D1: the region the copy holds, in degrees. */
export interface Region {
	w: number;
	s: number;
	e: number;
	n: number;
}
export const MIRROR_REGION: Region = { w: 10, s: -35.5, e: 41, n: -8 };

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

const round9 = (x: number) => Number(x.toFixed(9));

/** CHC's global grid, as feeds/cellCache.ts names cells: its north-west corner. */
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

/** The mirror's (y, x) of a global CHC cell: y counted north from the region's south edge, x east from its west edge. */
export interface MirrorCell {
	y: number;
	x: number;
}

/**
 * The mirror cell of a CHC grid cell (feeds/cellCache.ts chcCell), or a
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

/** The inverse of mirrorCell: the global CHC cell of a mirror (y, x). */
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
