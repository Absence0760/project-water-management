// Pre-summarise a daily evaporation product into the grid of monthly means
// the app reads (180_evaporation_reference.sql; issue #326 B-evap,
// docs/maps.md § Evaporation from the map). The operator's tool, run as the
// schema owner (`pnpm import:evaporation`, `pnpm import:evaporation:fetch`); the app
// only reads the result, never a NetCDF file: this module is imported by
// backend/scripts/import-evaporation.ts and its tests only, and h5wasm (a
// dev dependency) is loaded lazily inside readDpetYear, so no HDF5 code can
// reach a Lambda bundle.
//
// Three inputs:
//  * dPET, the daily files of hPET (Singer et al. 2021; CC BY 4.0, derived
//    from ERA5-Land, docs/maps.md § Sources): one NetCDF-4 (HDF5) file a
//    year, `<year>_daily_pet.nc`, variable `pet` (time, latitude, longitude)
//    in mm/day, latitude 90 … −90 and longitude −180 … 180 in 0.1° steps
//    (cell centres). readDpetYear sums each cell's days into its 12 calendar-
//    month totals inside a box; a month with a missing day leaves the cell
//    out of that year.
//  * a year's totals as JSON (`--reduce` writes them, so the 2.4 GB files
//    can be deleted one by one): `{ "product": "dPET", "year": 2015,
//    "cellDeg": 0.1, "cells": [[lon, lat, [Jan … Dec]], …] }`.
//  * the fixture form: `{ "kind": "et0", "cellDeg": 0.1, "firstYear": …,
//    "lastYear": …, "cells": [[lon, lat, [Oct … Sep]], …] }`, each cell by
//    its centre, its values already the monthly means (the committed
//    synthetic grid).
// The monthly means are the mean of each calendar month's total over the
// years, kept only for a cell with every year (so no cell's mean leans on a
// different set of years than its neighbour's), in water-year order. A load
// replaces its dataset, in one transaction.
import { DPET_CELL_DEG, indexOf, originOf, toWaterYear, type CentreCell, type Climatology, type EvaporationCell } from './evaporationGrid.js';

// The grid's JSON form, its defaults and its database load live in
// evaporationGrid.ts (no NetCDF, so the migrate Lambda can carry them).
export * from './evaporationGrid.js';

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysIn = (y: number, m: number) => (m === 1 && leap(y) ? 29 : MONTH_DAYS[m]!);

export interface Bbox {
	west: number;
	south: number;
	east: number;
	north: number;
}

/** South Africa, Lesotho and Eswatini with a margin: the box the operator's load reads unless told otherwise. */
export const SOUTH_AFRICA_BBOX: Bbox = { west: 16, south: -35.2, east: 33.2, north: -22 };

/** A year's calendar-month totals per cell, mm (the `--reduce` file's content). */
export interface YearTotals {
	product: 'dPET';
	year: number;
	cellDeg: number;
	cells: CentreCell[];
}

/** The year a dPET file holds, from its name (`2015_daily_pet.nc`); null when the name doesn't say. */
export function dpetYear(path: string): number | null {
	const m = /(?:^|[/\\])((?:19|20)\d\d)_daily_pet[^/\\]*\.nc$/i.exec(path);
	return m ? Number(m[1]) : null;
}

interface H5Attr {
	value: unknown;
}
interface H5Dataset {
	shape: number[] | null;
	attrs: Record<string, H5Attr>;
	value: unknown;
	slice(ranges: [number, number][]): unknown;
}

const scalar = (a: H5Attr | undefined): number | null => {
	if (!a) return null;
	const v = a.value as unknown;
	const x = typeof v === 'number' ? v : ArrayBuffer.isView(v) || Array.isArray(v) ? Number((v as ArrayLike<number>)[0]) : typeof v === 'bigint' ? Number(v) : NaN;
	return Number.isFinite(x) ? x : null;
};

/** The index range [first, last) of `axis` (cell centres) whose values lie in [lo, hi]. */
function axisRange(axis: ArrayLike<number>, lo: number, hi: number): [number, number] | null {
	let first = -1;
	let last = -1;
	for (let i = 0; i < axis.length; i++) {
		const v = axis[i]!;
		if (v >= lo - 1e-9 && v <= hi + 1e-9) {
			if (first < 0) first = i;
			last = i;
		}
	}
	return first < 0 ? null : [first, last + 1];
}

/**
 * One dPET year inside `bbox`: each cell's 12 calendar-month totals, mm.
 * Reads the file month by month (only the box), honouring `_FillValue`,
 * `missing_value`, `scale_factor` and `add_offset`; a cell with any missing
 * day in a month is left out of the year. A negative month total counts
 * as 0 (the grid stores no negative evaporation). Refuses
 * a file whose shape isn't the year's days × latitude × longitude.
 */
