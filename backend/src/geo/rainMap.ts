// The mean annual precipitation (MAP) grids the Map tab draws as labelled
// grid points (207_rain_map_reference.sql; docs/maps.md § MAP grid):
//
//  - reading: the loaded datasets (the default first) and one dataset's cells
//    in a box, for GET …/map/map-grid (rainMapRoutes.ts);
//  - loading: an ESRI ASCII grid (`.asc`, which any GIS writes: `gdal_translate
//    -of AAIGrid`), streamed line by line and cut to an optional box, or the
//    committed fixture's JSON form (`{ "cellDeg", "source"?, "version"?,
//    "attribution"?, "cells": [[lon, lat, mapMm], …] }`, each cell by its
//    centre); and the replace of a dataset, in one transaction, as the schema
//    owner (backend/scripts/import-map-grid.ts).
//
// A grid's cells are keyed by their south-west corner's indices from the
// dataset's origin, as the evaporation grid's are (evaporationGrid.ts
// originOf/indexOf), so a box is a range on the primary key.
import type pg from 'pg';
import { indexOf, originOf } from './evaporationGrid.js';

/** The repo's invented grid (backend/fixtures/geo/map-grid.synthetic.json): never real rainfall. */
export const SYNTHETIC_RAIN_MAP_DATASET = 'synthetic';

type Db = pg.ClientBase | pg.Pool;

export interface RainMapDataset {
	dataset: string;
	source: string;
	version: string;
	attribution: string;
	cellDeg: number;
	/** How many cells have a value. */
	cells: number;
	synthetic: boolean;
}

/** The loaded MAP grids, the default first: a real one before the synthetic grid, then the finest, then by label. */
export async function rainMapDatasets(db: Db): Promise<RainMapDataset[]> {
	const { rows } = await db.query<{ dataset: string; source: string; version: string; attribution: string; cell_deg: number; cells: number }>(
		`SELECT d.dataset, d.source, d.version, d.attribution, d.cell_deg, d.cell_count AS cells
		 FROM rain_map_dataset d
		 ORDER BY d.dataset = $1, d.cell_deg, d.dataset`,
		[SYNTHETIC_RAIN_MAP_DATASET]
	);
	return rows.map((r) => ({
		dataset: r.dataset,
		source: r.source,
		version: r.version,
		attribution: r.attribution,
		cellDeg: r.cell_deg,
		cells: r.cells,
		synthetic: r.dataset === SYNTHETIC_RAIN_MAP_DATASET
	}));
}

/** A west, south, east, north box in WGS84 degrees. */
export interface Box {
	w: number;
	s: number;
	e: number;
	n: number;
}

/** One cell as the layer gets it: its centre and its MAP, mm/yr (rounded to whole mm). */
export type RainMapPoint = [lon: number, lat: number, mapMm: number];

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** The grid's rows and columns whose cells meet `box`, and how many cells that is at most. */
export function cellRange(grid: { cellDeg: number; originLon: number; originLat: number }, box: Box) {
	const c0 = Math.floor((box.w - grid.originLon) / grid.cellDeg);
	const c1 = Math.ceil((box.e - grid.originLon) / grid.cellDeg) - 1;
	const r0 = Math.floor((box.s - grid.originLat) / grid.cellDeg);
	const r1 = Math.ceil((box.n - grid.originLat) / grid.cellDeg) - 1;
	return { r0, r1, c0, c1, most: Math.max(0, r1 - r0 + 1) * Math.max(0, c1 - c0 + 1) };
}

/**
 * The cells of `dataset` whose centres lie in `box`, at most `max`: null
 * when the box holds more than `max` of the grid's cells (counted from the
 * grid, before any read: the caller says zoom in), else each cell's centre and
 * MAP, south to north, west to east.
 */
