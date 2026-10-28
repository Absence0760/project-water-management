// The soil water capacity grid (268_soil_grid.sql; issue #622 step 2,
// docs/maps.md § Soil water capacity, docs/model.md §2.10m): root-zone
// plant-available water capacity (PAWC, mm) per cell, which the regional GR4J
// prior relates x1 to.
//
//  - the file: its JSON form (`{ "kind": "pawc", "cellDeg", "source"?,
//    "version"?, "attribution"?, "cells": [[lon, lat, pawcMm, rootDepthCm],
//    …] }`, each cell by its centre), which `ingest/soils.py` writes from
//    SoilGrids 2.0 and iSDAsoil and the committed synthetic fixture uses; a
//    production load reads the same file (geo/referenceLoad.ts);
//  - the load: the replace of a dataset, in one transaction, as the schema
//    owner (backend/scripts/import-soils.ts, and the production load);
//  - the read: a catchment or unit polygon → its area-weighted mean PAWC,
//    as the evaporation grid's month is (geo/evaporation.ts): each cell
//    weighted by its area on the ellipsoid × the share of it inside, cells
//    without a value left out of both sums, nothing past MIN_COVERAGE.
//
// Cells are keyed by their south-west corner's indices from the dataset's
// origin, as the evaporation and MAP grids' are (evaporationGrid.ts
// originOf/indexOf). The repo ships an invented grid (`dataset:
// 'synthetic'`); a summary from it says so.
import type pg from 'pg';
import type { Db } from '../db/tx.js';
import { indexOf, originOf } from './evaporationGrid.js';
import type { Geometry } from './geojson.js';
import { cellAreaM2, cellSpan, gridShares, toGrid } from './gridShares.js';
import { recordReferenceOrigin, type ReferenceOrigin } from './referenceOrigin.js';

/** The label the committed fixture loads under; a summary from it is marked synthetic. */
export const SYNTHETIC_SOIL_DATASET = 'synthetic';
/** The most cells one summary's bounding box may span (as the evaporation grid's, at 0.05° about 120 000 km²). */
export const MAX_SOIL_CELLS = 40_000;
/** Below this share of the polygon with values, the grid doesn't describe it: no value. */
export const MIN_SOIL_COVERAGE = 0.5;
/** SoilGrids 2.0's water retention depths, cm: six layers to 200 cm. */
export const SOILGRIDS_LAYERS_CM: readonly (readonly [number, number])[] = [
	[0, 5],
	[5, 15],
	[15, 30],
	[30, 60],
	[60, 100],
	[100, 200]
];

/** What the operator's production load stores unless the file says otherwise (docs/data-sources.md § soilgrids, § isdasoil). */
export const SOILS = {
	source:
		'SoilGrids 2.0 volumetric water content at 33 kPa (wv0033) and 1500 kPa (wv1500), six depths to 200 cm (ISRIC, Turek et al. 2023, https://doi.org/10.1016/j.iswcr.2022.08.001), CC BY 4.0; depth to bedrock from iSDAsoil (iSDA, https://registry.opendata.aws/isdasoil), CC BY 4.0',
	version: 'SoilGrids 2.0 (2023 water retention); iSDAsoil v1',
	attribution:
		'Soil water retention: SoilGrids 2.0 © ISRIC – World Soil Information, CC BY 4.0. Depth to bedrock: iSDAsoil © Innovative Solutions for Decision Agriculture (iSDA), CC BY 4.0.'
} as const;

/** The computation in words, as the prior's provenance cites it. */
export function soilMethodFor(cellDeg: number): string {
	return (
		`Pre-computed at import (ingest/soils.py) on a ${cellDeg}° grid: root-zone plant-available water capacity = Σ over SoilGrids’ six layers (0–5, 5–15, 15–30, 30–60, 60–100, 100–200 cm) of (water content at 33 kPa − at 1500 kPa) × the layer’s thickness inside the root zone, which ends at min(200 cm, iSDAsoil’s depth to bedrock). ` +
		'A polygon’s value is the mean of the cells it covers, each weighted by its area on the WGS84 ellipsoid × the share of it inside; cells without a value are left out.'
	);
}

export interface SoilCell {
	row: number;
	col: number;
	pawcMm: number;
	rootDepthCm: number;
}

export interface SoilGrid {
	cellDeg: number;
	originLon: number;
	originLat: number;
	cells: SoilCell[];
}

export interface SoilMeta {
	dataset: string;
	source: string;
	version: string;
	method: string;
	attribution: string;
}

