import type { ModelInput, NetworkNode } from '../project';
import { cmpStr } from '../order';

/** 1 mm over 1 km² = 1 000 m³. */
export const MM_KM2_TO_M3 = 1000;

/**
 * The sum of the land units' areas, which GR4J runs on (docs/model.md §2.4h:
 * Per unit, the only method since engine 1.109.0, issue #658), whatever the
 * override. A model with no land unit: the explicit catchment area, else the
 * sum of the farm areas (the workbook's rFarmSpec_AreaTotal).
 */
export function resolveCatchmentAreaKm2(cal: { catchmentAreaKm2: number | null }, input: ModelInput): number {
	// Runoff from each unit's own rain (engine ≥ 1.78.0, docs/model.md §2.4h): the land units' areas, which GR4J runs on.
	const perUnit = perUnitAreaKm2(input);
	if (perUnit !== null) return perUnit;
	if (cal.catchmentAreaKm2 != null && cal.catchmentAreaKm2 > 0) return cal.catchmentAreaKm2;
	// Summed in node-id order, so the area, and every natural flow scaled by it,
	// is the same to the last bit however the nodes are listed (fuzz seed 7094; ../order.ts).
	return input.model.nodes
		.filter((n) => n.kind === 'farm')
		.sort((a, b) => cmpStr(a.id, b.id))
		.reduce((sum, n) => sum + (n.areaKm2 || 0), 0);
}

/** resolveCatchmentAreaKm2, refusing a catchment with no area (rain can't become flow). */
export function requireCatchmentAreaKm2(cal: { catchmentAreaKm2: number | null }, input: ModelInput): number {
	const area = resolveCatchmentAreaKm2(cal, input);
	if (!(area > 0)) throw new Error('catchment area is 0 — give the units an area (km²) or set calibration.catchmentAreaKm2');
	return area;
}

/** A land unit: a farm with an area (gauges and water users have no land). */
export const isLandUnit = (n: NetworkNode): boolean => n.kind === 'farm' && n.areaKm2 > 0;

/**
 * With at least one land unit, the sum of the land units' areas (node-id
 * order): the area the per-unit runoff is made on, which replaces
 * calibration.catchmentAreaKm2. Null without a land unit. Per unit is the only
 * method since engine 1.109.0 (issue #658), so the settings play no part.
 */
export function perUnitAreaKm2(input: Pick<ModelInput, 'model'> & { settings?: unknown }): number | null {
	const units = input.model.nodes.filter(isLandUnit).sort((a, b) => cmpStr(a.id, b.id));
	if (!units.length) return null;
	return units.reduce((s, n) => s + n.areaKm2, 0);
}
