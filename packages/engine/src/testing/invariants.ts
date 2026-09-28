// Invariants that re-run the model (order invariance, doubled crop areas,
// determinism). The per-run checks live in ../verify/checks.ts, which runModel
// itself runs; they are re-exported here for the tests. See docs/model.md §6
// "Verification".
import type { ModelInput, ModelOutput } from '../project';
import { runModel } from '../run';
import { checkInvariants } from '../verify/checks';
import { stressClassOf } from '../network/reliability';
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
			const isVolume = /M3|Mm3/.test(k) || k.endsWith('Ls');
			const ofDemand = (k.startsWith('fraction') || k.endsWith('Fraction')) && demand > 0 && Number.isFinite(demand);
			const d = sameValue(ra[k], rb[k], `${path}.${k}`, isVolume ? volume : ofDemand ? volume / demand : scale, volume);
			if (d) return d;
		}
		return null;
	}
	return a === b ? null : `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

/** Two daily series, value for value to the last bit (NaN equals NaN; so do 0 and −0). */
function sameBits(a: ArrayLike<number> | undefined, b: ArrayLike<number> | undefined, path: string): string | null {
	if (!a || !b) return a === b ? null : `${path}: missing in one run`;
	if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
	for (let t = 0; t < a.length; t++) {
		const p = a[t]!;
		const q = b[t]!;
		if (p !== q && !(Number.isNaN(p) && Number.isNaN(q))) return `${path}[${t}]: ${p} vs ${q}`;
	}
	return null;
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
			supplyAssurance: s.supplyAssurance && {
				...s.supplyAssurance,
				reliability: byNode(s.supplyAssurance.reliability),
				stress: { ...s.supplyAssurance.stress, nodes: byNode(s.supplyAssurance.stress.nodes) }
			},
			dataQuality: s.dataQuality && { ...s.dataQuality, areaMismatches: s.dataQuality.areaMismatches && byNode(s.dataQuality.areaMismatches) },
			// Warnings name elements in input order; compare them as a multiset of
			// sentences with the name lists sorted.
			warnings: s.warnings.map(sortNameLists).sort()
		}
	};
}
// A name may carry its own parentheses ("Farm (upper)"), one level deep.
const sortNameLists = (w: string) =>
	w.replace(/\(((?:[^()]|\([^()]*\))*;(?:[^()]|\([^()]*\))*)\)/g, (_, inner: string) => `(${inner.split('; ').sort().join('; ')})`);

/**
 * Display order must not matter: the node array and every sortOrder, the crop
 * list, the crop-area rows, the transfer rules, the land-cover patches and the
 * EWR rule tables give the same results.
 * Transfer rules run by their priority, and rules of equal priority share a
 * dam pro rata (engine ≥ 0.16.0, docs/model.md Q18), so shuffling them is
 * no exception any more.
 *
 * Every daily series must be identical to the last bit (engine ≥ 0.26.1):
 * every sum that feeds the balance runs in id order (../order.ts), so a list
 * order can't even change float noise. It has to be exact, not within noise,
 * because the balance has thresholds that turn one ulp into a real
 * difference: a dam sitting exactly at its drought-borehole trigger pumped
 * 116 938 m³ in one order and nothing in the other (fuzz seed 3899), and a
 * dam that ran dry in one order kept a residue in the other, whose area–
 * storage power then gave it a surface (seeds 5703, 15208). The summary
 * (window means, totals over farms in list order) is compared within float
 * noise, as before.
 */
export function checkOrderInvariance(input: ModelInput, out: ModelOutput, seed: number): string | null {
	const x = scrambleOrder(input, seed);
	let y: ModelOutput;
	try {
		y = runModel(x);
	} catch (e) {
		return `order invariance: scrambled input threw ${(e as Error).message}`;
	}
	// The summary's volumes are of the same catchment, so their common scale is
	// the largest magnitude in any series of either run.
	let scale = 1;
	for (const o of [out, y]) for (const s of o.series) for (const v of s.values) if (Number.isFinite(v)) scale = Math.max(scale, Math.abs(v));
	const ca = canonical(out);
	const cb = canonical(y);
	let d: string | null = null;
	for (const k of new Set([...Object.keys(ca.series), ...Object.keys(cb.series)])) {
		d ??= sameBits(ca.series[k]?.values, cb.series[k]?.values, `series ${k}`);
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
 * Dam evaporation, rain on the dam and seepage stay on: a lower dam has a
 * smaller surface and loses (and catches) less, but never so much less that
 * it ends the day with more water, so they keep the law. (Seeds 4197, 7686,
 * 15979 and 17277 broke it until engine 0.21.1, when the daily step did let
 * a fuller, very shallow dam with b > 1 end the day emptier; fixed in the
 * engine, network/simulate.ts damDay, not here.)
 * Demand is not rounded (R1), so it doubles exactly and the only slack is
 * float noise. That noise is absolute, in the volumes a farm's daily supply
 * is worked out from (its dam storage, inflows, top-ups), not relative to
 * its demand, so it does not double with the demand and the fraction it
 * leaves shrinks as the demand grows: the check allows each fraction a few
 * ulps of the farm's largest volume over its mean demand (`noiseOf`), like
 * order invariance's volume / demand scale. Fuzz seed 1774 (engine 1.3.0):
 * n14's dam seeps its whole content every day and a supplemental borehole
 * that pumps into it tops it up to dead storage + demand (≈ 2.19e5 m³), so
 * `avail + gd − dead` gives back the demand only to an ulp of 2.19e5
 * (2.9e-11 m³). Every short day was such a top-up, none short by more than
 * 1.49 ulp; Σ(D − G) ≈ 2.1e-9 m³ in both runs over Σ D = 639 then 1278 m³,
 * so 1 − fraction went 3.6e-12 → 1.6e-12 and the fraction "rose" 2e-12.
 */
export function checkDoubledCropAreas(input: ModelInput): string | null {
	const base = cloneInput(input);
	for (const n of base.model.nodes) n.lossReturnFraction = 0;
	// Demand objects' returns (engine ≥ 1.7.0) likewise: a return from stored water helps the farms below today.
	for (const o of base.model.demandObjects ?? []) o.returnPct = 0;
	// An allocation mode (engine ≥ 1.18.0) is taken off: a full allocation scales every allocated unit's demand
	// back to its registered volume (a fixed demand beside a growing one, as above), and a cap ties supply to the
	// volume, not the demand, so neither keeps the property. The allocations themselves stay (they only compare).
	base.settings.allocationMode = 'none';
	const x = cloneInput(base);
	for (const a of x.model.cropAreas) a.areaM2 *= 2;
	// Demand objects (engine ≥ 1.7.0) double with the crops: a fixed demand beside a growing one can raise a
	// farm's whole-run supply fraction legitimately (more demand on days fully met, the same on days short), so
	// the property is about doubling every demand the model holds. Priority classes and pro-rata splits are
	// scale-free, so doubling them all changes no one's share.
	for (const o of x.model.demandObjects ?? []) {
		if (o.monthlyM3Day) o.monthlyM3Day = o.monthlyM3Day.map((v) => v * 2);
		if (o.count !== null) o.count *= 2;
	}
	let o1: ModelOutput;
	let o2: ModelOutput;
	try {
		o1 = runModel(base);
		o2 = runModel(x);
	} catch (e) {
		return `doubled crop areas threw ${(e as Error).message}`;
	}
	const slack = 1e-12;
	// Each node's largest volume in either run, the scale of its supply's float noise.
	const volume = new Map<string, number>();
	for (const o of [o1, o2])
		for (const s of o.series) {
			if (s.nodeId === null) continue;
			let m = volume.get(s.nodeId) ?? 0;
			for (const v of s.values) if (Number.isFinite(v)) m = Math.max(m, Math.abs(v));
			volume.set(s.nodeId, m);
		}
	/** A few ulps (ε = 2⁻⁵²) of that volume per day, as a fraction of a mean daily demand; never below `slack`. */
	const noiseOf = (v: number, demand: number) => Math.max(slack, (4 * Number.EPSILON * v) / demand);
	const before = new Map(o1.summary.farms.map((f) => [f.nodeId, f]));
	const noise = new Map<string, number>();
	for (const f2 of o2.summary.farms) {
		const f1 = before.get(f2.nodeId)!;
		if (!(f1.avgDemandM3Day > 0)) continue;
		const tol = noiseOf(volume.get(f2.nodeId) ?? 0, f1.avgDemandM3Day);
		noise.set(f2.nodeId, tol);
		if (f2.fractionSupplied > f1.fractionSupplied + tol)
			return `doubling crop areas raised ${f2.nodeId}'s supply fraction ${f1.fractionSupplied} → ${f2.fractionSupplied}`;
	}
	// Nor any reliability metric (WP-3.4): time-based, volumetric, annual.
	const rel = new Map((o1.summary.supplyAssurance?.reliability ?? []).map((r) => [r.nodeId, r]));
	for (const r2 of o2.summary.supplyAssurance?.reliability ?? []) {
		const r1 = rel.get(r2.nodeId);
		if (!r1 || r1.kind !== 'farm') continue;
		for (const k of ['timeReliability', 'volumetricReliability', 'annualReliability'] as const) {
			const a = r1[k];
			const b = r2[k];
			// Volumetric reliability is Σ supplied / Σ demand, the supply fraction's noise; the others count days or years.
			const tol = k === 'volumetricReliability' ? (noise.get(r2.nodeId) ?? slack) : slack;
			if (a !== null && b !== null && b > a + tol) return `doubling crop areas raised ${r2.nodeId}'s ${k} ${a} → ${b}`;
		}
	}
	const tot = (o: ModelOutput) => o.summary.farms.reduce((s, f) => [s[0]! + f.avgDemandM3Day, s[1]! + f.avgSuppliedM3Day], [0, 0]);
	const [d1, s1] = tot(o1);
	const [d2, s2] = tot(o2);
	if (!(d1! > 0) || !(d2! > 0)) return null;
	const c1 = s1! / d1!;
	const c2 = s2! / d2!;
	let v = 0;
	for (const f of o1.summary.farms) v += volume.get(f.nodeId) ?? 0;
	return c2 > c1 + noiseOf(v, d1!) ? `doubling crop areas raised the catchment supply fraction ${c1} → ${c2}` : null;
}

