// summary.drought (issue #620, the portfolio badge; docs/model.md §2.15b): the drought badge's headline,
// stored with the run so the project list and the team portfolio can show it from the run summary alone,
// without loading any run's daily series. Worked out from the run's own catchment `rain_final` and `pet`
// (droughtBadge), cut at the run's last day of history: a forecast-mode run's summary is its run without
// the forecast tail's, and an ordinary run whose rain ran on past the record on forecast rain
// (summary.forecastRain) stops at the last recorded day. Output only: runModel's numbers don't change, so
// ENGINE_VERSION doesn't move with it.
import { fromEpochDay, toEpochDay } from '../calendar';
import type { ModelOutput, RunSummary } from '../project';
import { addMonths, droughtBadge, driestIndex, type DroughtClass, type DroughtIndexKind, type DroughtScale } from './spi';

/** The catchment series the badge reads. */
export const DROUGHT_RAIN_KEY = 'rain_final';
export const DROUGHT_PET_KEY = 'pet';

/** The driest index with a value for the badge's month. */
export interface RunDroughtIndex {
	kind: DroughtIndexKind;
	scale: DroughtScale;
	value: number;
	class: DroughtClass;
	/** The first month of the period it covers (`YYYY-MM`); the period ends on RunDrought.month. */
	from: string;
}

/**
 * Why a run has no driest index: no catchment rain_final, no whole month of history, a record too short
 * for a fit (fewer than DROUGHT_MIN_YEARS in a calendar month), or a month missing in every period.
 */
export type RunDroughtGap = 'no-rain' | 'no-month' | 'short-record' | 'missing-month';

/** RunSummary.drought (engine 1.105.0): the badge's headline. */
export interface RunDrought {
	/** The month the badge is for: the last whole month of the run's history (`YYYY-MM`), null when none. */
	month: string | null;
	/** The driest of SPI and SPEI over 3, 6 and 12 months; null when none has a value (`gap` says why). */
	driest: RunDroughtIndex | null;
	gap?: RunDroughtGap;
}

/**
 * The run's last day of history, the day the badge counts to: the run's end, or the last recorded rain
 * when the run went on over forecast rain (summary.forecastRain; a day of forecast rain filling a gap
 * before that is history, as everywhere else). The day before the run when no day had recorded rain.
 */
export function droughtLastDay(run: { startDate: string; endDate: string; summary: Pick<RunSummary, 'forecastRain'> }): string {
	const f = run.summary.forecastRain;
	if (!f) return run.endDate;
	if (f.lastRecorded === null) return fromEpochDay(toEpochDay(run.startDate) - 1);
	return f.lastRecorded < run.endDate ? f.lastRecorded : run.endDate;
}

/** summary.drought for a run's output (runModelChecked attaches it). */
export function runDrought(output: Pick<ModelOutput, 'startDate' | 'endDate' | 'series' | 'summary'>): RunDrought {
	const catchment = (key: string) => output.series.find((s) => s.nodeId === null && s.key === key);
	const rain = catchment(DROUGHT_RAIN_KEY);
	if (!rain) return { month: null, driest: null, gap: 'no-rain' };
	const pet = catchment(DROUGHT_PET_KEY);
	const badge = droughtBadge({
		rain: { startDate: output.startDate, values: rain.values },
		pet: pet ? { startDate: output.startDate, values: pet.values } : null,
		lastDay: droughtLastDay(output)
	});
	if (!badge.month) return { month: null, driest: null, gap: 'no-month' };
	const d = driestIndex(badge);
	if (!d || d.value === null || d.class === null)
		return { month: badge.month, driest: null, gap: badge.indices.some((i) => i.gap === 'short-record') ? 'short-record' : 'missing-month' };
	return { month: badge.month, driest: { kind: d.kind, scale: d.scale, value: d.value, class: d.class, from: addMonths(badge.month, -(d.scale - 1)) } };
}
