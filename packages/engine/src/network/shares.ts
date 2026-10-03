// Flow fragmentation — port of b023 [Farm spec] "Selected fragmentation (%)":
// the share of catchment natural flow (and of the pragmatic EWR) each farm's
// own land generates.
import { defaultProjectSettings, type FlowShareMethod, type ModelInput, type NetworkNode } from '../project';
import { cmpStr } from '../order';

/** b023 `rFarmSpec_FragmentationTolerance`: shares must sum to 1 within this. */
export const SHARE_TOLERANCE = 0.0002;

export interface FlowShares {
	/** share[i] for node i (0 for gauges). */
	share: Float64Array;
	sum: number;
	warnings: string[];
}

/**
 * - area:   farm area / Σ farm area
 * - hiLo:   hi/Σhi × split.hi + lo/Σlo × split.lo  (Pitman high/low MAP split)
 * - manual: node.flowShareManual
 * Only farms carry a share; gauges generate no runoff of their own.
 */
export function flowShares(
	nodes: readonly NetworkNode[],
	method: FlowShareMethod,
	hiLoSplit: { hi: number; lo: number }
): FlowShares {
	const warnings: string[] = [];
	const share = new Float64Array(nodes.length);
	// In node-id order: the sums below (Σ area, Σ hi, Σ lo) must not depend on
	// how the nodes are listed. A last-bit difference in a share is enough for
	// a dam that sits exactly at its drought trigger or runs dry to go the
	// other way, a real difference in the results (fuzz seed 3899, WP-1.34).
	const farms = nodes
		.map((n, i) => ({ n, i }))
		.filter((x) => x.n.kind === 'farm')
		.sort((a, b) => cmpStr(a.n.id, b.n.id));

	if (method === 'manual') {
		for (const { n, i } of farms) {
			if (n.flowShareManual === null) warnings.push(`unit "${n.name}" has no manual flow share; using 0`);
			share[i] = n.flowShareManual ?? 0;
		}
	} else if (method === 'hiLo') {
		let sumHi = 0;
		let sumLo = 0;
		for (const { n } of farms) {
			sumHi += n.areaHiKm2;
			sumLo += n.areaLoKm2;
		}
		for (const { n, i } of farms) {
			share[i] =
				(sumHi > 0 ? (n.areaHiKm2 / sumHi) * hiLoSplit.hi : 0) +
				(sumLo > 0 ? (n.areaLoKm2 / sumLo) * hiLoSplit.lo : 0);
		}
		if (sumHi === 0 || sumLo === 0) warnings.push('hi/lo flow shares: total high or low MAP area is 0');
		// A farm area that differs from hi + lo (engine review F7, audit W3) is
		// reported once per run by quality.ts areaMismatches, for every method.
	} else {
		let sum = 0;
		for (const { n } of farms) sum += n.areaKm2;
		for (const { n, i } of farms) share[i] = sum > 0 ? n.areaKm2 / sum : 0;
		if (sum === 0 && farms.length > 0) warnings.push('area flow shares: total unit area is 0');
	}

	let sum = 0;
	for (const { i } of farms) sum += share[i]!;
	// Over 100 % is refused by the run (overAllocationError), so only a shortfall is a warning.
	// A network of gauges alone allocates none of the natural flow either (engine ≥ 1.69.0: it warns too).
	if (1 - sum >= SHARE_TOLERANCE) {
		warnings.push(
			`unit flow shares sum to ${(sum * 100).toFixed(2)}%, not 100% (tolerance ±${SHARE_TOLERANCE * 100}%): ` +
				'natural flow and EWR are not fully allocated to units'
		);
	}
	return { share, sum, warnings };
}

/**
 * Why a run can't go ahead with these shares, or null. Shares summing to more
 * than 100 % make the farms generate more runoff than the catchment's natural
 * flow: water from nowhere, which lifts the outflow and hides EWR failures
 * while every self-check still closes (each checks the balance it is given).
 */
export function overAllocationError(sum: number): string | null {
	if (sum - 1 < SHARE_TOLERANCE) return null;
	return (
		`unit flow shares sum to ${(sum * 100).toFixed(2)}%, more than 100%: the units would generate more water than the catchment's natural flow. ` +
		'Correct the manual flow shares (Network) or the high/low MAP split (Settings) so they add up to 100%'
	);
}

/**
 * The shares a stored or raw input applies, with the settings' defaults filled
 * in the way the run fills them: for checking a run's snapshot after the fact.
 */
export function inputFlowShares(input: { model: Pick<ModelInput['model'], 'nodes'>; settings: object }): FlowShares {
	const d = defaultProjectSettings();
	const raw = input.settings as Record<string, unknown>;
	const method = ['area', 'hiLo', 'manual'].includes(String(raw.flowShareMethod)) ? (raw.flowShareMethod as FlowShareMethod) : d.flowShareMethod;
	return flowShares(input.model.nodes, method, { ...d.hiLoSplit, ...((raw.hiLoSplit as object | undefined) ?? {}) });
}
