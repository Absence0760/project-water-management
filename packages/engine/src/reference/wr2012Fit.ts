// The WR2012 five-statistic calibration table (calibration research CR-28,
// engine ≥ 1.18.0).
//
// South African practice with the WRSM/Pitman model (WR2012: Bailey & Pitman
// 2016; Ndiritu 2009) judges a calibration on five statistics of observed and
// simulated flow, each as a % difference against a "good fit" band, beside
// the visual comparison of the hydrograph and the flow-duration curve:
//
//   MAR            mean annual runoff, Mm³ a year
//   mean of logs   mean of log10(annual runoff in Mm³)
//   SD             sample standard deviation of annual runoff, Mm³
//   log SD         sample standard deviation of log10(annual runoff)
//   seasonal index how unevenly the year's flow falls across its 12 months
//
// This app's model is daily, so the statistics are taken on monthly
// aggregates of the scored days (observed and simulated on the same days),
// summed to hydrological (water) years, Oct–Sep. The rules:
//
// - A month counts when at least WR2012_FIT_MONTH_MIN_SHARE (90 %) of its days
//   are scored (observed, inside the window, outside every exclusion). Its
//   volume, observed and simulated alike, is the mean of those paired days ×
//   the month's days, so a few missing days don't bias one side.
// - A water year counts only when all 12 months count; every statistic is
//   over those complete years. The two SDs need at least 2 years.
// - The log statistics need a positive annual runoff on both sides; a year
//   with none is left out of them (`logYears` says how many were used).
// - % difference = 100 × (simulated − observed) ÷ |observed| (the absolute
//   value keeps the sign "simulated higher" for a negative mean of logs, which
//   annual runoff below 1 Mm³ gives). null when the observed statistic is 0.
//
// **Seasonal index: the app's working definition, not yet confirmed.** WR2012
// practice names a "seasonal index" but the definition in the WRSM/Pitman
// manuals (WRC TT 689/16, TT 690/16) could not be read. The app uses the
// Walsh & Lawler (1981) seasonality index of the 12 mean monthly flows, as a
// percentage: SI = 100 × Σ_m |Q̄_m − MAR/12| ÷ MAR. It is 0 for flow spread
// evenly over the year and 183 (= 100 × 22/12) for all of it in one month.
// Swap `seasonalIndex` below if the hydrologist confirms another definition.
//
// Pure: no I/O.

import { daysPerMonth, monthOfEpochDay, waterYearIndex, waterYearOf } from '../calendar';

/** A month counts toward the table when at least this share of its days is scored. */
export const WR2012_FIT_MONTH_MIN_SHARE = 0.9;

export type Wr2012FitStatKey = 'mar' | 'meanLog' | 'sd' | 'logSd' | 'seasonalIndex';

/** The five statistics in the order WR2012 practice tabulates them. */
export const WR2012_FIT_STAT_KEYS: readonly Wr2012FitStatKey[] = ['mar', 'meanLog', 'sd', 'logSd', 'seasonalIndex'];

/**
 * The "good fit" bands: the largest |% difference| (strictly below) that
 * reads as a good fit, per statistic.
 *
 * **Indicative, not confirmed.** These are the "good fit" guidelines a 2025
 * consultant hydrology report submitted to a CMA tabulates, citing WR2012
 * (Dabrowski 2025, Table 4: < 4 %, < 4 %, < 6 %, < 6 %, < 8 %). They could
 * not be checked in the WR2012 manuals themselves (WRC TT 689/16 user manual,
 * TT 690/16 theory manual), so the UI calls them "indicative bands (to be
 * confirmed)" while `confirmed` is false. A hydrologist's or CMA's answer
 * changes only this constant.
 */
export const WR2012_GOOD_FIT_BANDS = {
	confirmed: false,
	source: 'Dabrowski 2025 (consultant report citing WR2012), Table 4; not yet checked in WRC TT 689/16 or TT 690/16',
	pct: { mar: 4, meanLog: 4, sd: 6, logSd: 6, seasonalIndex: 8 } satisfies Record<Wr2012FitStatKey, number>
} as const;

export interface Wr2012FitStat {
	key: Wr2012FitStatKey;
	/** Mm³ a year (MAR, SD), log10 of Mm³ (mean of logs, log SD) or % (seasonal index). null when it can't be computed. */
	observed: number | null;
	simulated: number | null;
	/** 100 × (simulated − observed) ÷ |observed|. */
	diffPct: number | null;
	/** The band's largest |% difference| (WR2012_GOOD_FIT_BANDS). */
	bandPct: number;
	/** |diffPct| < bandPct; null when there is no difference to judge. */
	withinBand: boolean | null;
}

export interface Wr2012FitStats {
	/** Complete water years used (by the year they start in), ascending. */
	waterYears: number[];
	/** Years in the log statistics (positive runoff on both sides). */
	logYears: number;
	/** The five statistics, in WR2012_FIT_STAT_KEYS order. */
	stats: Wr2012FitStat[];
	/** Copied from WR2012_GOOD_FIT_BANDS.confirmed, so a stored result says what it was judged against. */
	bandsConfirmed: boolean;
}

