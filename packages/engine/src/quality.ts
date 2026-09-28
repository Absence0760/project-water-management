// Input data-quality checks that don't depend on a model run's results.
//
// observedAgreement: when a catchment has two observed flow records (a gauge
// and a logger), compare their volumes per water
// year on the days both have a reading. Two instruments on the same river
// should agree roughly; a year where one reads a small fraction of the other
// usually means something physical at one of them (weir damage, siltation, a
// rating change, bypass, zero-filled gaps) — and calibrating to the wrong one
// skews every result.
//
// seriesChecks: negative values, outliers and flat-lines (a stuck logger, a
// filled-in gap) in each input series, plus two catchment-rain checks for
// missing data recorded as 0 (issue #2): long zero runs in the wet season
// (zeroRainRuns) and water years far below CHIRPS (rainVsChirps). A zero is a
// reading, so it blocks the CHIRPS fallback that a blank day gets. The
// double-mass check against CHIRPS ('doublemass', engine ≥ 0.18.0) lives in
// ./doublemass.ts, because it needs the zero-rain settings (./rain.ts).
// areaMismatches: farms whose area is not
// the sum of their high- and low-MAP areas (engine-review F7).
//
// None of these change a model result. They become run warnings and
// RunSummary.dataQuality, and the Time series tab shows them before a run.
import { fromEpochDay, monthOfEpochDay, toEpochDay, waterYearLabel, waterYearOf } from './calendar';
import {
	defaultProjectSettings,
	SERIES_KINDS,
	type DailySeries,
	type DataQualitySettings,
	type FlowShareMethod,
	type NetworkNode,
	type SeriesKind
} from './project';

/** Observed-flow kinds compared with each other. */
export const OBSERVED_FLOW_KINDS = ['flow_observed_m3s', 'flow_logger_m3s'] as const satisfies readonly SeriesKind[];
export type ObservedFlowKind = (typeof OBSERVED_FLOW_KINDS)[number];

export const OBSERVED_FLOW_LABEL: Record<ObservedFlowKind, string> = {
	flow_observed_m3s: 'observed gauge flow',
	flow_logger_m3s: 'logger flow'
};

export interface AgreementOptions {
	/** Flag a year when a / b falls below this … (default 2/3). */
	minRatio?: number;
	/** … or above this (default 1.5). */
	maxRatio?: number;
	/** Ignore water years with fewer shared days than this (default 90). */
	minDays?: number;
}

export interface AgreementYear {
	/** Water year starting 1 October of this calendar year. */
	waterYear: number;
	/** Days where both records have a reading. */
	days: number;
	/** Volume on those days, million m³. */
	volumeAMm3: number;
	volumeBMm3: number;
	/** volumeA / volumeB; null when B recorded no volume. */
	ratio: number | null;
	flagged: boolean;
}

export interface ObservedAgreement {
	a: ObservedFlowKind;
	b: ObservedFlowKind;
	minRatio: number;
	maxRatio: number;
	minDays: number;
	years: AgreementYear[];
	/** Water years that were flagged, in order. */
	flaggedYears: number[];
}

const M3S_TO_MM3_PER_DAY = 86_400 / 1e6;

/**
 * Compare two daily m³/s series per water year on their shared days. Returns
 * null when either series is missing or they never overlap.
 */
export function observedAgreement(
	series: Partial<Record<SeriesKind, DailySeries>>,
	options: AgreementOptions = {}
): ObservedAgreement | null {
	const [a, b] = OBSERVED_FLOW_KINDS;
	const sa = series[a];
	const sb = series[b];
	if (!sa || !sb) return null;
	const minRatio = options.minRatio ?? 2 / 3;
	const maxRatio = options.maxRatio ?? 1.5;
	const minDays = options.minDays ?? 90;
	if (!(minRatio > 0 && minRatio <= maxRatio && Number.isFinite(maxRatio) && minDays >= 0)) {
		throw new RangeError(`agreement thresholds need 0 < minRatio ≤ maxRatio and minDays ≥ 0 (got ${minRatio}, ${maxRatio}, ${minDays})`);
	}

	const a0 = toEpochDay(sa.startDate);
	const b0 = toEpochDay(sb.startDate);
	const from = Math.max(a0, b0);
	const to = Math.min(a0 + sa.values.length, b0 + sb.values.length); // exclusive
	if (to <= from) return null;

	const byYear = new Map<number, { days: number; va: number; vb: number }>();
	for (let day = from; day < to; day++) {
		const va = sa.values[day - a0];
		const vb = sb.values[day - b0];
		// A shared day needs a valid reading in both: present, finite and not
		// negative (a negative flow is an error, which seriesChecks reports).
		if (!isReading(va) || !isReading(vb)) continue;
		const wy = waterYearOf(day);
		const y = byYear.get(wy) ?? { days: 0, va: 0, vb: 0 };
		y.days++;
		y.va += va * M3S_TO_MM3_PER_DAY;
		y.vb += vb * M3S_TO_MM3_PER_DAY;
		byYear.set(wy, y);
	}
	if (byYear.size === 0) return null;

	const years: AgreementYear[] = [...byYear.entries()]
		.sort(([x], [y]) => x - y)
		.map(([waterYear, y]) => {
			const ratio = y.vb > 0 ? y.va / y.vb : null;
			const outOfBand = ratio === null ? y.va > 0 : ratio < minRatio || ratio > maxRatio;
			return {
				waterYear,
				days: y.days,
				volumeAMm3: y.va,
				volumeBMm3: y.vb,
				ratio,
				flagged: y.days >= minDays && outOfBand
			};
		});
	return { a, b, minRatio, maxRatio, minDays, years, flaggedYears: years.filter((y) => y.flagged).map((y) => y.waterYear) };
}

