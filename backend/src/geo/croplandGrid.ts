// The cropland grid's data, without any raster (173_cropland_reference.sql;
// issue #326 B-landcover, docs/maps.md § Cultivated area from land cover):
// the products' defaults and method text, the pre-summarised JSON form
// (`{ "cellDeg": 0.005, "cells": [[lon, lat, fraction], …] }`, each cell by
// its centre: the committed synthetic fixture's form, and what
// `pnpm import:land-cover --out` writes for a production load), and the
// load into the database, which replaces a dataset in one transaction.
//
// Split from loadCropland.ts (the GeoTIFF reader) so the migrate Lambda's
// reference loads (geo/referenceLoad.ts, docs/deployment.md § Reference
// datasets) carry no raster code: lambda-migrate.test.ts checks its bundle.
import type pg from 'pg';
import { recordReferenceOrigin, type ReferenceOrigin } from './referenceOrigin.js';

export const WORLDCOVER_CROPLAND = 40;
/** The cell size the operator's load uses unless told otherwise: 30 WorldCover pixels, about 250 m × 230 m in South Africa. */
export const DEFAULT_CELL_DEG = 0.0025;

/** The product the operator's raster load defaults to (each can be overridden on the command line). */
export const WORLDCOVER_2021 = {
	source:
		'ESA WorldCover 10 m 2021 v200 (Zanaga, D. et al. 2022, https://doi.org/10.5281/zenodo.7254221), CC BY 4.0',
	version: '2021 v200',
	attribution: '© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium'
} as const;

/** The counting method in words, as proposals and revisions cite it. */
export function methodFor(cellDeg: number, classes: readonly number[]): string {
	const cls = classes.length === 1 ? `class ${classes[0]}` : `classes ${classes.join(', ')}`;
	return (
		`Pre-summarised at import: each ${cellDeg}° grid cell's share of pixels in ${cls} (cultivated) among its pixels with data. ` +
		'A polygon’s cultivated area is the sum over the cells it covers of the cell’s area on the WGS84 ellipsoid × the share of the cell inside the polygon × that cultivated share, ' +
		'cropland taken as spread evenly within each cell.'
	);
}

/** One grid cell with cropland: its south-west indices (row = ⌊lat / cell⌋, col = ⌊lon / cell⌋) and the share of it that is cropland, 0–1. */
export interface CroplandCell {
	row: number;
	col: number;
	fraction: number;
}


// ---------------------------------------------------------------------------
// The fixture's JSON form
// ---------------------------------------------------------------------------

/** What the JSON form may say about its own product (the fixture says all of it). */
export interface JsonMeta {
	source?: string;
	version?: string;
	attribution?: string;
	classes?: number[];
}

const text = (v: unknown, max: number): string | undefined => {
	const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
	return s ? s.slice(0, max) : undefined;
};

/**
 * `{ cellDeg, cells: [[lon, lat, fraction], …], source?, version?,
 * attribution?, classes? }`: each cell by its centre.
 */
export function croplandFromJson(doc: unknown): { cellDeg: number; cells: CroplandCell[]; meta: JsonMeta; problems: string[] } | string {
	const d = doc as { cellDeg?: unknown; cells?: unknown; source?: unknown; version?: unknown; attribution?: unknown; classes?: unknown };
	const cellDeg = Number(d?.cellDeg);
	if (!(cellDeg > 0 && cellDeg <= 1)) return 'the JSON file has no "cellDeg" between 0 and 1';
	if (!Array.isArray(d.cells)) return 'the JSON file has no "cells" array';
	const cells: CroplandCell[] = [];
	const problems: string[] = [];
	d.cells.forEach((c: unknown, i: number) => {
		const [lon, lat, fraction] = Array.isArray(c) ? c.map(Number) : [];
		if (![lon, lat, fraction].every((x) => Number.isFinite(x)) || Math.abs(lon!) > 180 || Math.abs(lat!) > 90) return problems.push(`cell ${i + 1}: not [lon, lat, fraction]`);
		if (!(fraction! > 0 && fraction! <= 1)) return problems.push(`cell ${i + 1}: the fraction ${fraction} is not above 0 and at most 1`);
		cells.push({ row: Math.floor(lat! / cellDeg), col: Math.floor(lon! / cellDeg), fraction: fraction! });
	});
	const classes = Array.isArray(d.classes) && d.classes.length && d.classes.every((x) => Number.isInteger(x)) ? (d.classes as number[]) : undefined;
	return {
		cellDeg,
		cells,
		meta: { source: text(d.source, 500), version: text(d.version, 100), attribution: text(d.attribution, 500), classes },
		problems
	};
}

/**
 * The JSON form of a pre-summarised grid (what croplandFromJson reads back):
 * the product's own fields, then each cell by its centre. Written by
 * `pnpm import:land-cover --out` for a production load (docs/deployment.md
 * § Reference datasets), so the GeoTIFF tiles are read on the operator's
 * machine and only the summary travels. One cell a line, so a country's
 * grid stays a readable, diffable file.
 */
