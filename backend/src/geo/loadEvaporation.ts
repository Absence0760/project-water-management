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
import type pg from 'pg';
import type { EvaporationKind } from './evaporation.js';

/** The product the operator's dPET load defaults to (each can be overridden on the command line). */
export const DPET = {
	source:
		'dPET, the daily files of hPET: potential evapotranspiration by the FAO-56 Penman-Monteith equation from ERA5-Land (Singer, M.B. et al. 2021, Sci Data 8, 224; https://doi.org/10.5523/bris.qb8ujazzda0s2aykkv0oq0ctp), CC BY 4.0',
	version: 'hPET v3 (University of Bristol data.bris)',
	attribution:
		'hPET/dPET © Singer et al. 2021, University of Bristol, CC BY 4.0. Contains modified Copernicus Climate Change Service information (ERA5-Land, CC BY 4.0); neither the European Commission nor ECMWF is responsible for any use of it.'
} as const;

/** The dPET grid: 0.1° cells, centred on whole tenths of a degree. */
export const DPET_CELL_DEG = 0.1;

/** The summarising method in words, as proposals and revisions cite it. */
export function evaporationMethodFor(cellDeg: number, firstYear: number, lastYear: number, kind: EvaporationKind): string {
	const what = kind === 'et0' ? 'reference evapotranspiration (ET₀)' : 'A-pan evaporation';
	return (
		`Pre-summarised at import: each ${cellDeg}° cell's daily ${what} summed into calendar-month totals and averaged over ${firstYear}–${lastYear} (cells with every year only). ` +
		'The catchment’s month is the mean of the cells it covers, each weighted by its area on the WGS84 ellipsoid × the share of it inside the boundary; cells without a value are left out.'
	);
}

/** One grid cell: its centre and 12 values (the meaning of the values depends on the input). */
export type CentreCell = [lon: number, lat: number, values: number[]];

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysIn = (y: number, m: number) => (m === 1 && leap(y) ? 29 : MONTH_DAYS[m]!);

/** Jan … Dec → Oct … Sep (the water year settings.apanMm and settings.pe use). */
export const toWaterYear = (calendar: readonly number[]): number[] => [...calendar.slice(9), ...calendar.slice(0, 9)];

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

/** A grid cell keyed by its south-west indices, in a grid whose corners sit at (origin + index × cell). */
export interface EvaporationCell {
	row: number;
	col: number;
	/** Oct … Sep, mean monthly total, mm. */
	monthlyMm: number[];
}

/** The origin (0 ≤ origin < cell) of the grid whose cells are centred on `centre`. */
export const originOf = (centre: number, cellDeg: number): number => {
	const o = (((centre - cellDeg / 2) % cellDeg) + cellDeg) % cellDeg;
	return o > cellDeg - 1e-9 ? 0 : round9(o);
};
const round9 = (x: number) => Math.round(x * 1e9) / 1e9;

/** A cell centre → its indices in the grid with this origin. */
const indexOf = (centre: number, origin: number, cellDeg: number) => Math.floor((centre - origin) / cellDeg + 1e-6);