const isReading = (v: number | null | undefined): v is number => v != null && Number.isFinite(v) && v >= 0;

/** observedAgreement options from the project's settings.dataQuality. */
export function agreementOptions(dq: DataQualitySettings): Required<AgreementOptions> {
	return { minRatio: dq.agreementMinRatio, maxRatio: dq.agreementMaxRatio, minDays: dq.agreementMinDays };
}

/**
 * settings.dataQuality merged over the defaults. An invalid field (not a
 * finite number, min ratio outside 0 < r ≤ 1, max ratio below 1, days not a
 * whole number in 1–366) falls back to its default with a warning, so a
 * hand-edited or old stored value can't break a run.
 */
export function resolveDataQuality(raw: unknown, warnings: string[] = []): DataQualitySettings {
	const d = defaultProjectSettings().dataQuality;
	const r = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
	const pick = (key: keyof DataQualitySettings, ok: (v: number) => boolean, rule: string): number => {
		const v = r[key];
		if (v === undefined || v === null) return d[key];
		if (typeof v === 'number' && Number.isFinite(v) && ok(v)) return v;
		warnings.push(`data-quality setting ${key} = ${JSON.stringify(v)} is invalid (${rule}); using the default ${+d[key].toFixed(4)}`);
		return d[key];
	};
	return {
		agreementMinRatio: pick('agreementMinRatio', (v) => v > 0 && v <= 1, 'needs 0 < ratio ≤ 1'),
		agreementMaxRatio: pick('agreementMaxRatio', (v) => v >= 1, 'needs a ratio ≥ 1'),
		agreementMinDays: pick('agreementMinDays', (v) => Number.isInteger(v) && v >= 1 && v <= 366, 'needs a whole number of days, 1–366')
	};
}

/** One human-readable warning for the flagged years, or null. */
export function agreementWarning(ag: ObservedAgreement | null): string | null {
	if (!ag || ag.flaggedYears.length === 0) return null;
	const parts = ag.years
		.filter((y) => y.flagged)
		.map((y) => (y.ratio === null ? `${waterYearLabel(y.waterYear)}: the ${OBSERVED_FLOW_LABEL[ag.b]} recorded nothing` : `${waterYearLabel(y.waterYear)}: ${pctText(y.ratio)}`));
	return (
		`Observed flow records disagree — the ${OBSERVED_FLOW_LABEL[ag.a]} as a share of the ${OBSERVED_FLOW_LABEL[ag.b]} volume ` +
		`(days both have readings; expected ${Math.round(ag.minRatio * 100)}–${Math.round(ag.maxRatio * 100)} %): ${parts.join('; ')}. ` +
		`Check which record to calibrate against (Settings → calibration flow series).`
	);
}

/** A ratio as a whole percentage; a tiny non-zero ratio shows as "<1 %" rather than a misleading "0 %". */
function pctText(r: number): string {
	const p = Math.round(r * 100);
	return p === 0 && r > 0 ? '<1 %' : `${p} %`;
}

// ---------------------------------------------------------------------------
// Series checks: negative values, outliers, flat-lines
// ---------------------------------------------------------------------------

export type SeriesCheckKind = 'negative' | 'outlier' | 'flatline' | 'zerorun' | 'lowvschirps' | 'doublemass';

export interface SeriesCheck {
	seriesKind: SeriesKind;
	check: SeriesCheckKind;
	/** Days affected (for a flat-line: days inside the flat stretches). */
	days: number;
	/**
	 * Up to MAX_EXAMPLES cases: the day, its value, and for a flat-line or zero
	 * run the stretch length. A zero run also has its last day. A low-vs-CHIRPS
	 * year has the water year's first and last day, value = catchment / CHIRPS
	 * and runDays = the days both series have a reading.
	 */
	examples: { date: string; value: number; runDays?: number; endDate?: string }[];
	/** One sentence for the run warnings and the Time series tab. */
	text: string;
}

