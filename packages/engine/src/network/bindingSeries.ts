// The stored binding EWR site (engine ≥ 1.5.0, followups "The binding EWR
// site is recomputed, not stored"): which EWR site set a farm's charge each
// day (./attribution.ts `binding`), kept as a run series so a saved run's
// projection (views/farmProjection.ts) reads it instead of re-running the
// attribution on the stored flows. The recompute can't be exact when the
// transfer rules form a loop; the stored series always is.
//
// Compact on purpose: a series only for a farm upstream of two or more EWR
// sites. For any other farm the binding site follows from the charge alone
// (the one site below it on a charged day, none otherwise), and the reader
// derives it (bindingFromCharge). A day with no charge is NaN, which the
// database stores as NULL: one bit in the array's null bitmap, not eight
// bytes, so a farm never charged costs about a bit a day. It is stored even
// then, so a run that has the series for every such farm is known to be one
// from engine 1.5.0 on, and one that lacks it is recomputed.
import type { AttributionResult } from './attribution';

export const EWR_BINDING_SERIES = {
	key: 'ewr_binding_site',
	label: 'EWR site that set the charge (index into the run’s EWR sites: 0 = the outlet, then gauges by node id; blank = not charged)',
	unit: 'index'
} as const;

/** The sites (indices into res.sites) whose catchment holds node f. */
export function sitesAbove(res: Pick<AttributionResult, 'sites'>, f: number): number[] {
	const out: number[] = [];
	res.sites.forEach((s, si) => {
		if (s.farms.includes(f)) out.push(si);
	});
	return out;
}

/**
 * Farm f's binding-site series for storing, or null when it needn't be stored
 * (upstream of fewer than two sites).
 */
export function bindingSeries(res: AttributionResult, f: number, days: number): Float64Array | null {
	if (sitesAbove(res, f).length < 2) return null;
	const b = res.binding[f]!;
	const out = new Float64Array(days);
	for (let t = 0; t < days; t++) out[t] = b[t]! >= 0 ? b[t]! : NaN;
	return out;
}

/**
 * The binding series a farm upstream of at most one site has without storing
 * one: that site on every charged day, −1 otherwise. null when the farm is
 * upstream of two or more sites (the run must store it, or be recomputed).
 */
export function bindingFromCharge(charge: ArrayLike<number>, sites: readonly number[]): Int32Array | null {
	if (sites.length > 1) return null;
	const out = new Int32Array(charge.length).fill(-1);
	if (sites.length === 1) for (let t = 0; t < charge.length; t++) if (charge[t]! < 0) out[t] = sites[0]!;
	return out;
}
