// Invariants that re-run the model (order invariance, doubled crop areas,
// determinism). The per-run checks live in ../verify/checks.ts, which runModel
// itself runs; they are re-exported here for the tests. See docs/model.md §6
// "Verification".
import type { ModelInput, ModelOutput } from '../project';
import { runModel } from '../run';
import { checkInvariants } from '../verify/checks';
import { cloneInput, scrambleOrder } from './fuzz';

export { checkBalance, checkEwrAttribution, checkInvariants, checkReportTotals, checkRunoffBalance, checkTransferLimits, checkWorkings } from '../verify/checks';

/**
 * Deep equality for two runs of the same model. NaN equals NaN; whole numbers
 * (day counts, water years) must match exactly. Other numbers may differ by
 * float noise, 1e-9 of their scale: summing upstream flows or crop areas in
 * another order changes the last bits, and 1e-7 m³ in a catchment moving
 * 10⁹ m³/day is noise, not a different result. The scale of a volume (a field
 * named …M3…, …Mm3…, …Ls, or a numeric array) is `volume`, the largest volume
 * in either run. A fraction of a farm's demand (fractionSupplied,
 * targetFraction, fractionOfDemandLeft) carries that volume noise divided by
 * the demand, so its scale is volume / demand; any other ratio is compared to
 * 1e-9 of itself.
 */
