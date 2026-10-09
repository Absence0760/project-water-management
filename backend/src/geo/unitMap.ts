// Each hydrological unit's mean annual precipitation (MAP) from a MAP grid
// (issue #482 follow-up; docs/maps.md § MAP for each unit, docs/model.md
// §2.4h): the area-weighted mean of a grid's cells over the unit's parcel,
//     Σ over the cells with a value: cell area × share of the cell inside the
//     parcel (geo/gridShares.ts) × the cell's MAP
//     ÷ Σ over the same cells: cell area × share inside,
// as the evaporation from the map takes a boundary's (geo/evaporation.ts). A
// cell half inside counts half; the cell's area on the ellipsoid carries the
// cos(latitude) shrinking of a degree of longitude.
//
// One grid for the whole project, never a mix (the user's call): a 100 m
// provincial surface and a 1.7 km national grid differ by tens of percent in
// mountain catchments, so units' MAPs from two grids would not compare. The
// grid proposed is the finest real grid that covers every unit with a
// polygon; with none covering all, the real grid covering the most (the
// finest of those); the synthetic grid only when no real grid covers any unit.
// A unit the chosen grid doesn't cover is listed, never filled from another
// grid. A unit's MAP takes the engine's range (mapMmError, as PUT /model
// checks): a grid value outside it leaves the unit uncovered, saying why.
import { MAP_MM_MAX, MAP_MM_MIN } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { loadUnits, unitParcel } from '../feeds/fromUnits.js';
import type { Geometry } from './geojson.js';
import { cellAreaM2, gridShares, toGrid } from './gridShares.js';
import { rainMapDatasets, type RainMapDataset } from './rainMap.js';

/** Below this share of a unit's parcel with values, the grid doesn't describe the unit: it is uncovered (provisional). */
export const MIN_UNIT_COVERAGE = 0.9;
/**
 * The most grid cells one unit's bounding box may span: a 100 m grid over a
 * unit about 30 km across. A bound on the rows read and the clipping; a unit
 * past it is uncovered by that grid, saying so.
 */
export const MAX_UNIT_MAP_CELLS = 100_000;
/** How a grid MAP was taken, in its source line. */
export const UNIT_MAP_METHOD = 'area-weighted mean over the unit’s parcel';
/**
 * The most grid cells one request reads from one grid, summed over the
 * units' bounding boxes: 60 units of about 4 km on a 100 m grid is under a
 * tenth of it. Past it, the remaining units are uncovered by that grid,
 * saying so, so a GET over hundreds of large units stays bounded.
 */
export const MAX_GRID_CELLS_PER_REQUEST = 1_000_000;

export interface UnitMapGrid extends RainMapDataset {
	originLon: number;
	originLat: number;
}

/** The loaded MAP grids, in rainMapDatasets' order, with their origins. */
export async function unitMapGrids(db: Db): Promise<UnitMapGrid[]> {
	const datasets = await rainMapDatasets(db);
	if (!datasets.length) return [];
	const { rows } = await db.query<{ dataset: string; origin_lon: number; origin_lat: number }>(
		'SELECT dataset, origin_lon, origin_lat FROM rain_map_dataset WHERE dataset = ANY($1::text[])',
		[datasets.map((d) => d.dataset)]
	);
	const origin = new Map(rows.map((r) => [r.dataset, r]));
	return datasets.flatMap((d) => {
		const o = origin.get(d.dataset);
		return o ? [{ ...d, originLon: o.origin_lon, originLat: o.origin_lat }] : [];
	});
}

/** A grid's citation as a unit's MAP source begins: its label and version. */
export const gridCitation = (g: Pick<RainMapDataset, 'dataset' | 'version'>) => `${g.dataset} ${g.version}`;

/** A unit's MAP source line: "<label> <version>, area-weighted mean over the unit’s parcel, <n> cells". */
export const unitMapSource = (g: Pick<RainMapDataset, 'dataset' | 'version'>, cells: number) =>
	`${gridCitation(g)}, ${UNIT_MAP_METHOD}, ${cells} cell${cells === 1 ? '' : 's'}`;

