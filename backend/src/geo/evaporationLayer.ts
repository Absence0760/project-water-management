// The A-pan grid layer of the catchment map (docs/maps.md § A-pan grid): one
// evaporation grid's cells in a box, each its centre and its value for one
// month or the year, for GET …/map/evaporation-grid
// (evaporationLayerRoutes.ts). The grids are the evaporation proposals' own
// (180_evaporation_reference.sql): cells keyed by their south-west corner's
// indices, so a box is a range on the primary key, as the MAP grid's is
// (rainMap.ts cellRange).
//
// Only the A-pan kind is drawn (the WRC Atlas's is modelled, not measured
// pans). A reference ET (et0) grid isn't pan evaporation, and a layer of it
// beside the pan would read as one more pan: it stays on Evaporation from the
// map, where its proposal says what it is. (An S-pan grid layer was removed on
// 2026-11-09: the Atlas has no S-pan grids, issue #738.)
import type { Db } from '../db/tx.js';
import { evaporationDatasets, evaporationLabel, type EvaporationDataset } from './evaporation.js';
import { cellRange, type Box } from './rainMap.js';

/** The evaporation kinds the map draws as layers. */
export const EVAPORATION_LAYER_KINDS = ['apan'] as const;
export type EvaporationLayerKind = (typeof EVAPORATION_LAYER_KINDS)[number];

/** A dataset as the layer lists it: the proposals' fields, and its values in words (evaporationLabel: "modelled" for a modelled A-pan). */
export interface EvaporationLayerDataset {
	dataset: string;
	kind: EvaporationLayerKind;
	label: string;
	source: string;
	version: string;
	method: string;
	attribution: string;
	/** Both null when the source states no period (issue #755). */
	firstYear: number | null;
	lastYear: number | null;
	cellDeg: number;
	synthetic: boolean;
}

/** The loaded datasets of `kind`, in the proposals' order (a real one before the synthetic grid, then the newest load). */
export async function evaporationLayerDatasets(db: Db, kind: EvaporationLayerKind): Promise<(EvaporationLayerDataset & { grid: EvaporationDataset })[]> {
	return (await evaporationDatasets(db))
		.filter((d) => d.kind === kind)
		.map((d) => ({
			dataset: d.dataset,
			kind,
			label: evaporationLabel(d),
			source: d.source,
			version: d.version,
			method: d.method,
			attribution: d.attribution,
			firstYear: d.firstYear,
			lastYear: d.lastYear,
			cellDeg: d.cellDeg,
			synthetic: d.synthetic,
			grid: d
		}));
}

/** A calendar month (1 = January) → its place in a cell's values, which run Oct … Sep (180). */
export const waterYearIndex = (month: number) => (month + 2) % 12;

/** A cell's value: the month's mean total (`month` 1–12), or the year's (the 12 months summed) without one; whole mm. */
export function cellValue(monthlyMm: readonly number[], month: number | null): number {
	if (month !== null) return Math.round(monthlyMm[waterYearIndex(month)]!);
	let sum = 0;
	for (const v of monthlyMm) sum += v;
	return Math.round(sum);
}

/** One cell as the layer gets it: its centre and its value, mm. */
export type EvaporationLayerPoint = [lon: number, lat: number, mm: number];

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/**
 * The cells of `grid` whose centres lie in `box`, at most `max`: null when
 * the box holds more than `max` of the grid's cells (counted from the grid
 * before any read: the caller says zoom in), else each cell's centre and
 * value (cellValue), south to north, west to east.
 */
export async function evaporationCellsIn(
	db: Db,
	grid: Pick<EvaporationDataset, 'dataset' | 'cellDeg' | 'originLon' | 'originLat'>,
	box: Box,
	max: number,
	month: number | null
): Promise<EvaporationLayerPoint[] | null> {
	const range = cellRange(grid, box);
	if (range.most > max) return null;
	const { rows } = await db.query<{ row_idx: number; col_idx: number; monthly_mm: number[] }>(
		`SELECT row_idx, col_idx, monthly_mm FROM evaporation_cell_reference
		 WHERE dataset = $1 AND row_idx BETWEEN $2 AND $3 AND col_idx BETWEEN $4 AND $5
		 ORDER BY row_idx, col_idx`,
		[grid.dataset, range.r0, range.r1, range.c0, range.c1]
	);
	const out: EvaporationLayerPoint[] = [];
	for (const r of rows) {
		const lon = grid.originLon + (r.col_idx + 0.5) * grid.cellDeg;
		const lat = grid.originLat + (r.row_idx + 0.5) * grid.cellDeg;
		if (lon < box.w || lon > box.e || lat < box.s || lat > box.n) continue;
		out.push([round6(lon), round6(lat), cellValue(r.monthly_mm, month)]);
	}
	return out;
}