const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** The file's JSON form, or why it can't be read; a bad cell is a problem, never stored. */
export function soilFromJson(doc: unknown): { grid: SoilGrid; meta: { source?: string; version?: string; attribution?: string }; problems: string[] } | string {
	const d = doc as { kind?: unknown; cellDeg?: unknown; cells?: unknown; source?: unknown; version?: unknown; attribution?: unknown };
	if (d?.kind !== 'pawc') return 'the JSON file has no "kind" of "pawc" (the soil water capacity grid ingest/soils.py writes)';
	const cellDeg = Number(d.cellDeg);
	if (!(cellDeg > 0 && cellDeg <= 1)) return 'the JSON file has no "cellDeg" between 0 and 1';
	if (!Array.isArray(d.cells) || !d.cells.length) return 'the JSON file has no "cells"';
	if (!Array.isArray(d.cells[0])) return 'the JSON file’s first cell is not [lon, lat, pawcMm, rootDepthCm]';
	const [lon0, lat0] = (d.cells[0] as unknown[]).map(Number) as [number, number];
	const originLon = originOf(lon0, cellDeg);
	const originLat = originOf(lat0, cellDeg);
	const problems: string[] = [];
	const cells: SoilCell[] = [];
	const seen = new Set<string>();
	d.cells.forEach((c: unknown, i: number) => {
		const [lon, lat, pawc, depth] = (Array.isArray(c) ? c : []).map(Number);
		if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon!) > 180 || Math.abs(lat!) > 90) return problems.push(`cell ${i + 1}: not [lon, lat, pawcMm, rootDepthCm]`);
		if (!(Number.isFinite(pawc) && pawc! >= 0 && pawc! <= 1000)) return problems.push(`cell ${i + 1}: the water capacity is not 0–1000 mm`);
		if (!(Number.isFinite(depth) && depth! > 0 && depth! <= 200)) return problems.push(`cell ${i + 1}: the root depth is not over 0 and at most 200 cm`);
		if (Math.abs(originOf(lon!, cellDeg) - originLon) > 1e-6 || Math.abs(originOf(lat!, cellDeg) - originLat) > 1e-6) {
			return problems.push(`cell ${i + 1}: its centre isn't on the first cell's ${cellDeg}° grid`);
		}
		const row = indexOf(lat!, originLat, cellDeg);
		const col = indexOf(lon!, originLon, cellDeg);
		if (seen.has(`${row}:${col}`)) return problems.push(`cell ${i + 1}: the same cell twice`);
		seen.add(`${row}:${col}`);
		cells.push({ row, col, pawcMm: pawc!, rootDepthCm: depth! });
	});
	return { grid: { cellDeg, originLon, originLat, cells }, meta: { source: text(d.source, 500), version: text(d.version, 100), attribution: text(d.attribution, 500) }, problems };
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** A grid in the JSON form soilFromJson reads. */
export function soilToJson(meta: Pick<SoilMeta, 'source' | 'version' | 'attribution'>, grid: SoilGrid): string {
	return JSON.stringify({
		kind: 'pawc',
		cellDeg: grid.cellDeg,
		source: meta.source,
		version: meta.version,
		attribution: meta.attribution,
		cells: grid.cells.map((c) => [round6(grid.originLon + (c.col + 0.5) * grid.cellDeg), round6(grid.originLat + (c.row + 0.5) * grid.cellDeg), c.pawcMm, c.rootDepthCm])
	});
}

const BATCH = 5_000;

/**
 * Replace `meta.dataset` with `grid`'s cells, in one transaction, as the
 * schema owner. `origin`: the reference-bucket file a production load read,
 * null for any other replace. Returns how many cells it wrote.
 */
