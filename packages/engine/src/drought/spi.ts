// The drought badge (issue #620, slice 1; docs/model.md §2.15b): the Standardized Precipitation Index
// (McKee et al. 1993; WMO-No. 1090, 2012) and the Standardized Precipitation-Evapotranspiration Index
// (Vicente-Serrano et al. 2010; Beguería et al. 2014) over 3, 6 and 12 months, from a run's own daily
// `rain_final` and `pet`. A derived view of a run's record: runModel doesn't change and nothing here is
// stored, so ENGINE_VERSION doesn't move with it.
//
// - Monthly totals from whole months only; a month with a missing day has no total, and nor has any
//   accumulation over it (no infilling here: rain_final is already the gap-filled series).
// - SPI: per calendar month of the accumulation's last month, a two-parameter gamma fitted to the non-zero
//   totals by Thom's (1958) maximum-likelihood approximation, mixed with the share of zero totals, the
//   zeros placed at the centre of their probability mass (Stagge et al. 2015), then through Φ⁻¹.
// - SPEI: the monthly climatic water balance D = P − PET, accumulated, and per calendar month a
//   three-parameter log-logistic (Hosking's generalised logistic) fitted by L-moments from unbiased
//   probability-weighted moments, as the SPEI R package does since 1.7, then through Φ⁻¹.
// - Reference period: 1991–2020 (the WMO climatological standard normal) when the record has at least
//   DROUGHT_MIN_STANDARD_YEARS of its 30 years in every calendar month, else the whole record. A calendar
//   month with fewer than DROUGHT_MIN_YEARS values in the reference has no fit, and no index.
// - Values are clamped to ±3 (probability 0.00135 / 0.99865): further out a fit to 20–40 values says
//   nothing, and the log-logistic's bounded tail would give ±∞.
//
// The later slices of #620 build on this: the analogue outlook (§2.15) can add the current SPI state to the
// ONI/AAO distance it selects years by, and the C3S outlook reports its members' season totals against the
// same per-calendar-month fits (`fitIndex`).
import { fromEpochDay, toEpochDay } from '../calendar';
import type { DailySeries } from '../project';
import { gammaP, normalQuantile, sampleLMoments } from './stats';

/** The accumulation periods, in months, the badge shows. */
export const DROUGHT_SCALES = [3, 6, 12] as const;
export type DroughtScale = (typeof DROUGHT_SCALES)[number];
export type DroughtIndexKind = 'spi' | 'spei';

/** The WMO climatological standard normal the fits use when the record covers it. */
export const DROUGHT_STANDARD_PERIOD = { from: 1991, to: 2020 } as const;
/** Years of the 30 in the standard period every calendar month needs before it is used. */
export const DROUGHT_MIN_STANDARD_YEARS = 25;
/** Values a calendar month's fit needs (WMO-No. 1090: 20–30 years at the least). */
export const DROUGHT_MIN_YEARS = 20;
/** Non-zero totals the gamma needs; with fewer, the month is too often dry for an SPI. */
export const SPI_MIN_NONZERO = 10;
/** The indices are clamped to ±this. */
export const DROUGHT_CLAMP = 3;

/** A monthly series: values[i] is the month `firstMonth` + i (`YYYY-MM`); null = no value. */
export interface MonthlySeries {
	firstMonth: string;
	values: (number | null)[];
}

const monthIndex = (ym: string) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
const monthText = (i: number) => `${String(Math.floor(i / 12)).padStart(4, '0')}-${String((i % 12) + 1).padStart(2, '0')}`;
/** `YYYY-MM` + n months. */
export const addMonths = (ym: string, n: number) => monthText(monthIndex(ym) + n);

/**
 * Whole calendar months' totals of a daily series up to `lastDay` (default: the series' last day). A
 * partial first or last month is left out; a month with a missing day (null, NaN) has no total.
 */