/**
 * Outlier rule: a value above FACTOR × the 99th percentile of the series'
 * positive values, once there are at least OUTLIER_MIN_POSITIVE of them. The
 * factors are deliberately wide: the point is to catch typing and unit errors
 * (an l/s record loaded as m³/s, a misplaced decimal), not real floods.
 */
export const OUTLIER_FACTOR = { rain: 5, flow: 10 } as const;
export const OUTLIER_MIN_POSITIVE = 100;
/**
 * Flat-line rule: at least this many consecutive days with the same non-zero
 * value. Zero stretches of rain and evaporation are normal (dry spells). For
 * flow this is the floor of a resolution-aware limit, zero flow included
 * (flowFlatlineMinDays, engine ≥ 1.12.0).
 */
export const FLATLINE_MIN_DAYS: Partial<Record<SeriesKind, number>> = {
	rain_catchment_mm: 5,
	rain_catchment_alt_mm: 5,
	rain_chirps_mm: 5,
	rain_reanalysis_mm: 5,
	rain_forecast_mm: 5,
	flow_observed_m3s: 14,
	flow_logger_m3s: 14,
	flow_reference_m3s: 14,
	// A week of one value is how a monthly mean pasted into a daily pan record shows (issue #45).
	evap_apan_mm: 7
};
/**
 * Flow flat-lines by the record's resolution (engine ≥ 1.12.0, issue #46
 * item 17, pending the hydrologist). A record stored at a fixed resolution
 * r (DWS: m³/s to three decimals, r = 0.001) holds a slow recession on one
 * value for days: falling FLATLINE_FLOW_RECESSION_PER_DAY (1 %) a day, a
 * flow Q moves one step of r in r / (0.01·Q) days. A run of one value is a
 * flat-line only when it lasts FLATLINE_FLOW_RESOLUTION_STEPS (3) such
 * steps, and never fewer than FLATLINE_MIN_DAYS (14) nor more than
 * FLATLINE_FLOW_MAX_DAYS (90) days: max(14, ⌈3·r / (0.01·Q)⌉), capped at 90.
 * Zero flow (a river that stops) gets the cap. So 0.004 m³/s at r = 0.001
 * needs 75 days, 1 m³/s the floor of 14. GSIM Part 2 (Gudmundsson et al.
 * 2018, ESSD 10, 787–804, https://essd.copernicus.org/articles/10/787/2018/)
 * uses a 10-day rule for the same reason: slow recessions genuinely repeat
 * for 10–40 days at fixed resolution. Every number here is judgement.
 */
export const FLATLINE_FLOW_RECESSION_PER_DAY = 0.01;
export const FLATLINE_FLOW_RESOLUTION_STEPS = 3;
export const FLATLINE_FLOW_MAX_DAYS = 90;
/** Differences at or below this (m³/s) are float noise, not the record's resolution. */
const RESOLUTION_NOISE = 1e-9;

/**
 * A record's resolution: the smallest difference between two of its distinct
 * valid values (above float noise); null with fewer than two distinct values.
 */
export function seriesResolution(values: readonly (number | null)[]): number | null {
	const xs = [...new Set(values.filter(valid))].sort((a, b) => a - b);
	let r: number | null = null;
	for (let i = 1; i < xs.length; i++) {
		const d = xs[i]! - xs[i - 1]!;
		if (d > RESOLUTION_NOISE && (r === null || d < r)) r = d;
	}
	return r;
}

/**
 * The days a flow must hold `q` to be a flat-line, at resolution `r`:
 * max(14, ⌈3·r / (0.01·|q|)⌉), capped at 90; the cap for zero flow; the
 * floor when the resolution is unknown (null) and the flow isn't zero.
 */
export function flowFlatlineMinDays(q: number, r: number | null): number {
	const floor = FLATLINE_MIN_DAYS.flow_observed_m3s!;
	const a = Math.abs(q);
	if (a === 0) return FLATLINE_FLOW_MAX_DAYS;
	if (r === null) return floor;
	// Rounded to 1e-9 first, so float noise in r / q (0.0010000000000000002) doesn't add a day.
	const days = Math.ceil(+((FLATLINE_FLOW_RESOLUTION_STEPS * r) / (FLATLINE_FLOW_RECESSION_PER_DAY * a)).toFixed(9));
	return Math.min(FLATLINE_FLOW_MAX_DAYS, Math.max(floor, days));
}
const MAX_EXAMPLES = 5;

