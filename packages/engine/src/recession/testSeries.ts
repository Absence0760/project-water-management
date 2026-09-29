// Synthetic recession records for the recession tests (invented numbers, no
// real catchment): storms, each a wet day with a flow peak, followed by dry
// days on a known recession curve.

export interface SyntheticEvent {
	/** Flow on the storm day, m³/s. */
	peakM3s: number;
	/** Dry days after the storm day. */
	dryDays: number;
}

export interface SyntheticRecord {
	flowM3s: (number | null)[];
	rainMm: (number | null)[];
	/** Index of each storm day. */
	stormDays: number[];
}

/**
 * Storm days (20 mm) each followed by `dryDays` rain-free days whose flow
 * follows `curve(peak, t)` for t = 1 … dryDays days after the storm; the
 * record starts with 3 flat wet days so nothing before the first storm counts.
 */
export function syntheticRecord(events: readonly SyntheticEvent[], curve: (peak: number, t: number) => number): SyntheticRecord {
	const flowM3s: (number | null)[] = [1, 1, 1];
	const rainMm: (number | null)[] = [20, 20, 20];
	const stormDays: number[] = [];
	for (const e of events) {
		stormDays.push(flowM3s.length);
		flowM3s.push(e.peakM3s);
		rainMm.push(20);
		for (let t = 1; t <= e.dryDays; t++) {
			flowM3s.push(curve(e.peakM3s, t));
			rainMm.push(0);
		}
	}
	return { flowM3s, rainMm, stormDays };
}

/** Q(t) = Q0·e^(−k·t): −dQ/dt = k·Q, b = 1. */
export const exponential = (k: number) => (q0: number, t: number) => q0 * Math.exp(-k * t);
/** Q(t) = 1 ÷ (1/Q0 + a·t): −dQ/dt = a·Q², b = 2. */
export const quadratic = (a: number) => (q0: number, t: number) => 1 / (1 / q0 + a * t);