export function monthlyTotals(s: DailySeries, lastDay?: string): MonthlySeries | null {
	const start = toEpochDay(s.startDate);
	let end = start + s.values.length - 1;
	if (lastDay !== undefined) end = Math.min(end, toEpochDay(lastDay));
	if (end < start) return null;
	// The first whole month starts on the first day of a month on or after the series' start.
	const firstDay = fromEpochDay(start);
	const firstMonth = firstDay.endsWith('-01') ? firstDay.slice(0, 7) : addMonths(firstDay.slice(0, 7), 1);
	// The last whole month ends on `end`, or is the month before end's.
	const endDay = fromEpochDay(end);
	const afterEnd = fromEpochDay(end + 1);
	const lastMonth = afterEnd.endsWith('-01') ? endDay.slice(0, 7) : addMonths(endDay.slice(0, 7), -1);
	const count = monthIndex(lastMonth) - monthIndex(firstMonth) + 1;
	if (count <= 0) return null;
	const values: (number | null)[] = [];
	let day = toEpochDay(`${firstMonth}-01`);
	for (let m = 0; m < count; m++) {
		const next = toEpochDay(`${addMonths(firstMonth, m + 1)}-01`);
		let sum = 0;
		let ok = true;
		for (; day < next; day++) {
			const v = s.values[day - start];
			if (v === null || v === undefined || !Number.isFinite(v)) ok = false;
			else sum += v;
		}
		values.push(ok ? sum : null);
	}
	return { firstMonth, values };
}

/** The k-month running sum ending at each month (null for the first k − 1 months and over a missing month). */
export function accumulate(m: MonthlySeries, k: number): MonthlySeries {
	const values = m.values.map((_, i) => {
		if (i < k - 1) return null;
		let sum = 0;
		for (let j = i - k + 1; j <= i; j++) {
			const v = m.values[j];
			if (v === null || v === undefined) return null;
			sum += v;
		}
		return sum;
	});
	return { firstMonth: m.firstMonth, values };
}

/** The monthly climatic water balance P − PET (null where either is). Both series must start the same month. */
export function waterBalance(rain: MonthlySeries, pet: MonthlySeries): MonthlySeries {
	const offset = monthIndex(pet.firstMonth) - monthIndex(rain.firstMonth);
	return {
		firstMonth: rain.firstMonth,
		values: rain.values.map((p, i) => {
			const e = pet.values[i - offset];
			return p === null || e === null || e === undefined ? null : p - e;
		})
	};
}

/** A gamma fitted to a calendar month's totals, mixed with its zeros. */
export interface GammaFit {
	alpha: number;
	beta: number;
	/** Values in the sample, and how many were zero. */
	n: number;
	zeros: number;
}

/**
 * The SPI's gamma (McKee et al. 1993): Thom's (1958) approximation to the maximum-likelihood shape
 * α = (1 + √(1 + 4A/3)) / 4A, A = ln x̄ − mean(ln x), and scale β = x̄ / α, over the non-zero values. Null
 * with fewer than DROUGHT_MIN_YEARS values, fewer than SPI_MIN_NONZERO non-zero ones, or no spread.
 */
export function gammaFit(sample: readonly number[]): GammaFit | null {
	const n = sample.length;
	if (n < DROUGHT_MIN_YEARS) return null;
	const wet = sample.filter((v) => v > 0);
	if (wet.length < SPI_MIN_NONZERO) return null;
	const mean = wet.reduce((a, v) => a + v, 0) / wet.length;
	const meanLog = wet.reduce((a, v) => a + Math.log(v), 0) / wet.length;
	const A = Math.log(mean) - meanLog;
	if (!(A > 1e-12)) return null;
	const alpha = (1 + Math.sqrt(1 + (4 * A) / 3)) / (4 * A);
	return { alpha, beta: mean / alpha, n, zeros: n - wet.length };
}

/**
 * H(x), the SPI's cumulative probability: q + (1 − q) G(x) with q = zeros / (n + 1); a zero total sits
 * at the centre of the zeros' mass, (zeros + 1) / 2(n + 1) (Stagge et al. 2015).
 */
export function gammaProbability(x: number, fit: GammaFit): number {
	if (x <= 0) return (fit.zeros + 1) / (2 * (fit.n + 1));
	const q = fit.zeros / (fit.n + 1);
	return q + (1 - q) * gammaP(fit.alpha, x / fit.beta);
}

/** Hosking's generalised logistic, the three-parameter log-logistic of the SPEI: location ξ, scale α, shape k. */
export interface LogLogisticFit {
	xi: number;
	alpha: number;
	k: number;
	n: number;
}

/**
 * The SPEI's log-logistic by L-moments (Hosking 1997 GLO): k = −τ3, α = λ2 sin(kπ) / kπ,
 * ξ = λ1 − α (1/k − π / sin(kπ)); k → 0 is the logistic (α = λ2, ξ = λ1). Null with fewer than
 * DROUGHT_MIN_YEARS values, no spread, or |τ3| ≥ 1.
 */
