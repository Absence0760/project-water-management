// Each hydrological unit's mean monthly A-pan from an A-pan grid (the CCWR
// A-pan grid, `Atlas-Apan-2007`; docs/maps.md § A-pan for each unit): the
// area-weighted mean of the grid's 12 monthly means over the unit's parcel,
//     Σ over the cells with a value: cell area × share of the cell inside the
//     parcel (geo/gridShares.ts) × the cell's month m
//     ÷ Σ over the same cells: cell area × share inside,
// the same way a unit's MAP is taken from a MAP grid (geo/unitMap.ts) and the
// catchment's A-pan from the boundary (geo/evaporation.ts), beside the
// catchment boundary's own average.
//
// For comparison only: the model runs every unit on the one catchment A-pan
// row (settings.apanMm). The table lets the hydrologist judge whether the
// units differ enough to matter. A unit the grid covers under 90 % (the
// unit MAP's MIN_UNIT_COVERAGE), without an outline, or with several
// parcels none of which is its area is listed with the reason, never filled
// from elsewhere. Reads are bounded as the unit MAP's are: at most
// MAX_UNIT_MAP_CELLS cells in one unit's box, MAX_GRID_CELLS_PER_REQUEST in
// one request.
import type { Db } from '../db/tx.js';
import { loadUnits, unitParcel } from '../feeds/fromUnits.js';
import { evaporationDatasets, summariseEvaporation, type EvaporationDataset } from './evaporation.js';
import type { Geometry } from './geojson.js';
import { cellAreaM2, gridShares, toGrid } from './gridShares.js';
import { MAX_GRID_CELLS_PER_REQUEST, MAX_UNIT_MAP_CELLS, MIN_UNIT_COVERAGE } from './unitMap.js';

type Grid = Pick<EvaporationDataset, 'cellDeg' | 'originLon' | 'originLat'>;

/** How a unit's row is taken, in words (its source line and the History reason say it). */
export const UNIT_APAN_METHOD = 'each unit’s 12 monthly means area-weighted over its outline (cells × the share inside, on the WGS84 ellipsoid), units under 90 % covered left out';

const round1 = (x: number) => Math.round(x * 10) / 10;
const sum = (row: readonly number[]) => row.reduce((a, b) => a + b, 0);

/** One unit over the grid: its 12 monthly means (mm, Oct … Sep, to 0.1), or why the grid doesn't describe it. */
export type UnitOverApanGrid = { monthlyMm: number[]; annualMm: number; cells: number; coveredShare: number } | { coveredShare: number; reason: string };

type Shares = Exclude<ReturnType<typeof gridShares>, { problem: string }>;

const sharesOver = (g: Geometry, grid: Grid, maxCells = MAX_UNIT_MAP_CELLS) => gridShares(toGrid(g, grid), grid.cellDeg, maxCells, undefined, 'A-pan grid');

function fromShares(shares: Shares, grid: Grid, cells: ReadonlyMap<string, readonly number[]>): UnitOverApanGrid {
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
	const coveredShare = total > 0 ? Math.min(1, covered / total) : 0;
	if (!(covered > 0)) return { coveredShare: 0, reason: 'the grid has no value inside the unit’s parcel' };
	if (coveredShare < MIN_UNIT_COVERAGE) {
		return { coveredShare, reason: `the grid has values for only ${Math.round(coveredShare * 100)} % of the unit’s parcel (at least ${Math.round(MIN_UNIT_COVERAGE * 100)} % is needed)` };
	}
	const monthlyMm = sums.map((s) => round1(s / covered));
	return { monthlyMm, annualMm: round1(sum(monthlyMm)), cells: n, coveredShare };
}

/** The unit's area-weighted monthly A-pan from cells already read (keyed `row:col`, 12 values each, Oct … Sep). Pure. */
export function unitApanFromCells(g: Geometry, grid: Grid, cells: ReadonlyMap<string, readonly number[]>, maxCells = MAX_UNIT_MAP_CELLS): UnitOverApanGrid {
	const shares = sharesOver(g, grid, maxCells);
	return 'problem' in shares ? { coveredShare: 0, reason: shares.problem } : fromShares(shares, grid, cells);
}

