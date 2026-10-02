// What a project's viewers read of its registered volumes (decision D3,
// provisional position, pre-counsel research 2026-10-01; 162_allocation_viewer_units.sql,
// docs/allocations.md § Who sees what).
//
// Owners and editors read every allocation. A viewer reads each farm's
// volumes only when an owner has switched project.allocations_viewer_units
// on; otherwise RLS gives a viewer no allocation row, and the API serves
// totals per water source instead, summed here from app_allocation_volumes
// (which returns a source's rows only when 5 or more registered users hold
// it). The run's own copy of the rows (its model's `allocations`, the
// per-unit part of its summary's `allocations`) is left out of what a viewer
// reads too (redactRunAllocations).
import {
	allocationStatus,
	compareAllocations,
	type AllocationComparison,
	type AllocationEntry,
	type AllocationStatus,
	type AllocationUseNode,
	type AllocationWaterSource
} from '@water-management/engine';
import type { Db } from '../db/tx.js';
import type { Role } from '../projects/access.js';

/** A viewer on a project whose owners haven't let viewers read each registered volume. */
export async function allocationUnitsHidden(db: Db, projectId: string, role: Role): Promise<boolean> {
	if (role !== 'viewer') return false;
	const { rows } = await db.query<{ on: boolean }>('SELECT app_allocations_viewer_units($1) AS "on"', [projectId]);
	return !rows[0]?.on;
}

/** One row behind a viewer's totals (app_allocation_volumes): no name, number or property. */
export interface VolumeRow {
	waterSource: AllocationWaterSource;
	holders: number;
	nodeId: string | null;
	volumeM3PerYear: number;
	storageM3: number | null;
	waterUse: '21a' | '21b';
	validFrom: string | null;
	validTo: string | null;
}

export async function loadVolumes(db: Db, projectId: string): Promise<VolumeRow[]> {
	const { rows } = await db.query<VolumeRow>(
		`SELECT water_source AS "waterSource", holders, node_id AS "nodeId", volume_m3_year AS "volumeM3PerYear", storage_m3 AS "storageM3",
			water_use AS "waterUse", to_char(valid_from, 'YYYY-MM-DD') AS "validFrom", to_char(valid_to, 'YYYY-MM-DD') AS "validTo"
		 FROM app_allocation_volumes($1)`,
		[projectId]
	);
	return rows;
}

/** A water source's registered volumes in force on a day, summed: what a viewer reads instead of the list. */
export interface AllocationTotal {
	waterSource: AllocationWaterSource;
	/** Registered users holding this source (5 or more, or it isn't returned). */
	holders: number;
	/** Volumes in force that day, m³ a year (takes only; a 21b row is storage). */
	registeredM3PerYear: number;
	/** Registered storage in force that day, m³; null when none states one. */
	storageM3: number | null;
}

const inForce = (r: Pick<VolumeRow, 'validFrom' | 'validTo'>, day: string) => (!r.validFrom || r.validFrom <= day) && (!r.validTo || r.validTo >= day);
const SOURCES: readonly AllocationWaterSource[] = ['surface', 'groundwater'];

export function volumeTotals(rows: readonly VolumeRow[], day: string): AllocationTotal[] {
	return SOURCES.flatMap((src) => {
		const mine = rows.filter((r) => r.waterSource === src);
		if (!mine.length) return [];
		const now = mine.filter((r) => inForce(r, day));
		const storages = now.filter((r) => r.storageM3 !== null);
		return [
			{
				waterSource: src,
				holders: mine[0]!.holders,
				registeredM3PerYear: now.filter((r) => r.waterUse !== '21b').reduce((s, r) => s + r.volumeM3PerYear, 0),
				storageM3: storages.length ? storages.reduce((s, r) => s + r.storageM3!, 0) : null
			}
		];
	});
}

/** One water year of a source's use, summed over the units with a volume on it. */
export interface AllocationYearTotal {
	waterYear: number;
	/** A part of the year only (the run's edge): listed, not judged. */
	partial: boolean;
	registeredM3: number;
	modelledM3: number;
	status: AllocationStatus;
}

export interface AllocationSourceTotals {
	waterSource: AllocationWaterSource;
	holders: number;
	/** Units with a registered volume on this source in the run. */
	units: number;
	years: AllocationYearTotal[];
}

export interface AllocationComparisonTotals {
	tolerance: number;
	sources: AllocationSourceTotals[];
}

/**
 * The run's modelled use against the registered volumes, summed per water
 * source and water year over the units that hold one (compareAllocations,
 * then the sum). A source with fewer than 5 holders isn't in `rows`, so it
 * isn't here.
 */
export function comparisonTotals(input: { startDate: string; nodes: readonly AllocationUseNode[]; tolerance: number; rows: readonly VolumeRow[] }): AllocationComparisonTotals {
	const holders = new Map(input.rows.map((r) => [r.waterSource, r.holders]));
	const allocations: AllocationEntry[] = input.rows.map((r, i) => ({
		id: `v${i}`,
		nodeId: r.nodeId,
		waterSource: r.waterSource,
		volumeM3PerYear: r.volumeM3PerYear,
		storageM3: r.storageM3,
		...(r.waterUse === '21b' ? { waterUse: '21b' as const } : {}),
		validFrom: r.validFrom,
		validTo: r.validTo
	}));
	const c: AllocationComparison = compareAllocations({ startDate: input.startDate, nodes: input.nodes, tolerance: input.tolerance, allocations });
	const sources = SOURCES.flatMap((src): AllocationSourceTotals[] => {
		if (!holders.has(src)) return [];
		const held = c.nodes.map((n) => n[src]).filter((s) => s.allocationIds.length > 0);
		const byYear = new Map<number, AllocationYearTotal>();
		for (const s of held)
			for (const y of s.years) {
				const t = byYear.get(y.waterYear) ?? { waterYear: y.waterYear, partial: y.partial, registeredM3: 0, modelledM3: 0, status: 'none' as AllocationStatus };
				t.registeredM3 += y.registeredM3;
				t.modelledM3 += y.modelledM3;
				t.partial ||= y.partial;
				byYear.set(y.waterYear, t);
			}
		const years = [...byYear.values()].sort((a, b) => a.waterYear - b.waterYear).map((y) => ({ ...y, status: allocationStatus(y.modelledM3, y.registeredM3, input.tolerance) }));
		return [{ waterSource: src, holders: holders.get(src)!, units: held.length, years }];
	});
	return { tolerance: input.tolerance, sources };
}

type RunLike = { model?: { allocations?: unknown } | null; summary?: { allocations?: { nodes?: unknown[] } | null } | null; inputs?: { model?: { allocations?: unknown } | null } | null };

/**
 * A run as a viewer who can't read each registered volume gets it: no
 * allocation rows in its model (or inputs' model), and its summary's
 * allocations without the per-unit part (the mode, band and counts stay).
 */
export function redactRunAllocations<T extends RunLike>(run: T): T {
	const out = { ...run };
	if (out.model && 'allocations' in out.model) out.model = { ...out.model, allocations: [] };
	if (out.inputs?.model && 'allocations' in out.inputs.model) out.inputs = { ...out.inputs, model: { ...out.inputs.model, allocations: [] } };
	if (out.summary?.allocations) out.summary = { ...out.summary, allocations: { ...out.summary.allocations, nodes: [] } };
	return out;
}
