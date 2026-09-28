// Deterministic synthetic daily rainfall for the example catchments. Invented
// data (safe to commit, unlike client workbooks): a two-state Markov chain per
// calendar month with gamma-ish rain depths, seeded so every run is identical.

/** mulberry32 — small, fast, seedable PRNG. */
export function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export interface RainClimate {
	/** Probability a day is wet, per calendar month (Jan … Dec). */
	wetProb: number[];
	/** Mean rain on a wet day (mm), per calendar month. */
	wetMeanMm: number[];
	/** Extra chance of a wet day following a wet day (storm persistence). */
	persistence: number;
}

/** Western-Cape style winter rainfall (wet May–Sep). */
export const WINTER_RAIN: RainClimate = {
	wetProb: [0.06, 0.06, 0.1, 0.18, 0.3, 0.38, 0.38, 0.36, 0.26, 0.16, 0.1, 0.07],
	wetMeanMm: [5, 5, 7, 9, 12, 14, 14, 13, 10, 8, 6, 5],
	persistence: 0.25
};

/** Highveld style summer thunderstorm rainfall (wet Nov–Mar). */
export const SUMMER_RAIN: RainClimate = {
	wetProb: [0.36, 0.3, 0.26, 0.14, 0.05, 0.02, 0.02, 0.02, 0.06, 0.15, 0.26, 0.33],
	wetMeanMm: [11, 10, 9, 7, 5, 4, 4, 4, 6, 8, 10, 11],
	persistence: 0.15
};

/** Daily rainfall (mm, one decimal) from `startDate` for `days` days. */
export function dailyRain(climate: RainClimate, startDate: string, days: number, seed: number, scale = 1): number[] {
	const r = rng(seed);
	const start = Date.parse(`${startDate}T00:00:00Z`);
	const out: number[] = [];
	let wet = false;
	for (let i = 0; i < days; i++) {
		const m = new Date(start + i * 86_400_000).getUTCMonth();
		const p = Math.min(0.95, climate.wetProb[m]! + (wet ? climate.persistence : 0));
		wet = r() < p;
		if (!wet) {
			out.push(0);
			continue;
		}
		// Sum of two exponentials ≈ gamma(k=2): fewer tiny drizzles, occasional big storms.
		const mean = climate.wetMeanMm[m]! * scale;
		const depth = (-Math.log(1 - r()) - Math.log(1 - r())) * (mean / 2);
		out.push(Math.round(depth * 10) / 10);
	}
	return out;
}

/**
 * A plausible "observed" gauge record: the model's own simulated outflow with
 * multiplicative noise, a small timing wobble, and gaps — so calibration
 * statistics look like a real, imperfect fit rather than a perfect one.
 */
export function observedFrom(simulatedM3Day: number[], seed: number, gapFraction = 0.04): (number | null)[] {
	const r = rng(seed);
	const out: (number | null)[] = [];
	for (let i = 0; i < simulatedM3Day.length; i++) {
		if (r() < gapFraction) {
			out.push(null);
			continue;
		}
		const lagged = 0.7 * simulatedM3Day[i]! + 0.3 * (simulatedM3Day[Math.max(0, i - 1)] ?? 0);
		const noise = Math.exp((r() - 0.5) * 1.1);
		out.push(sig3((lagged * noise) / 86_400));
	}
	return out;
}

/**
 * Three significant figures, as a rated gauge reports. Rounding to a fixed
 * 0.001 m³/s instead turned every summer low flow into weeks of identical
 * 0.001 readings, which the flat-line check rightly flags as a stuck logger.
 */
export const sig3 = (v: number): number => (v > 0 ? Number(v.toPrecision(3)) : 0);

/**
 * A CHIRPS-like satellite estimate of the same rain: scaled per calendar month
 * by `bias` (CHIRPS under-reads orographic winter rain in the Western Cape),
 * with multiplicative noise, part of each storm smeared onto the next day (a
 * 0.05° pixel and a day boundary that doesn't match the gauge's 08:00
 * reading), and a light drizzle on some dry days. Rounded to 0.1 mm.
 */
export function chirpsFrom(rainMm: number[], startDate: string, bias: number[], seed: number): number[] {
	const r = rng(seed);
	const start = Date.parse(`${startDate}T00:00:00Z`);
	const out = new Array<number>(rainMm.length).fill(0);
	for (let i = 0; i < rainMm.length; i++) {
		const m = new Date(start + i * 86_400_000).getUTCMonth();
		const noise = Math.exp((r() - 0.5) * 0.8);
		const v = rainMm[i]! * bias[m]! * noise;
		out[i]! += 0.75 * v;
		if (i + 1 < out.length) out[i + 1]! += 0.25 * v;
		if (rainMm[i] === 0 && r() < 0.03) out[i]! += 0.5 + r() * 1.5;
	}
	return out.map((v) => Math.round(v * 10) / 10);
}
