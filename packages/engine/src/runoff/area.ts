import type { ModelInput } from '../project';
import { cmpStr } from '../order';

/** Explicit catchment area, else the sum of the farm areas (the workbook's rFarmSpec_AreaTotal). */
export function resolveCatchmentAreaKm2(cal: { catchmentAreaKm2: number | null }, input: ModelInput): number {
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
	if (!(area > 0)) throw new Error('catchment area is 0 — give the farms an area (km²) or set calibration.catchmentAreaKm2');
	return area;
}
