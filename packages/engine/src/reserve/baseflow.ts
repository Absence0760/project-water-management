// Base flow of a daily flow series (engine ≥ 1.3.0, issue #64; docs/model.md
// §2.9d): the Lyne–Hollick recursive digital filter, as South African
// practice applies it to daily flows. Pure: no I/O.
//
// One pass over x (forward, or backward on a reversed series):
//   f_t = α·f_{t−1} + (1 + α)/2 · (x_t − x_{t−1}),  then 0 ≤ f_t ≤ x_t
//   b_t = x_t − f_t
// with f_0 = 0 (Lyne & Hollick 1979). Three passes, forward, backward,
// forward, each filtering the last one's base flow (Nathan & McMahon 1990).
// α = 0.995: the value Smakhtin & Watkins (1997, WRC Report 494/1/97) found
// for daily flows in most South African catchments, and the one Hughes,
// Hannart & Watkins (2003, Water SA 29(1)) build their separation on (the
// international default, α = 0.925 from Nathan & McMahon, gives more quick
// flow). The series is reflected by BASEFLOW_REFLECT_DAYS days at both ends
// before filtering (Ladson et al. 2013), so the first and last days don't
// carry the filter's start-up. Every choice here is pending the hydrologist
// (plan.md question 17).
//
// Causal per month (engine ≥ 1.6.0): the backward pass makes a day's base
// flow depend on the days after it, so filtering the whole record lets a
// flood next month (or days appended to the record) change this month's base
// flow. A month's base flow is therefore filtered over a window that ends on
// its last day: the month and at most BASEFLOW_HISTORY_DAYS days before it,
// reflected at both ends as above (monthBaseflowSum). Nothing after the month
// reaches it, and a model-state snapshot that carries the window's days
// resumes it exactly (../warmstart, docs/model.md §2.9d).

/** Filter parameter (South African daily flows, Smakhtin & Watkins 1997). */
export const BASEFLOW_ALPHA = 0.995;
/** Passes: forward, backward, forward (Nathan & McMahon 1990). */
export const BASEFLOW_PASSES = 3;
/** Days reflected at each end before filtering (Ladson et al. 2013). */
export const BASEFLOW_REFLECT_DAYS = 30;
/**
 * Days of record before a month that its base flow is filtered over
 * (engine ≥ 1.6.0). Two years: on a 30-year synthetic record a longer
 * window gave the same month sums to the bit as the whole record up to the
 * month's end (the clamp at 0 forgets the filter's state on each
 * recession), where one year moved them by up to 2.5 %.
 */
export const BASEFLOW_HISTORY_DAYS = 730;

/**
 * Daily base flow of `flow` (any unit, ≥ 0 by construction: a non-finite or
 * negative day counts as 0). Every day 0 ≤ base flow ≤ flow; a constant
 * series is all base flow.
 */
export function lyneHollickBaseflow(
	flow: ArrayLike<number>,
	alpha: number = BASEFLOW_ALPHA,
	passes: number = BASEFLOW_PASSES,
	reflect: number = BASEFLOW_REFLECT_DAYS
): Float64Array {
	const n = flow.length;
	if (n === 0) return new Float64Array(0);
	const q = Float64Array.from({ length: n }, (_, t) => {
		const v = flow[t]!;
		return Number.isFinite(v) && v > 0 ? v : 0;
	});
	const r = Math.max(0, Math.min(reflect, n - 1));
	// [q_r … q_1, q_0 … q_{n−1}, q_{n−2} … q_{n−1−r}]
	const x = new Float64Array(n + 2 * r);
	for (let i = 0; i < r; i++) x[i] = q[r - i]!;
	x.set(q, r);
	for (let i = 0; i < r; i++) x[r + n + i] = q[n - 2 - i]!;
	const c = (1 + alpha) / 2;
	for (let p = 0; p < passes; p++) {
		const forward = p % 2 === 0;
		const len = x.length;
		let f = 0;
		let prev = x[forward ? 0 : len - 1]!;
		for (let k = 0; k < len; k++) {
			const i = forward ? k : len - 1 - k;
			const v = x[i]!;
			if (k > 0) f = alpha * f + c * (v - prev);
			if (f < 0) f = 0;
			else if (f > v) f = v;
			prev = v;
			x[i] = v - f;
		}
	}
	return x.slice(r, r + n);
}

/**
 * A month's base flow, causally (engine ≥ 1.6.0): `window` is the month's
 * daily flow preceded by the days of record before it (at most
 * BASEFLOW_HISTORY_DAYS), and the result is the base flow of its last
 * `days` days, filtered over the window alone (reflected at both ends as
 * lyneHollickBaseflow does) and summed oldest first. It depends on nothing
 * after the month's last day.
 */
export function monthBaseflowSum(window: ArrayLike<number>, days: number): number {
	if (days < 0 || days > window.length) throw new RangeError(`a ${days}-day month does not fit a ${window.length}-day window`);
	const b = lyneHollickBaseflow(window);
	let sum = 0;
	for (let t = window.length - days; t < window.length; t++) sum += b[t]!;
	return sum;
}
