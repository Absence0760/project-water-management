// Goodness-of-fit of simulated outflow against an observed flow record.
import { fromEpochDay, toEpochDay, waterYearOf } from '../calendar';
import { excludedDayMask, type ExclusionRange } from '../calibrate/provenance';
import type { AnnualVolume, CalibrationStats } from '../project';
import { wr2012FitStats } from '../reference/wr2012Fit';

const SEC_PER_DAY = 86_400;

/** Where to score: the run's first date and an optional window (ISO, inclusive; null = open). */
export interface CalibrationWindow {
	/** ISO date of index 0 of the arrays. Without it there is no window and no annual table. */
	startDate: string;
	windowStart?: string | null;
	windowEnd?: string | null;
	/** Periods left out of every score (settings.calibrationExclusions as dates). Needs startDate. */
	exclusions?: readonly ExclusionRange[];
}

/**
 * Goodness-of-fit over the days where an observation exists, optionally
 * restricted to a calibration window. Flows are compared in m³/s.
 *
 * - NSE    = 1 − Σ(o − s)² / Σ(o − ō)²                  (1 = perfect; null if obs is constant)
 * - PBIAS  = 100 × Σ(o − s) / Σo                         (%; positive = model under-estimates)
 * - RMSE   = √(Σ(o − s)² / n)                            (m³/s)
 * - KGE    = 1 − √((r − 1)² + (α − 1)² + (β − 1)²)      (Gupta et al. 2009)
 *            r = Pearson correlation, α = σs / σo, β = s̄ / ō (population σ)
 * - R²     = r²
 * - logNSE = NSE of ln(Q + ε), ε = ō / 100               (weights low flows; Pushpalatha et al. 2012)
 * - volume error = 100 × (Σs − Σo) / Σo                  (%; positive = model too wet; = −PBIAS)
 * - annual volumes per water year (Oct–Sep), paired days only, in Mm³
 * - the WR2012 five-statistic table on the same days (reference/wr2012Fit.ts; needs startDate)
 *
 * @param simulatedM3Day simulated outflow, m³/day, aligned with `observedM3s`
 * @param observedM3s    observed flow, m³/s; null = missing
 */