export async function readDpetYear(path: string, bbox: Bbox): Promise<YearTotals> {
	const year = dpetYear(path);
	if (year === null) throw new Error(`${path}: name the file <year>_daily_pet.nc, as dPET does, so the year is known`);
	const { default: h5wasm } = await import('h5wasm/node');
	await h5wasm.ready;
	const file = new h5wasm.File(path, 'r');
	try {
		const get = (name: string) => file.get(name) as unknown as H5Dataset | null;
		const pet = get('pet');
		const latDs = get('latitude') ?? get('lat');
		const lonDs = get('longitude') ?? get('lon');
		if (!pet || !latDs || !lonDs) throw new Error(`${path}: no pet, latitude and longitude variables (is it a dPET file?)`);
		const lats = latDs.value as ArrayLike<number>;
		const lons = lonDs.value as ArrayLike<number>;
		const days = MONTH_DAYS.reduce((s, _, m) => s + daysIn(year, m), 0);
		const shape = pet.shape ?? [];
		if (shape.length !== 3 || shape[0] !== days || shape[1] !== lats.length || shape[2] !== lons.length) {
			throw new Error(`${path}: pet is ${shape.join(' × ')}, not ${days} days × ${lats.length} × ${lons.length} for ${year}`);
		}
		const step = Math.abs(lons[1]! - lons[0]!);
		if (Math.abs(step - DPET_CELL_DEG) > 1e-4) throw new Error(`${path}: the longitude step is ${step}°, not dPET's ${DPET_CELL_DEG}°`);
		const rows = axisRange(lats, bbox.south, bbox.north);
		const cols = axisRange(lons, bbox.west, bbox.east);
		if (!rows || !cols) throw new Error(`${path}: no cell centre lies inside the box`);
		const fill = [scalar(pet.attrs._FillValue), scalar(pet.attrs.missing_value)].filter((x): x is number => x !== null);
		const scale = scalar(pet.attrs.scale_factor) ?? 1;
		const offset = scalar(pet.attrs.add_offset) ?? 0;
		const ny = rows[1] - rows[0];
		const nx = cols[1] - cols[0];
		const totals = Array.from({ length: 12 }, () => new Float64Array(ny * nx));
		const missing = Array.from({ length: 12 }, () => new Uint8Array(ny * nx));
		let t = 0;
		for (let m = 0; m < 12; m++) {
			const nd = daysIn(year, m);
			const block = pet.slice([
				[t, t + nd],
				[rows[0], rows[1]],
				[cols[0], cols[1]]
			]) as ArrayLike<number>;
			for (let d = 0; d < nd; d++) {
				for (let i = 0; i < ny * nx; i++) {
					const raw = Number(block[d * ny * nx + i]);
					if (!Number.isFinite(raw) || fill.some((f) => raw === f) || Math.abs(raw) > 1e20) missing[m]![i] = 1;
					else totals[m]![i]! += raw * scale + offset;
				}
			}
			t += nd;
		}
		const cells: CentreCell[] = [];
		for (let y = 0; y < ny; y++) {
			for (let x = 0; x < nx; x++) {
				const i = y * nx + x;
				if (missing.some((mm) => mm[i])) continue;
				cells.push([round4(lons[cols[0] + x]!), round4(lats[rows[0] + y]!), totals.map((tt) => round2(Math.max(0, tt[i]!)))]);
			}
		}
		return { product: 'dPET', year, cellDeg: DPET_CELL_DEG, cells };
	} finally {
		file.close();
	}
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

/** A `--reduce` file read back, or why it can't be. */
export function yearTotalsFromJson(doc: unknown): YearTotals | string {
	const d = doc as Partial<YearTotals>;
	if (d?.product !== 'dPET') return 'not a year of dPET totals ("product": "dPET")';
	if (!Number.isInteger(d.year)) return 'no "year"';
	if (!(Number(d.cellDeg) > 0)) return 'no "cellDeg"';
	if (!Array.isArray(d.cells)) return 'no "cells" array';
	return { product: 'dPET', year: d.year!, cellDeg: Number(d.cellDeg), cells: d.cells as CentreCell[] };
}

/**
 * The mean of each calendar month's total over `years`, per cell, for the
 * cells every year has, in water-year order. Refuses years that repeat,
 * leave a gap, or are on different grids.
 */
export function climatology(years: readonly YearTotals[]): Climatology | string {
	if (!years.length) return 'no years to average';
	const sorted = [...years].sort((a, b) => a.year - b.year);
	for (let i = 1; i < sorted.length; i++) {
		if (sorted[i]!.year === sorted[i - 1]!.year) return `${sorted[i]!.year} is given twice`;
		if (sorted[i]!.year !== sorted[i - 1]!.year + 1) return `the years skip from ${sorted[i - 1]!.year} to ${sorted[i]!.year}: give a continuous run of years`;
		if (sorted[i]!.cellDeg !== sorted[0]!.cellDeg) return `${sorted[i]!.year} is on a ${sorted[i]!.cellDeg}° grid, ${sorted[0]!.year} on ${sorted[0]!.cellDeg}°`;
	}
	const cellDeg = sorted[0]!.cellDeg;
	const first = sorted[0]!.cells[0];
	if (!first) return `${sorted[0]!.year} has no cells`;
	const originLon = originOf(first[0], cellDeg);
	const originLat = originOf(first[1], cellDeg);
	const sums = new Map<string, { row: number; col: number; sum: number[]; n: number }>();
	for (const y of sorted) {
		for (const [lon, lat, v] of y.cells) {
			const row = indexOf(lat, originLat, cellDeg);
			const col = indexOf(lon, originLon, cellDeg);
			const k = `${row}:${col}`;
			const s = sums.get(k) ?? { row, col, sum: new Array<number>(12).fill(0), n: 0 };
			for (let m = 0; m < 12; m++) s.sum[m]! += Number(v[m]);
			s.n++;
			sums.set(k, s);
		}
	}
	const cells: EvaporationCell[] = [];
	let partial = 0;
	for (const s of sums.values()) {
		if (s.n !== sorted.length) {
			partial++;
			continue;
		}
		cells.push({ row: s.row, col: s.col, monthlyMm: toWaterYear(s.sum.map((x) => round2(x / s.n))) });
	}
	cells.sort((a, b) => a.row - b.row || a.col - b.col);
	return { cellDeg, originLon, originLat, firstYear: sorted[0]!.year, lastYear: sorted.at(-1)!.year, cells, partial };
}
