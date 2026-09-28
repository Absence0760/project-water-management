// GR4J (modèle du Génie Rural à 4 paramètres Journalier), the daily
// rainfall–runoff model of Perrin, Michel & Andréassian (2003), "Improvement
// of a parsimonious model for streamflow simulation", J. Hydrol. 279:275–289.
// https://doi.org/10.1016/S0022-1694(03)00225-7
//
// Written from the paper's equations as restated in issue #4 §2 (and
// docs/model.md § "Rain to flow: GR4J"). The reference implementation (R
// package airGR) is GPL-2 and this repo is MIT: no code is taken from it.
//
// Stores, all in mm over the catchment:
// - production store S (capacity X1): soil moisture, fed by net rain, emptied
//   by evaporation and percolation;
// - two unit-hydrograph queues: water on its way to the routing store (UH1,
//   90 % of routed water) and to the outlet directly (UH2, 10 %);
// - routing store R (reference capacity X3): the slow, non-linear reservoir.
// X2 exchanges water with groundwater outside the catchment; it is fixed at 0
// by default, which makes the model closed: rain leaves only as evaporation
// or flow, or stays in a store.
import { GR4J_PARAMS, type Gr4jParams } from './params';
import type { DayFluxes, RunoffModel, StoreSpec } from './types';

export interface Gr4jState {
	/** Production store (mm). */
	s: number;
	/** Routing store (mm). */
	r: number;
	/** UH1 queue: q1[k] leaves the queue k days from today. */
	q1: Float64Array;
	/** UH2 queue, likewise. */
	q2: Float64Array;
	/** UH1 / UH2 ordinates (fixed for a run: they depend on X4 only). */
	ord1: Float64Array;
	ord2: Float64Array;
}

/** S-curve of UH1: cumulative share of an input released by time t (days). */
export function sh1(t: number, x4: number): number {
	if (t <= 0) return 0;
	if (t < x4) return (t / x4) ** 2.5;
	return 1;
}

/** S-curve of UH2 (time base 2·X4, symmetric about X4). */
export function sh2(t: number, x4: number): number {
	if (t <= 0) return 0;
	if (t <= x4) return 0.5 * (t / x4) ** 2.5;
	if (t < 2 * x4) return 1 - 0.5 * (2 - t / x4) ** 2.5;
	return 1;
}

/** Ordinates j = 1 … ⌈base⌉ of a unit hydrograph: SH(j) − SH(j − 1). They sum to 1. */
export function uhOrdinates(sh: (t: number, x4: number) => number, x4: number, base: number): Float64Array {
	const n = Math.max(1, Math.ceil(base));
	const out = new Float64Array(n);
	for (let j = 1; j <= n; j++) out[j - 1] = sh(j, x4) - sh(j - 1, x4);
	return out;
}

const STORES: StoreSpec[] = [
	{ key: 'production_store', label: 'Production store (soil moisture)' },
	{ key: 'routing_store', label: 'Routing store' },
	{ key: 'uh_store', label: 'Water in transit (unit hydrographs)' }
];

/** Add `x` spread by `ord` to queue `q`, release today's share and shift the queue a day. */
function convolve(q: Float64Array, ord: Float64Array, x: number): number {
	const n = q.length;
	for (let k = 0; k < n; k++) q[k] = q[k]! + ord[k]! * x;
	const out = q[0]!;
	for (let k = 0; k < n - 1; k++) q[k] = q[k + 1]!;
	q[n - 1] = 0;
	return out;
}

function sum(a: Float64Array): number {
	let t = 0;
	for (let i = 0; i < a.length; i++) t += a[i]!;
	return t;
}

export const gr4j: RunoffModel<Gr4jParams, Gr4jState> = {
	id: 'gr4j',
	params: GR4J_PARAMS,
	stores: STORES,

	init(p, fill = 0.5) {
		const ord1 = uhOrdinates(sh1, p.x4, p.x4);
		const ord2 = uhOrdinates(sh2, p.x4, 2 * p.x4);
		return { s: fill * p.x1, r: fill * p.x3, q1: new Float64Array(ord1.length), q2: new Float64Array(ord2.length), ord1, ord2 };
	},

	step(p, st, P, E, out: DayFluxes) {
		const { x1, x2, x3 } = p;

		// 1. Interception: rain and evaporation cancel first.
		let pn = 0;
		let en = 0;
		if (P >= E) pn = P - E;
		else en = E - P;

		// 2. Production store: part of the net rain fills it, net evaporation empties it.
		let s = st.s;
		let ps = 0;
		let es = 0;
		if (pn > 0) {
			const t = Math.tanh(pn / x1);
			const sr = s / x1;
			ps = (x1 * (1 - sr * sr) * t) / (1 + sr * t);
		}
		if (en > 0) {
			const t = Math.tanh(en / x1);
			const sr = s / x1;
			es = (s * (2 - sr) * t) / (1 + (1 - sr) * t);
		}
		s = s - es + ps;

		// 3. Percolation from the production store.
		const perc = s * (1 - (1 + ((4 * s) / (9 * x1)) ** 4) ** -0.25);
		s -= perc;
		st.s = s;

		// 4–5. Routed water, split 90/10 over the two unit hydrographs.
		const pr = perc + (pn - ps);
		const q9 = convolve(st.q1, st.ord1, 0.9 * pr);
		const q1 = convolve(st.q2, st.ord2, 0.1 * pr);

		// 6. Groundwater exchange, driven by the routing store's level.
		const f = x2 === 0 ? 0 : x2 * (st.r / x3) ** 3.5;

		// 7. Routing store (never below empty: a large export is clipped).
		// 8. Direct flow, with the same exchange (clipped at 0).
		// The exchange reported is the one applied after clipping; with X2 = 0
		// the model is closed and it is exactly 0.
		const r0 = st.r;
		let r: number;
		let qd: number;
		let exchange = 0;
		if (f === 0) {
			r = r0 + q9;
			qd = q1;
		} else {
			r = Math.max(0, r0 + q9 + f);
			qd = Math.max(0, q1 + f);
			exchange = r - r0 - q9 + (qd - q1);
		}
		const qr = r * (1 - (1 + (r / x3) ** 4) ** -0.25);
		st.r = r - qr;

		out.qMm = qr + qd;
		out.aetMm = Math.min(P, E) + es;
		out.exchangeMm = exchange;
	},

	capacities(p) {
		return [p.x1, null, null];
	},

	storage(st) {
		return st.s + st.r + sum(st.q1) + sum(st.q2);
	},

	readStores(st, out) {
		out[0] = st.s;
		out[1] = st.r;
		out[2] = sum(st.q1) + sum(st.q2);
	},

	// [S, R, …UH1 queue, …UH2 queue]; the ordinates follow from X4.
	saveState(st) {
		return [st.s, st.r, ...st.q1, ...st.q2];
	},

	loadState(p, data) {
		const st = gr4j.init(p, 0);
		const n1 = st.q1.length;
		const n2 = st.q2.length;
		if (data.length !== 2 + n1 + n2) throw new Error(`GR4J state has ${data.length} numbers; X4 = ${p.x4} needs ${2 + n1 + n2}`);
		st.s = data[0]!;
		st.r = data[1]!;
		for (let k = 0; k < n1; k++) st.q1[k] = data[2 + k]!;
		for (let k = 0; k < n2; k++) st.q2[k] = data[2 + n1 + k]!;
		return st;
	}
};
