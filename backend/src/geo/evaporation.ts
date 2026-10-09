// Evaporation from the map (issue #326 Part B, "B-evap"; docs/maps.md
// § Evaporation from the map): the catchment boundary → the mean monthly
// evaporation of an evaporation grid over it.
//
// The operator pre-summarises a daily product into a grid of cells, each with
// its 12 mean monthly totals (180_evaporation_reference.sql,
// geo/loadEvaporation.ts). The boundary's month m is then the area-weighted
// mean
//     Σ over the cells with a value: cell area × share of the cell inside the
//     boundary (geo/gridShares.ts) × the cell's month m
//     ÷ Σ over the same cells: cell area × share inside,
// so a cell half inside counts half, and cells without a value (sea, or past
// the loaded box) are left out of both sums; the share of the boundary they
// leave uncovered is reported, and past MIN_COVERAGE nothing is proposed.
//
// What a value is depends on the dataset's kind, and nothing is converted
// between kinds here: an 'et0' grid (FAO-56 reference ET) proposes GR4J's
// monthly PE (settings.pe), an 'apan' grid the A-pan row (settings.apanMm).
// This only *proposes*: the modeller accepts the 12 values together
// (geo/evaporationRoutes.ts). The repo ships an invented grid
// (`dataset: 'synthetic'`); a proposal from it says so.
import type { Db } from '../db/tx.js';
import type { Geometry } from './geojson.js';
import { cellAreaM2, cellSpan, gridShares, toGrid } from './gridShares.js';

/** The label the committed fixture loads under; a proposal from it is marked synthetic. */
export const SYNTHETIC_EVAPORATION_DATASET = 'synthetic';
/**
 * The most grid cells one summary's bounding box may span (about 480 000
 * km² at 0.1° in South Africa): a bound on the rows read and the clipping,
 * far past any catchment one project models.
 */
export const MAX_EVAPORATION_CELLS = 40_000;
/** Below this share of the boundary with values, the grid doesn't describe the catchment: nothing is proposed. */
export const MIN_COVERAGE = 0.5;

export type EvaporationKind = 'et0' | 'apan';
/** The settings an accepted value goes into: GR4J's monthly PE, or the A-pan row. */
export type EvaporationTarget = 'pe' | 'apan';
export const TARGET_OF: Record<EvaporationKind, EvaporationTarget> = { et0: 'pe', apan: 'apan' };

export interface EvaporationDataset {
	dataset: string;
	kind: EvaporationKind;
	source: string;
	version: string;
	method: string;
	attribution: string;
	firstYear: number;
	lastYear: number;
	cellDeg: number;
	originLon: number;
	originLat: number;
	loadedAt: string;
	/** True for the repo's invented grid: never real values. */
	synthetic: boolean;
}

interface DatasetRow {
	dataset: string;
	kind: EvaporationKind;
	source: string;
	version: string;
	method: string;
	attribution: string;
	first_year: number;
	last_year: number;
	cell_deg: number;
	origin_lon: number;
	origin_lat: number;
	loaded_at: Date;
}

const toDataset = (r: DatasetRow): EvaporationDataset => ({
	dataset: r.dataset,
	kind: r.kind,
	source: r.source,
	version: r.version,
	method: r.method,
	attribution: r.attribution,
	firstYear: r.first_year,
	lastYear: r.last_year,
	cellDeg: r.cell_deg,
	originLon: r.origin_lon,
	originLat: r.origin_lat,
	loadedAt: r.loaded_at.toISOString(),
	synthetic: r.dataset === SYNTHETIC_EVAPORATION_DATASET
});

/** The loaded evaporation datasets, the default first: a real one before the synthetic grid, then the newest load, then by label. */
export async function evaporationDatasets(db: Db): Promise<EvaporationDataset[]> {
	const { rows } = await db.query<DatasetRow>(
		`SELECT dataset, kind, source, version, method, attribution, first_year, last_year, cell_deg, origin_lon, origin_lat, loaded_at
		 FROM evaporation_dataset
		 ORDER BY dataset = $1, loaded_at DESC, dataset`,
		[SYNTHETIC_EVAPORATION_DATASET]
	);
	return rows.map(toDataset);
}

