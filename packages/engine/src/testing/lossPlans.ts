// Test helpers: a reach's bed losses and a unit's base flow as the plan holds
// them (by calendar month, index 1–12, engine 1.116.0), with one value in
// every month, for tests that build a plan or call the day functions directly.
import type { PlanBaseflow } from '../network/baseflow';
import type { PlanReachLoss } from '../network/reachLoss';

function months(v: number): Float64Array {
	const a = new Float64Array(13).fill(v);
	a[0] = 0;
	return a;
}

/** A reach losing the share `frac` up to `cap` m³/day (Infinity = none) in every month. */
export function reachAllYear(frac: number, cap: number): PlanReachLoss {
	return { frac: months(frac), maxM3Day: months(cap) };
}

/** A unit losing up to `loss` and gaining `gain` m³/day in every month. */
export function baseflowAllYear(loss: number, gain: number): PlanBaseflow {
	return { lossM3Day: months(loss), gainM3Day: months(gain), loses: loss > 0, gains: gain > 0 };
}