/**
 * The same model with every drought borehole rule (WP-1.34) run as
 * supplemental, for checkDoubledCropAreas. A drought rule pumps only while the
 * dam is low, so more demand, which empties the dam sooner, switches the
 * boreholes on earlier and can raise the supply fraction legitimately (fuzz
 * seed 4623, GR4J: n24 0.963 → 0.978; seed 1450 before the generator drew EWR rule tables). The property is a law of the rest of
 * the network, so it is checked with the trigger taken out. The trigger
 * supply rule (WP-3.8) switches to the river the same way, so it runs as
 * river first here. A borehole's annual cap (WP-3.9) is taken off too: more
 * demand uses the cap up earlier in the water year, which moves the pumping,
 * and the stream depletion it causes, earlier in time, so a farm downstream
 * can get more of the river on the days it needs it (fuzz seed 2909, found by
 * the 20 000-case soak: the lagged depletion of n2's capped borehole fell on
 * the days n1's full-level dam needed topping up, and n1's time reliability
 * rose 1/70 → 3/70). The caps themselves are checked by the groundwater
 * self-check (checkGroundwater).
 */
export function droughtBoreholesAsSupplemental(input: ModelInput): ModelInput {
	const x = cloneInput(input);
	for (const n of x.model.nodes) if (n.boreholeRule === 'drought') n.boreholeRule = 'supplemental';
	// Individual boreholes (WP-3.9): emergency mode triggers on the dam the same way.
	for (const b of x.model.boreholes ?? []) if (b.mode === 'emergency') b.mode = 'supplemental';
	for (const n of x.model.nodes) if (n.supplyRule === 'trigger') n.supplyRule = 'riverFirst';
	for (const b of x.model.boreholes ?? []) b.annualCapM3 = null;
	return x;
}