/** The boundary's summary: 12 monthly means, Oct … Sep, mm (to 0.1), their sum, and how much of the boundary the grid covered. */
export interface EvaporationSummary {
	monthlyMm: number[];
	annualMm: number;
	/** The share of the boundary's area with values, 0–1. */
	coverage: number;
	/** How many cells with a value the boundary touches. */
	cells: number;
}

export type EvaporationResult = EvaporationSummary | { problem: string };

type Grid = Pick<EvaporationDataset, 'cellDeg' | 'originLon' | 'originLat'>;

/** The grid rows and columns a polygon spans, in the grid's own frame; null with no area. */
export function evaporationExtent(g: Geometry, grid: Grid): { rows: [number, number]; cols: [number, number] } | null {
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

/** The boundary's summary from the cells already read (keyed `row:col`, 12 values each). Pure. */
export function evaporationFromCells(g: Geometry, grid: Grid, cells: ReadonlyMap<string, readonly number[]>, maxCells = MAX_EVAPORATION_CELLS): EvaporationResult {
	const shares = gridShares(toGrid(g, grid), grid.cellDeg, maxCells, undefined, 'evaporation');
	if ('problem' in shares) return shares;
	let total = 0;
	let covered = 0;
	let n = 0;
	const sums = new Array<number>(12).fill(0);
	for (const s of shares.cells) {
		// The cell's area where it really is (the shift only aligned the grid).
		const w = cellAreaM2(s.col * grid.cellDeg + grid.originLon, s.row * grid.cellDeg + grid.originLat, grid.cellDeg) * s.share;
		total += w;
		const v = cells.get(`${s.row}:${s.col}`);
		if (!v) continue;
		covered += w;
		n++;
		for (let m = 0; m < 12; m++) sums[m]! += w * v[m]!;
	}
	if (!(covered > 0)) return { problem: 'the grid has no value inside the boundary (is it loaded for this area?)' };
	const coverage = Math.min(1, covered / total);
	if (coverage < MIN_COVERAGE) return { problem: `the grid has values for only ${Math.round(coverage * 100)} % of the boundary, too little to stand for the catchment` };
	const monthlyMm = sums.map((s) => round1(s / covered));
	return { monthlyMm, annualMm: round1(monthlyMm.reduce((a, b) => a + b, 0)), coverage, cells: n };
}

/** The boundary's summary from `dataset`: one read of the cells over its extent, refused past MAX_EVAPORATION_CELLS. */
export async function summariseEvaporation(db: Db, dataset: EvaporationDataset, g: Geometry): Promise<EvaporationResult> {
	const box = evaporationExtent(g, dataset);
	if (!box) return { problem: 'the boundary has no area' };
	const span = (box.rows[1] - box.rows[0]) * (box.cols[1] - box.cols[0]);
	if (span > MAX_EVAPORATION_CELLS) {
		return { problem: `the boundary spans ${span.toLocaleString('en-ZA')} evaporation cells, more than the ${MAX_EVAPORATION_CELLS.toLocaleString('en-ZA')} one summary reads` };
	}
	const { rows } = await db.query<{ row_idx: number; col_idx: number; monthly_mm: number[] }>(
		`SELECT row_idx, col_idx, monthly_mm FROM evaporation_cell_reference
		 WHERE dataset = $1 AND row_idx >= $2 AND row_idx < $3 AND col_idx >= $4 AND col_idx < $5`,
		[dataset.dataset, box.rows[0], box.rows[1], box.cols[0], box.cols[1]]
	);
	return evaporationFromCells(g, dataset, new Map(rows.map((r) => [`${r.row_idx}:${r.col_idx}`, r.monthly_mm])));
}

/** What a dataset's values are, in words. */
export const KIND_LABEL: Record<EvaporationKind, string> = {
	et0: 'reference evapotranspiration (FAO-56 Penman-Monteith ET₀)',
	apan: 'Class-A pan evaporation'
};

/** A dataset's citation in one line, for a revision's reason, the PE row's source and the proposal's source line. */
export const citeEvaporation = (d: Pick<EvaporationDataset, 'dataset' | 'source' | 'version' | 'firstYear' | 'lastYear'>) =>
	`${d.source} (${d.version}, ${d.firstYear}–${d.lastYear} monthly means; dataset “${d.dataset}”)`;
