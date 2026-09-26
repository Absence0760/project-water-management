// Invariants every conceptual runoff model must satisfy (issue #4 §4), stated
// on the model alone (rain and PET in, mm out), so each new model inherits
// them. Each check returns the first broken property as text, or null.
// Run by ../runoff/runoff.invariants.test.ts across random parameters and
// forcing; the run-level balance (a whole ModelOutput) is checkRunoffBalance
// in ./invariants.ts.
import type { RunoffForcing } from '../runoff/simulate';
import type { DayFluxes, ParamSpec, RunoffModel } from '../runoff/types';
import type { Rng } from './fuzz';

const tol = (x: number) => 1e-9 + 1e-12 * Math.abs(x);

/** Random parameters inside each spec's bounds (log-uniform where the range spans decades). */
export function randomParams<P>(rng: Rng, specs: ParamSpec<P>[], opts: { freeFixed?: boolean } = {}): P {
	const out: Record<string, number> = {};
	for (const s of specs) {
		if (s.fixedByDefault && !opts.freeFixed) out[s.key] = s.default;
		else if (s.min > 0 && s.max / s.min > 20) out[s.key] = rng.logFloat(s.min, s.max);
		else out[s.key] = rng.float(s.min, s.max);
	}
	return out as P;
}

/** Daily rain with dry spells, storms and the odd huge event; seasonal PET, sometimes none. */
export function randomForcing(rng: Rng, days: number): RunoffForcing {
	const rainMm = new Float64Array(days);
	const petMm = new Float64Array(days);
	const pWet = rng.pick([0.05, 0.2, 0.5]);
	const petMean = rng.pick([0, 1, 3, 6, 10]);
	const phase = rng.float(0, 2 * Math.PI);
	for (let t = 0; t < days; t++) {
		if (rng.bool(pWet)) rainMm[t] = rng.bool(0.01) ? rng.float(150, 600) : rng.logFloat(0.1, 80);
		petMm[t] = Math.max(0, petMean * (1 + 0.6 * Math.sin((2 * Math.PI * t) / 365.25 + phase)));
	}
	return { rainMm, petMm };
}

/**
 * Per-day balance and bounds, then the whole-run balance:
 * - P − AET − Q + exchange = Δ storage every day (all stores and the UH queues);
 * - Q ≥ 0, 0 ≤ AET ≤ PET, every store within [0, capacity];
 * - ΣP = ΣAET + ΣQ + Δstorage − Σexchange, and so ΣQ ≤ ΣP + opening storage
 *   + the water gained through exchange (runoff coefficient ≤ 1 from empty
 *   stores with no import).
 */
export function checkDailyBalance<P, S>(model: RunoffModel<P, S>, p: P, f: RunoffForcing, fill = 0.5): string | null {
	const st = model.init(p, fill);
	const day: DayFluxes = { qMm: 0, aetMm: 0, exchangeMm: 0 };
	const caps = model.capacities(p);
	const stores = new Float64Array(model.stores.length);
	const start = model.storage(st);
	let before = start;
	let sP = 0;
	let sAet = 0;
	let sQ = 0;
	let sEx = 0;
	for (let t = 0; t < f.rainMm.length; t++) {
		const P = f.rainMm[t]!;
		const E = f.petMm[t]!;
		model.step(p, st, P, E, day);
		const after = model.storage(st);
		const where = `${model.id} day ${t}`;
		const lhs = P - day.aetMm - day.qMm + day.exchangeMm;
		if (!(Math.abs(lhs - (after - before)) <= tol(Math.max(before, after, P)))) return `${where}: P − AET − Q + exchange = ${lhs} ≠ Δstorage ${after - before}`;
		if (!(day.qMm >= 0)) return `${where}: Q = ${day.qMm}`;
		if (!(day.aetMm >= 0) || day.aetMm > E + tol(E)) return `${where}: AET ${day.aetMm} outside [0, PET ${E}]`;
		model.readStores(st, stores);
		for (let j = 0; j < stores.length; j++) {
			const cap = caps[j];
			if (stores[j]! < -tol(0) || (cap != null && stores[j]! > cap + tol(cap))) return `${where}: ${model.stores[j]!.key} = ${stores[j]} outside [0, ${cap ?? '∞'}]`;
		}
		sP += P;
		sAet += day.aetMm;
		sQ += day.qMm;
		sEx += day.exchangeMm;
		before = after;
	}
	const scale = sP + sAet + sQ + Math.abs(sEx) + start + before;
	if (Math.abs(sP - (sAet + sQ + (before - start) - sEx)) > 1e-9 * Math.max(1, scale)) return `${model.id}: whole-run balance ΣP ${sP} ≠ ΣAET + ΣQ + Δstorage − Σexchange`;
	if (sQ > sP + start + Math.max(0, sEx) + 1e-9 * Math.max(1, scale)) return `${model.id}: ΣQ ${sQ} > ΣP ${sP} + opening storage ${start} + imported ${Math.max(0, sEx)}`;
	return null;
}

