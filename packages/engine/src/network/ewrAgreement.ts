// EWR agreement: does the model fail the EWR on the same days the river did?
//
// The outlet EWR test (run.ts, ewrDaysNotMet) compares the simulated outflow
// with the pragmatic EWR. A gauge or logger record measures that same impacted
// outflow, so on every day with an observation the observed flow can take the
// same test. Cross-tabulating the two answers settles which runoff model's EWR
// failures are real (issue #4: legacy and GR4J disagree strongly on how many
// days the Reserve is not met). See docs/model.md §2.9b.
import { fromEpochDay, monthOfEpochDay, toEpochDay, waterYearIndex, waterYearOf } from '../calendar';
import type { EwrAgreement, EwrAgreementScores } from '../project';
import { shortfall } from './simulate';

const SEC_PER_DAY = 86_400;

/** An inclusive ISO date range left out of the scoring (same shape as calibration exclusions). */
export interface EwrAgreementExclusion {
	start: string;
	end: string;
}

export interface EwrAgreementOptions {
	/** ISO date of index 0 of every array. */
	startDate: string;
	/** Periods left out (a gauge outage, a known bad stretch): the calibration exclusions. */
	exclusions?: readonly EwrAgreementExclusion[];
	/** Optional inclusive window (ISO; null = open). */
	windowStart?: string | null;
	windowEnd?: string | null;
}

/**
 * "Below the EWR" exactly as the outlet test counts it: MIN(flow − EWR, 0) < 0,
 * with float noise treated as met (network/simulate.ts `shortfall`).
 */
export const belowEwr = (flowM3Day: number, ewrM3Day: number): boolean =>
	shortfall(flowM3Day, ewrM3Day, Math.max(Math.abs(flowM3Day), Math.abs(ewrM3Day))) < 0;

interface Counts {
	days: number;
	bothBelow: number;
	falseAlarm: number;
	miss: number;
	bothAbove: number;
}

const zero = (): Counts => ({ days: 0, bothBelow: 0, falseAlarm: 0, miss: 0, bothAbove: 0 });

/**
 * Scores of one 2×2 table. Every ratio is null when its denominator is 0:
 * - hit rate (probability of detection) = both below ÷ observed below;
 * - false-alarm ratio = model-only ÷ model below;
 * - frequency bias = model below ÷ observed below, which over the same days
 *   is the model's share of days below the EWR ÷ the observed share
 *   (1 = the model fails the EWR as often as the river did; > 1 = too often).
 */
export function scoreContingency(c: Counts): EwrAgreementScores {
	const obsBelow = c.bothBelow + c.miss;
	const modelBelow = c.bothBelow + c.falseAlarm;
	return {
		...c,
		hitRate: obsBelow > 0 ? c.bothBelow / obsBelow : null,
		falseAlarmRatio: modelBelow > 0 ? c.falseAlarm / modelBelow : null,
		frequencyBias: obsBelow > 0 ? modelBelow / obsBelow : null,
		modelFractionBelow: c.days > 0 ? modelBelow / c.days : null,
		observedFractionBelow: c.days > 0 ? obsBelow / c.days : null
	};
}

/**
 * The 2×2 contingency table of "simulated outflow below the EWR" against
 * "observed flow below the EWR", over the days with an observation (missing,
 * non-finite, excluded and out-of-window days are skipped), overall, per
 * water-year month (index 0 = Oct … 11 = Sep) and per water year.
 *
 * @param simulatedM3Day simulated outflow (m³/day)
 * @param observedM3s    observed flow (m³/s); null/NaN = missing
 * @param ewrM3Day       the pragmatic EWR at the outlet (m³/day)
 */
export function ewrAgreement(
	simulatedM3Day: ArrayLike<number>,
	observedM3s: ArrayLike<number | null>,
	ewrM3Day: ArrayLike<number>,
	opts: EwrAgreementOptions
): EwrAgreement {
	const len = Math.min(simulatedM3Day.length, observedM3s.length, ewrM3Day.length);
	const d0 = toEpochDay(opts.startDate);
	let from = 0;
	let to = len - 1;
	if (opts.windowStart) from = Math.max(from, toEpochDay(opts.windowStart) - d0);
	if (opts.windowEnd) to = Math.min(to, toEpochDay(opts.windowEnd) - d0);

	const excluded = new Uint8Array(Math.max(len, 0));
	for (const x of opts.exclusions ?? []) {
		const a = Math.max(0, toEpochDay(x.start) - d0);
		const b = Math.min(len - 1, toEpochDay(x.end) - d0);
		for (let t = a; t <= b; t++) excluded[t] = 1;
	}

	const overall = zero();
	const months = Array.from({ length: 12 }, zero);
	const years = new Map<number, Counts>();
	let excludedDays = 0;
	let first = -1;
	let last = -1;
	for (let t = from; t <= to; t++) {
		const o = observedM3s[t];
		const s = simulatedM3Day[t]!;
		const e = ewrM3Day[t]!;
		if (o === null || o === undefined || !Number.isFinite(o) || !Number.isFinite(s) || !Number.isFinite(e)) continue;
		if (excluded[t]) {
			excludedDays++;
			continue;
		}
		if (first < 0) first = t;
		last = t;
		const model = belowEwr(s, e);
		const obs = belowEwr(o * SEC_PER_DAY, e);
		const field: keyof Counts = model ? (obs ? 'bothBelow' : 'falseAlarm') : obs ? 'miss' : 'bothAbove';
		const day = d0 + t;
		const wy = waterYearOf(day);
		let y = years.get(wy);
		if (!y) years.set(wy, (y = zero()));
		for (const c of [overall, months[waterYearIndex(monthOfEpochDay(day))]!, y]) {
			c.days++;
			c[field]++;
		}
	}

	return {
		days: overall.days,
		excludedDays,
		firstObservedDate: first >= 0 ? fromEpochDay(d0 + first) : null,
		lastObservedDate: last >= 0 ? fromEpochDay(d0 + last) : null,
		overall: scoreContingency(overall),
		byMonth: months.map(scoreContingency),
		byWaterYear: [...years.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([waterYear, c]) => ({ waterYear, ...scoreContingency(c) }))
	};
}
