// Cultivated area from land cover (issue #326 Part B, "B-landcover";
// docs/maps.md § Cultivated area from land cover): a polygon on the map →
// the area inside it that the land-cover product maps as cropland.
//
// The operator pre-summarises the 10 m raster into a grid of cells, each
// with the share of it that is cropland (173_cropland_reference.sql,
// geo/loadCropland.ts). A polygon's cultivated area is then
//     Σ over the cells it covers: cell area on the ellipsoid × share of the
//     cell inside the polygon (geo/gridShares.ts) × the cell's cropland share,
// which assumes the cropland is spread evenly within each cell (about 250 m
// across): a parcel's edge cuts a cell's cropland in proportion to its area.
//
// This only *proposes*. The modeller accepts one value at a time, as the
// planted area of a crop they choose (geo/croplandRoutes.ts): the land cover
// says where land is cultivated, never what grows there (#90 Q9), nor whether
// it is irrigated. The repo ships an invented grid (`dataset: 'synthetic'`);
// a proposal from it says so.
import type { Db } from '../db/tx.js';
import { geometryAreaM2 } from './area.js';
import type { Geometry } from './geojson.js';
import { cellSpan, gridShares } from './gridShares.js';

/** The label the committed fixture loads under; a proposal from it is marked synthetic. */
export const SYNTHETIC_CROPLAND_DATASET = 'synthetic';
/**
 * The most grid cells one summary's bounding box may span (about 58 000 km²
 * at 0.0025° in South Africa): a bound on the rows read and the clipping,
 * far past any catchment one project models.
 */
export const MAX_SUMMARY_CELLS = 1_000_000;

export interface CroplandDataset {
	dataset: string;
	source: string;
	version: string;
	method: string;
	attribution: string;
	cellDeg: number;
	classes: number[];
	loadedAt: string;
	/** True for the repo's invented grid: never real values. */
	synthetic: boolean;
}

interface DatasetRow {
	dataset: string;
	source: string;
	version: string;
	method: string;
	attribution: string;
	cell_deg: number;
	classes: number[];
	loaded_at: Date;
}

const toDataset = (r: DatasetRow): CroplandDataset => ({
	dataset: r.dataset,
	source: r.source,
	version: r.version,
	method: r.method,
	attribution: r.attribution,
	cellDeg: r.cell_deg,
	classes: r.classes,
	loadedAt: r.loaded_at.toISOString(),
	synthetic: r.dataset === SYNTHETIC_CROPLAND_DATASET
});

/**
 * The loaded land-cover datasets, the default first: a real one before the
 * synthetic grid, then the newest load, then by label.
 */
export async function croplandDatasets(db: Db): Promise<CroplandDataset[]> {
	const { rows } = await db.query<DatasetRow>(
		`SELECT dataset, source, version, method, attribution, cell_deg, classes, loaded_at FROM cropland_dataset
		 ORDER BY dataset = $1, loaded_at DESC, dataset`,
		[SYNTHETIC_CROPLAND_DATASET]
	);
	return rows.map(toDataset);
}

/** A polygon's summary: its area and the part of it the land cover maps as cropland, m². */
export interface CultivatedArea {
	areaM2: number;
	cultivatedM2: number;
}

export type CultivatedResult = CultivatedArea | { problem: string };

/** The cells with cropland of `dataset` in a box of rows and columns, keyed `row:col`. */
async function cellsIn(db: Db, dataset: string, rows: [number, number], cols: [number, number]): Promise<Map<string, number>> {
	const { rows: cells } = await db.query<{ row_idx: number; col_idx: number; fraction: number }>(
		`SELECT row_idx, col_idx, fraction FROM cropland_cell_reference
		 WHERE dataset = $1 AND row_idx >= $2 AND row_idx < $3 AND col_idx >= $4 AND col_idx < $5`,
		[dataset, rows[0], rows[1], cols[0], cols[1]]
	);
	return new Map(cells.map((c) => [`${c.row_idx}:${c.col_idx}`, c.fraction]));
}

/** The grid rows and columns a set of polygons spans (one read for them all). */
function extent(geometries: readonly Geometry[], cellDeg: number): { rows: [number, number]; cols: [number, number] } | null {
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
	if (!(south < north && west < east)) return null;
	return { rows: cellSpan(south, north, cellDeg), cols: cellSpan(west, east, cellDeg) };
}

/** One polygon's cultivated area from the cells already read. */
export function cultivatedFromCells(g: Geometry, cellDeg: number, cells: ReadonlyMap<string, number>, maxCells = MAX_SUMMARY_CELLS): CultivatedResult {
	const shares = gridShares(g, cellDeg, maxCells, (r, c) => cells.has(`${r}:${c}`));
	if ('problem' in shares) return shares;
	let cultivated = 0;
	for (const s of shares.cells) cultivated += s.cellM2 * s.share * cells.get(`${s.row}:${s.col}`)!;
	const areaM2 = geometryAreaM2(g) ?? 0;
	// A polygon's cultivated area can't pass its own area (the even-spread assumption could, by rounding, by a hair).
	return { areaM2, cultivatedM2: Math.min(cultivated, areaM2) };
}

/**
 * The cultivated area of each polygon in `geometries`, from `dataset`, in
 * the same order: one read of the cells over their joint extent, refused
 * (every entry a problem) past MAX_SUMMARY_CELLS.
 */
export async function cultivatedAreas(db: Db, dataset: CroplandDataset, geometries: readonly Geometry[]): Promise<CultivatedResult[]> {
	if (!geometries.length) return [];
	const box = extent(geometries, dataset.cellDeg);
	if (!box) return geometries.map(() => ({ problem: 'the polygon has no area' }));
	const span = (box.rows[1] - box.rows[0]) * (box.cols[1] - box.cols[0]);
	if (span > MAX_SUMMARY_CELLS) {
		const problem = `the polygons span ${span.toLocaleString('en-ZA')} land-cover cells, more than the ${MAX_SUMMARY_CELLS.toLocaleString('en-ZA')} one summary reads`;
		return geometries.map(() => ({ problem }));
	}
	const cells = await cellsIn(db, dataset.dataset, box.rows, box.cols);
	return geometries.map((g) => cultivatedFromCells(g, dataset.cellDeg, cells));
}

/** A dataset's citation in one line, for a revision's reason and the proposal's source column. */
export const citeDataset = (d: Pick<CroplandDataset, 'dataset' | 'source' | 'version'>) => `${d.source} (${d.version}; dataset “${d.dataset}”)`;