/**
 * The unit over `grid`: one read of the cells over its parcel's extent (none
 * past MAX_UNIT_MAP_CELLS). `budget` counts the cells read in this request:
 * past MAX_GRID_CELLS_PER_REQUEST nothing more is read.
 */
export async function unitOverApanGrid(db: Db, grid: EvaporationDataset, g: Geometry, budget: { cells: number } = { cells: 0 }): Promise<UnitOverApanGrid> {
	const shares = sharesOver(g, grid);
	if ('problem' in shares) return { coveredShare: 0, reason: shares.problem };
	const span = (shares.rows[1] - shares.rows[0]) * (shares.cols[1] - shares.cols[0]);
	if (budget.cells + span > MAX_GRID_CELLS_PER_REQUEST) {
		return { coveredShare: 0, reason: `the units together span more than the ${MAX_GRID_CELLS_PER_REQUEST.toLocaleString('en-ZA')} cells of this grid one request reads` };
	}
	budget.cells += span;
	const { rows } = await db.query<{ row_idx: number; col_idx: number; monthly_mm: number[] }>(
		`SELECT row_idx, col_idx, monthly_mm FROM evaporation_cell_reference
		 WHERE dataset = $1 AND row_idx >= $2 AND row_idx < $3 AND col_idx >= $4 AND col_idx < $5`,
		[grid.dataset, shares.rows[0], shares.rows[1], shares.cols[0], shares.cols[1]]
	);
	return fromShares(shares, grid, new Map(rows.map((r) => [`${r.row_idx}:${r.col_idx}`, r.monthly_mm])));
}

interface Named {
	nodeId: string;
	name: string;
}

export interface UnitApanUnit extends Named {
	/** The unit's area in the model, km² (what an area-weighted mean of the units weighs by). */
	areaKm2: number;
	monthlyMm: number[];
	annualMm: number;
	cells: number;
	coveredShare: number;
	/** (unit's year − catchment's year) ÷ catchment's year × 100, to 0.1; null without a catchment average. */
	diffPct: number | null;
}

export interface UnitApanProposal {
	/** The A-pan grid read; null when it (or any A-pan grid, with none asked for) isn't loaded on this server. */
	dataset: { label: string; version: string; source: string; attribution: string; method: string; cellDeg: number; synthetic: boolean; firstYear: number | null; lastYear: number | null } | null;
	boundary: { featureId: string; name: string } | null;
	/** The boundary's average over the same grid (what the CCWR option proposes as the A-pan row), or why there is none. */
	catchment: { monthlyMm: number[]; annualMm: number; coverage: number; cells: number } | { problem: string } | null;
	units: UnitApanUnit[];
	/** Units whose parcel the grid covers under 90 % (or can't be read): never filled from elsewhere. */
	uncovered: (Named & { coveredShare: number; reason: string })[];
	withoutPolygon: Named[];
	/** Units with several parcels and none its area. */
	refused: (Named & { reason: string })[];
	/** The A-pan row the model runs every unit on now (the catchment row). */
	settingsApanMm: number[];
	/** What the settings hold now: the basis (engine ≥ 1.117.0) and the units' saved rows, if any. */
	saved: { basis: 'catchment' | 'units'; dataset: string | null; source: string | null; units: Record<string, number[]> };
	/** Every covered unit's row is saved as shown, from this grid (nothing to use). */
	same: boolean;
}

/** The A-pan grid asked for (null when it isn't loaded or isn't an A-pan grid), else the first A-pan grid loaded. */
async function apanGrid(db: Db, asked: string | undefined): Promise<EvaporationDataset | null> {
	const apan = (await evaporationDatasets(db)).filter((d) => d.kind === 'apan');
	return asked === undefined ? (apan[0] ?? null) : (apan.find((d) => d.dataset === asked) ?? null);
}