const SERIES_NAME: Record<SeriesKind, string> = {
	rain_catchment_mm: 'Rainfall (catchment)',
	rain_catchment_alt_mm: 'Rainfall (alternative catchment gauge)',
	rain_chirps_mm: 'Rainfall (CHIRPS)',
	rain_reanalysis_mm: 'Rainfall (reanalysis)',
	rain_forecast_mm: 'Rainfall (forecast)',
	flow_observed_m3s: 'Observed flow',
	flow_logger_m3s: 'Logger flow',
	flow_reference_m3s: 'Reference gauge (other catchment)',
	evap_apan_mm: 'A-pan evaporation (daily)'
};
const unitOf = (k: SeriesKind) => (k.endsWith('_mm') ? 'mm' : 'm³/s');
/**
 * The outlier factor for a kind: depths (rain, and daily A-pan evaporation,
 * engine ≥ 0.38.0) use the rain factor, flows the flow factor.
 */
export const outlierFactorOf = (kind: string): number => (kind.startsWith('flow_') ? OUTLIER_FACTOR.flow : OUTLIER_FACTOR.rain);
const fmt = (v: number) => String(+v.toPrecision(4));
const valid = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

/** Linear-interpolated quantile of an ascending array (q in 0–1). */
function quantileSorted(xs: Float64Array, q: number): number {
	const pos = (xs.length - 1) * q;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	return xs[lo]! + (xs[hi]! - xs[lo]!) * (pos - lo);
}

/**
 * The flat-line rule for a series: the minimum run of one value, and for flow
 * the record's resolution it depends on (null for rain and evaporation, or
 * a flow with fewer than two distinct values). Rain and evaporation skip
 * zero runs; flow counts them (at the cap).
 */
function flatlineRule(kind: SeriesKind, values: readonly (number | null)[]): { minDays: (v: number) => number; zeros: boolean; resolution: number | null } | null {
	const days = FLATLINE_MIN_DAYS[kind];
	if (!days) return null;
	if (!kind.startsWith('flow_')) return { minDays: () => days, zeros: false, resolution: null };
	const r = seriesResolution(values);
	return { minDays: (v) => flowFlatlineMinDays(v, r), zeros: true, resolution: r };
}

/** The flat stretches of a series under flatlineRule: [first index, end index (exclusive), value]. */
function flatRuns(kind: SeriesKind, values: readonly (number | null)[]): { runs: [number, number, number][]; resolution: number | null } | null {
	const rule = flatlineRule(kind, values);
	if (!rule) return null;
	const runs: [number, number, number][] = [];
	for (let i = 0; i < values.length; ) {
		const v = values[i];
		let j = i + 1;
		if (valid(v) && (v !== 0 || rule.zeros)) {
			while (j < values.length && values[j] === v) j++;
			if (j - i >= rule.minDays(v)) runs.push([i, j, v]);
		}
		i = j;
	}
	return { runs, resolution: rule.resolution };
}

export interface SeriesRowFlags {
	/** Per-day: value < 0 (rain and flow can't be negative). */
	negative: boolean[];
	/** Per-day: value above the outlier threshold (see checkSeries). */
	outlier: boolean[];
	/** Per-day: inside a flat stretch (see checkSeries). */
	flatline: boolean[];
}

/**
 * Per-day negative / outlier / flat-line flags for a series — the exact same
 * rules and constants (OUTLIER_FACTOR, OUTLIER_MIN_POSITIVE, FLATLINE_MIN_DAYS)
 * checkSeries uses to build its (capped) run-warning examples, but returned
 * one boolean per day instead, for row-level display (e.g. the Data tab's
 * series preview table). Missing days are never flagged; a day can carry more
 * than one flag.
 */
export function seriesRowFlags(kind: SeriesKind, s: DailySeries): SeriesRowFlags {
	const n = s.values.length;
	const negative = new Array<boolean>(n).fill(false);
	const outlier = new Array<boolean>(n).fill(false);
	const flatline = new Array<boolean>(n).fill(false);

	s.values.forEach((v, i) => {
		if (valid(v) && v < 0) negative[i] = true;
	});

	const positive = Float64Array.from(s.values.filter((v): v is number => valid(v) && v > 0)).sort();
	if (positive.length >= OUTLIER_MIN_POSITIVE) {
		const factor = outlierFactorOf(kind);
		const limit = factor * quantileSorted(positive, 0.99);
		s.values.forEach((v, i) => {
			if (valid(v) && v > limit) outlier[i] = true;
		});
	}

	for (const [i, j] of flatRuns(kind, s.values)?.runs ?? []) for (let k = i; k < j; k++) flatline[k] = true;

	return { negative, outlier, flatline };
}

