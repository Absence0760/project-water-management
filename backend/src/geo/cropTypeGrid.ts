// The orchard and vine grid's data, without any raster (259_crop_type_reference.sql;
// issue #604 R5-D, docs/maps.md § Orchards and vines from SANLC): SANLC's
// defaults and the method text, the pre-summarised JSON form (`{ "cellDeg":
// 0.005, "cells": [[lon, lat, orchard, vine, newOrchard, newVine], …] }`,
// each cell by its centre: the committed synthetic fixture's form, and what
// `pnpm import:crop-types --out` writes), and the load into the database,
// which replaces a dataset in one transaction.
//
// Split from loadCropTypes.ts (the GeoTIFF counting) as croplandGrid.ts is
// from loadCropland.ts, so a production load, once SANLC's terms are recorded
// and referenceLoad.ts allows the kind, carries no raster code.
import type pg from 'pg';

/** SANLC's class codes for permanent orchards and vines (issue #604 research); check each edition's legend before a load. */
export const SANLC_ORCHARDS = 32;
export const SANLC_VINES = 33;

/**
 * The product the operator's raster load defaults to (each can be overridden
 * on the command line). The licence is not named here: SANLC's terms are not
 * yet recorded (docs/maps.md § Sources), which is why production refuses it.
 */
export const SANLC_2022 = {
	source: 'South African National Land Cover 2022 (SANLC), Department of Forestry, Fisheries and the Environment (DFFE), egis.environment.gov.za',
	version: '2022',
	attribution: 'South African National Land Cover 2022, DFFE (terms pending: not for production use until recorded)'
} as const;

/** A crop-type grid's layers: what a proposal can use as a crop's planted area. */
export type CropTypeLayer = 'orchard' | 'vine';

export const LAYER_WORDS: Record<CropTypeLayer, string> = { orchard: 'permanent orchards', vine: 'permanent vines' };

/** The counting method in words, as proposals and revisions cite it. */
export function cropTypeMethodFor(cellDeg: number, orchardClasses: readonly number[], vineClasses: readonly number[], baselineVersion: string | null): string {
	const cls = (c: readonly number[]) => (c.length === 1 ? `class ${c[0]}` : `classes ${c.join(', ')}`);
	return (
		`Pre-summarised at import: each ${cellDeg}° grid cell's share of pixels in ${cls(orchardClasses)} (permanent orchards) and in ${cls(vineClasses)} (permanent vines) among its pixels with data` +
		(baselineVersion
			? `; new plantings are the pixels in either now that were in neither in the ${baselineVersion} edition (a pixel with no data then is not counted as new). `
			: '. ') +
		'A polygon’s area of each is the sum over the cells it covers of the cell’s area on the WGS84 ellipsoid × the share of the cell inside the polygon × that share, ' +
		'each taken as spread evenly within its cell.'
	);
}

/** One grid cell with orchards or vines: its south-west indices and the four shares, 0–1. */
export interface CropTypeCell {
	row: number;
	col: number;
	orchard: number;
	vine: number;
	newOrchard: number;
	newVine: number;
}

export interface CropTypeDatasetMeta {
	dataset: string;
	source: string;
	version: string;
	baselineVersion: string | null;
	method: string;
	attribution: string;
	cellDeg: number;
	orchardClasses: number[];
	vineClasses: number[];
}

// ---------------------------------------------------------------------------
// The JSON form
// ---------------------------------------------------------------------------

/** What the JSON form may say about its own product (the fixture says all of it). */
export interface CropTypeJsonMeta {
	source?: string;
	version?: string;
	baselineVersion?: string;
	attribution?: string;
	orchardClasses?: number[];
	vineClasses?: number[];
}

const text = (v: unknown, max: number): string | undefined => {
	const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
	return s ? s.slice(0, max) : undefined;
};
const codes = (v: unknown): number[] | undefined =>
	Array.isArray(v) && v.length && v.length <= 50 && v.every((x) => Number.isInteger(x) && x >= 0 && x < 256) ? (v as number[]) : undefined;

/** `{ cellDeg, cells: [[lon, lat, orchard, vine, newOrchard, newVine], …], source?, version?, baselineVersion?, attribution?, orchardClasses?, vineClasses? }`. */
export function cropTypesFromJson(doc: unknown): { cellDeg: number; cells: CropTypeCell[]; meta: CropTypeJsonMeta; problems: string[] } | string {
	const d = doc as Record<string, unknown> | null;
	const cellDeg = Number(d?.cellDeg);
	if (!(cellDeg > 0 && cellDeg <= 1)) return 'the JSON file has no "cellDeg" between 0 and 1';
	if (!Array.isArray(d!.cells)) return 'the JSON file has no "cells" array';
	const cells: CropTypeCell[] = [];
	const problems: string[] = [];
	(d!.cells as unknown[]).forEach((c, i) => {
		const v = Array.isArray(c) ? c.map(Number) : [];
		const [lon, lat, orchard, vine, newOrchard = 0, newVine = 0] = v;
		if (v.length < 4 || v.length > 6 || ![lon, lat, orchard, vine, newOrchard, newVine].every((x) => Number.isFinite(x)) || Math.abs(lon!) > 180 || Math.abs(lat!) > 90) {
			return problems.push(`cell ${i + 1}: not [lon, lat, orchard, vine, newOrchard, newVine]`);
		}
		const share = (x: number) => x >= 0 && x <= 1;
		if (![orchard!, vine!, newOrchard, newVine].every(share) || !(orchard! + vine! > 0) || orchard! + vine! > 1 + 1e-6) {
			return problems.push(`cell ${i + 1}: the orchard and vine shares are not each 0–1 with a sum above 0 and at most 1`);
		}
		if (newOrchard > orchard! || newVine > vine!) return problems.push(`cell ${i + 1}: a new-planting share is larger than its layer's`);
		cells.push({ row: Math.floor(lat! / cellDeg), col: Math.floor(lon! / cellDeg), orchard: orchard!, vine: vine!, newOrchard, newVine });
	});
	return {
		cellDeg,
		cells,
		meta: {
			source: text(d!.source, 500),
			version: text(d!.version, 100),
			baselineVersion: text(d!.baselineVersion, 100),
			attribution: text(d!.attribution, 500),
			orchardClasses: codes(d!.orchardClasses),
			vineClasses: codes(d!.vineClasses)
		},
		problems
	};
}