/**
 * Each land unit's monthly A-pan over `asked` (else the first A-pan grid), beside the catchment boundary's. Read-only.
 * `settingsApanMm` is the caller's (the stored settings merged over the defaults).
 */
export async function unitApanProposal(
	db: Db,
	projectId: string,
	asked: string | undefined,
	settings: { apanMm: readonly number[]; apanBasis?: unknown; apanUnits?: { dataset: string; source: string; units: Record<string, number[]> } | null }
): Promise<UnitApanProposal> {
	const stored = settings.apanUnits ?? null;
	const saved = { basis: settings.apanBasis === 'units' ? ('units' as const) : ('catchment' as const), dataset: stored?.dataset ?? null, source: stored?.source ?? null, units: stored?.units ?? {} };
	const out: UnitApanProposal = { dataset: null, boundary: null, catchment: null, units: [], uncovered: [], withoutPolygon: [], refused: [], settingsApanMm: [...settings.apanMm], saved, same: false };
	const grid = await apanGrid(db, asked);
	const { rows: b } = await db.query<{ id: string; name: string; geometry: Geometry }>(
		`SELECT id, name, geometry FROM map_feature WHERE project_id = $1 AND kind = 'catchment_boundary' ORDER BY created_at, id LIMIT 1`,
		[projectId]
	);
	const boundary = b[0] ?? null;
	out.boundary = boundary ? { featureId: boundary.id, name: boundary.name } : null;
	if (!grid) return out;
	out.dataset = {
		label: grid.dataset,
		version: grid.version,
		source: grid.source,
		attribution: grid.attribution,
		method: grid.method,
		cellDeg: grid.cellDeg,
		synthetic: grid.synthetic,
		firstYear: grid.firstYear,
		lastYear: grid.lastYear
	};
	if (boundary) {
		const s = await summariseEvaporation(db, grid, boundary.geometry);
		out.catchment = 'problem' in s ? { problem: s.problem } : { monthlyMm: s.monthlyMm, annualMm: s.annualMm, coverage: s.coverage, cells: s.cells };
	}
	const catchmentYear = out.catchment && 'annualMm' in out.catchment && out.catchment.annualMm > 0 ? out.catchment.annualMm : null;
	const units = await loadUnits(db, projectId);
	const { rows: areas } = await db.query<{ id: string; area_km2: number }>(`SELECT id, area_km2 FROM node WHERE project_id = $1 AND kind = 'farm' AND area_km2 > 0`, [projectId]);
	const areaOf = new Map(areas.map((r) => [r.id, Number(r.area_km2)]));
	const budget = { cells: 0 };
	for (const u of units) {
		const named = { nodeId: u.nodeId, name: u.name };
		const p = unitParcel(u);
		if (p === null) out.withoutPolygon.push(named);
		else if (p === 'several') out.refused.push({ ...named, reason: 'the unit has several parcels on the map and none is its area: use one parcel’s area for the unit on the Map tab first' });
		else {
			const r = await unitOverApanGrid(db, grid, p.geometry, budget);
			if ('monthlyMm' in r) {
				const diffPct = catchmentYear === null ? null : round1(((r.annualMm - catchmentYear) / catchmentYear) * 100);
				out.units.push({ ...named, areaKm2: areaOf.get(u.nodeId) ?? 0, ...r, diffPct });
			} else out.uncovered.push({ ...named, coveredShare: r.coveredShare, reason: r.reason });
		}
	}
	// Saved as shown: the same grid, exactly these units, each to 0.05 mm (the settings round-trip floats).
	const close = (a: readonly number[] | undefined, b: readonly number[]) => !!a && a.length === 12 && a.every((x, m) => Math.abs(x - b[m]!) < 0.05);
	out.same =
		out.units.length > 0 &&
		saved.dataset === grid.dataset &&
		Object.keys(saved.units).length === out.units.length &&
		out.units.every((u) => close(saved.units[u.nodeId], u.monthlyMm));
	return out;
}
