// Seeded Latin hypercube sampling (McKay, Beckman & Conover 1979) for the
// uncertainty ensemble (docs/model.md §2.10e). Each of the n members falls in
// a different one of n equal strata of every dimension, so even a few hundred
// members cover each parameter's whole range, and a categorical dimension
// split into k values gets n ÷ k members each (± 1). Deterministic for a seed.
import { Rng } from '../random';

/**
 * n points in [0, 1)^d: point i's coordinate in dimension j is
 * (π_j(i) + u) ÷ n, π_j a seeded random permutation of 0 … n − 1 and u
 * uniform in [0, 1). Rows are points, in member order.
 */
export function latinHypercube(n: number, d: number, seed: number): Float64Array[] {
	const rng = new Rng(seed);
	const rows = Array.from({ length: n }, () => new Float64Array(d));
	for (let j = 0; j < d; j++) {
		const perm = rng.shuffle(Array.from({ length: n }, (_, i) => i));
		for (let i = 0; i < n; i++) rows[i]![j] = (perm[i]! + rng.next()) / n;
	}
	return rows;
}

/** A unit coordinate mapped onto [min, max], linearly or log-uniformly (min > 0). */
export function scaleUnit(u: number, min: number, max: number, scale: 'linear' | 'log'): number {
	if (scale === 'log') return Math.exp(Math.log(min) + u * (Math.log(max) - Math.log(min)));
	return min + u * (max - min);
}

/** A unit coordinate mapped onto one of `values` (equal shares, in order). */
export function pickUnit<T>(u: number, values: readonly T[]): T {
	return values[Math.min(values.length - 1, Math.floor(u * values.length))]!;
}

/**
 * 'log' for a positive range spanning at least a factor of ten (GR4J's X1
 * and X3): a uniform draw would put nearly
 * every member in the top decade. Otherwise 'linear'.
 */
export function defaultScale(min: number, max: number): 'linear' | 'log' {
	return min > 0 && max / min >= 10 ? 'log' : 'linear';
}