/** The JSON form of a pre-summarised grid (what cropTypesFromJson reads back): the product's fields, then one cell a line. */
export function cropTypesToJson(meta: Omit<CropTypeDatasetMeta, 'dataset' | 'method'>, cells: readonly CropTypeCell[]): string {
	const centre = (i: number) => Number(((i + 0.5) * meta.cellDeg).toFixed(7));
	const f = (x: number) => Number(x.toFixed(6));
	const head = JSON.stringify(
		{
			source: meta.source,
			version: meta.version,
			...(meta.baselineVersion ? { baselineVersion: meta.baselineVersion } : {}),
			attribution: meta.attribution,
			orchardClasses: meta.orchardClasses,
			vineClasses: meta.vineClasses,
			cellDeg: meta.cellDeg
		},
		null,
		1
	);
	const lines = cells.map((c) => `[${centre(c.col)},${centre(c.row)},${f(c.orchard)},${f(c.vine)},${f(c.newOrchard)},${f(c.newVine)}]`);
	return `${head.slice(0, -2)},\n "cells": [\n${lines.join(',\n')}\n ]\n}\n`;
}

/** The dataset row a JSON grid loads as: the command line's fields, else the file's own, else SANLC 2022's. */
export function cropTypeJsonMeta(
	dataset: string,
	got: { cellDeg: number; meta: CropTypeJsonMeta },
	fallback: { source?: string | null; version?: string | null; baselineVersion?: string | null; attribution?: string | null } = {}
): CropTypeDatasetMeta {
	const orchardClasses = got.meta.orchardClasses ?? [SANLC_ORCHARDS];
	const vineClasses = got.meta.vineClasses ?? [SANLC_VINES];
	const baselineVersion = fallback.baselineVersion ?? got.meta.baselineVersion ?? null;
	return {
		dataset,
		source: fallback.source ?? got.meta.source ?? SANLC_2022.source,
		version: fallback.version ?? got.meta.version ?? SANLC_2022.version,
		baselineVersion,
		attribution: fallback.attribution ?? got.meta.attribution ?? SANLC_2022.attribution,
		method: cropTypeMethodFor(got.cellDeg, orchardClasses, vineClasses, baselineVersion),
		cellDeg: got.cellDeg,
		orchardClasses,
		vineClasses
	};
}

// ---------------------------------------------------------------------------
// The database
// ---------------------------------------------------------------------------

const BATCH = 20_000;

/**
 * Replace `meta.dataset` with `cells`, in one transaction, as the schema
 * owner. A cell listed twice keeps its last entry. Returns how many cells it
 * wrote; refuses a grid with none (a wrong file or class).
 */
export async function replaceCropTypeDataset(client: pg.ClientBase, meta: CropTypeDatasetMeta, cells: readonly CropTypeCell[]): Promise<number> {
	const byKey = new Map(cells.map((c) => [`${c.row}:${c.col}`, c]));
	const all = [...byKey.values()];
	if (!all.length) throw new Error('no cell has any orchard or vine: check the files and the classes');
	await client.query('BEGIN');
	try {
		// The cells go with their dataset (ON DELETE CASCADE).
		await client.query('DELETE FROM crop_type_dataset WHERE dataset = $1', [meta.dataset]);
		await client.query(
			`INSERT INTO crop_type_dataset (dataset, source, version, baseline_version, method, attribution, cell_deg, orchard_classes, vine_classes)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			[meta.dataset, meta.source, meta.version, meta.baselineVersion, meta.method, meta.attribution, meta.cellDeg, meta.orchardClasses, meta.vineClasses]
		);
		for (let i = 0; i < all.length; i += BATCH) {
			const part = all.slice(i, i + BATCH);
			await client.query(
				`INSERT INTO crop_type_cell_reference (dataset, row_idx, col_idx, orchard, vine, new_orchard, new_vine)
				 SELECT $1, r, c, o, v, no, nv FROM unnest($2::integer[], $3::integer[], $4::real[], $5::real[], $6::real[], $7::real[]) AS t (r, c, o, v, no, nv)`,
				[
					meta.dataset,
					part.map((c) => c.row),
					part.map((c) => c.col),
					part.map((c) => c.orchard),
					part.map((c) => c.vine),
					part.map((c) => c.newOrchard),
					part.map((c) => c.newVine)
				]
			);
		}
		await client.query('COMMIT');
		return all.length;
	} catch (e) {
		await client.query('ROLLBACK');
		throw e;
	}
}
