// The flow shares engines up to 1.104.x applied (b023 [Farm spec] "Selected
// fragmentation (%)"): area, Hi/Lo MAP or specific, from
// settings.flowShareMethod. Engine 1.105.0 retired them (issue #616): every
// unit's share of the flow, the EWR, the land-cover threshold and the senior
// users' claims is now its natural MAR share (../network/ewrSplit.ts,
// docs/model.md §2.5), which adds up to 1 by construction.
//
// Kept only to read an older run's snapshot after the fact: the evidence
// nomination check refuses a run whose shares summed to more than 100 %
// (backend runs/evidence.ts), which only runs before engine 0.27.1 can trip,
// since later engines refused such shares. Nothing in a run calls it.
import { cmpStr } from '../order';
import type { FlowShareMethod } from '../project';

/** b023 `rFarmSpec_FragmentationTolerance`: shares had to sum to 1 within this. */
export const SHARE_TOLERANCE = 0.0002;

export interface FlowShares {
	/** share[i] for node i (0 for gauges). */
	share: Float64Array;
	sum: number;
	warnings: string[];
}

/** A node as an older snapshot stores it: the retired fields may be there. */
interface LegacyNode {
	kind: string;
	id: string;
	name: string;
	areaKm2: number;
	areaHiKm2?: number;
	areaLoKm2?: number;
	flowShareManual?: number | null;
}

/**
 * - area:   farm area / Σ farm area
 * - hiLo:   hi/Σhi × split.hi + lo/Σlo × split.lo  (Pitman high/low MAP split)
 * - manual: node.flowShareManual
 * Only farms carry a share; gauges generate no runoff of their own.
 */
export function flowShares(nodes: readonly LegacyNode[], method: FlowShareMethod, hiLoSplit: { hi: number; lo: number }): FlowShares {
	const warnings: string[] = [];
	const share = new Float64Array(nodes.length);
	// In node-id order, as the engines that applied them summed them.
	const farms = nodes
		.map((n, i) => ({ n, i }))
		.filter((x) => x.n.kind === 'farm')
		.sort((a, b) => cmpStr(a.n.id, b.n.id));

	if (method === 'manual') {
		for (const { n, i } of farms) {
			const m = n.flowShareManual ?? null;
			if (m === null) warnings.push(`unit "${n.name}" has no manual flow share; using 0`);
			share[i] = m ?? 0;
		}
	} else if (method === 'hiLo') {
		let sumHi = 0;
		let sumLo = 0;
		for (const { n } of farms) {
			sumHi += n.areaHiKm2 ?? 0;
			sumLo += n.areaLoKm2 ?? 0;
		}
		for (const { n, i } of farms) {
			share[i] = (sumHi > 0 ? ((n.areaHiKm2 ?? 0) / sumHi) * hiLoSplit.hi : 0) + (sumLo > 0 ? ((n.areaLoKm2 ?? 0) / sumLo) * hiLoSplit.lo : 0);
		}
		if (sumHi === 0 || sumLo === 0) warnings.push('hi/lo flow shares: total high or low MAP area is 0');
	} else {
		let sum = 0;
		for (const { n } of farms) sum += n.areaKm2;
		for (const { n, i } of farms) share[i] = sum > 0 ? n.areaKm2 / sum : 0;
		if (sum === 0 && farms.length > 0) warnings.push('area flow shares: total unit area is 0');
	}

	let sum = 0;
	for (const { i } of farms) sum += share[i]!;
	return { share, sum, warnings };
}

/**
 * Why a run with these shares couldn't be relied on, or null. Shares summing to more than 100 % made the farms
 * generate more runoff than the catchment's natural flow: water from nowhere, which lifted the outflow and hid EWR
 * failures while every self-check still closed.
 */
export function overAllocationError(sum: number): string | null {
	if (sum - 1 < SHARE_TOLERANCE) return null;
	return `unit flow shares sum to ${(sum * 100).toFixed(2)}%, more than 100%: the units generated more water than the catchment's natural flow`;
}

/**
 * The shares an older run's stored input applied, with the settings' defaults filled in the way those engines
 * filled them (area; a 50/50 high/low split); null when the input names no flow-share method, as every input
 * from engine 1.105.0 on (its shares add up to 1 by construction).
 */
export function inputFlowShares(input: { model: { nodes: readonly LegacyNode[] }; settings: object }): FlowShares | null {
	const raw = input.settings as Record<string, unknown>;
	if (raw.flowShareMethod === undefined) return null;
	const method = ['area', 'hiLo', 'manual'].includes(String(raw.flowShareMethod)) ? (raw.flowShareMethod as FlowShareMethod) : 'area';
	return flowShares(input.model.nodes, method, { hi: 0.5, lo: 0.5, ...((raw.hiLoSplit as object | undefined) ?? {}) });
}
