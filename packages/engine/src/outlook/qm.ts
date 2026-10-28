// Empirical quantile mapping of monthly rain totals (issue #620 step 6,
// docs/model.md §2.15d): a forecast system's monthly totals mapped onto the
// distribution of the base run's own monthly rain, so a member says "as wet
// as the forecast's p-th percentile is, in this catchment's terms".
//
// The map x → Q_obs(F_fc(x)):
//   F_fc  the forecast sample's empirical CDF: its sorted values at Hazen
//         plotting positions (i − 0.5) ÷ n, a block of tied values at the
//         mean of its positions, linear between distinct values.
//   Q_obs the observed sample's empirical quantile function: its sorted
//         values at (j − 0.5) ÷ m, linear between them, held at the smallest
//         and largest value below the first and above the last position.
// Outside the forecast sample's range the correction at that end is carried
// on multiplicatively, as rain is: x × Q_obs(F_fc(top)) ÷ top above the
// largest forecast value (plus x when that value is 0), x × Q_obs(F_fc(bottom))
// ÷ bottom below the smallest. So the map is continuous, never negative and
// increasing, and a forecast wetter than any hindcast month stays wetter than
// any observed month by the same ratio.
//
// Hazen positions are symmetric (a sample's median sits at 0.5) and unbiased
// for the quantiles of most distributions (Cunnane 1978); the forecast sample
// pools every member of every hindcast year, so it is many times the size of
// the observed one (one month a year) and spans wider positions, which is why
// Q_obs is held at its ends rather than extrapolated.
//
// Pure: no I/O.

/** A fitted map: the forecast's distinct values and their positions, the observed values sorted and theirs. */
export interface QuantileMap {
	fcValues: Float64Array;
	fcPositions: Float64Array;
	obsValues: Float64Array;
	obsPositions: Float64Array;
}

const finiteNonNegative = (v: number) => Number.isFinite(v) && v >= 0;

/** Fit a map from forecast totals onto observed totals (mm). Throws on an empty sample or a value that isn't a finite number ≥ 0. */
export function fitQuantileMap(forecast: readonly number[], observed: readonly number[]): QuantileMap {
	if (!forecast.length || !observed.length) throw new RangeError('a quantile map needs at least one forecast and one observed value');
	for (const v of [...forecast, ...observed]) if (!finiteNonNegative(v)) throw new RangeError(`a quantile map's values must be finite and ≥ 0, not ${String(v)}`);
	const fc = Float64Array.from(forecast).sort();
	const n = fc.length;
	const values: number[] = [];
	const positions: number[] = [];
	for (let s = 0; s < n; ) {
		let e = s;
		while (e + 1 < n && fc[e + 1] === fc[s]) e++;
		values.push(fc[s]!);
		// The mean of the block's Hazen positions, (i − 0.5) ÷ n for 1-based i = s + 1 … e + 1.
		positions.push((s + e + 1) / 2 / n);
		s = e + 1;
	}
	const obs = Float64Array.from(observed).sort();
	const m = obs.length;
	return { fcValues: Float64Array.from(values), fcPositions: Float64Array.from(positions), obsValues: obs, obsPositions: Float64Array.from(obs, (_, j) => (j + 0.5) / m) };
}

/** The largest index i with xs[i] ≤ x (xs sorted, xs[0] ≤ x). */
function below(xs: Float64Array, x: number): number {
	let lo = 0;
	let hi = xs.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (xs[mid]! <= x) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/** Linear interpolation of ys over xs at x, held at the ends. */
function interp(xs: Float64Array, ys: Float64Array, x: number): number {
	const last = xs.length - 1;
	if (x <= xs[0]!) return ys[0]!;
	if (x >= xs[last]!) return ys[last]!;
	const i = below(xs, x);
	const w = (x - xs[i]!) / (xs[i + 1]! - xs[i]!);
	return ys[i]! + w * (ys[i + 1]! - ys[i]!);
}

/** The observed quantile at the forecast's CDF of `x` (both inside the forecast's range). */
const inside = (m: QuantileMap, x: number) => interp(m.obsPositions, m.obsValues, interp(m.fcValues, m.fcPositions, x));

/** Map one forecast total (mm, finite and ≥ 0) to the observed distribution. */
export function applyQuantileMap(m: QuantileMap, x: number): number {
	if (!finiteNonNegative(x)) throw new RangeError(`a forecast total must be finite and ≥ 0, not ${String(x)}`);
	const lo = m.fcValues[0]!;
	const hi = m.fcValues[m.fcValues.length - 1]!;
	if (x > hi) {
		const top = inside(m, hi);
		return hi > 0 ? (top * x) / hi : top + x;
	}
	// x < lo implies lo > 0 (x ≥ 0).
	if (x < lo) return (inside(m, lo) * x) / lo;
	return inside(m, x);
}