/** Checks for one daily series. Missing days are skipped, never counted as a value. */
export function checkSeries(kind: SeriesKind, s: DailySeries): SeriesCheck[] {
	const out: SeriesCheck[] = [];
	const d0 = toEpochDay(s.startDate);
	const date = (i: number) => fromEpochDay(d0 + i);
	const name = SERIES_NAME[kind] ?? kind;
	const unit = unitOf(kind);
	const eg = (xs: SeriesCheck['examples']) =>
		xs.map((x) => `${x.date}: ${fmt(x.value)} ${unit}${x.runDays ? ` for ${x.runDays} days` : ''}`).join('; ');
	const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

	// Negative values: impossible for rain and for flow.
	const neg: SeriesCheck['examples'] = [];
	let negDays = 0;
	s.values.forEach((v, i) => {
		if (valid(v) && v < 0) {
			negDays++;
			if (neg.length < MAX_EXAMPLES) neg.push({ date: date(i), value: v });
		}
	});
	if (negDays) {
		out.push({
			seriesKind: kind,
			check: 'negative',
			days: negDays,
			examples: neg,
			text:
				kind === 'evap_apan_mm'
					? `${name}: ${plural(negDays, 'negative value')} (${eg(neg)}). Evaporation can't be negative; the run uses the monthly A-pan mean on these days`
					: kind.startsWith('flow_')
						? `${name}: ${plural(negDays, 'negative value')} (${eg(neg)}). Flow can't be negative (−999 and −1 are common "no reading" placeholders); the run treats these days as missing, so the calibration statistics, the fit and the plausibility checks skip them`
						: `${name}: ${plural(negDays, 'negative value')} (${eg(neg)}). Rain and flow can't be negative; the gauge-vs-logger comparison skips these days`
		});
	}

	// Outliers against the series' own distribution.
	const positive = Float64Array.from(s.values.filter((v): v is number => valid(v) && v > 0)).sort();
	if (positive.length >= OUTLIER_MIN_POSITIVE) {
		const factor = outlierFactorOf(kind);
		const limit = factor * quantileSorted(positive, 0.99);
		const hits: SeriesCheck['examples'] = [];
		s.values.forEach((v, i) => {
			if (valid(v) && v > limit) hits.push({ date: date(i), value: v });
		});
		if (hits.length) {
			const top = [...hits].sort((a, b) => b.value - a.value || (a.date < b.date ? -1 : 1)).slice(0, MAX_EXAMPLES);
			out.push({
				seriesKind: kind,
				check: 'outlier',
				days: hits.length,
				examples: top,
				text: `${name}: ${plural(hits.length, 'day')} above ${factor}× the 99th percentile, ${fmt(limit)} ${unit} (${eg(top)}). Check for typing or unit errors`
			});
		}
	}

	// Flat-lines: the same value on many consecutive days (rain and evaporation: non-zero; flow: by the record's resolution).
	const flat = flatRuns(kind, s.values);
	if (flat?.runs.length) {
		const minRun = FLATLINE_MIN_DAYS[kind]!;
		const runs: SeriesCheck['examples'] = flat.runs.slice(0, MAX_EXAMPLES).map(([i, j, v]) => ({ date: date(i), value: v, runDays: j - i }));
		const flatDays = flat.runs.reduce((a, [i, j]) => a + j - i, 0);
		const nRuns = flat.runs.length;
		const limit = !kind.startsWith('flow_')
			? `${minRun} or more days`
			: flat.resolution === null
				? `${minRun} or more days (${FLATLINE_FLOW_MAX_DAYS} at zero flow)`
				: `more days than a slow recession holds one value at the record's resolution of ${fmt(flat.resolution)} ${unit} (${minRun} to ${FLATLINE_FLOW_MAX_DAYS} days by flow)`;
		out.push({
			seriesKind: kind,
			check: 'flatline',
			days: flatDays,
			examples: runs,
			text: `${name}: ${plural(nRuns, 'flat stretch', 'flat stretches')} of ${limit} with the same value (${eg(runs)}). A stuck logger or a filled-in gap?`
		});
	}

	// Long zero runs in the catchment rain: missing data recorded as 0?
	if (kind === 'rain_catchment_mm') {
		const z = zeroRainCheck(zeroRainRuns(s));
		if (z) out.push(z);
	}
	return out;
}

/**
 * checkSeries for every series present, in SERIES_KINDS order. The
 * catchment-vs-CHIRPS check, which needs both, follows the catchment rain's own.
 */
export function seriesChecks(series: Partial<Record<SeriesKind, DailySeries>>): SeriesCheck[] {
	return SERIES_KINDS.flatMap((k) => {
		if (!series[k]) return [];
		const own = checkSeries(k, series[k]!);
		const low = k === 'rain_catchment_mm' ? rainVsChirpsCheck(rainVsChirps(series)) : null;
		return low ? [...own, low] : own;
	});
}

