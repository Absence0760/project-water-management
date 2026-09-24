// Seeded pseudo-random numbers for the engine: calibration (./calibrate/dds.ts)
// and the property tests (./testing/fuzz.ts). Deterministic for a seed, so a
// calibration or a failing test case reproduces exactly.

/** mulberry32: small, fast, seedable PRNG (no dependency). */
export class Rng {
	private a: number;
	constructor(seed: number) {
		this.a = seed >>> 0;
	}
	/** Uniform in [0, 1). */
	next(): number {
		this.a = (this.a + 0x6d2b79f5) >>> 0;
		let t = this.a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}
	/** Integer in [lo, hi]. */
	int(lo: number, hi: number): number {
		return lo + Math.floor(this.next() * (hi - lo + 1));
	}
	float(lo: number, hi: number): number {
		return lo + this.next() * (hi - lo);
	}
	/** Log-uniform in [lo, hi] (lo > 0): spreads values over orders of magnitude. */
	logFloat(lo: number, hi: number): number {
		return Math.exp(this.float(Math.log(lo), Math.log(hi)));
	}
	bool(p = 0.5): boolean {
		return this.next() < p;
	}
	pick<T>(xs: readonly T[]): T {
		return xs[Math.floor(this.next() * xs.length)]!;
	}
	/** Standard normal deviate (Box–Muller). */
	normal(): number {
		let u = 0;
		while (u === 0) u = this.next();
		return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
	}
	shuffle<T>(xs: T[]): T[] {
		for (let i = xs.length - 1; i > 0; i--) {
			const j = Math.floor(this.next() * (i + 1));
			[xs[i], xs[j]] = [xs[j]!, xs[i]!];
		}
		return xs;
	}
	/** A fraction in 0–1 that is exactly 0 or 1 a good share of the time. */
	frac(pZero = 0.2, pOne = 0.2): number {
		const r = this.next();
		if (r < pZero) return 0;
		if (r < pZero + pOne) return 1;
		return this.bool(0.3) ? Math.round(this.next() * 20) / 20 : this.next();
	}
}