const mean = (a: readonly number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const sampleSd = (a: readonly number[]) => {
	if (a.length < 2) return null;
	const m = mean(a);
	return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};

/**
 * Seasonal index of 12 mean monthly volumes (any order): Walsh & Lawler
 * (1981) as a %, 100 × Σ |Q̄_m − MAR/12| ÷ MAR, MAR = Σ Q̄_m. null when MAR ≤ 0.
 * The app's working definition (see the file header).
 */
export function seasonalIndex(monthlyMeans: readonly number[]): number | null {
	const mar = monthlyMeans.reduce((s, v) => s + v, 0);
	if (!(mar > 0)) return null;
	return (100 * monthlyMeans.reduce((s, v) => s + Math.abs(v - mar / 12), 0)) / mar;
}

/**
 * The five statistics from complete water years of monthly volumes (Mm³,
 * water-year order Oct … Sep, 12 per year), observed and simulated paired.
 * null when there is no year.
 */
export function wr2012FitStatsFromMonthly(years: readonly { waterYear: number; observed: readonly number[]; simulated: readonly number[] }[]): Wr2012FitStats | null {
	if (!years.length) return null;
	const side = (pick: 'observed' | 'simulated') => {
		const annual = years.map((y) => y[pick].reduce((s, v) => s + v, 0));
		const monthlyMeans = Array.from({ length: 12 }, (_, m) => mean(years.map((y) => y[pick][m]!)));
		return { annual, monthlyMeans };
	};
	const o = side('observed');
	const s = side('simulated');
	const logIdx = years.map((_, i) => i).filter((i) => o.annual[i]! > 0 && s.annual[i]! > 0);
	const logs = (a: number[]) => logIdx.map((i) => Math.log10(a[i]!));
	const values: Record<Wr2012FitStatKey, [number | null, number | null]> = {
		mar: [mean(o.annual), mean(s.annual)],
		meanLog: logIdx.length ? [mean(logs(o.annual)), mean(logs(s.annual))] : [null, null],
		sd: [sampleSd(o.annual), sampleSd(s.annual)],
		logSd: [sampleSd(logs(o.annual)), sampleSd(logs(s.annual))],
		seasonalIndex: [seasonalIndex(o.monthlyMeans), seasonalIndex(s.monthlyMeans)]
	};
	const stats = WR2012_FIT_STAT_KEYS.map((key): Wr2012FitStat => {
		const [observed, simulated] = values[key];
		const diffPct = observed !== null && simulated !== null && observed !== 0 ? (100 * (simulated - observed)) / Math.abs(observed) : null;
		const bandPct = WR2012_GOOD_FIT_BANDS.pct[key];
		return { key, observed, simulated, diffPct, bandPct, withinBand: diffPct === null ? null : Math.abs(diffPct) < bandPct };
	});
	return { waterYears: years.map((y) => y.waterYear), logYears: logIdx.length, stats, bandsConfirmed: WR2012_GOOD_FIT_BANDS.confirmed };
}

/**
 * The five statistics on the scored days of a daily record.
 *
 * @param startEpochDay epoch day of index 0 of the arrays
 * @param observedM3Day observed flow, m³/day (any consistent unit works: volumes are reported in Mm³ for m³/day input)
 * @param simulatedM3Day simulated flow, m³/day, aligned with `observedM3Day`
 * @param days the scored day indices (observed, inside the window, outside exclusions), ascending
 * @returns null when no water year has all 12 months scored
 */
export function wr2012FitStats(startEpochDay: number, observedM3Day: ArrayLike<number>, simulatedM3Day: ArrayLike<number>, days: ArrayLike<number>): Wr2012FitStats | null {
	// water year → 12 months of [scored days, Σ observed, Σ simulated, days in the month]
	const acc = new Map<number, Float64Array>();
	for (let i = 0; i < days.length; i++) {
		const t = days[i]!;
		const o = observedM3Day[t]!;
		const s = simulatedM3Day[t]!;
		if (!Number.isFinite(o) || !Number.isFinite(s)) continue;
		const ed = startEpochDay + t;
		const wy = waterYearOf(ed);
		let a = acc.get(wy);
		if (!a) acc.set(wy, (a = new Float64Array(12 * 3)));
		const m = waterYearIndex(monthOfEpochDay(ed));
		a[m * 3]!++;
		a[m * 3 + 1]! += o;
		a[m * 3 + 2]! += s;
	}
	const years: { waterYear: number; observed: number[]; simulated: number[] }[] = [];
	for (const wy of [...acc.keys()].sort((x, y) => x - y)) {
		const a = acc.get(wy)!;
		const leap = (wy + 1) % 4 === 0 && ((wy + 1) % 100 !== 0 || (wy + 1) % 400 === 0);
		const lengths = daysPerMonth(leap ? 29 : 28);
		const observed: number[] = [];
		const simulated: number[] = [];
		let complete = true;
		for (let m = 0; m < 12 && complete; m++) {
			const n = a[m * 3]!;
			const len = lengths[m]!;
			if (n < WR2012_FIT_MONTH_MIN_SHARE * len) complete = false;
			else {
				observed.push(((a[m * 3 + 1]! / n) * len) / 1e6);
				simulated.push(((a[m * 3 + 2]! / n) * len) / 1e6);
			}
		}
		if (complete) years.push({ waterYear: wy, observed, simulated });
	}
	return wr2012FitStatsFromMonthly(years);
}
