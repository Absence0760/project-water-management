// The special functions and sample statistics the drought indices fit with (§2.15b, issue #620): the log of
// the gamma function, the regularised lower incomplete gamma function, the standard normal quantile and the
// unbiased probability-weighted moments behind L-moments. Pure arithmetic, no dependency, so the indices
// compute the same in the browser and in Lambda.

/** Lanczos coefficients (g = 7, n = 9), the usual set: ln Γ(x) to ~15 significant digits for x > 0. */
const LANCZOS = [
	0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
	-0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
];

/** ln Γ(x) for x > 0 (Lanczos approximation; reflection below 0.5). */
export function lnGamma(x: number): number {
	if (!(x > 0)) return NaN;
	if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
	const z = x - 1;
	let a = LANCZOS[0]!;
	const t = z + 7.5;
	for (let i = 1; i < 9; i++) a += LANCZOS[i]! / (z + i);
	return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

const EPS = 1e-15;
const MAX_ITER = 1000;

/**
 * The regularised lower incomplete gamma function P(a, x) = γ(a, x) / Γ(a), the gamma distribution's CDF
 * with shape a at x / scale. The series for x < a + 1, else the continued fraction (modified Lentz), as in
 * Numerical Recipes §6.2. P(a, 0) = 0; NaN for a ≤ 0 or x < 0.
 */
export function gammaP(a: number, x: number): number {
	if (!(a > 0) || !(x >= 0) || Number.isNaN(x)) return NaN;
	if (x === 0) return 0;
	if (x === Infinity) return 1;
	const lnPre = a * Math.log(x) - x - lnGamma(a);
	if (x < a + 1) {
		let ap = a;
		let del = 1 / a;
		let sum = del;
		for (let n = 0; n < MAX_ITER; n++) {
			ap += 1;
			del *= x / ap;
			sum += del;
			if (Math.abs(del) < Math.abs(sum) * EPS) break;
		}
		return Math.min(1, sum * Math.exp(lnPre));
	}
	const tiny = 1e-300;
	let b = x + 1 - a;
	let c = 1 / tiny;
	let d = 1 / b;
	let h = d;
	for (let i = 1; i < MAX_ITER; i++) {
		const an = -i * (i - a);
		b += 2;
		d = an * d + b;
		if (Math.abs(d) < tiny) d = tiny;
		c = b + an / c;
		if (Math.abs(c) < tiny) c = tiny;
		d = 1 / d;
		const del = d * c;
		h *= del;
		if (Math.abs(del - 1) < EPS) break;
	}
	return Math.max(0, 1 - Math.exp(lnPre) * h);
}

/**
 * The standard normal quantile Φ⁻¹(p) (Wichura 1988, algorithm AS 241 PPND16, ~1e-16 relative accuracy).
 * −Infinity at 0, Infinity at 1, NaN outside [0, 1].
 */
export function normalQuantile(p: number): number {
	if (Number.isNaN(p) || p < 0 || p > 1) return NaN;
	if (p === 0) return -Infinity;
	if (p === 1) return Infinity;
	const q = p - 0.5;
	if (Math.abs(q) <= 0.425) {
		const r = 0.180625 - q * q;
		return (
			(q *
				(((((((r * 2509.0809287301226727 + 33430.575583588128105) * r + 67265.770927008700853) * r + 45921.953931549871457) * r +
					13731.693765509461125) *
					r +
					1971.5909503065514427) *
					r +
					133.14166789178437745) *
					r +
					3.387132872796366608)) /
			(((((((r * 5226.495278852545925 + 28729.085735721942674) * r + 39307.89580009271061) * r + 21213.794301586595867) * r +
				5394.1960214247511077) *
				r +
				687.1870074920579083) *
				r +
				42.313330701600911252) *
				r +
				1)
		);
	}
	let r = q < 0 ? p : 1 - p;
	r = Math.sqrt(-Math.log(r));
	let v: number;
	if (r <= 5) {
		r -= 1.6;
		v =
			(((((((r * 7.7454501427834140764e-4 + 0.0227238449892691845833) * r + 0.24178072517745061177) * r + 1.27045825245236838258) * r +
				3.64784832476320460504) *
				r +
				5.7694972214606914055) *
				r +
				4.6303378461565452959) *
				r +
				1.42343711074968357734) /
			(((((((r * 1.05075007164441684324e-9 + 5.475938084995344946e-4) * r + 0.0151986665636164571966) * r + 0.14810397642748007459) * r +
				0.68976733498510000455) *
				r +
				1.6763848301838038494) *
				r +
				2.05319162663775882187) *
				r +
				1);
	} else {
		r -= 5;
		v =
			(((((((r * 2.01033439929228813265e-7 + 2.71155556874348757815e-5) * r + 0.0012426609473880784386) * r + 0.026532189526576123093) * r +
				0.29656057182850489123) *
				r +
				1.7848265399172913358) *
				r +
				5.4637849111641143699) *
				r +
				6.6579046435011037772) /
			(((((((r * 2.04426310338993978564e-15 + 1.4215117583164458887e-7) * r + 1.8463183175100546818e-5) * r + 7.868691311456132591e-4) * r +
				0.0148753612908506148525) *
				r +
				0.13692988092273580531) *
				r +
				0.59983220655588793769) *
				r +
				1);
	}
	return q < 0 ? -v : v;
}

/** The first three sample L-moments: λ1 (mean), λ2 (L-scale) and τ3 = λ3 / λ2 (L-skewness). */
export interface LMoments {
	l1: number;
	l2: number;
	t3: number;
}

/**
 * The sample L-moments from the unbiased probability-weighted moments b0, b1, b2 (Hosking 1990; the
 * "unbiased PWM" Beguería et al. 2014 recommend for the SPEI): with x sorted ascending,
 * b_r = n⁻¹ Σ_j [(j−1)…(j−r)] / [(n−1)…(n−r)] x_(j). Null for fewer than 3 values or no spread.
 */
export function sampleLMoments(sample: readonly number[]): LMoments | null {
	const n = sample.length;
	if (n < 3) return null;
	const x = [...sample].sort((a, b) => a - b);
	let b0 = 0;
	let b1 = 0;
	let b2 = 0;
	for (let j = 1; j <= n; j++) {
		const v = x[j - 1]!;
		b0 += v;
		b1 += ((j - 1) / (n - 1)) * v;
		b2 += (((j - 1) * (j - 2)) / ((n - 1) * (n - 2))) * v;
	}
	b0 /= n;
	b1 /= n;
	b2 /= n;
	const l2 = 2 * b1 - b0;
	if (!(l2 > 0)) return null;
	const l3 = 6 * b2 - 6 * b1 + b0;
	return { l1: b0, l2, t3: l3 / l2 };
}