const SOURCE_RE = new RegExp(`^(.*), ${UNIT_MAP_METHOD}, \\d+ cells?$`);

/** The grid citation a MAP source line names, when the MAP came from a grid (this module wrote it); null for a MAP typed in. */
export const gridOfSource = (source: string | null | undefined): string | null => (source ? (SOURCE_RE.exec(source)?.[1] ?? null) : null);

/** One unit over one grid: its MAP, or why the grid doesn't cover it. */
export type UnitOverGrid = { mapMm: number; cells: number; coveredShare: number } | { coveredShare: number; reason: string };

type Shares = Exclude<ReturnType<typeof gridShares>, { problem: string }>;

/** The unit's share of each cell of `grid` (in the grid's frame), or why it can't be read. */
const sharesOver = (g: Geometry, grid: Pick<UnitMapGrid, 'cellDeg' | 'originLon' | 'originLat'>, maxCells = MAX_UNIT_MAP_CELLS) =>
	gridShares(toGrid(g, grid), grid.cellDeg, maxCells, undefined, 'MAP grid');

function fromShares(shares: Shares, grid: Pick<UnitMapGrid, 'cellDeg' | 'originLon' | 'originLat'>, cells: ReadonlyMap<string, number>): UnitOverGrid {
	let total = 0;
	let covered = 0;
	let sum = 0;
	let n = 0;
	for (const s of shares.cells) {
		// The cell's area where it really is (the shift only aligned the grid).
		const w = cellAreaM2(s.col * grid.cellDeg + grid.originLon, s.row * grid.cellDeg + grid.originLat, grid.cellDeg) * s.share;
		total += w;
		const v = cells.get(`${s.row}:${s.col}`);
		if (v === undefined) continue;
		covered += w;
		sum += w * v;
		n++;
	}
	const coveredShare = total > 0 ? Math.min(1, covered / total) : 0;
	if (!(covered > 0)) return { coveredShare: 0, reason: 'the grid has no value inside the unit’s parcel' };
	if (coveredShare < MIN_UNIT_COVERAGE) {
		return { coveredShare, reason: `the grid has values for only ${Math.round(coveredShare * 100)} % of the unit’s parcel (at least ${Math.round(MIN_UNIT_COVERAGE * 100)} % is needed)` };
	}
	const mapMm = Math.round(sum / covered);
	// The range a unit's MAP takes (the engine's mapMmError, which PUT /model applies): a grid may hold more (a wrong unit or file).
	if (mapMm < MAP_MM_MIN) return { coveredShare, reason: `the grid’s MAP over the unit’s parcel rounds below ${MAP_MM_MIN} mm` };
	if (mapMm > MAP_MM_MAX) return { coveredShare, reason: `the grid’s MAP over the unit’s parcel, ${mapMm} mm, is above the ${MAP_MM_MAX} mm a unit’s MAP takes` };
	return { mapMm, cells: n, coveredShare };
}

/** The unit's area-weighted MAP (whole mm) from cells already read (keyed `row:col`, mm). Pure. */
export function unitMapFromCells(g: Geometry, grid: Pick<UnitMapGrid, 'cellDeg' | 'originLon' | 'originLat'>, cells: ReadonlyMap<string, number>, maxCells = MAX_UNIT_MAP_CELLS): UnitOverGrid {
	const shares = sharesOver(g, grid, maxCells);
	return 'problem' in shares ? { coveredShare: 0, reason: shares.problem } : fromShares(shares, grid, cells);
}

/**
 * The unit over `grid`: one read of the cells over its parcel's extent (none
 * past MAX_UNIT_MAP_CELLS). `budget` counts the cells read from this grid in
 * this request: past MAX_GRID_CELLS_PER_REQUEST nothing more is read.
 */
