// Flow-duration curves: the flow equalled or exceeded a given percentage of
// the time, a standard hydrological view of a daily flow record. The Runs
// tab's FDC chart draws them (frontend runs/RunCharts.svelte), and its
// Q10–Q95 table, the run summary CSV, the .xlsx workbook and the report all
// read that table from fdcPercentileTable here (issue #45), so an export
// carries exactly the numbers the chart shows. A view over a saved run's
// series: not part of runModel, so ENGINE_VERSION doesn't move.

/** Exceedance percentages sampled for plotting: fine at the tails, coarser in the middle. */
export function exceedanceGrid(): number[] {
	// [from, to, step] in thousandths of a percent, integer maths so there are no duplicates.
	const bands: [number, number, number][] = [
		[0, 1000, 50],
		[1000, 5000, 100],
		[5000, 95000, 500],
		[95000, 99000, 100],
		[99000, 100000, 50]
	];
	const out: number[] = [];
	for (const [from, to, step] of bands) for (let p = from; p < to; p += step) out.push(p / 1000);
	out.push(100);
	return out;
}

/** Finite values sorted from highest to lowest (nulls/NaN dropped). */
export function sortedDescending(values: ArrayLike<number | null>): Float64Array {
	const out: number[] = [];
	for (let i = 0; i < values.length; i++) {
		const v = values[i];
		if (v != null && Number.isFinite(v)) out.push(v);
	}
	const a = Float64Array.from(out);
	a.sort();
	a.reverse();
	return a;
}

/**
 * Flow equalled or exceeded `pct` % of the time, by linear interpolation on
 * Weibull plotting positions (rank / (n + 1)). `sortedDesc` from sortedDescending().
 */
export function flowAtExceedance(sortedDesc: Float64Array, pct: number): number | null {
	const n = sortedDesc.length;
	if (n === 0) return null;
	if (n === 1) return sortedDesc[0]!;
	// Rank r (1-based) has exceedance 100·r/(n+1); invert for fractional rank.
	const r = (pct / 100) * (n + 1);
	if (r <= 1) return sortedDesc[0]!;
	if (r >= n) return sortedDesc[n - 1]!;
	const lo = Math.floor(r);
	const f = r - lo;
	return sortedDesc[lo - 1]! * (1 - f) + sortedDesc[lo]! * f;
}

/** FDCs for several series on one shared exceedance axis (for a single chart). */
export function flowDurationCurves(series: ArrayLike<number | null>[], grid = exceedanceGrid()) {
	const sorted = series.map(sortedDescending);
	return {
		x: grid,
		ys: sorted.map((s) => grid.map((p) => flowAtExceedance(s, p)))
	};
}

/** The usual percentile flows: Q10 (high), Q50 (median), Q90/Q95 (low flow). */
export function percentileFlows(values: ArrayLike<number | null>) {
	const s = sortedDescending(values);
	return {
		q10: flowAtExceedance(s, 10),
		q50: flowAtExceedance(s, 50),
		q90: flowAtExceedance(s, 90),
		q95: flowAtExceedance(s, 95),
		n: s.length
	};
}

/**
 * `values` kept only on the days `mask` has a finite value (null elsewhere):
 * so simulated and natural flow can be ranked over exactly the days the gauge
 * read, not the whole run. A curve built from different days than the
 * observed one isn't comparable with it (a gauge covering half the record put
 * simulated Q50 a factor of 3 away from its value on the observed days).
 */
export function onDaysOf(values: ArrayLike<number | null>, mask: ArrayLike<number | null>): (number | null)[] {
	const out: (number | null)[] = new Array(values.length);
	for (let i = 0; i < values.length; i++) {
		const m = i < mask.length ? mask[i] : null;
		out[i] = m != null && Number.isFinite(m) ? (values[i] ?? null) : null;
	}
	return out;
}

/** How many finite values a series has. */
export function finiteCount(values: ArrayLike<number | null>): number {
	let n = 0;
	for (let i = 0; i < values.length; i++) {
		const v = values[i];
		if (v != null && Number.isFinite(v)) n++;
	}
	return n;
}

/** The flow records the FDC chart ranks, in its order (natural, simulated outflow, observed). */
export const FDC_RECORDS = ['natural', 'simulated', 'observed'] as const;
export type FdcRecord = (typeof FDC_RECORDS)[number];

/** One row of the Q10–Q95 table: a record's percentile flows, in the unit its values were given in. */
export interface FdcPercentileRow {
	record: FdcRecord;
	q10: number | null;
	q50: number | null;
	q90: number | null;
	q95: number | null;
	/** Days ranked. */
	n: number;
}

export interface FdcPercentileTable {
	/** Every record over all its own days (the chart's "Whole run"). */
	wholeRun: FdcPercentileRow[];
	/**
	 * Natural and simulated flow ranked on only the days the observed record
	 * read, observed as in wholeRun (the chart's "Observed days", its default):
	 * like with like. Null when that is no different from wholeRun, i.e. with
	 * no observed record or one that reads every day of the run.
	 */
	onObservedDays: FdcPercentileRow[] | null;
	/** Days of the run (the simulated series' length, else natural's). */
	runDays: number;
	/** Days the observed record has a reading. */
	observedDays: number;
}

/**
 * The FDC chart's Q10/Q50/Q90/Q95 table for a run's catchment flows. Values
 * in any one unit (the chart passes m³/s or m³/day, the exports m³/s); a
 * record that is absent is left out.
 */
export function fdcPercentileTable(flows: Partial<Record<FdcRecord, ArrayLike<number | null>>>): FdcPercentileTable {
	const present = FDC_RECORDS.filter((r) => flows[r]);
	const obs = flows.observed ?? null;
	const runDays = flows.simulated?.length ?? flows.natural?.length ?? 0;
	const observedDays = obs ? finiteCount(obs) : 0;
	const row = (record: FdcRecord, values: ArrayLike<number | null>): FdcPercentileRow => ({ record, ...percentileFlows(values) });
	const wholeRun = present.map((r) => row(r, flows[r]!));
	const partial = !!obs && observedDays > 0 && observedDays < runDays;
	const onObservedDays = partial ? wholeRun.map((w) => (w.record === 'observed' ? w : row(w.record, onDaysOf(flows[w.record]!, obs!)))) : null;
	return { wholeRun, onObservedDays, runDays, observedDays };
}

/** A daily series in m³/day as m³/s, gaps (null, NaN) as null: the conversion the Runs tab's charts make (frontend runs/results.ts toDisplayUnit). */
export function m3DayToM3sSeries(values: ArrayLike<number | null>): (number | null)[] {
	const out: (number | null)[] = new Array(values.length);
	for (let i = 0; i < values.length; i++) {
		const v = values[i];
		out[i] = v == null || !Number.isFinite(v) ? null : v / 86_400;
	}
	return out;
}