export async function rainMapCellsIn(db: Db, dataset: string, box: Box, max: number): Promise<{ cells: RainMapPoint[]; inBox: number } | null> {
	const { rows: ds } = await db.query<{ cell_deg: number; origin_lon: number; origin_lat: number }>(
		'SELECT cell_deg, origin_lon, origin_lat FROM rain_map_dataset WHERE dataset = $1',
		[dataset]
	);
	const d = ds[0];
	if (!d) return { cells: [], inBox: 0 };
	const grid = { cellDeg: d.cell_deg, originLon: d.origin_lon, originLat: d.origin_lat };
	const range = cellRange(grid, box);
	if (range.most > max) return null;
	const { rows } = await db.query<{ row_idx: number; col_idx: number; map_mm: number }>(
		`SELECT row_idx, col_idx, map_mm FROM rain_map_cell_reference
		 WHERE dataset = $1 AND row_idx BETWEEN $2 AND $3 AND col_idx BETWEEN $4 AND $5
		 ORDER BY row_idx, col_idx`,
		[dataset, range.r0, range.r1, range.c0, range.c1]
	);
	const cells: RainMapPoint[] = [];
	for (const r of rows) {
		const lon = grid.originLon + (r.col_idx + 0.5) * grid.cellDeg;
		const lat = grid.originLat + (r.row_idx + 0.5) * grid.cellDeg;
		if (lon < box.w || lon > box.e || lat < box.s || lat > box.n) continue;
		cells.push([round6(lon), round6(lat), Math.round(r.map_mm)]);
	}
	return { cells, inBox: cells.length };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** A grid ready to load: its cell size, origin and cells by index. */
export interface RainMapGrid {
	cellDeg: number;
	originLon: number;
	originLat: number;
	cells: { row: number; col: number; mapMm: number }[];
}

export interface RainMapMeta {
	dataset: string;
	source: string;
	version: string;
	attribution: string;
}

/** MAP outside this is a wrong file or unit (South Africa's wettest point is about 3 200 mm). */
const MAP_MAX_MM = 20_000;
const inBox = (lon: number, lat: number, box: Box | null) => !box || (lon >= box.w && lon <= box.e && lat >= box.s && lat <= box.n);

/**
 * An ESRI ASCII grid's lines → its cells with a value whose centres lie in
 * `box` (all of them without one). The header's corner or centre form
 * (`xllcorner`/`xllcenter`), any NODATA value; rows run north to south, as
 * the format has them. Coordinates must be WGS84 degrees: a projected grid
 * (a cell size past 1°, or corners outside ±180/±90) is refused.
 */
export async function rainMapFromAscii(lines: AsyncIterable<string> | Iterable<string>, box: Box | null): Promise<RainMapGrid> {
	const head: Record<string, number> = {};
	let row = -1;
	let nrows = 0;
	let ncols = 0;
	let x0 = 0;
	let yTop = 0;
	let size = 0;
	let nodata: number | null = null;
	let grid: RainMapGrid | null = null;
	for await (const raw of lines) {
		const line = raw.trim();
		if (!line) continue;
		if (row < 0) {
			const m = /^([A-Za-z_]+)\s+(\S+)$/.exec(line);
			if (m) {
				const v = Number(m[2]);
				if (!Number.isFinite(v)) throw new Error(`the header's ${m[1]} is not a number`);
				head[m[1]!.toLowerCase()] = v;
				continue;
			}
			ncols = head.ncols ?? 0;
			nrows = head.nrows ?? 0;
			size = head.cellsize ?? 0;
			nodata = head.nodata_value ?? null;
			if (!(Number.isInteger(ncols) && ncols > 0 && Number.isInteger(nrows) && nrows > 0)) throw new Error('the header has no ncols and nrows');
			if (!(size > 0 && size <= 1)) throw new Error('the cell size is not between 0 and 1 degree: the grid must be in WGS84 degrees (reproject it first)');
			const xll = head.xllcorner ?? (head.xllcenter !== undefined ? head.xllcenter - size / 2 : NaN);
			const yll = head.yllcorner ?? (head.yllcenter !== undefined ? head.yllcenter - size / 2 : NaN);
			if (!Number.isFinite(xll) || !Number.isFinite(yll)) throw new Error('the header has no xllcorner/xllcenter and yllcorner/yllcenter');
			if (xll < -180 || xll + ncols * size > 180 || yll < -90 || yll + nrows * size > 90) throw new Error('the grid is outside ±180°, ±90°: it must be in WGS84 degrees (reproject it first)');
			x0 = xll;
			yTop = yll + nrows * size;
			const originLon = originOf(x0 + size / 2, size);
			const originLat = originOf(yll + size / 2, size);
			grid = { cellDeg: size, originLon, originLat, cells: [] };
			row = 0;
		}
		if (row >= nrows) throw new Error(`the grid has more than its ${nrows} rows`);
		const lat = yTop - (row + 0.5) * size;
		if (!box || (lat >= box.s && lat <= box.n)) {
			const values = line.split(/\s+/);
			if (values.length !== ncols) throw new Error(`row ${row + 1} has ${values.length} values, not ${ncols}`);
			for (let c = 0; c < ncols; c++) {
				const v = Number(values[c]);
				if (!Number.isFinite(v) || v === nodata || v < 0) continue;
				if (v > MAP_MAX_MM) throw new Error(`row ${row + 1}, column ${c + 1}: ${v} mm is not a mean annual precipitation`);
				const lon = x0 + (c + 0.5) * size;
				if (!inBox(lon, lat, box)) continue;
				grid!.cells.push({ row: indexOf(lat, grid!.originLat, size), col: indexOf(lon, grid!.originLon, size), mapMm: v });
			}
		}
		row++;
	}
	if (!grid) throw new Error('the file has no ESRI ASCII grid header (ncols, nrows, xllcorner, yllcorner, cellsize)');
	if (row !== nrows) throw new Error(`the grid has ${row} rows, not ${nrows}`);
	return grid;
}

const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** The fixture's JSON form → the grid and its own source lines, or why it can't be read. */
export function rainMapFromJson(doc: unknown): { grid: RainMapGrid; meta: { source?: string; version?: string; attribution?: string } } | string {
	const d = doc as { cellDeg?: unknown; cells?: unknown; source?: unknown; version?: unknown; attribution?: unknown };
	const cellDeg = Number(d?.cellDeg);
	if (!(cellDeg > 0 && cellDeg <= 1)) return 'the JSON file has no "cellDeg" between 0 and 1';
	if (!Array.isArray(d.cells) || !d.cells.length || !Array.isArray(d.cells[0])) return 'the JSON file has no "cells" of [lon, lat, mapMm]';
	const [lon0, lat0] = (d.cells[0] as unknown[]).map(Number) as [number, number];
	const grid: RainMapGrid = { cellDeg, originLon: originOf(lon0, cellDeg), originLat: originOf(lat0, cellDeg), cells: [] };
	for (const [i, c] of (d.cells as unknown[]).entries()) {
		const [lon, lat, v] = Array.isArray(c) ? c.map(Number) : [];
		if (!(Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon!) <= 180 && Math.abs(lat!) <= 90)) return `cell ${i + 1}: not [lon, lat, mapMm]`;
		if (!(Number.isFinite(v) && v! >= 0 && v! <= MAP_MAX_MM)) return `cell ${i + 1}: not a MAP of 0–${MAP_MAX_MM} mm`;
		if (Math.abs(originOf(lon!, cellDeg) - grid.originLon) > 1e-6 || Math.abs(originOf(lat!, cellDeg) - grid.originLat) > 1e-6) return `cell ${i + 1}: its centre isn't on the first cell's ${cellDeg}° grid`;
		grid.cells.push({ row: indexOf(lat!, grid.originLat, cellDeg), col: indexOf(lon!, grid.originLon, cellDeg), mapMm: v! });
	}
	return { grid, meta: { source: text(d.source, 500), version: text(d.version, 100), attribution: text(d.attribution, 500) } };
}