function sameValue(a: unknown, b: unknown, path: string, scale = 1, volume = 1): string | null {
	if (typeof a === 'number' && typeof b === 'number') {
		if (Number.isNaN(a) && Number.isNaN(b)) return null;
		if (Number.isInteger(a) && Number.isInteger(b)) return a === b ? null : `${path}: ${a} vs ${b}`;
		return Math.abs(a - b) <= 1e-9 * Math.max(scale, Math.abs(a), Math.abs(b)) ? null : `${path}: ${a} vs ${b}`;
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
		for (let i = 0; i < a.length; i++) {
			const d = sameValue(a[i], b[i], `${path}[${i}]`, scale, volume);
			if (d) return d;
		}
		return null;
	}
	if (a && b && typeof a === 'object' && typeof b === 'object') {
		const ra = a as Record<string, unknown>;
		const rb = b as Record<string, unknown>;
		const demand = Math.min(...[ra.demandM3Day, rb.demandM3Day, ra.avgDemandM3Day, rb.avgDemandM3Day].filter((v): v is number => typeof v === 'number').map(Math.abs));
		const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
		for (const k of keys) {
			const isVolume = /M3|Mm3|Ls$/.test(k);
			const ofDemand = /^fraction|Fraction$/.test(k) && demand > 0 && Number.isFinite(demand);
			const d = sameValue(ra[k], rb[k], `${path}.${k}`, isVolume ? volume : ofDemand ? volume / demand : scale, volume);
			if (d) return d;
		}
		return null;
	}
	return a === b ? null : `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

/** The output with every list that follows input order put into a canonical order. */
function canonical(out: ModelOutput) {
	const byNode = <T extends { nodeId: string | null }>(xs: T[]) => [...xs].sort((p, q) => String(p.nodeId).localeCompare(String(q.nodeId)));
	const s = out.summary;
	return {
		...out,
		series: Object.fromEntries(out.series.map((s) => [`${s.nodeId}|${s.key}`, s])),
		summary: {
			...s,
			farms: byNode(s.farms),
			users: s.users && byNode(s.users),
			curtailment: s.curtailment && { ...s.curtailment, farms: byNode(s.curtailment.farms), otherUsers: s.curtailment.otherUsers && byNode(s.curtailment.otherUsers) },
			ewrCompliance: s.ewrCompliance && { ...s.ewrCompliance, farms: byNode(s.ewrCompliance.farms) },
			dataQuality: s.dataQuality && { ...s.dataQuality, areaMismatches: s.dataQuality.areaMismatches && byNode(s.dataQuality.areaMismatches) },
			// Warnings name elements in input order; compare them as a multiset of
			// sentences with the name lists sorted.
			warnings: s.warnings.map(sortNameLists).sort()
		}
	};
}
const sortNameLists = (w: string) => w.replace(/\(([^()]*;[^()]*)\)/g, (_, inner: string) => `(${inner.split('; ').sort().join('; ')})`);

/**
 * Display order must not matter: the node array and every sortOrder, the crop
 * list, the crop-area rows and the transfer rules give the same results.
 * Transfer rules run by their priority, and rules of equal priority share a
 * dam pro rata (engine ≥ 0.16.0, docs/model.md Q18), so shuffling them is
 * no exception any more.
 */
export function checkOrderInvariance(input: ModelInput, out: ModelOutput, seed: number): string | null {
	const x = scrambleOrder(input, seed);
	let y: ModelOutput;
	try {
		y = runModel(x);
	} catch (e) {
		return `order invariance: scrambled input threw ${(e as Error).message}`;
	}
	// Every series is a volume (or flow) of the same catchment, so their common
	// scale is the largest magnitude in either run: a residue of 1e-7 m³ from
	// cancelling two 10⁹ m³ sums is rounding, whatever series it lands in.
	let scale = 1;
	for (const o of [out, y]) for (const s of o.series) for (const v of s.values) if (Number.isFinite(v)) scale = Math.max(scale, Math.abs(v));
	const ca = canonical(out);
	const cb = canonical(y);
	let d: string | null = null;
	for (const k of new Set([...Object.keys(ca.series), ...Object.keys(cb.series)])) {
		d ??= sameValue(ca.series[k]?.values, cb.series[k]?.values, `series ${k}`, scale, scale);
	}
	d ??= sameValue({ ...ca, series: null }, { ...cb, series: null }, 'output', 1, scale);
	return d ? `order invariance (seed ${seed}): ${d}` : null;
}

/**
 * More irrigated land can't leave anyone better supplied. Doubling every crop
 * area never raises any farm's supply fraction (avg supplied / avg demand), nor
 * the catchment's Σ supplied / Σ demand.
 *
 * This is a law only without return flow, so both runs set every
 * lossReturnFraction to 0 (no losses return; irrigation efficiency stays as it
 * is, audit N1). With return flow it can fail legitimately: a farm that
 * doubles its draw on stored water that would otherwise have stayed in its dam
 * returns part of it to the river, and a starved farm downstream gets more
 * than twice the water (found by the soak, seed 4660: 25.43 % → 25.72 %).
 * Without return flow extra use upstream can only lower the water available
 * downstream on every later day, which is what the property relies on.
 * Demand is not rounded (R1), so it doubles exactly and the only slack is
 * float noise.
 */
export function checkDoubledCropAreas(input: ModelInput): string | null {
	const base = cloneInput(input);
	for (const n of base.model.nodes) n.lossReturnFraction = 0;
	const x = cloneInput(base);
	for (const a of x.model.cropAreas) a.areaM2 *= 2;
	let o1: ModelOutput;
	let o2: ModelOutput;
	try {
		o1 = runModel(base);
		o2 = runModel(x);
	} catch (e) {
		return `doubled crop areas threw ${(e as Error).message}`;
	}
	const slack = 1e-12;
	const before = new Map(o1.summary.farms.map((f) => [f.nodeId, f]));
	for (const f2 of o2.summary.farms) {
		const f1 = before.get(f2.nodeId)!;
		if (!(f1.avgDemandM3Day > 0)) continue;
		if (f2.fractionSupplied > f1.fractionSupplied + slack)
			return `doubling crop areas raised ${f2.nodeId}'s supply fraction ${f1.fractionSupplied} → ${f2.fractionSupplied}`;
	}
	const tot = (o: ModelOutput) => o.summary.farms.reduce((s, f) => [s[0]! + f.avgDemandM3Day, s[1]! + f.avgSuppliedM3Day], [0, 0]);
	const [d1, s1] = tot(o1);
	const [d2, s2] = tot(o2);
	if (!(d1! > 0) || !(d2! > 0)) return null;
	const c1 = s1! / d1!;
	const c2 = s2! / d2!;
	return c2 > c1 + slack ? `doubling crop areas raised the catchment supply fraction ${c1} → ${c2}` : null;
}

/** runModel + every invariant, including the ones that re-run the model. */
export function checkAll(input: ModelInput, seed = 1): string | null {
	let out: ModelOutput;
	try {
		out = runModel(input);
	} catch (e) {
		return `threw: ${(e as Error).message}`;
	}
	const bad = checkInvariants(input, out);
	if (bad) return bad;
	if (JSON.stringify(runModel(input)) !== JSON.stringify(out)) return 'not deterministic';
	return checkOrderInvariance(input, out, seed) ?? checkDoubledCropAreas(input);
}