export async function unitOverGrid(db: Db, grid: UnitMapGrid, g: Geometry, budget: { cells: number } = { cells: 0 }): Promise<UnitOverGrid> {
	const shares = sharesOver(g, grid);
	if ('problem' in shares) return { coveredShare: 0, reason: shares.problem };
	const span = (shares.rows[1] - shares.rows[0]) * (shares.cols[1] - shares.cols[0]);
	if (budget.cells + span > MAX_GRID_CELLS_PER_REQUEST) {
		return { coveredShare: 0, reason: `the units together span more than the ${MAX_GRID_CELLS_PER_REQUEST.toLocaleString('en-ZA')} cells of this grid one request reads; give fewer, smaller units a MAP from it at a time` };
	}
	budget.cells += span;
	const { rows } = await db.query<{ row_idx: number; col_idx: number; map_mm: number }>(
		`SELECT row_idx, col_idx, map_mm FROM rain_map_cell_reference
		 WHERE dataset = $1 AND row_idx >= $2 AND row_idx < $3 AND col_idx >= $4 AND col_idx < $5`,
		[grid.dataset, shares.rows[0], shares.rows[1], shares.cols[0], shares.cols[1]]
	);
	return fromShares(shares, grid, new Map(rows.map((r) => [`${r.row_idx}:${r.col_idx}`, r.map_mm])));
}

interface Named {
	nodeId: string;
	name: string;
}

export interface UnitMapUnit extends Named {
	featureId: string;
	mapMm: number;
	cells: number;
	coveredShare: number;
	/** What the unit's form holds now. */
	current: { mapMm: number | null; mapSource: string | null };
	/** The unit already holds this MAP from this grid. */
	same: boolean;
}

export interface UnitMapCandidate {
	label: string;
	version: string;
	cellDeg: number;
	synthetic: boolean;
	/** How many of the units with a polygon it covers. */
	covered: number;
	/** The units with a polygon it doesn't cover. */
	missing: Named[];
}

export interface UnitMapProposal {
	dataset: { label: string; version: string; source: string; attribution: string; cellDeg: number; synthetic: boolean } | null;
	/** Whether `dataset` covers every unit with a polygon. */
	coversAll: boolean;
	units: UnitMapUnit[];
	/** Units with a polygon the chosen grid doesn't cover, and why: never filled from another grid. */
	uncovered: (Named & { coveredShare: number; reason: string })[];
	withoutPolygon: Named[];
	/** Units whose polygon can't be chosen (several parcels, none its area). */
	refused: (Named & { reason: string })[];
	/** Units the chosen grid doesn't cover whose MAP came from another grid: applying would mix two grids, so it is refused until they are cleared. */
	otherGrid: (Named & { mapSource: string })[];
	/** Every loaded grid, in the order the choice reads them. */
	candidates: UnitMapCandidate[];
}

interface UnitWithParcel extends Named {
	featureId: string;
	geometry: Geometry;
	current: { mapMm: number | null; mapSource: string | null };
}

/**
 * The proposal: every land unit over every loaded grid, the grid chosen
 * (`asked`, else by the rule above), and each unit's MAP from it. Read-only.
 * `asked` names a grid that isn't loaded: null.
 */