// ---------------------------------------------------------------------------
// Catchment rain recorded as 0 when it is really missing (issue #2)
// ---------------------------------------------------------------------------
//
// Rain used = the first non-blank of catchment, CHIRPS and forecast rain
// (model.md §2.4 column R). A blank day falls back to CHIRPS; a 0 does not. So
// a stretch of missing data exported as zeros runs the catchment artificially
// dry. The checks themselves only report. From engine 0.15.0 a run sets the
// flagged zero runs aside as missing (./rain.ts zeroRainMask, CR-20), so they
// do change the rain a run uses unless settings.zeroRainRuns says otherwise.

/**
 * Zero-run rule: a run of consecutive days with catchment rain exactly 0 is
 * flagged when at least this many of its days fall in the catchment's wet half
 * of the year: the six calendar months with the highest mean daily rain in the
 * series itself. That works for winter- and summer-rainfall catchments alike,
 * and a dry-season spell, however long, never counts.
 */
export const ZERO_RUN_MIN_WET_DAYS = 60;
/** Each calendar month needs this many valid days (about two years) before the series' own climatology is trusted. */
export const CLIMATOLOGY_MIN_DAYS_PER_MONTH = 56;
/** Without a usable climatology (a short or all-zero series): flag a zero run of this many days in any season. */
export const ZERO_RUN_PLAIN_DAYS = 180;

export interface ZeroRun {
	startDate: string;
	endDate: string;
	days: number;
	/** Days of the run in the wet half of the year (all of them without a climatology). */
	wetDays: number;
	/** Rain the series' own monthly means would put on these days, mm; null without a climatology. */
	usualMm: number | null;
}

export interface ZeroRainRuns {
	/** The six wettest calendar months (1–12, ascending), or null when the series is too short or never rains. */
	wetMonths: number[] | null;
	/** Flagged runs, in date order. */
	runs: ZeroRun[];
}

/** Mean daily rain per calendar month (index 1–12), or null when a month has too few valid days or the series never rains. */
function monthlyMeans(s: DailySeries): number[] | null {
	const d0 = toEpochDay(s.startDate);
	const sum = new Array<number>(13).fill(0);
	const n = new Array<number>(13).fill(0);
	s.values.forEach((v, i) => {
		if (!isReading(v)) return;
		const m = monthOfEpochDay(d0 + i);
		sum[m] = sum[m]! + v;
		n[m] = n[m]! + 1;
	});
	for (let m = 1; m <= 12; m++) if (n[m]! < CLIMATOLOGY_MIN_DAYS_PER_MONTH) return null;
	const mean = sum.map((x, m) => (m === 0 ? 0 : x / n[m]!));
	return mean.some((x) => x > 0) ? mean : null;
}

