// A hydrological unit's registered irrigated area against the area the run
// planted (docs/allocations.md § The comparison, § Per unit, all three).
// Pure arithmetic beside the comparison (./compare.ts), like the storage
// line: the backend's Allocations route adds it to each unit of a run's
// comparison (withIrrigatedAreas). runModel never calls it and the model
// never reads a registered irrigated area, so ENGINE_VERSION doesn't move.
//
// The modelled area is the unit's planted crop areas in the run's own inputs
// (ProjectModel.cropAreas, m² → ha): every crop the engine models is
// irrigated (docs/model.md §2.3). The registered area is the sum of the
// irrigated areas stated on the unit's takes (s21a) in force on any of the
// run's days, as the registered storage is counted (a row that lapsed
// before the run, or starts after it, isn't the unit's now).

import { toEpochDay } from '../calendar';
import { allocationStatus, isStorageOnly, type AllocationComparison, type AllocationStatus, type AllocationWaterUse } from './compare';

/** One unit's irrigated area: registered (ha) against the run's planted crop areas (ha). */
export interface IrrigatedAreaComparison {
	/** Σ irrigated area stated on the unit's takes in force on any of the run's days, ha; null when none states one. */
	registeredHa: number | null;
	/** Σ the unit's planted crop areas in the run, ha (0 with none). */
	modelledHa: number;
	/** modelled − registered, ha; null without a registered area. */
	differenceHa: number | null;
	/**
	 * allocationStatus(modelled, registered ?? 0) with the comparison's band:
	 * `over` = more planted than registered, `under` = less, `unregistered` =
	 * planted with no area registered, `none` = neither.
	 */
	status: AllocationStatus;
}

/** A registered row as the area comparison reads it. */
export interface IrrigatedAreaEntry {
	nodeId: string | null;
	irrigatedAreaHa?: number | null;
	waterUse?: AllocationWaterUse | null;
	validFrom?: string | null;
	validTo?: string | null;
}

/** A planted crop area as the run's inputs store it. */
export interface PlantedArea {
	nodeId: string;
	areaM2: number;
}

const finite = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** Each unit's planted crop area, ha. */
export function plantedHaByNode(cropAreas: readonly PlantedArea[] | null | undefined): Map<string, number> {
	const out = new Map<string, number>();
	for (const a of cropAreas ?? []) {
		if (!a || typeof a.nodeId !== 'string') continue;
		out.set(a.nodeId, (out.get(a.nodeId) ?? 0) + finite(a.areaM2) / 10_000);
	}
	return out;
}

/**
 * Each unit's registered irrigated area against its planted crop area, for
 * the units `nodeIds`, over the run's days [startDate, endDate] and with the
 * comparison's band.
 */
export function compareIrrigatedAreas(input: {
	startDate: string;
	endDate: string;
	nodeIds: readonly string[];
	cropAreas: readonly PlantedArea[] | null | undefined;
	allocations: readonly IrrigatedAreaEntry[];
	tolerance: number;
}): Map<string, IrrigatedAreaComparison> {
	const start = toEpochDay(input.startDate);
	const end = toEpochDay(input.endDate);
	const planted = plantedHaByNode(input.cropAreas);
	const registered = new Map<string, number>();
	for (const a of input.allocations) {
		if (!a.nodeId || isStorageOnly(a) || a.irrigatedAreaHa === null || a.irrigatedAreaHa === undefined || !Number.isFinite(a.irrigatedAreaHa)) continue;
		if (a.validTo && toEpochDay(a.validTo) < start) continue;
		if (a.validFrom && toEpochDay(a.validFrom) > end) continue;
		registered.set(a.nodeId, (registered.get(a.nodeId) ?? 0) + Math.max(0, a.irrigatedAreaHa));
	}
	const out = new Map<string, IrrigatedAreaComparison>();
	for (const id of input.nodeIds) {
		const modelledHa = planted.get(id) ?? 0;
		const registeredHa = registered.has(id) ? registered.get(id)! : null;
		out.set(id, {
			registeredHa,
			modelledHa,
			differenceHa: registeredHa === null ? null : modelledHa - registeredHa,
			status: allocationStatus(modelledHa, registeredHa ?? 0, input.tolerance)
		});
	}
	return out;
}

/** The comparison with each unit's irrigated area beside its use and storage (the Allocations route's, not the run summary's). */
export function withIrrigatedAreas(
	c: AllocationComparison,
	cropAreas: readonly PlantedArea[] | null | undefined,
	allocations: readonly IrrigatedAreaEntry[]
): AllocationComparison {
	const areas = compareIrrigatedAreas({ startDate: c.startDate, endDate: c.endDate, nodeIds: c.nodes.map((n) => n.nodeId), cropAreas, allocations, tolerance: c.tolerance });
	return { ...c, nodes: c.nodes.map((n) => ({ ...n, irrigatedArea: areas.get(n.nodeId)! })) };
}