export async function unitMapProposal(db: Db, projectId: string, asked?: string): Promise<UnitMapProposal | null> {
	const grids = await unitMapGrids(db);
	if (asked !== undefined && !grids.some((g) => g.dataset === asked)) return null;
	const units = await loadUnits(db, projectId);
	const { rows: maps } = await db.query<{ id: string; map_mm: number | null; map_source: string | null }>(
		`SELECT id, map_mm, map_source FROM node WHERE project_id = $1 AND kind = 'farm' AND area_km2 > 0`,
		[projectId]
	);
	const mapOf = new Map(maps.map((r) => [r.id, { mapMm: r.map_mm, mapSource: r.map_source }]));
	const withoutPolygon: Named[] = [];
	const refused: (Named & { reason: string })[] = [];
	const placed: UnitWithParcel[] = [];
	for (const u of units) {
		const p = unitParcel(u);
		if (p === null) withoutPolygon.push({ nodeId: u.nodeId, name: u.name });
		else if (p === 'several') refused.push({ nodeId: u.nodeId, name: u.name, reason: 'the unit has several parcels on the map and none is its area: use one parcel’s area for the unit on the Map tab first' });
		else placed.push({ nodeId: u.nodeId, name: u.name, featureId: p.id, geometry: p.geometry, current: mapOf.get(u.nodeId) ?? { mapMm: null, mapSource: null } });
	}
	const over = new Map<string, UnitOverGrid[]>();
	for (const g of grids) {
		const results: UnitOverGrid[] = [];
		const budget = { cells: 0 };
		for (const u of placed) results.push(await unitOverGrid(db, g, u.geometry, budget));
		over.set(g.dataset, results);
	}
	const candidates: UnitMapCandidate[] = grids.map((g) => {
		const r = over.get(g.dataset)!;
		const missing = placed.filter((_, i) => !('mapMm' in r[i]!)).map(({ nodeId, name }) => ({ nodeId, name }));
		return { label: g.dataset, version: g.version, cellDeg: g.cellDeg, synthetic: g.synthetic, covered: placed.length - missing.length, missing };
	});
	let chosen: UnitMapGrid | null = null;
	if (asked !== undefined) chosen = grids.find((g) => g.dataset === asked)!;
	else {
		// Among the real grids, the first (finest) covering every unit, else the one covering the most (the finest of
		// those); the synthetic grid only when no real grid covers any unit: invented rainfall never wins over a real
		// grid by covering more.
		const pick = (synthetic: boolean) => {
			let at = -1;
			for (const [k, c] of candidates.entries()) {
				if (c.synthetic !== synthetic || c.covered === 0) continue;
				if (c.covered === placed.length) return k;
				if (at < 0 || c.covered > candidates[at]!.covered) at = k;
			}
			return at;
		};
		const real = pick(false);
		const at = real >= 0 ? real : pick(true);
		chosen = at >= 0 ? grids[at]! : null;
	}
	const out: UnitMapProposal = { dataset: null, coversAll: false, units: [], uncovered: [], withoutPolygon, refused, otherGrid: [], candidates };
	if (!chosen) return out;
	out.dataset = { label: chosen.dataset, version: chosen.version, source: chosen.source, attribution: chosen.attribution, cellDeg: chosen.cellDeg, synthetic: chosen.synthetic };
	const cite = gridCitation(chosen);
	const results = over.get(chosen.dataset)!;
	placed.forEach((u, i) => {
		const r = results[i]!;
		if ('mapMm' in r) {
			const source = unitMapSource(chosen, r.cells);
			out.units.push({
				nodeId: u.nodeId,
				name: u.name,
				featureId: u.featureId,
				mapMm: r.mapMm,
				cells: r.cells,
				coveredShare: r.coveredShare,
				current: u.current,
				same: u.current.mapMm === r.mapMm && u.current.mapSource === source
			});
		} else {
			out.uncovered.push({ nodeId: u.nodeId, name: u.name, coveredShare: r.coveredShare, reason: r.reason });
		}
	});
	out.coversAll = out.uncovered.length === 0;
	// Every land unit outside the proposal (uncovered, no polygon, refused) whose MAP came from another grid.
	const proposed = new Set(out.units.map((u) => u.nodeId));
	for (const u of units) {
		if (proposed.has(u.nodeId)) continue;
		const cur = mapOf.get(u.nodeId);
		const from = gridOfSource(cur?.mapSource);
		if (cur?.mapMm !== null && cur?.mapMm !== undefined && from !== null && from !== cite) out.otherGrid.push({ nodeId: u.nodeId, name: u.name, mapSource: cur.mapSource! });
	}
	return out;
}
