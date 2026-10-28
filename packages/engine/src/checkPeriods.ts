// Every flagged period of a stored series, one item each, with a stable id
// (issue #611, the Warnings page; docs/model.md §2.10a "Flagged periods").
//
// checkSeries (./quality.ts) gives one SeriesCheck per series and kind with
// at most MAX_EXAMPLES examples, the outliers' the five largest. An
// actionable list needs every period. checkPeriods builds them from the same
// sources the checks use, so the two can never disagree on what is flagged:
//   - negative and outlier: seriesRowFlags' per-day flags, consecutive flagged
//     days grouped into one period;
//   - flatline: flatRuns, one period per stretch;
//   - zerorun (the catchment rain kind only, as checkSeries): zeroRainRuns,
//     each run with its CHIRPS verdict, the runs CHIRPS reads as dry included
//     (severity 'info': they are reported but not set aside);
//   - lowvschirps (opt-in, the catchment gauge only, as a run and the Data
//     tab do): rainVsChirps, one period per flagged water year;
//   - doublemass: a DoubleMass the caller computed (the Data tab already does,
//     with the project's zero-rain settings), one period per break: the
//     segment after it.
// runCheckPeriods adds what only a run knows: the catchment rain's
// accumulation windows (summary.rainAccumulation) and the breaks of the
// observed flow's double-mass curve (summary.plausibility.flowDoubleMass).
//
// `treatment` is what a run does with the period under the default settings
// (for a run's items, what that run did), so the page can show the ones
// already handled. Pure: no run output changes.
import { fromEpochDay, toEpochDay } from './calendar';
import type { DoubleMass } from './doublemass';
import type { CalibrationFlowKind, DailySeries, DataQualitySettings, RunSummary, SeriesKind } from './project';
import { defaultDataQualitySettings } from './project';
import { flatRuns, outlierFactorOf, rainVsChirps, seriesRowFlags, zeroRainRuns, type SeriesCheckKind, type ZeroRunVerdict } from './quality';
import type { AccumulationStatus } from './accumulation';

/** The checks a period can come from: the data checks' kinds, plus two only a run reports. */
export type CheckPeriodKind = SeriesCheckKind | 'accumulation' | 'flowdoublemass';

/**
 * What a run does with a flagged period by default:
 * - 'none': uses the values as recorded (the check only reports);
 * - 'missing': reads the days as missing (a negative flow, everywhere);
 * - 'setAside': sets the rain aside as missing and fills it (a flagged zero
 *   run, §2.4c; an accumulation reading set aside);
 * - 'spread': spreads an accumulation's total over its days (§2.4d);
 * - 'fitExcluded': leaves the days out of Fit automatically only (a flow
 *   outlier or non-zero flat stretch, `qualityFlags.suspect = 'exclude'`,
 *   §2.10h); the run's statistics still score them.
 */
export type CheckTreatment = 'none' | 'missing' | 'setAside' | 'spread' | 'fitExcluded';

/** 'warning': flagged; 'info': reported but not flagged (a zero run CHIRPS reads as dry too). */
export type CheckSeverity = 'warning' | 'info';

export interface CheckPeriod {
	/** checkItemId(check, seriesId, start, end). */
	id: string;
	check: CheckPeriodKind;
	seriesId: string;
	seriesKind: SeriesKind;
	/** First and last day of the period, ISO, inclusive. */
	start: string;
	end: string;
	/**
	 * Days the check counts in the period: every day for a run of days; for a
	 * water-year period (lowvschirps, doublemass, flowdoublemass) the days it
	 * judged (both series have a reading).
	 */
	days: number;
	severity: CheckSeverity;
	treatment: CheckTreatment;
	/** The figures behind the flag, by check (see each builder); numbers in the series' unit. */
	params: Record<string, number | string | null>;
}

/** The id of a flagged period: `<check>:<seriesId>:<start>:<end>`. The same period flagged again gets the same id; one that grows gets a new one. */
export function checkItemId(check: CheckPeriodKind, seriesId: string, start: string, end: string): string {
	return `${check}:${seriesId}:${start}:${end}`;
}

/** What checkPeriods reads beyond checkSeries' own inputs. */
export interface CheckPeriodsOptions {
	/** List the water years far below CHIRPS (needs `chirps` and the catchment rain kind): the catchment gauge's check. */
	lowVsChirps?: boolean;
	/** The double-mass curve against CHIRPS (doubleMass in ./doublemass.ts), whose breaks are listed. */
	doubleMass?: DoubleMass | null;
	/**
	 * The rain record reads a negative as missing (a no-data code): a unit's
	 * own gauge and an outlet station do (./runoff/unitGaugeChecks.ts,
	 * ./runoff/stationRecord.ts); the catchment gauge keeps it as a reading.
	 * A flow record always does.
	 */
	negativeAsMissing?: boolean;
}

