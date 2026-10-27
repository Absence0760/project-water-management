// Orchards and vines from SANLC (issue #604 R5-D; docs/maps.md § Orchards and
// vines from SANLC): a polygon on the map → the area inside it a crop-type
// product maps as permanent orchards and as permanent vines, and the part of
// each that is new since the earlier edition.
//
// The same arithmetic as the cultivated area (geo/cropland.ts): per layer,
//     Σ over the cells it covers: cell area on the ellipsoid × share of the
//     cell inside the polygon (geo/gridShares.ts) × the cell's layer share,
// each layer taken as spread evenly within its cell. It only proposes: the
// modeller uses orchards or vines as one crop's planted area (which fruit,
// which cultivar, is theirs to say), and SANLC doesn't say whether either is
// irrigated. The repo ships an invented grid (`dataset: 'synthetic'`).
import type { Db } from '../db/tx.js';
import { geometryAreaM2 } from './area.js';
import { MAX_SUMMARY_CELLS, SYNTHETIC_CROPLAND_DATASET } from './cropland.js';
import type { CropTypeLayer } from './cropTypeGrid.js';
import type { Geometry } from './geojson.js';
import { cellSpan, gridShares } from './gridShares.js';

export interface CropTypeDataset {
	dataset: string;
	source: string;
	version: string;
	/** The earlier edition new plantings are counted against; null: none loaded, so no new plantings. */
	baselineVersion: string | null;
	method: string;
	attribution: string;
	cellDeg: number;
	orchardClasses: number[];
	vineClasses: number[];
	loadedAt: string;
	synthetic: boolean;
}

interface DatasetRow {
	dataset: string;
	source: string;
	version: string;
	baseline_version: string | null;
	method: string;
	attribution: string;
	cell_deg: number;
	orchard_classes: number[];
	vine_classes: number[];
	loaded_at: Date;
}

/** The loaded crop-type datasets, the default first: a real one before the synthetic grid, then the newest load, then by label. */
export async function cropTypeDatasets(db: Db): Promise<CropTypeDataset[]> {
	const { rows } = await db.query<DatasetRow>(
		`SELECT dataset, source, version, baseline_version, method, attribution, cell_deg, orchard_classes, vine_classes, loaded_at FROM crop_type_dataset
		 ORDER BY dataset = $1, loaded_at DESC, dataset`,
		[SYNTHETIC_CROPLAND_DATASET]
	);
	return rows.map((r) => ({
		dataset: r.dataset,
		source: r.source,
		version: r.version,
		baselineVersion: r.baseline_version,
		method: r.method,
		attribution: r.attribution,
		cellDeg: r.cell_deg,
		orchardClasses: r.orchard_classes,
		vineClasses: r.vine_classes,
		loadedAt: r.loaded_at.toISOString(),
		synthetic: r.dataset === SYNTHETIC_CROPLAND_DATASET
	}));
}

/** A polygon's crop types, m²: its area, orchards and vines, and the part of each new since the earlier edition. */
export interface CropTypeArea {
	areaM2: number;
	orchardM2: number;
	vineM2: number;
	newOrchardM2: number;
	newVineM2: number;
}

export type CropTypeResult = CropTypeArea | { problem: string };

type Shares = [orchard: number, vine: number, newOrchard: number, newVine: number];

/** One polygon's crop types from the cells already read (keyed `row:col`). */
export function cropTypesFromCells(g: Geometry, cellDeg: number, cells: ReadonlyMap<string, Shares>, maxCells = MAX_SUMMARY_CELLS): CropTypeResult {
	const shares = gridShares(g, cellDeg, maxCells, (r, c) => cells.has(`${r}:${c}`));
	if ('problem' in shares) return shares;
	const sum: Shares = [0, 0, 0, 0];
	for (const s of shares.cells) {
		const v = cells.get(`${s.row}:${s.col}`)!;
		for (let i = 0; i < 4; i++) sum[i]! += s.cellM2 * s.share * v[i]!;
	}
	const areaM2 = geometryAreaM2(g) ?? 0;
	// Each layer can't pass the polygon's area (the even-spread assumption could, by rounding, by a hair).
	const cap = (x: number) => Math.min(x, areaM2);
	return { areaM2, orchardM2: cap(sum[0]), vineM2: cap(sum[1]), newOrchardM2: Math.min(cap(sum[2]), cap(sum[0])), newVineM2: Math.min(cap(sum[3]), cap(sum[1])) };
}

/**
 * The crop types of each polygon in `geometries`, from `dataset`, in the same
 * order: one read of the cells over their joint extent, refused (every entry
 * a problem) past MAX_SUMMARY_CELLS.
 */
export async function cropTypeAreas(db: Db, dataset: Pick<CropTypeDataset, 'dataset' | 'cellDeg'>, geometries: readonly Geometry[]): Promise<CropTypeResult[]> {
	if (!geometries.length) return [];
	let south = Infinity;
	let north = -Infinity;
	let west = Infinity;
	let east = -Infinity;
	for (const g of geometries) {
		const polygons = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
		for (const rings of polygons) {
			for (const [x, y] of rings[0] ?? []) {
				south = Math.min(south, y);
				north = Math.max(north, y);
				west = Math.min(west, x);
				east = Math.max(east, x);
			}
		}
	}
	if (!(south < north && west < east)) return geometries.map(() => ({ problem: 'the polygon has no area' }));
	const rows = cellSpan(south, north, dataset.cellDeg);
	const cols = cellSpan(west, east, dataset.cellDeg);
	const span = (rows[1] - rows[0]) * (cols[1] - cols[0]);
	if (span > MAX_SUMMARY_CELLS) {
		const problem = `the polygons span ${span.toLocaleString('en-ZA')} crop-type cells, more than the ${MAX_SUMMARY_CELLS.toLocaleString('en-ZA')} one summary reads`;
		return geometries.map(() => ({ problem }));
	}
	const { rows: found } = await db.query<{ row_idx: number; col_idx: number; orchard: number; vine: number; new_orchard: number; new_vine: number }>(
		`SELECT row_idx, col_idx, orchard, vine, new_orchard, new_vine FROM crop_type_cell_reference
		 WHERE dataset = $1 AND row_idx >= $2 AND row_idx < $3 AND col_idx >= $4 AND col_idx < $5`,
		[dataset.dataset, rows[0], rows[1], cols[0], cols[1]]
	);
	const cells = new Map<string, Shares>(found.map((c) => [`${c.row_idx}:${c.col_idx}`, [c.orchard, c.vine, c.new_orchard, c.new_vine]]));
	return geometries.map((g) => cropTypesFromCells(g, dataset.cellDeg, cells));
}

/** A layer's area in a summary. */
export const layerM2 = (a: CropTypeArea, layer: CropTypeLayer): number => (layer === 'orchard' ? a.orchardM2 : a.vineM2);