export function logLogisticFit(sample: readonly number[]): LogLogisticFit | null {
	if (sample.length < DROUGHT_MIN_YEARS) return null;
	const lm = sampleLMoments(sample);
	if (!lm || !(Math.abs(lm.t3) < 1)) return null;
	const k = -lm.t3;
	if (Math.abs(k) < 1e-6) return { xi: lm.l1, alpha: lm.l2, k: 0, n: sample.length };
	const kpi = k * Math.PI;
	const alpha = (lm.l2 * Math.sin(kpi)) / kpi;
	return { xi: lm.l1 - alpha * (1 / k - Math.PI / Math.sin(kpi)), alpha, k, n: sample.length };
}

/** F(x) of the generalised logistic: 1 / (1 + e^−y), y = −k⁻¹ ln(1 − k(x − ξ)/α); 0 or 1 past a bound. */
export function logLogisticProbability(x: number, fit: LogLogisticFit): number {
	let y: number;
	if (fit.k === 0) y = (x - fit.xi) / fit.alpha;
	else {
		const arg = 1 - (fit.k * (x - fit.xi)) / fit.alpha;
		if (arg <= 0) return fit.k > 0 ? 1 : 0;
		y = -Math.log(arg) / fit.k;
	}
	return 1 / (1 + Math.exp(-y));
}

/** A probability as a standard normal deviate, clamped to ±DROUGHT_CLAMP. */
export function standardize(p: number): number {
	const z = normalQuantile(p);
	return Math.max(-DROUGHT_CLAMP, Math.min(DROUGHT_CLAMP, z));
}

/** The years a fit was made over: the standard period, or the whole record (first and last year with a value). */
export interface DroughtReference {
	kind: 'standard' | 'record';
	from: number;
	to: number;
	/** The fewest values any calendar month's fit had. */
	minYears: number;
}

/** One index over one accumulation period, every month of the record. */
export interface IndexSeries extends MonthlySeries {
	kind: DroughtIndexKind;
	scale: number;
	/** Null when no calendar month could be fitted. */
	reference: DroughtReference | null;
}

const yearOf = (m: MonthlySeries, i: number) => Math.floor((monthIndex(m.firstMonth) + i) / 12);
const calOf = (m: MonthlySeries, i: number) => (monthIndex(m.firstMonth) + i) % 12;

/** Which years the fits use (DROUGHT_STANDARD_PERIOD when every calendar month has enough of it, else all). */
export function droughtReference(acc: MonthlySeries): { kind: 'standard' | 'record'; from: number; to: number } | null {
	const inStd = new Array<number>(12).fill(0);
	let first = Infinity;
	let last = -Infinity;
	acc.values.forEach((v, i) => {
		if (v === null) return;
		const y = yearOf(acc, i);
		first = Math.min(first, y);
		last = Math.max(last, y);
		if (y >= DROUGHT_STANDARD_PERIOD.from && y <= DROUGHT_STANDARD_PERIOD.to) inStd[calOf(acc, i)]!++;
	});
	if (first === Infinity) return null;
	if (inStd.every((c) => c >= DROUGHT_MIN_STANDARD_YEARS)) return { kind: 'standard', ...DROUGHT_STANDARD_PERIOD };
	return { kind: 'record', from: first, to: last };
}

/**
 * Fit each calendar month of an accumulated series over its reference years: the gamma for the SPI, the
 * log-logistic for the SPEI. `fits[c]` is calendar month c (0 = January), null where it couldn't be fitted.
 */
export function fitIndex(acc: MonthlySeries, kind: DroughtIndexKind): { fits: (GammaFit | LogLogisticFit | null)[]; reference: DroughtReference | null } {
	const ref = droughtReference(acc);
	const samples: number[][] = Array.from({ length: 12 }, () => []);
	if (ref)
		acc.values.forEach((v, i) => {
			const y = yearOf(acc, i);
			if (v !== null && y >= ref.from && y <= ref.to) samples[calOf(acc, i)]!.push(v);
		});
	const fits = samples.map((s) => (kind === 'spi' ? gammaFit(s) : logLogisticFit(s)));
	const fitted = fits.flatMap((f) => (f ? [f.n] : []));
	return { fits, reference: ref && fitted.length ? { ...ref, minYears: Math.min(...fitted) } : null };
}

/** An accumulated value as its index, against its calendar month's fit (null when either is missing). */
export function indexValue(x: number | null, fit: GammaFit | LogLogisticFit | null, kind: DroughtIndexKind): number | null {
	if (x === null || !fit) return null;
	return standardize(kind === 'spi' ? gammaProbability(x, fit as GammaFit) : logLogisticProbability(x, fit as LogLogisticFit));
}