/** Flow (mm/day) a model gives for a rain and PET sequence, from a fixed starting state. */
export type EventRunner = (rainMm: Float64Array, petMm: Float64Array) => Float64Array;

export function modelRunner<P, S>(model: RunoffModel<P, S>, p: P, fill = 0.5): EventRunner {
	return (rain, pet) => {
		const st = model.init(p, fill);
		const day: DayFluxes = { qMm: 0, aetMm: 0, exchangeMm: 0 };
		const q = new Float64Array(rain.length);
		for (let t = 0; t < rain.length; t++) {
			model.step(p, st, rain[t]!, pet[t]!, day);
			q[t] = day.qMm;
		}
		return q;
	};
}

export const EVENT_DEPTHS_MM = [1, 2, 5, 10, 20, 50, 100, 200, 400];

/**
 * The H1 regression. After a year with no rain (a dry catchment), one storm of
 * depth d falls, then two dry years. The storm's own runoff is the flow minus
 * the flow of the same run without the storm. Its runoff coefficient must be
 * ≤ 1 (the storm can't give back more than fell), and must not fall as d rises
 * (wetter soils shed a larger share; the removed legacy b023 model did the
 * opposite, docs/engine-audit.md H1).
 */
export function checkEventScale(run: EventRunner, petMmPerDay = 3): string | null {
	const n = 365 + 1 + 730;
	const pet = new Float64Array(n).fill(petMmPerDay);
	const base = run(new Float64Array(n), pet);
	let prev = -Infinity;
	for (const d of EVENT_DEPTHS_MM) {
		const rain = new Float64Array(n);
		rain[365] = d;
		const q = run(rain, pet);
		let extra = 0;
		for (let t = 0; t < n; t++) extra += q[t]! - base[t]!;
		const c = extra / d;
		if (c > 1 + 1e-9) return `a ${d} mm storm on a dry catchment returns ${c.toFixed(3)}× its rain`;
		if (c < prev - 1e-9) return `event runoff coefficient falls as the storm grows: ${prev.toFixed(4)} → ${c.toFixed(4)} at ${d} mm`;
		prev = c;
	}
	return null;
}

/**
 * More rain on any one day never lowers cumulative flow, and more PET never
 * raises it (at every later day). Holds for a closed model (GR4J with X2 = 0);
 * groundwater export that grows with storage can legitimately break it.
 */
export function checkMonotonicity(run: EventRunner, f: RunoffForcing, rng: Rng): string | null {
	const n = f.rainMm.length;
	if (n === 0) return null;
	const base = run(f.rainMm, f.petMm);
	const d = rng.int(0, n - 1);
	const delta = rng.logFloat(0.01, 100);
	const cmp = (q: Float64Array, sign: 1 | -1, what: string) => {
		let a = 0;
		let b = 0;
		for (let t = 0; t < n; t++) {
			a += base[t]!;
			b += q[t]!;
			if (sign * (b - a) < -(1e-9 + 1e-12 * Math.max(a, b))) return `${what} on day ${d} (+${delta.toFixed(3)} mm) ${sign > 0 ? 'lowered' : 'raised'} cumulative flow by day ${t}: ${a} → ${b}`;
		}
		return null;
	};
	const rain = Float64Array.from(f.rainMm);
	rain[d] = rain[d]! + delta;
	const pet = Float64Array.from(f.petMm);
	pet[d] = pet[d]! + delta;
	return cmp(run(rain, f.petMm), 1, 'more rain') ?? cmp(run(f.rainMm, pet), -1, 'more PET');
}

/**
 * Constant rain and PET: flow converges to P − AET whatever the starting
 * state. Runs from empty and from full stores and compares the last day.
 * Needs P > E. With P ≤ E there is no net input and the stores empty
 * through power-law outflows (percolation ∝ S⁵, routing ∝ R⁵), which approach
 * 0 only algebraically: no fixed horizon reaches a fixed tolerance.
 */
export function checkSteadyState<P, S>(model: RunoffModel<P, S>, p: P, P0: number, E0: number, years = 200): string | null {
	if (!(P0 > E0)) throw new RangeError('checkSteadyState needs P > E');
	const n = Math.round(years * 365.25);
	const last = (fill: number) => {
		const st = model.init(p, fill);
		const day: DayFluxes = { qMm: 0, aetMm: 0, exchangeMm: 0 };
		for (let t = 0; t < n; t++) model.step(p, st, P0, E0, day);
		return { ...day };
	};
	const a = last(0);
	const b = last(1);
	const rel = 1e-6 * Math.max(1, P0);
	if (Math.abs(a.qMm - (P0 - a.aetMm + a.exchangeMm)) > rel) return `${model.id}: steady flow ${a.qMm} ≠ P − AET + exchange = ${P0 - a.aetMm + a.exchangeMm}`;
	if (Math.abs(a.qMm - b.qMm) > rel) return `${model.id}: steady flow depends on the starting state (${a.qMm} from empty, ${b.qMm} from full)`;
	return null;
}