export interface Climatology {
	cellDeg: number;
	originLon: number;
	originLat: number;
	firstYear: number;
	lastYear: number;
	cells: EvaporationCell[];
	/** Cells left out for missing a year. */
	partial: number;
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

const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** The fixture form, or why it can't be read. Values are already monthly means in water-year order. */
export function evaporationFromJson(doc: unknown):
	| { kind: EvaporationKind; climatology: Climatology; meta: { source?: string; version?: string; attribution?: string }; problems: string[] }
	| string {
	const d = doc as { kind?: unknown; cellDeg?: unknown; firstYear?: unknown; lastYear?: unknown; cells?: unknown; source?: unknown; version?: unknown; attribution?: unknown };
	if (d?.kind === 'span') return 'an S-pan dataset can’t be loaded: convert it to A-pan with your own monthly factors first, and say so in --source';
	if (d?.kind !== 'et0' && d?.kind !== 'apan') return 'the JSON file has no "kind" of "et0" (reference ET) or "apan" (Class-A pan)';
	const cellDeg = Number(d.cellDeg);
	if (!(cellDeg > 0 && cellDeg <= 1)) return 'the JSON file has no "cellDeg" between 0 and 1';
	const firstYear = Number(d.firstYear);
	const lastYear = Number(d.lastYear);
	if (!(Number.isInteger(firstYear) && Number.isInteger(lastYear) && firstYear <= lastYear)) return 'the JSON file has no "firstYear" ≤ "lastYear"';
	if (!Array.isArray(d.cells) || !d.cells.length) return 'the JSON file has no "cells"';
	const problems: string[] = [];
	const [lon0, lat0] = (d.cells[0] as unknown[]).map(Number) as [number, number];
	const originLon = originOf(lon0, cellDeg);
	const originLat = originOf(lat0, cellDeg);
	const cells: EvaporationCell[] = [];
	d.cells.forEach((c: unknown, i: number) => {
		const [lon, lat, v] = Array.isArray(c) ? c : [];
		const values = Array.isArray(v) ? v.map(Number) : [];
		if (!Number.isFinite(Number(lon)) || !Number.isFinite(Number(lat)) || Math.abs(Number(lon)) > 180 || Math.abs(Number(lat)) > 90) {
			return problems.push(`cell ${i + 1}: not [lon, lat, [12 values]]`);
		}
		if (values.length !== 12 || !values.every((x) => Number.isFinite(x) && x >= 0 && x <= 1000)) return problems.push(`cell ${i + 1}: not 12 monthly values of 0–1000 mm`);
		if (Math.abs(originOf(Number(lon), cellDeg) - originLon) > 1e-6 || Math.abs(originOf(Number(lat), cellDeg) - originLat) > 1e-6) {
			return problems.push(`cell ${i + 1}: its centre isn't on the first cell's ${cellDeg}° grid`);
		}
		cells.push({ row: indexOf(Number(lat), originLat, cellDeg), col: indexOf(Number(lon), originLon, cellDeg), monthlyMm: values });
	});
	return {
		kind: d.kind,
		climatology: { cellDeg, originLon, originLat, firstYear, lastYear, cells, partial: 0 },
		meta: { source: text(d.source, 500), version: text(d.version, 100), attribution: text(d.attribution, 500) },
		problems
	};
}

// ---------------------------------------------------------------------------
// The database
// ---------------------------------------------------------------------------

export interface EvaporationDatasetMeta {
	dataset: string;
	kind: EvaporationKind;
	/** Shown with every proposed value: the product, its version and where it came from. */
	source: string;
	version: string;
	/** How the cells were summarised, in words an evidence pack can print. */
	method: string;
	/** The licence and attribution line. */
	attribution: string;
}

const BATCH = 5_000;

/** Replace `meta.dataset` with `clim`'s cells, in one transaction, as the schema owner. Returns how many cells it wrote. */
export async function replaceEvaporationDataset(client: pg.ClientBase, meta: EvaporationDatasetMeta, clim: Climatology): Promise<number> {
	// A dataset with no cell is a wrong box or file, not a dataset to propose from.
	if (!clim.cells.length) throw new Error('no cell has a value for every month of every year: check the files and --bbox');
	await client.query('BEGIN');
	try {
		// The cells go with their dataset (ON DELETE CASCADE).
		await client.query('DELETE FROM evaporation_dataset WHERE dataset = $1', [meta.dataset]);
		await client.query(
			`INSERT INTO evaporation_dataset (dataset, kind, source, version, method, attribution, first_year, last_year, cell_deg, origin_lon, origin_lat)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
			[meta.dataset, meta.kind, meta.source, meta.version, meta.method, meta.attribution, clim.firstYear, clim.lastYear, clim.cellDeg, clim.originLon, clim.originLat]
		);
		for (let i = 0; i < clim.cells.length; i += BATCH) {
			const part = clim.cells.slice(i, i + BATCH);
			await client.query(
				`INSERT INTO evaporation_cell_reference (dataset, row_idx, col_idx, monthly_mm)
				 SELECT $1, r, c, (SELECT array_agg(x::real ORDER BY o) FROM jsonb_array_elements_text(v) WITH ORDINALITY AS e (x, o))
				 FROM unnest($2::integer[], $3::integer[], $4::jsonb[]) AS t (r, c, v)`,
				[meta.dataset, part.map((c) => c.row), part.map((c) => c.col), part.map((c) => JSON.stringify(c.monthlyMm))]
			);
		}
		await client.query('COMMIT');
		return clim.cells.length;
	} catch (e) {
		await client.query('ROLLBACK');
		throw e;
	}
}