export function calibrationStats(
	simulatedM3Day: ArrayLike<number>,
	observedM3s: ArrayLike<number | null>,
	window?: CalibrationWindow
): CalibrationStats {
	const len = Math.min(simulatedM3Day.length, observedM3s.length);
	let from = 0;
	let to = len - 1;
	let d0: number | null = null;
	if (window) {
		d0 = toEpochDay(window.startDate);
		if (window.windowStart) from = Math.max(from, toEpochDay(window.windowStart) - d0);
		if (window.windowEnd) to = Math.min(to, toEpochDay(window.windowEnd) - d0);
	}
	const hasWindow = d0 !== null && from <= to;
	const exclusions = d0 !== null && window?.exclusions?.length ? window.exclusions : null;
	const excluded = exclusions ? excludedDayMask(exclusions, window!.startDate, len) : null;
	const rawObsAt = (t: number): number | null => {
		const o = observedM3s[t];
		return o === null || o === undefined || !Number.isFinite(o) ? null : o;
	};
	let excludedDays = 0;
	if (excluded) for (let t = from; t <= to; t++) if (excluded[t] && rawObsAt(t) !== null) excludedDays++;
	const base = {
		windowStart: hasWindow ? fromEpochDay(d0! + from) : null,
		windowEnd: hasWindow ? fromEpochDay(d0! + to) : null,
		...(exclusions ? { exclusions: exclusions.map((x) => ({ ...x })), excludedDays } : {})
	};

	const obsAt = (t: number): number | null => (excluded?.[t] ? null : rawObsAt(t));

	let n = 0;
	let sumObs = 0;
	let sumSim = 0;
	let firstT = -1;
	let lastT = -1;
	for (let t = from; t <= to; t++) {
		const o = obsAt(t);
		if (o === null) continue;
		if (firstT < 0) firstT = t;
		lastT = t;
		n++;
		sumObs += o;
		sumSim += simulatedM3Day[t]! / SEC_PER_DAY;
	}
	if (n === 0) {
		return {
			days: 0,
			nse: null,
			pbias: null,
			rmseM3s: null,
			meanObservedM3s: null,
			meanSimulatedM3s: null,
			...base,
			firstObservedDate: null,
			lastObservedDate: null,
			kge: null,
			kgeR: null,
			kgeAlpha: null,
			kgeBeta: null,
			r2: null,
			logNse: null,
			logEpsilonM3s: null,
			volumeErrorPct: null,
			annualVolumes: [],
			wr2012Fit: null
		};
	}

	const meanObs = sumObs / n;
	const meanSim = sumSim / n;
	const eps = meanObs > 0 ? meanObs / 100 : null;
	let meanLogObs = 0;
	if (eps !== null) {
		for (let t = from; t <= to; t++) {
			const o = obsAt(t);
			if (o !== null) meanLogObs += Math.log(Math.max(o, 0) + eps);
		}
		meanLogObs /= n;
	}

	let sse = 0;
	let sst = 0;
	let diff = 0;
	let covOS = 0;
	let varS = 0;
	let logSse = 0;
	let logSst = 0;
	const years = new Map<number, AnnualVolume>();
	for (let t = from; t <= to; t++) {
		const o = obsAt(t);
		if (o === null) continue;
		const s = simulatedM3Day[t]! / SEC_PER_DAY;
		sse += (o - s) ** 2;
		sst += (o - meanObs) ** 2;
		diff += o - s;
		covOS += (o - meanObs) * (s - meanSim);
		varS += (s - meanSim) ** 2;
		if (eps !== null) {
			const lo = Math.log(Math.max(o, 0) + eps);
			const ls = Math.log(Math.max(s, 0) + eps);
			logSse += (lo - ls) ** 2;
			logSst += (lo - meanLogObs) ** 2;
		}
		if (d0 !== null) {
			const wy = waterYearOf(d0 + t);
			let y = years.get(wy);
			if (!y) {
				y = { waterYear: wy, days: 0, daysInWindow: 0, observedMm3: 0, simulatedMm3: 0, diffPct: null };
				years.set(wy, y);
			}
			y.days++;
			y.observedMm3 += (o * SEC_PER_DAY) / 1e6;
			y.simulatedMm3 += simulatedM3Day[t]! / 1e6;
		}
	}

	const annualVolumes = [...years.values()].sort((a, b) => a.waterYear - b.waterYear);
	for (const y of annualVolumes) {
		// Days of this water year inside the window (whether observed or not): flags part years.
		const a = Math.max(d0! + from, toEpochDay(`${y.waterYear}-10-01`));
		const b = Math.min(d0! + to, toEpochDay(`${y.waterYear + 1}-09-30`));
		// Excluded days still count here but aren't scored, so a year with an exclusion reads as a part year.
		y.daysInWindow = b - a + 1;
		y.diffPct = y.observedMm3 !== 0 ? (100 * (y.simulatedMm3 - y.observedMm3)) / y.observedMm3 : null;
	}

	const sdObs = Math.sqrt(sst / n);
	const sdSim = Math.sqrt(varS / n);
	// A flat simulation against a varying record has no correlation: r = 0, as the fit's KGE′ scores it
	// (calibrate/objective.ts), so the mean-flow benchmark scores KGE 1 − √2 and a dried-out outlet 1 − √3
	// (Knoben et al. 2019) rather than none. The tolerances absorb a constant's own-mean float residue, relative
	// to the record's spread and to the simulation's own size (a large constant mean leaves (1e-16 · mean)² a day).
	const flat = !(varS > 1e-24 * sst) || !(varS > n * (1e-13 * meanSim) ** 2);
	const r = sdObs > 0 ? (flat ? 0 : covOS / n / (sdObs * sdSim)) : null;
	const alpha = sdObs > 0 ? sdSim / sdObs : null;
	const beta = meanObs !== 0 ? meanSim / meanObs : null;
	const kge =
		r !== null && alpha !== null && beta !== null
			? 1 - Math.sqrt((r - 1) ** 2 + (alpha - 1) ** 2 + (beta - 1) ** 2)
			: null;

	return {
		days: n,
		nse: sst > 0 ? 1 - sse / sst : null,
		pbias: sumObs !== 0 ? (100 * diff) / sumObs : null,
		rmseM3s: Math.sqrt(sse / n),
		meanObservedM3s: meanObs,
		meanSimulatedM3s: meanSim,
		...base,
		firstObservedDate: d0 !== null ? fromEpochDay(d0 + firstT) : null,
		lastObservedDate: d0 !== null ? fromEpochDay(d0 + lastT) : null,
		kge,
		kgeR: r,
		kgeAlpha: alpha,
		kgeBeta: beta,
		r2: r !== null ? r * r : null,
		logNse: eps !== null && logSst > 0 ? 1 - logSse / logSst : null,
		logEpsilonM3s: eps,
		volumeErrorPct: sumObs !== 0 ? (100 * (sumSim - sumObs)) / sumObs : null,
		annualVolumes,
		wr2012Fit: d0 !== null ? wr2012OnScoredDays(d0, from, to, obsAt, simulatedM3Day) : null
	};
}

/** The WR2012 five-statistic table on the scored days, in m³/day. */
function wr2012OnScoredDays(d0: number, from: number, to: number, obsAt: (t: number) => number | null, simulatedM3Day: ArrayLike<number>) {
	const len = to + 1;
	const obs = new Float64Array(len).fill(NaN);
	const idx: number[] = [];
	for (let t = from; t <= to; t++) {
		const o = obsAt(t);
		if (o === null) continue;
		obs[t] = o * SEC_PER_DAY;
		idx.push(t);
	}
	return wr2012FitStats(d0, obs, simulatedM3Day, idx);
}