/** runModel + every invariant, including the ones that re-run the model. */
/**
 * Two runs gave the same output, to the bit: every series value compared with
 * Object.is (NaN equals NaN, 0 and −0 differ), the rest through JSON. Stricter
 * than comparing JSON.stringify of the whole output (which folds NaN into
 * null and −0 into 0), and it doesn't serialise hundreds of thousands of
 * daily values twice per fuzz case: that cost as much as the run itself.
 */
export function sameOutput(a: ModelOutput, b: ModelOutput): boolean {
	if (a.engineVersion !== b.engineVersion || a.startDate !== b.startDate || a.endDate !== b.endDate || a.days !== b.days) return false;
	if (a.series.length !== b.series.length) return false;
	for (let i = 0; i < a.series.length; i++) {
		const x = a.series[i]!;
		const y = b.series[i]!;
		if (x.nodeId !== y.nodeId || x.key !== y.key || x.label !== y.label || x.unit !== y.unit || x.values.length !== y.values.length) return false;
		for (let t = 0; t < x.values.length; t++) if (!Object.is(x.values[t], y.values[t])) return false;
	}
	return JSON.stringify(a.summary) === JSON.stringify(b.summary);
}

export function checkAll(input: ModelInput, seed = 1): string | null {
	let out: ModelOutput;
	try {
		out = runModel(input);
	} catch (e) {
		return `threw: ${(e as Error).message}`;
	}
	const bad = checkInvariants(input, out) ?? checkReliability(out) ?? checkWaterAccount(out);
	if (bad) return bad;
	if (!sameOutput(runModel(input), out)) return 'not deterministic';
	return checkOrderInvariance(input, out, seed) ?? checkDoubledCropAreas(droughtBoreholesAsSupplemental(input));
}

