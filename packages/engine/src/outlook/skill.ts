// The skill gate's score (issue #620 step 6, docs/model.md §2.15d): the
// continuous ranked probability score of a weighted ensemble, and its skill
// score against a reference ensemble.
//
// CRPS(F, y) = ∫ (F(x) − 1{x ≥ y})² dx. For an ensemble x_i with weights w_i
// (Σ w = 1) as a step CDF it is exactly
//   Σ_i w_i |x_i − y| − ½ Σ_i Σ_j w_i w_j |x_i − x_j|
// (Gneiting & Raftery 2007, eq. 21, with weights; Hersbach 2000): the mean
// error of the members less half their mean spread, in the variable's own
// units, 0 for a perfect deterministic forecast and the absolute error for a
// one-member one. CRPSS = 1 − mean CRPS ÷ mean CRPS of the reference over the
// same cases: above 0 the forecast is better, 0 as good, below 0 worse.
//
// Pure: no I/O.

/** The CRPS of an ensemble with weights (null = equal; normalised here) at the outcome `y`. Throws on an empty or invalid ensemble. */
export function crpsEnsemble(values: readonly number[], weights: readonly number[] | null, y: number): number {
	const n = values.length;
	if (!n) throw new RangeError('a CRPS needs at least one member');
	if (!Number.isFinite(y)) throw new RangeError(`the outcome ${String(y)} is not a number`);
	if (weights && weights.length !== n) throw new RangeError(`${weights.length} weights for ${n} members`);
	let total = 0;
	for (let i = 0; i < n; i++) {
		const w = weights ? weights[i]! : 1;
		if (!Number.isFinite(values[i]!)) throw new RangeError(`member ${i + 1} is not a number`);
		if (!(Number.isFinite(w) && w >= 0)) throw new RangeError(`weight ${i + 1} must be finite and ≥ 0`);
		total += w;
	}
	if (!(total > 0)) throw new RangeError('the weights sum to 0');
	const w = (i: number) => (weights ? weights[i]! : 1) / total;
	let err = 0;
	let spread = 0;
	for (let i = 0; i < n; i++) {
		const wi = w(i);
		err += wi * Math.abs(values[i]! - y);
		for (let j = 0; j < n; j++) spread += wi * w(j) * Math.abs(values[i]! - values[j]!);
	}
	return err - spread / 2;
}

/** 1 − mean(forecast) ÷ mean(reference) over paired cases; null with no case or a reference whose mean CRPS is 0. */
export function crpss(forecast: readonly number[], reference: readonly number[]): number | null {
	if (forecast.length !== reference.length) throw new RangeError(`${forecast.length} forecast scores for ${reference.length} reference scores`);
	if (!forecast.length) return null;
	const mean = (v: readonly number[]) => v.reduce((a, b) => a + b, 0) / v.length;
	const ref = mean(reference);
	return ref > 0 ? 1 - mean(forecast) / ref : null;
}
