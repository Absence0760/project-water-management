// Empirical quantile mapping of wet-day rain (engine ≥ 1.20.0, issue #66,
// docs/model.md §2.4e *Daily intensity*, calibration-research.md §4 and
// CR-23).
//
// Pure and self-contained, so the same mapper can serve a rain-source
// period's replacement gauge (rainSourcePeriods.ts, today's only caller) and,
// later, CHIRPS against the catchment record (CR-23, docs/followups.md).
//
// A sample is summarised as a quantile table: QUANTILE_POINTS values at
// non-exceedance probabilities 0, 1/(N−1), …, 1, read from the sorted sample
// by linear interpolation between order statistics. A value is mapped by
// finding its probability in the source table (the middle of a flat run for a
// tie, clamped to 0 or 1 outside the table) and reading the target table at
// that probability. Tables of a fixed size keep a pinned fit (a warm-start
// snapshot, ./warmstart) small whatever the sample size.

/** Points in a quantile table: every percentile, min and max included. */
export const QUANTILE_POINTS = 101;

/** The sample's quantile table (ascending), or null for an empty sample. Non-finite values are left out. */
export function quantileTable(sample: readonly number[], points = QUANTILE_POINTS): number[] | null {
	const xs = sample.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
	if (!xs.length || points < 2) return null;
	const n = xs.length;
	return Array.from({ length: points }, (_, k) => {
		const r = (k / (points - 1)) * (n - 1);
		const i = Math.floor(r);
		const f = r - i;
		return i + 1 < n ? xs[i]! + f * (xs[i + 1]! - xs[i]!) : xs[i]!;
	});
}

/** Where `x` sits in an ascending table, as a fractional index 0 … length − 1. */
function position(table: readonly number[], x: number): number {
	const last = table.length - 1;
	if (x <= table[0]!) {
		// A tie with the bottom of the table: the middle of its flat run.
		let hi = 0;
		while (hi < last && table[hi + 1]! <= x) hi++;
		return x < table[0]! ? 0 : hi / 2;
	}
	if (x >= table[last]!) {
		let lo = last;
		while (lo > 0 && table[lo - 1]! >= x) lo--;
		return x > table[last]! ? last : (lo + last) / 2;
	}
	let lo = 0;
	while (table[lo]! < x) lo++;
	// table[lo] ≥ x > table[lo − 1]
	if (table[lo] === x) {
		let hi = lo;
		while (hi < last && table[hi + 1] === x) hi++;
		return (lo + hi) / 2;
	}
	const a = table[lo - 1]!;
	const b = table[lo]!;
	return lo - 1 + (x - a) / (b - a);
}

/** The value of an ascending table at a fractional index. */
function at(table: readonly number[], pos: number): number {
	const i = Math.floor(pos);
	const f = pos - i;
	return i + 1 < table.length ? table[i]! + f * (table[i + 1]! - table[i]!) : table[table.length - 1]!;
}

/**
 * Map `x` from the `source` distribution onto the `target` one (both quantile
 * tables of the same length): target quantile at x's non-exceedance
 * probability in the source. Monotone non-decreasing in x.
 */
export function quantileMapValue(source: readonly number[], target: readonly number[], x: number): number {
	if (source.length !== target.length || source.length < 2) throw new RangeError('quantile tables must have the same length (≥ 2)');
	return at(target, position(source, x));
}

/**
 * Wet-day quantile mapping of one group of days (a month, or pooled months)
 * with totals kept: each wet value (≥ `wetDayMm`) is mapped from `source` to
 * `target`; a dry value is left as it is. The caller then rescales each
 * block whose total must hold (rescaleToTotal).
 */
export const mapWetDay = (source: readonly number[], target: readonly number[], x: number, wetDayMm: number): number =>
	x >= wetDayMm ? quantileMapValue(source, target, x) : x;

/**
 * Scale `mapped` so it sums to `total` (the block's total before mapping):
 * the mapping moves rain between days, never adds or removes it. A block
 * whose mapped total is 0 while `total` isn't can't be scaled and keeps
 * `fallback` (the unmapped values). Returns new arrays; the inputs stay.
 */
export function rescaleToTotal(mapped: readonly number[], fallback: readonly number[], total: number): { values: number[]; kept: boolean } {
	const sum = mapped.reduce((s, x) => s + x, 0);
	if (total === 0) return { values: mapped.map(() => 0), kept: false };
	if (!(sum > 0)) return { values: [...fallback], kept: true };
	const k = total / sum;
	return { values: mapped.map((x) => x * k), kept: false };
}

/** Share of `values`' total that fell on days of at least `heavyMm` (0 … 1), or null with no rain. */
export function heavyDayShare(values: Iterable<number>, heavyMm: number): { share: number | null; totalMm: number; heavyTotalMm: number; heavyDays: number } {
	let total = 0;
	let heavy = 0;
	let heavyDays = 0;
	for (const v of values) {
		if (!(v > 0)) continue;
		total += v;
		if (v >= heavyMm) {
			heavy += v;
			heavyDays++;
		}
	}
	return { share: total > 0 ? heavy / total : null, totalMm: total, heavyTotalMm: heavy, heavyDays };
}