/** SPI (from monthly rain) or SPEI (from monthly P − PET) over `scale` months, for every month of the record. */
export function standardizedIndex(monthly: MonthlySeries, scale: number, kind: DroughtIndexKind): IndexSeries {
	const acc = accumulate(monthly, scale);
	const { fits, reference } = fitIndex(acc, kind);
	return {
		kind,
		scale,
		firstMonth: acc.firstMonth,
		values: acc.values.map((v, i) => indexValue(v, fits[calOf(acc, i)]!, kind)),
		reference
	};
}

/** The usual SPI/SPEI classes (McKee et al. 1993; WMO-No. 1090 Table 1). */
export type DroughtClass = 'extremely-wet' | 'very-wet' | 'moderately-wet' | 'near-normal' | 'moderately-dry' | 'severely-dry' | 'extremely-dry';

export function droughtClass(v: number): DroughtClass {
	if (v >= 2) return 'extremely-wet';
	if (v >= 1.5) return 'very-wet';
	if (v >= 1) return 'moderately-wet';
	if (v > -1) return 'near-normal';
	if (v > -1.5) return 'moderately-dry';
	if (v > -2) return 'severely-dry';
	return 'extremely-dry';
}

/** Each class as the workspace writes it. */
export const DROUGHT_CLASS_LABEL: Record<DroughtClass, string> = {
	'extremely-wet': 'Extremely wet',
	'very-wet': 'Very wet',
	'moderately-wet': 'Moderately wet',
	'near-normal': 'Near normal',
	'moderately-dry': 'Moderately dry',
	'severely-dry': 'Severely dry',
	'extremely-dry': 'Extremely dry'
};

/** Why an index has no value for the badge's month. */
export type DroughtGap = 'no-pet' | 'missing-month' | 'short-record';

export interface DroughtBadgeIndex {
	kind: DroughtIndexKind;
	scale: DroughtScale;
	value: number | null;
	class: DroughtClass | null;
	reference: DroughtReference | null;
	gap?: DroughtGap;
}

export interface DroughtBadge {
	/** The month the badge is for (`YYYY-MM`): the last whole month of the record, null when there is none. */
	month: string | null;
	/** The whole months of rain the record has. */
	firstMonth: string | null;
	indices: DroughtBadgeIndex[];
}

/**
 * The drought badge: SPI and SPEI over DROUGHT_SCALES months for the last whole month up to `lastDay` (a
 * run's last day of history, never a forecast day). `pet` is optional: without it the SPEI rows are 'no-pet'.
 */
export function droughtBadge(input: { rain: DailySeries; pet?: DailySeries | null; lastDay?: string }): DroughtBadge {
	const rain = monthlyTotals(input.rain, input.lastDay);
	const pet = input.pet ? monthlyTotals(input.pet, input.lastDay) : null;
	const month = rain ? addMonths(rain.firstMonth, rain.values.length - 1) : null;
	const balance = rain && pet ? waterBalance(rain, pet) : null;
	const indices: DroughtBadgeIndex[] = [];
	for (const kind of ['spi', 'spei'] as const) {
		for (const scale of DROUGHT_SCALES) {
			const monthly = kind === 'spi' ? rain : balance;
			if (!monthly) {
				indices.push({ kind, scale, value: null, class: null, reference: null, gap: kind === 'spei' && rain ? 'no-pet' : 'missing-month' });
				continue;
			}
			const s = standardizedIndex(monthly, scale, kind);
			const last = s.values.length - 1;
			const value = last >= 0 ? s.values[last]! : null;
			const accLast = accumulate(monthly, scale).values[last] ?? null;
			indices.push({
				kind,
				scale,
				value,
				class: value === null ? null : droughtClass(value),
				reference: s.reference,
				...(value === null ? { gap: accLast === null ? ('missing-month' as const) : ('short-record' as const) } : {})
			});
		}
	}
	return { month, firstMonth: rain?.firstMonth ?? null, indices };
}

/** The driest index with a value (lowest; SPI before SPEI and the shorter period first on a tie), or null. */
export function driestIndex(badge: DroughtBadge): DroughtBadgeIndex | null {
	let best: DroughtBadgeIndex | null = null;
	for (const i of badge.indices) if (i.value !== null && (best === null || i.value < best.value!)) best = i;
	return best;
}
