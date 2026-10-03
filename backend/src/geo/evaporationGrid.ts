// The evaporation grid's data, without any NetCDF (180_evaporation_reference.sql;
// issue #326 B-evap, docs/maps.md § Evaporation from the map): dPET's
// defaults and the method text, the grid of monthly means in its JSON form
// (`{ "kind": "et0", "cellDeg": 0.1, "firstYear": …, "lastYear": …,
// "source"?, "version"?, "attribution"?, "cells": [[lon, lat, [Oct … Sep]], …] }`,
// each cell by its centre: the committed synthetic fixture's form, and what
// `pnpm import:evaporation … --out` writes for a production load), and the
// load into the database, which replaces a dataset in one transaction.
//
// Split from loadEvaporation.ts (the dPET NetCDF reader, h5wasm) so the
// migrate Lambda's reference loads (geo/referenceLoad.ts, docs/deployment.md §
// Reference datasets) carry no HDF5 code: lambda-migrate.test.ts checks its
// bundle.
import type pg from 'pg';
import { recordReferenceOrigin, type ReferenceOrigin } from './referenceOrigin.js';
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

/** Jan … Dec → Oct … Sep (the water year settings.apanMm and settings.pe use). */
export const toWaterYear = (calendar: readonly number[]): number[] => [...calendar.slice(9), ...calendar.slice(0, 9)];

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
export const indexOf = (centre: number, origin: number, cellDeg: number) => Math.floor((centre - origin) / cellDeg + 1e-6);

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
	if (!Array.isArray(d.cells[0])) return 'the JSON file’s first cell is not [lon, lat, [12 values]]';
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

/** Six decimals: a cell centre to about 0.1 m, so it lands back in its own cell. */
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/**
 * A grid of monthly means in the JSON form evaporationFromJson reads (the
 * file a production load takes): each cell by its centre, its values Oct … Sep,
 * with the dataset's kind, years, source, version and attribution.
 */
export function evaporationToJson(meta: Pick<EvaporationDatasetMeta, 'kind' | 'source' | 'version' | 'attribution'>, clim: Climatology): string {
	return JSON.stringify({
		kind: meta.kind,
		cellDeg: clim.cellDeg,
		firstYear: clim.firstYear,
		lastYear: clim.lastYear,
		source: meta.source,
		version: meta.version,
		attribution: meta.attribution,
		cells: clim.cells.map((c) => [
			round6(clim.originLon + (c.col + 0.5) * clim.cellDeg),
			round6(clim.originLat + (c.row + 0.5) * clim.cellDeg),
			c.monthlyMm
		])
	});
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

/**
 * Replace `meta.dataset` with `clim`'s cells, in one transaction, as the
 * schema owner. `origin`: the reference-bucket file a production load read
 * (recorded with the data; referenceOrigin.ts), null for any other replace.
 * Returns how many cells it wrote.
 */
export async function replaceEvaporationDataset(client: pg.ClientBase, meta: EvaporationDatasetMeta, clim: Climatology, origin: ReferenceOrigin | null = null): Promise<number> {
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
		await recordReferenceOrigin(client, 'evaporation', meta.dataset, origin);
		await client.query('COMMIT');
		return clim.cells.length;
	} catch (e) {
		await client.query('ROLLBACK');
		throw e;
	}
}