const DEFAULT_DQ: DataQualitySettings = defaultDataQualitySettings();
const ORDER: readonly CheckPeriodKind[] = ['negative', 'outlier', 'flatline', 'zerorun', 'accumulation', 'lowvschirps', 'doublemass', 'flowdoublemass'];

const isFlowKind = (k: string) => k.startsWith('flow_');
const waterYearStart = (wy: number) => `${wy}-10-01`;
const waterYearEnd = (wy: number) => `${wy + 1}-09-30`;

function item(
	check: CheckPeriodKind,
	seriesId: string,
	seriesKind: SeriesKind,
	start: string,
	end: string,
	days: number,
	treatment: CheckTreatment,
	params: CheckPeriod['params'],
	severity: CheckSeverity = 'warning'
): CheckPeriod {
	return { id: checkItemId(check, seriesId, start, end), check, seriesId, seriesKind, start, end, days, severity, treatment, params };
}

/** Consecutive true days as [first index, end index (exclusive)]. */
function spans(flags: readonly boolean[]): [number, number][] {
	const out: [number, number][] = [];
	for (let i = 0; i < flags.length; ) {
		if (!flags[i]) {
			i++;
			continue;
		}
		let j = i + 1;
		while (j < flags.length && flags[j]) j++;
		out.push([i, j]);
		i = j;
	}
	return out;
}

/** Items in date order, then by check, so a list reads the same however it was built. */
function sorted(items: CheckPeriod[]): CheckPeriod[] {
	return items.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : ORDER.indexOf(a.check) - ORDER.indexOf(b.check) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
}

/**
 * Every flagged period of one stored series, under settings.dataQuality (the
 * defaults without it). The inputs are checkSeries': the same kind, series,
 * limits and CHIRPS (read by the catchment rain's zero-run check when
 * dq.zeroRunChirpsCheck is on), so it runs on every stored series the Data
 * tab checks, a unit's gauge, a station and an inner gauge's flow record
 * included. Its day counts per check equal checkSeries' (doublemass aside:
 * checkSeries counts every segment's days, an item the segment after its
 * break). Params by check: negative `{ min }`, outlier `{ max, limit }`,
 * flatline `{ value }`, zerorun `{ wetDays, usualMm, chirpsShare, verdict }`,
 * lowvschirps `{ waterYear, catchmentMm, chirpsMm, ratio, usualRatio }`,
 * doublemass `{ afterWaterYear, slopeBefore, slopeAfter, change }`.
 */
export function checkPeriods(
	seriesId: string,
	kind: SeriesKind,
	s: DailySeries,
	dq: DataQualitySettings = DEFAULT_DQ,
	chirps: DailySeries | null = null,
	opts: CheckPeriodsOptions = {}
): CheckPeriod[] {
	const out: CheckPeriod[] = [];
	const d0 = toEpochDay(s.startDate);
	const date = (i: number) => fromEpochDay(d0 + i);
	const flow = isFlowKind(kind);
	const rows = seriesRowFlags(kind, s, dq);

	// Negative: a flow is read as missing everywhere (prepare.ts alignFlow), as is a unit gauge's or a station's rain;
	// the catchment gauge's stays a reading (§2.4b, runs as 0).
	for (const [i, j] of spans(rows.negative)) {
		let min = 0;
		for (let k = i; k < j; k++) min = Math.min(min, s.values[k]!);
		out.push(item('negative', seriesId, kind, date(i), date(j - 1), j - i, flow || opts.negativeAsMissing ? 'missing' : 'none', { min }));
	}

	// Outliers: the per-day rule, grouped. Flow outliers are suspect days, left out of Fit automatically by default.
	const outlierSpans = spans(rows.outlier);
	if (outlierSpans.length) {
		const positive = Float64Array.from(s.values.filter((v): v is number => v != null && Number.isFinite(v) && v > 0)).sort();
		const limit = outlierLimit(positive, kind, dq);
		for (const [i, j] of outlierSpans) {
			let max = -Infinity;
			for (let k = i; k < j; k++) max = Math.max(max, s.values[k]!);
			out.push(item('outlier', seriesId, kind, date(i), date(j - 1), j - i, flow ? 'fitExcluded' : 'none', { max, limit }));
		}
	}

	// Flat stretches. A non-zero flow stretch is suspect (Fit automatically leaves it out); a zero one is judged by the zero-flow rule instead (§2.10h).
	for (const [i, j, v] of flatRuns(kind, s.values, dq)?.runs ?? []) {
		out.push(item('flatline', seriesId, kind, date(i), date(j - 1), j - i, flow && v !== 0 ? 'fitExcluded' : 'none', { value: v }));
	}

	if (kind === 'rain_catchment_mm') {
		// Zero runs, as checkSeries reads them: flagged runs are set aside and filled by default (zeroRainRuns.mode 'missing', §2.4c).
		const z = zeroRainRuns(s, { dq, chirps });
		const zeroItem = (r: (typeof z.runs)[number], flagged: boolean) =>
			item(
				'zerorun',
				seriesId,
				kind,
				r.startDate,
				r.endDate,
				r.days,
				flagged ? 'setAside' : 'none',
				{ wetDays: r.wetDays, usualMm: r.usualMm, chirpsShare: r.chirpsShare ?? null, verdict: (r.verdict ?? null) satisfies ZeroRunVerdict | null },
				flagged ? 'warning' : 'info'
			);
		for (const r of z.runs) out.push(zeroItem(r, true));
		for (const r of z.dryRuns ?? []) out.push(zeroItem(r, false));

		if (opts.lowVsChirps && chirps) {
			const low = rainVsChirps({ rain_catchment_mm: s, rain_chirps_mm: chirps }, dq);
			for (const y of low?.years ?? []) {
				if (!y.flagged) continue;
				out.push(
					item('lowvschirps', seriesId, kind, waterYearStart(y.waterYear), waterYearEnd(y.waterYear), y.days, 'none', {
						waterYear: y.waterYear,
						catchmentMm: y.catchmentMm,
						chirpsMm: y.chirpsMm,
						ratio: y.ratio,
						usualRatio: y.usualRatio ?? low!.usualRatio
					})
				);
			}
		}
	}

	const dm = opts.doubleMass;
	if (dm)
		dm.breaks.forEach((b, j) => {
			const next = dm.segments[j + 1];
			if (!next) return;
			out.push(
				item('doublemass', seriesId, kind, waterYearStart(next.fromWaterYear), waterYearEnd(next.toWaterYear), next.days, 'none', {
					afterWaterYear: b.afterWaterYear,
					slopeBefore: b.slopeBefore,
					slopeAfter: b.slopeAfter,
					change: b.change
				})
			);
		});

	return sorted(out);
}