/**
 * Assurance of supply (WP-3.4, ../network/reliability.ts) agrees with the rest
 * of the summary: every metric is a fraction in [0, 1]; a farm's volumetric
 * reliability is the curtailment table's supplied ÷ demand over the same
 * window; time-based reliability is 1 exactly when no demand day fell short;
 * the months add up to the whole; and each stress class matches its ratio.
 */
export function checkReliability(out: ModelOutput): string | null {
	const a = out.summary.supplyAssurance;
	if (!a) return 'supplyAssurance missing';
	const cur = new Map((out.summary.curtailment?.farms ?? []).map((f) => [f.nodeId, f]));
	const get = new Map(out.series.map((s) => [`${s.nodeId}|${s.key}`, s.values]));
	const d0 = Math.round(Date.parse(`${out.startDate}T00:00:00Z`) / 86_400_000);
	const from = Math.round(Date.parse(`${a.reportStart}T00:00:00Z`) / 86_400_000) - d0;
	const to = from + a.days - 1;
	const inUnit = (v: number | null) => v === null || (v >= 0 && v <= 1 + 1e-12);
	for (const r of a.reliability) {
		for (const k of ['timeReliability', 'volumetricReliability', 'annualReliability'] as const)
			if (!inUnit(r[k])) return `reliability ${r.nodeId} ${k} = ${r[k]} outside [0, 1]`;
		const c = cur.get(r.nodeId);
		if (r.kind === 'farm') {
			if (!c) return `reliability ${r.nodeId} has no curtailment row`;
			const v = c.demandM3Day > 0 ? c.suppliedM3Day / c.demandM3Day : null;
			if ((v === null) !== (r.volumetricReliability === null) || (v !== null && Math.abs(v - r.volumetricReliability!) > 1e-9))
				return `reliability ${r.nodeId}: volumetric ${r.volumetricReliability} ≠ curtailment ΣI/ΣH ${v}`;
		}
		const D = get.get(`${r.nodeId}|demand`);
		const G = get.get(`${r.nodeId}|supplied`);
		if (!D || !G) return `reliability ${r.nodeId}: no demand/supplied series`;
		let short = false;
		for (let t = from; t <= to; t++) if (D[t]! > 0 && D[t]! - G[t]! > 1e-9 * D[t]!) short = true;
		if ((r.timeReliability === 1) === short && r.timeReliability !== null)
			return `reliability ${r.nodeId}: time reliability ${r.timeReliability} but ${short ? 'a' : 'no'} demand day fell short`;
		if (r.metDays > r.demandDays) return `reliability ${r.nodeId}: met days ${r.metDays} > demand days ${r.demandDays}`;
		const md = r.months.reduce((s, m) => s + m.demandDays, 0);
		const mm = r.months.reduce((s, m) => s + m.metDays, 0);
		if (md !== r.demandDays || mm !== r.metDays) return `reliability ${r.nodeId}: months sum to ${mm}/${md} days, not ${r.metDays}/${r.demandDays}`;
		if ((r.failureRuns === 0) !== (r.metDays === r.demandDays)) return `reliability ${r.nodeId}: ${r.failureRuns} failure runs with ${r.demandDays - r.metDays} failed days`;
		if (r.waterYearsMet > r.waterYears) return `reliability ${r.nodeId}: ${r.waterYearsMet} of ${r.waterYears} water years met`;
	}
	for (const g of [a.stress.system, ...a.stress.nodes]) {
		for (let i = 0; i < g.ratio.length; i++)
			for (let j = 0; j < 12; j++) {
				const x = g.ratio[i]![j]!;
				if (!inUnit(x)) return `stress ${g.name} ratio ${x} outside [0, 1]`;
				if (stressClassOf(x) !== g.stressClass[i]![j]) return `stress ${g.name}: class ${g.stressClass[i]![j]} for ratio ${x}`;
			}
	}
	return null;
}