/** Mean days per calendar month (index 1–12; February averaged over leap years). */
const MEAN_MONTH_DAYS = [0, 31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * The rain the series' own climatology puts in a year, mm: Σ over the
 * calendar months of mean daily rain × the month's days. Its means include
 * any suspect zeros, so it leans low. null when monthlyMeans has no
 * climatology (a calendar month with too few valid days, or no rain at all).
 */
export function usualAnnualRainMm(s: DailySeries): number | null {
	const mean = monthlyMeans(s);
	return mean ? mean.reduce((a, x, m) => a + x * MEAN_MONTH_DAYS[m]!, 0) : null;
}

/**
 * Runs of consecutive zero catchment rain long enough to look like missing
 * data: ZERO_RUN_MIN_WET_DAYS of them in the wet half of the year, or
 * ZERO_RUN_PLAIN_DAYS in any season without a climatology. A blank, negative
 * or non-finite day ends a run.
 */
export function zeroRainRuns(s: DailySeries): ZeroRainRuns {
	const d0 = toEpochDay(s.startDate);
	const mean = monthlyMeans(s);
	let wetMonths: number[] | null = null;
	const wet = new Array<boolean>(13).fill(true);
	if (mean) {
		// Wettest first; a tie goes to the earlier month so the choice is deterministic.
		wetMonths = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
			.sort((a, b) => mean[b]! - mean[a]! || a - b)
			.slice(0, 6)
			.sort((a, b) => a - b);
		wet.fill(false);
		for (const m of wetMonths) wet[m] = true;
	}
	const minDays = mean ? ZERO_RUN_MIN_WET_DAYS : ZERO_RUN_PLAIN_DAYS;
	const runs: ZeroRun[] = [];
	for (let i = 0; i < s.values.length; ) {
		if (s.values[i] !== 0) {
			i++;
			continue;
		}
		let j = i;
		let wetDays = 0;
		let usual = 0;
		for (; j < s.values.length && s.values[j] === 0; j++) {
			const m = monthOfEpochDay(d0 + j);
			if (wet[m]) wetDays++;
			if (mean) usual += mean[m]!;
		}
		if (wetDays >= minDays) {
			runs.push({ startDate: fromEpochDay(d0 + i), endDate: fromEpochDay(d0 + j - 1), days: j - i, wetDays, usualMm: mean ? usual : null });
		}
		i = j;
	}
	return { wetMonths, runs };
}

const MONTH_ABBR = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** At most this many runs or years are spelled out in one warning. */
export const MAX_LISTED = 12;
const listed = (parts: string[]) =>
	parts.length > MAX_LISTED ? `${parts.slice(0, MAX_LISTED).join('; ')}; and ${parts.length - MAX_LISTED} more` : parts.join('; ');
const FALLBACK_NOTE =
	'A zero counts as a reading, so on its own it blocks the fallback to CHIRPS (then forecast) rain that a blank day gets. ' +
	'A run treats these runs as missing, so CHIRPS fills them, unless Settings → Zero-rain runs keeps them as recorded; the run says what it filled';

/** The zero-run result as a SeriesCheck, or null when nothing is flagged. */
export function zeroRainCheck(z: ZeroRainRuns): SeriesCheck | null {
	if (z.runs.length === 0) return null;
	const parts = z.runs.map(
		(r) =>
			`${r.startDate} to ${r.endDate} (${r.days} days` +
			(z.wetMonths ? `, ${r.wetDays} in the wet season, which usually brings about ${Math.round(r.usualMm!)} mm` : '') +
			')'
	);
	const rule = z.wetMonths
		? `${ZERO_RUN_MIN_WET_DAYS}+ days of the wet season (${z.wetMonths.map((m) => MONTH_ABBR[m]).join(', ')}: this series' six wettest months)`
		: `${ZERO_RUN_PLAIN_DAYS}+ days (too little data to tell the wet season)`;
	return {
		seriesKind: 'rain_catchment_mm',
		check: 'zerorun',
		days: z.runs.reduce((a, r) => a + r.days, 0),
		examples: z.runs.slice(0, MAX_EXAMPLES).map((r) => ({ date: r.startDate, endDate: r.endDate, value: 0, runDays: r.days })),
		text:
			`Rainfall (catchment): ${z.runs.length === 1 ? '1 run' : `${z.runs.length} runs`} of zero rain covering ${rule}: ${listed(parts)}. ` +
			`Real dry spells, or missing data? ${FALLBACK_NOTE}`
	};
}

/**
 * Low-vs-CHIRPS rule: a water year is flagged when its catchment rain, on the
 * days both series have a reading, is below LOW_VS_CHIRPS_RATIO × the record's
 * usual catchment / CHIRPS ratio (the median over the judged years; 1 when
 * fewer than RATIO_BASELINE_MIN_YEARS years can be judged). Measuring against
 * the record's own median absorbs CHIRPS's systematic bias at catchment scale,
 * so a year shows only when it has lost about half its rain relative to the
 * others.
 */
export const LOW_VS_CHIRPS_RATIO = 0.5;
/** A water year is judged only with this many shared days … */
export const LOW_VS_CHIRPS_MIN_DAYS = 180;
/** … and at least this much CHIRPS rain on them, mm. */
export const LOW_VS_CHIRPS_MIN_MM = 50;
/** Fewer judged years than this: the usual ratio is taken as 1. */
export const RATIO_BASELINE_MIN_YEARS = 5;

export interface RainVsChirpsYear {
	/** Water year starting 1 October of this calendar year. */
	waterYear: number;
	/** Days both series have a reading. */
	days: number;
	catchmentMm: number;
	chirpsMm: number;
	/** catchmentMm / chirpsMm; null when CHIRPS recorded no rain. */
	ratio: number | null;
	flagged: boolean;
}

export interface RainVsChirps {
	/** Median ratio over the judged years, or 1 when there are too few of them. */
	usualRatio: number;
	years: RainVsChirpsYear[];
	/** Water years that were flagged, in order. */
	flaggedYears: number[];
}

/** Catchment vs CHIRPS rain per water year on their shared days; null unless both exist and overlap. */
export function rainVsChirps(series: Partial<Record<SeriesKind, DailySeries>>): RainVsChirps | null {
	const sa = series.rain_catchment_mm;
	const sb = series.rain_chirps_mm;
	if (!sa || !sb) return null;
	const a0 = toEpochDay(sa.startDate);
	const b0 = toEpochDay(sb.startDate);
	const from = Math.max(a0, b0);
	const to = Math.min(a0 + sa.values.length, b0 + sb.values.length); // exclusive
	const byYear = new Map<number, { days: number; a: number; b: number }>();
	for (let day = from; day < to; day++) {
		const va = sa.values[day - a0];
		const vb = sb.values[day - b0];
		if (!isReading(va) || !isReading(vb)) continue;
		const wy = waterYearOf(day);
		const y = byYear.get(wy) ?? { days: 0, a: 0, b: 0 };
		y.days++;
		y.a += va;
		y.b += vb;
		byYear.set(wy, y);
	}
	if (byYear.size === 0) return null;
	const judged = (y: { days: number; b: number }) => y.days >= LOW_VS_CHIRPS_MIN_DAYS && y.b >= LOW_VS_CHIRPS_MIN_MM;
	const ratios = [...byYear.values()]
		.filter(judged)
		.map((y) => y.a / y.b)
		.sort((x, y) => x - y);
	const usualRatio = ratios.length >= RATIO_BASELINE_MIN_YEARS ? median(ratios) : 1;
	const years = [...byYear.entries()]
		.sort(([x], [y]) => x - y)
		.map(([waterYear, y]) => {
			const ratio = y.b > 0 ? y.a / y.b : null;
			return {
				waterYear,
				days: y.days,
				catchmentMm: y.a,
				chirpsMm: y.b,
				ratio,
				flagged: judged(y) && ratio! < LOW_VS_CHIRPS_RATIO * usualRatio
			};
		});
	return { usualRatio, years, flaggedYears: years.filter((y) => y.flagged).map((y) => y.waterYear) };
}

/** Median of an ascending, non-empty array. */
function median(sorted: number[]): number {
	const h = sorted.length >> 1;
	return sorted.length % 2 ? sorted[h]! : (sorted[h - 1]! + sorted[h]!) / 2;
}

/** The low-vs-CHIRPS result as a SeriesCheck, or null when nothing is flagged. */
export function rainVsChirpsCheck(r: RainVsChirps | null): SeriesCheck | null {
	if (!r || r.flaggedYears.length === 0) return null;
	const flagged = r.years.filter((y) => y.flagged);
	const parts = flagged.map(
		(y) => `${waterYearLabel(y.waterYear)}: ${Math.round(y.catchmentMm)} mm vs ${Math.round(y.chirpsMm)} mm, ${pctText(y.ratio!)} (${y.days} days)`
	);
	return {
		seriesKind: 'rain_catchment_mm',
		check: 'lowvschirps',
		days: flagged.reduce((a, y) => a + y.days, 0),
		examples: flagged.slice(0, MAX_EXAMPLES).map((y) => ({
			date: `${y.waterYear}-10-01`,
			endDate: `${y.waterYear + 1}-09-30`,
			value: y.ratio!,
			runDays: y.days
		})),
		text:
			`Rainfall (catchment): ${flagged.length === 1 ? '1 water year' : `${flagged.length} water years`} below ` +
			`${Math.round(LOW_VS_CHIRPS_RATIO * 100)} % of the usual catchment / CHIRPS rain ratio (${pctText(r.usualRatio)}), ` +
			`on the days both have a reading: ${listed(parts)}. Zeros that are really missing data? ${FALLBACK_NOTE}`
	};
}

// ---------------------------------------------------------------------------
// Farm area vs high- + low-MAP area (engine-review F7)
// ---------------------------------------------------------------------------

/** Relative difference above which a farm's areas count as inconsistent. */
export const AREA_TOLERANCE = 0.01;

export interface AreaMismatch {
	nodeId: string;
	name: string;
	areaKm2: number;
	/** areaHiKm2 + areaLoKm2. */
	hiLoKm2: number;
	/** |area − (hi + lo)| / max(area, hi + lo), 0–1. */
	difference: number;
}

/**
 * Farms whose area (used by the area share and the rain volume) differs from
 * areaHiKm2 + areaLoKm2 (used by the hi/lo share) by more than 1 %. Farms that
 * leave hi and lo both at 0 are skipped unless the hi/lo method is chosen:
 * they simply haven't split their area.
 */
export function areaMismatches(nodes: readonly NetworkNode[], method: FlowShareMethod): AreaMismatch[] {
	const out: AreaMismatch[] = [];
	for (const n of nodes) {
		if (n.kind !== 'farm') continue;
		const hiLo = (n.areaHiKm2 || 0) + (n.areaLoKm2 || 0);
		const area = n.areaKm2 || 0;
		if (hiLo === 0 && method !== 'hiLo') continue;
		const big = Math.max(area, hiLo);
		if (!(big > 0)) continue;
		const difference = Math.abs(area - hiLo) / big;
		if (difference > AREA_TOLERANCE) out.push({ nodeId: n.id, name: n.name, areaKm2: area, hiLoKm2: hiLo, difference });
	}
	return out;
}

/** One run warning for the area mismatches, or null. */
export function areaMismatchWarning(list: readonly AreaMismatch[]): string | null {
	if (list.length === 0) return null;
	const parts = list.map((m) => `${m.name}: ${fmt(m.areaKm2)} km² vs ${fmt(m.hiLoKm2)} km²`);
	return (
		`Farm area differs from high-MAP + low-MAP area by more than ${AREA_TOLERANCE * 100} % (${parts.join('; ')}). ` +
		'The area flow share uses the farm area and the hi/lo share uses the split, so the two methods disagree for these farms.'
	);
}
