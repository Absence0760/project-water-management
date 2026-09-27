// Resizing a dam along its own area–volume relation (engine ≥ 1.10.0,
// docs/model.md §2.13, hydrologist persona review of issue #46 item 11,
// pending the hydrologist). A dam of another size at the same site is the
// same basin filled to another level, so its surface area when full is the
// dam's own area at that volume: A_full,new = A_full × (C_new / C)^b for a
// power-law dam (A = A_full × (V / C)^b), and a survey curve cut at the new
// top (exact) or carried beyond its top by a power law fitted to its top two
// rows (an extrapolation). Uniform scaling (area ∝ capacity, constant mean
// depth), used before 1.10.0, describes widening the basin at the same depth,
// and overstated an enlarged dam's evaporating surface. Pure.
import type { DamCurvePoint } from '../project';

/**
 * The full-supply area of a power-law dam of capacity `cap` and area `areaFull`
 * when full, resized to `newCap` along its own relation A = A_full × (V / C)^b.
 * 0 when either capacity is 0 (no dam to resize from, or none left).
 */
export function resizedFullArea(areaFull: number, cap: number, newCap: number, b: number): number {
	if (!(cap > 0) || !(newCap > 0)) return 0;
	if (newCap === cap) return areaFull;
	return areaFull * Math.pow(newCap / cap, b);
}

/** A curve resized to a new top: its rows (sorted by volume), and whether its top was extrapolated beyond the survey. */
export interface ResizedCurve<R> {
	rows: R[];
	/** true when the new top lies above the survey's: its area (and level) come from a power law fitted to the top rows. */
	extrapolated: boolean;
	/** The exponent the extrapolation used (only when extrapolated). */
	exponent?: number;
}

/**
 * The exponent b of A ∝ V^b through a curve's top two rows that store water
 * and have a surface, clamped to 0–3 (the power law's allowed range; 0 = the
 * top is flat, so the area stops growing). `fallback` when the curve has
 * fewer than two such rows.
 */
export function topExponent(volume: ArrayLike<number>, area: ArrayLike<number>, fallback: number): number {
	let hi = -1;
	let lo = -1;
	for (let k = volume.length - 1; k >= 0; k--) {
		if (!(volume[k]! > 0 && area[k]! > 0)) continue;
		if (hi < 0) hi = k;
		else if (volume[k]! < volume[hi]!) {
			lo = k;
			break;
		}
	}
	if (lo < 0) return fallback;
	const b = Math.log(area[hi]! / area[lo]!) / Math.log(volume[hi]! / volume[lo]!);
	return Number.isFinite(b) ? Math.min(Math.max(b, 0), 3) : fallback;
}

/**
 * A survey curve's rows resized to a new top volume `top` (> 0), rows sorted
 * by volume and non-decreasing in area:
 *  - at or below the survey's top: the rows below `top`, and a top row at
 *    `top` interpolated linearly in volume (area, and level when the rows
 *    carry one), as the run interpolates the curve: exact;
 *  - above it: the survey's rows and one more at `top`, its area the top
 *    row's × (top / V_top)^b, b from the top two rows (topExponent), and its
 *    level the top row's + ∫ dV / A(V) along that power law: extrapolated.
 * `make` builds a row from (volume, area, level); `level` is NaN for rows
 * without one.
 */
export function resizeCurveRows<R>(
	volume: ArrayLike<number>,
	area: ArrayLike<number>,
	level: ArrayLike<number> | null,
	top: number,
	fallbackExponent: number,
	make: (volume: number, area: number, level: number, k: number | null) => R
): ResizedCurve<R> {
	const n = volume.length;
	const lv = (k: number) => (level ? level[k]! : NaN);
	const vTop = volume[n - 1]!;
	if (top <= vTop) {
		const rows: R[] = [];
		for (let k = 0; k < n; k++) {
			if (volume[k]! < top) rows.push(make(volume[k]!, area[k]!, lv(k), k));
			else {
				if (volume[k]! === top) rows.push(make(top, area[k]!, lv(k), k));
				else {
					const k0 = k - 1;
					// top > 0 and the first row sits at or above it: the curve's own anchor (0, 0) is below.
					const v0 = k0 >= 0 ? volume[k0]! : 0;
					const a0 = k0 >= 0 ? area[k0]! : 0;
					const f = (top - v0) / (volume[k]! - v0);
					const l = k0 >= 0 ? lv(k0) + f * (lv(k) - lv(k0)) : NaN;
					rows.push(make(top, a0 + f * (area[k]! - a0), l, null));
				}
				break;
			}
		}
		return { rows, extrapolated: false };
	}
	const b = topExponent(volume, area, fallbackExponent);
	const aTop = area[n - 1]!;
	const aNew = aTop * Math.pow(top / vTop, b);
	// h(V) − h(V_top) = ∫ dV / A(V), A(V) = A_top (V / V_top)^b.
	const rise = b === 1 ? (vTop / aTop) * Math.log(top / vTop) : (Math.pow(vTop, b) / aTop) * ((Math.pow(top, 1 - b) - Math.pow(vTop, 1 - b)) / (1 - b));
	const rows: R[] = [];
	for (let k = 0; k < n; k++) rows.push(make(volume[k]!, area[k]!, lv(k), k));
	rows.push(make(top, aNew, lv(n - 1) + rise, null));
	return { rows, extrapolated: true, exponent: b };
}

/**
 * A node's survey curve rows resized to the top volume `top` (see
 * resizeCurveRows), sorted by volume. Rows kept from the survey are the
 * survey's own; a new top row carries an interpolated or extrapolated level.
 */
export function resizeDamCurve(rows: readonly DamCurvePoint[], top: number, fallbackExponent: number): ResizedCurve<DamCurvePoint> {
	const s = [...rows].sort((a, b) => a.volumeM3 - b.volumeM3);
	return resizeCurveRows(
		s.map((r) => r.volumeM3),
		s.map((r) => r.areaM2),
		s.map((r) => r.levelM),
		top,
		fallbackExponent,
		(volumeM3, areaM2, levelM, k) => (k !== null ? { ...s[k]! } : { levelM, areaM2, volumeM3 })
	);
}