/**
 * The water account (WP-3.4) closes: in − out − Δ storage is float noise
 * (≤ 1e-10 of Σ|terms|) in every water year and over the run, the years add
 * up to the run, and at each EWR site 0 ≤ met ≤ required.
 */
export function checkWaterAccount(out: ModelOutput): string | null {
	const w = out.summary.supplyAssurance?.waterAccount;
	if (!w) return 'waterAccount missing';
	for (const r of [...w.years, w.total]) {
		const at = r.waterYear ?? 'run';
		if (!(Math.abs(r.residualM3) <= 1e-10 * Math.max(r.scaleM3, 1))) return `water account ${at}: residual ${r.residualM3} m³ of ${r.scaleM3}`;
		for (const e of r.ewr) {
			const tol = 1e-9 * Math.max(e.requiredM3, 1);
			if (e.metM3 < -tol || e.metM3 > e.requiredM3 + tol) return `water account ${at}: EWR ${e.name} met ${e.metM3} of ${e.requiredM3}`;
		}
	}
	const days = w.years.reduce((s, r) => s + r.days, 0);
	if (days !== w.total.days) return `water account: years cover ${days} days, run ${w.total.days}`;
	const sum = (k: 'naturalFlowM3' | 'outflowM3' | 'consumptiveIrrigationM3') => w.years.reduce((s, r) => s + r[k], 0);
	for (const k of ['naturalFlowM3', 'outflowM3', 'consumptiveIrrigationM3'] as const) {
		if (Math.abs(sum(k) - w.total[k]) > 1e-9 * Math.max(w.total.scaleM3, 1)) return `water account: years' ${k} ${sum(k)} ≠ run ${w.total[k]}`;
	}
	for (let i = 1; i < w.years.length; i++) {
		if (w.years[i]!.openingStorageM3 !== w.years[i - 1]!.closingStorageM3) return `water account ${w.years[i]!.waterYear}: opening storage ≠ last year's closing`;
	}
	return null;
}