export async function replaceSoilDataset(client: pg.ClientBase, meta: SoilMeta, grid: SoilGrid, origin: ReferenceOrigin | null = null): Promise<number> {
	if (!grid.cells.length) throw new Error('no cell has a soil water capacity: check the file');
	await client.query('BEGIN');
	try {
		await client.query('DELETE FROM soil_dataset WHERE dataset = $1', [meta.dataset]);
		await client.query(
			`INSERT INTO soil_dataset (dataset, source, version, method, attribution, cell_deg, origin_lon, origin_lat)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			[meta.dataset, meta.source, meta.version, meta.method, meta.attribution, grid.cellDeg, grid.originLon, grid.originLat]
		);
		for (let i = 0; i < grid.cells.length; i += BATCH) {
			const part = grid.cells.slice(i, i + BATCH);
			await client.query(
				`INSERT INTO soil_cell_reference (dataset, row_idx, col_idx, pawc_mm, root_depth_cm)
				 SELECT $1, r, c, p, d FROM unnest($2::integer[], $3::integer[], $4::real[], $5::real[]) AS t (r, c, p, d)`,
				[meta.dataset, part.map((c) => c.row), part.map((c) => c.col), part.map((c) => c.pawcMm), part.map((c) => c.rootDepthCm)]
			);
		}
		await recordReferenceOrigin(client, 'soils', meta.dataset, origin);
		await client.query('COMMIT');
		return grid.cells.length;
	} catch (e) {
		await client.query('ROLLBACK');
		throw e;
	}
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface SoilDataset extends SoilMeta {
	cellDeg: number;
	originLon: number;
	originLat: number;
	loadedAt: string;
	/** True for the repo's invented grid: never real soil. */
	synthetic: boolean;
}

/** The loaded soil grids, the default first: a real one before the synthetic grid, then the newest load, then by label. */
export async function soilDatasets(db: Db | pg.ClientBase): Promise<SoilDataset[]> {
	const { rows } = await db.query<{
		dataset: string;
		source: string;
		version: string;
		method: string;
		attribution: string;
		cell_deg: number;
		origin_lon: number;
		origin_lat: number;
		loaded_at: Date;
	}>(
		`SELECT dataset, source, version, method, attribution, cell_deg, origin_lon, origin_lat, loaded_at
		 FROM soil_dataset ORDER BY dataset = $1, loaded_at DESC, dataset`,
		[SYNTHETIC_SOIL_DATASET]
	);
	return rows.map((r) => ({
		dataset: r.dataset,
		source: r.source,
		version: r.version,
		method: r.method,
		attribution: r.attribution,
		cellDeg: r.cell_deg,
		originLon: r.origin_lon,
		originLat: r.origin_lat,
		loadedAt: r.loaded_at.toISOString(),
		synthetic: r.dataset === SYNTHETIC_SOIL_DATASET
	}));
}

/** A polygon's soil water capacity: the area-weighted mean PAWC and root depth, and how much of it the grid covered. */
export interface SoilSummary {
	/** mm, to 0.1. */
	pawcMm: number;
	/** cm, to 0.1. */
	rootDepthCm: number;
	/** Share of the polygon's area with values, 0–1. */
	coverage: number;
	/** Cells with a value the polygon touches. */
	cells: number;
}

export type SoilResult = SoilSummary | { problem: string };

type Frame = Pick<SoilGrid, 'cellDeg' | 'originLon' | 'originLat'>;

/** The grid rows and columns a polygon spans, in the grid's own frame; null with no area. */
export function soilExtent(g: Geometry, grid: Frame): { rows: [number, number]; cols: [number, number] } | null {
	const polygons = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
	let south = Infinity;
	let north = -Infinity;
	let west = Infinity;
	let east = -Infinity;
	for (const rings of polygons) {
		for (const [x, y] of rings[0] ?? []) {
			south = Math.min(south, y - grid.originLat);
			north = Math.max(north, y - grid.originLat);
			west = Math.min(west, x - grid.originLon);
			east = Math.max(east, x - grid.originLon);
		}
	}
	if (!(south < north && west < east)) return null;
	return { rows: cellSpan(south, north, grid.cellDeg), cols: cellSpan(west, east, grid.cellDeg) };
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** The polygon's summary from the cells already read (keyed `row:col`). Pure. */
export function soilFromCells(g: Geometry, grid: Frame, cells: ReadonlyMap<string, { pawcMm: number; rootDepthCm: number }>, maxCells = MAX_SOIL_CELLS): SoilResult {
	const shares = gridShares(toGrid(g, grid), grid.cellDeg, maxCells, undefined, 'soil');
	if ('problem' in shares) return shares;
	let total = 0;
	let covered = 0;
	let pawc = 0;
	let depth = 0;
	let n = 0;
	for (const s of shares.cells) {
		const w = cellAreaM2(s.col * grid.cellDeg + grid.originLon, s.row * grid.cellDeg + grid.originLat, grid.cellDeg) * s.share;
		total += w;
		const v = cells.get(`${s.row}:${s.col}`);
		if (!v) continue;
		covered += w;
		n++;
		pawc += w * v.pawcMm;
		depth += w * v.rootDepthCm;
	}
	if (!(covered > 0)) return { problem: 'the soil grid has no value inside the boundary (is it loaded for this area?)' };
	const coverage = Math.min(1, covered / total);
	if (coverage < MIN_SOIL_COVERAGE) return { problem: `the soil grid has values for only ${Math.round(coverage * 100)} % of the boundary, too little to stand for it` };
	return { pawcMm: round1(pawc / covered), rootDepthCm: round1(depth / covered), coverage, cells: n };
}

/** The polygon's summary from `dataset`: one read of the cells over its extent, refused past MAX_SOIL_CELLS. */
export async function summariseSoil(db: Db | pg.ClientBase, dataset: Pick<SoilDataset, 'dataset' | 'cellDeg' | 'originLon' | 'originLat'>, g: Geometry): Promise<SoilResult> {
	const box = soilExtent(g, dataset);
	if (!box) return { problem: 'the boundary has no area' };
	const span = (box.rows[1] - box.rows[0]) * (box.cols[1] - box.cols[0]);
	if (span > MAX_SOIL_CELLS) {
		return { problem: `the boundary spans ${span.toLocaleString('en-ZA')} soil cells, more than the ${MAX_SOIL_CELLS.toLocaleString('en-ZA')} one summary reads` };
	}
	const { rows } = await db.query<{ row_idx: number; col_idx: number; pawc_mm: number; root_depth_cm: number }>(
		`SELECT row_idx, col_idx, pawc_mm, root_depth_cm FROM soil_cell_reference
		 WHERE dataset = $1 AND row_idx >= $2 AND row_idx < $3 AND col_idx >= $4 AND col_idx < $5`,
		[dataset.dataset, box.rows[0], box.rows[1], box.cols[0], box.cols[1]]
	);
	return soilFromCells(g, dataset, new Map(rows.map((r) => [`${r.row_idx}:${r.col_idx}`, { pawcMm: r.pawc_mm, rootDepthCm: r.root_depth_cm }])));
}