const BATCH = 10_000;

/** Replace `meta.dataset` with `grid`'s cells, in one transaction, as the schema owner. Returns how many cells it wrote. */
export async function replaceRainMapDataset(client: pg.ClientBase, meta: RainMapMeta, grid: RainMapGrid): Promise<number> {
	// A dataset with no cell is a wrong box or file, not a grid to show.
	if (!grid.cells.length) throw new Error('no cell has a value: check the file and --bbox');
	await client.query('BEGIN');
	try {
		// The cells go with their dataset (ON DELETE CASCADE).
		await client.query('DELETE FROM rain_map_dataset WHERE dataset = $1', [meta.dataset]);
		await client.query(
			`INSERT INTO rain_map_dataset (dataset, source, version, attribution, cell_deg, origin_lon, origin_lat, cell_count)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			[meta.dataset, meta.source, meta.version, meta.attribution, grid.cellDeg, grid.originLon, grid.originLat, grid.cells.length]
		);
		for (let i = 0; i < grid.cells.length; i += BATCH) {
			const part = grid.cells.slice(i, i + BATCH);
			await client.query(
				`INSERT INTO rain_map_cell_reference (dataset, row_idx, col_idx, map_mm)
				 SELECT $1, r, c, v FROM unnest($2::integer[], $3::integer[], $4::real[]) AS t (r, c, v)`,
				[meta.dataset, part.map((c) => c.row), part.map((c) => c.col), part.map((c) => c.mapMm)]
			);
		}
		await client.query('COMMIT');
		return grid.cells.length;
	} catch (e) {
		await client.query('ROLLBACK');
		throw e;
	}
}