/** seriesRowFlags' outlier limit, for the params: the factor × the 99th percentile of the positive values. */
function outlierLimit(positive: Float64Array, kind: SeriesKind, dq: DataQualitySettings): number {
	const pos = (positive.length - 1) * 0.99;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	const q99 = positive[lo]! + (positive[hi]! - positive[lo]!) * (pos - lo);
	return outlierFactorOf(kind, dq) * q99;
}

const ACC_TREATMENT: Record<AccumulationStatus, CheckTreatment> = {
	spread: 'spread',
	noChirps: 'spread',
	setAside: 'setAside',
	asRecorded: 'none',
	kept: 'none',
	noReading: 'none'
};

/** The run's series the items name: the catchment rain, and the record each flow kind was scored on. */
export type RunCheckSeriesId = (kind: 'rain_catchment_mm' | CalibrationFlowKind) => string | null;

/**
 * The flagged periods only a run reports, for the series `seriesIdOf` names
 * (none for a kind it gives null):
 * - accumulation: each window of summary.rainAccumulation (the catchment
 *   rain's, detected or listed), its treatment what the run did with it
 *   (status 'spread' or 'noChirps': spread; 'setAside'; else as recorded),
 *   params `{ status, source, totalMm, readingMm, runDays, outageDays }`;
 * - flowdoublemass: each break of summary.plausibility.flowDoubleMass (the
 *   calibration record's), the segment after it, params `{ afterWaterYear,
 *   slopeBefore, slopeAfter, change, unexplained, hint }`; only reported.
 * Absent parts (an older run, no catchment rain) give no items.
 */
export function runCheckPeriods(summary: Pick<RunSummary, 'rainAccumulation' | 'plausibility'> | null | undefined, seriesIdOf: RunCheckSeriesId): CheckPeriod[] {
	const out: CheckPeriod[] = [];
	const rainId = seriesIdOf('rain_catchment_mm');
	if (rainId)
		for (const w of summary?.rainAccumulation?.windows ?? []) {
			const days = toEpochDay(w.end) - toEpochDay(w.start) + 1;
			out.push(
				item('accumulation', rainId, 'rain_catchment_mm', w.start, w.end, days, ACC_TREATMENT[w.status] ?? 'none', {
					status: w.status,
					source: w.source,
					totalMm: w.totalMm,
					readingMm: w.readingMm,
					runDays: w.runDays,
					outageDays: w.outageDays ?? null
				})
			);
		}
	const fdm = summary?.plausibility?.flowDoubleMass;
	const flowId = fdm ? seriesIdOf(fdm.flowKind) : null;
	if (fdm && flowId)
		fdm.breaks.forEach((b, j) => {
			const next = fdm.segments[j + 1];
			if (!next) return;
			out.push(
				item('flowdoublemass', flowId, fdm.flowKind, waterYearStart(next.fromWaterYear), waterYearEnd(next.toWaterYear), next.days, 'none', {
					afterWaterYear: b.afterWaterYear,
					slopeBefore: b.slopeBefore,
					slopeAfter: b.slopeAfter,
					change: b.change,
					unexplained: b.unexplained,
					hint: b.hint
				})
			);
		});
	return sorted(out);
}