export function croplandToJson(meta: Omit<CroplandDatasetMeta, 'dataset' | 'method'>, cells: readonly CroplandCell[]): string {
	const centre = (i: number) => Number(((i + 0.5) * meta.cellDeg).toFixed(7));
	const head = JSON.stringify({ source: meta.source, version: meta.version, attribution: meta.attribution, classes: meta.classes, cellDeg: meta.cellDeg }, null, 1);
	const lines = cells.map((c) => `[${centre(c.col)},${centre(c.row)},${Number(c.fraction.toFixed(6))}]`);
	return `${head.slice(0, -2)},\n "cells": [\n${lines.join(',\n')}\n ]\n}\n`;
}

/**
 * The dataset row a JSON grid loads as: its own source, version, attribution
 * and classes, else `fallback` (the command line's), else WorldCover 2021's.
 */
export function jsonDatasetMeta(
	dataset: string,
	got: { cellDeg: number; meta: JsonMeta },
	fallback: { source?: string | null; version?: string | null; attribution?: string | null; classes?: number[] } = {}
): CroplandDatasetMeta {
	const classes = got.meta.classes ?? fallback.classes ?? [WORLDCOVER_CROPLAND];
	return {
		dataset,
		source: fallback.source ?? got.meta.source ?? WORLDCOVER_2021.source,
		version: fallback.version ?? got.meta.version ?? WORLDCOVER_2021.version,
		attribution: fallback.attribution ?? got.meta.attribution ?? WORLDCOVER_2021.attribution,
		method: methodFor(got.cellDeg, classes),
		cellDeg: got.cellDeg,
		classes
	};
}

/** Merge cells that name the same grid square (two inputs overlapping): the larger fraction wins, deterministically. */
export function mergeCells(cells: readonly CroplandCell[]): CroplandCell[] {
	const byKey = new Map<string, CroplandCell>();
	for (const c of cells) {
		const k = `${c.row}:${c.col}`;
		const was = byKey.get(k);
		if (!was || c.fraction > was.fraction) byKey.set(k, c);
	}
	return [...byKey.values()].sort((a, b) => a.row - b.row || a.col - b.col);
}

// ---------------------------------------------------------------------------
// The database
// ---------------------------------------------------------------------------

export interface CroplandDatasetMeta {
	dataset: string;
	/** Shown with every proposed value: the product, its version and where it came from. */
	source: string;
	/** The product's version, as its publisher names it ('2021 v200'). */
	version: string;
	/** How the cells were counted, in words an evidence pack can print. */
	method: string;
	/** The licence and attribution line the map must carry. */
	attribution: string;
	cellDeg: number;
	classes: number[];
}

const BATCH = 20_000;

/**
 * Replace `meta.dataset` with the cells `parts` yields (one part per input
 * file, read only when its turn comes, so a country's tiles never sit in
 * memory together), in one transaction, as the schema owner. A cell two
 * parts both give keeps the larger share. `origin`: the reference-bucket file
 * a production load read (recorded with the data; referenceOrigin.ts), null
 * for any other replace. Returns how many cells it wrote.
 */
export async function replaceCroplandDataset(
	client: pg.ClientBase,
	meta: CroplandDatasetMeta,
	parts: Iterable<readonly CroplandCell[]>,
	origin: ReferenceOrigin | null = null
): Promise<number> {
	await client.query('BEGIN');
	try {
		// The cells go with their dataset (ON DELETE CASCADE).
		await client.query('DELETE FROM cropland_dataset WHERE dataset = $1', [meta.dataset]);
		await client.query(
			`INSERT INTO cropland_dataset (dataset, source, version, method, attribution, cell_deg, classes)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			[meta.dataset, meta.source, meta.version, meta.method, meta.attribution, meta.cellDeg, meta.classes]
		);
		for (const cells of parts) {
			for (let i = 0; i < cells.length; i += BATCH) {
				const part = mergeCells(cells.slice(i, i + BATCH));
				await client.query(
					`INSERT INTO cropland_cell_reference (dataset, row_idx, col_idx, fraction)
					 SELECT $1, r, c, f FROM unnest($2::integer[], $3::integer[], $4::real[]) AS t (r, c, f)
					 ON CONFLICT (dataset, row_idx, col_idx) DO UPDATE SET fraction = GREATEST(cropland_cell_reference.fraction, EXCLUDED.fraction)`,
					[meta.dataset, part.map((c) => c.row), part.map((c) => c.col), part.map((c) => c.fraction)]
				);
			}
		}
		const { rows } = await client.query<{ n: number }>('SELECT count(*)::integer AS n FROM cropland_cell_reference WHERE dataset = $1', [meta.dataset]);
		// A product with no cropland at all is a wrong file or class, not a dataset to propose zeros from.
		if (!rows[0]!.n) throw new Error('no cell has any cropland: check the files and --classes');
		await recordReferenceOrigin(client, 'land-cover', meta.dataset, origin);
		await client.query('COMMIT');
		return rows[0]!.n;
	} catch (e) {
		await client.query('ROLLBACK');
		throw e;
	}
}
