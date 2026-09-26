// Forecast mode (WP-2.12, model.md § Forecast mode): the days after the last
// observed rain that run on the forecast (rain_forecast_mm), kept apart from
// the historical record.
//
// runModel already falls back to forecast rain on a day with no catchment or
// CHIRPS value, and a forecast extends the run window to its last day. Left
// like that, a forecast tail flows into every summary (the curtailment window,
// the EWR days not met, the farm averages, calibration), so yesterday's
// forecast changes the figures farmers and regulators rely on. This module
// splits the run instead:
//
//   forecastSplit        where the forecast tail starts (`forecastFrom`: the
//                        first day whose rain came from the forecast after the
//                        last day of rain from any other source) and the rain
//                        source of every day;
//   withoutForecastTail  the input with that tail cut off (the forecast series
//                        ends the day before forecastFrom, and so does the
//                        run): what an ordinary run uses;
//   runForecastChecked   forecast mode: every summary, and every series up
//                        to forecastFrom − 1, from the run without the tail;
//                        the tail days' series from the run with it; and
//                        summary.forecast over the tail days.
//
// Why two runs and not one: the model is not causal. A few figures are
// record-wide statistics, so a day at the end of the record changes values
// at its start: the land-cover low-flow threshold (the natural flow's Q75,
// network/landcover.ts), EWR rule tables read against the record's flow
// duration curve, and GR4J's warm-up, which cycles the forcing when the
// record is shorter than the warm-up. A forecast tail therefore moves
// historical values by float noise (1e-8 relative is typical) and, in a
// short record, by more. Taking the history from the run without the tail
// makes the historical figures those of an ordinary run to the bit, by
// construction; the forecast days carry on from the run with the tail, so
// the join between the two is continuous only up to that noise.
//
// Nothing here changes runModel: without a forecast tail runForecastChecked
// is runModelChecked (checkForecastPrefix, testing/invariants.ts, asserts
// both properties).
import { fromEpochDay, toEpochDay } from './calendar';
import type { ModelInput, ModelOutput, RunSeries } from './project';
import { RAIN_SOURCE_CODE, RAIN_SOURCE_COLUMN } from './rainSourcePeriods';
import { runModelChecked } from './run';
import { prepareRun } from './prepare';

/** A deficit below this (m³/day, under a millilitre) is float noise, not a short day (as views/farmProjection.ts). */
const NOISE_M3 = 1e-6;

/** Where a run's forecast tail starts, and the source of each day's rain. */
export interface ForecastSplit {
	/** The run's first day (ISO). */
	startDate: string;
	/** The run's last day (ISO). */
	endDate: string;
	/**
	 * The first day whose rain came from the forecast series after the last
	 * day of rain from any other source (the workbook's "F" rows); null when
	 * no day after that is forecast rain, or when no day has rain from another
	 * source (nothing observed to split from).
	 */
	forecastFrom: string | null;
	/** The last day whose rain came from a source other than the forecast; null when none did. */
	lastObserved: string | null;
	/**
	 * The source of each run day's rain, RAIN_SOURCE_CODE (0 catchment,
	 * 1 alternative gauge, 2 CHIRPS, 3 reanalysis, 4 forecast), NaN for none:
	 * the same codes as the `rain_source` column of rain-source periods.
	 */
	source: Float64Array;
}

/**
 * Where the forecast tail starts. Reads the rain exactly as the run does
 * (prepareRun: zero runs set aside, accumulations spread, rain-source
 * periods, CHIRPS blocked where it may not fill), so a day counts as
 * forecast only when the forecast is the rain the model used on it.
 */
export function forecastSplit(input: ModelInput): ForecastSplit {
	const prep = prepareRun(input);
	const { days, start } = prep;
	let source: Float64Array;
	if (prep.rainSource) source = prep.rainSource.column;
	else {
		const catchment = prep.aligned('rain_catchment_mm');
		const chirps = prep.aligned('rain_chirps_mm');
		const forecast = prep.aligned('rain_forecast_mm');
		source = new Float64Array(days);
		for (let t = 0; t < days; t++) {
			source[t] =
				catchment[t] != null
					? RAIN_SOURCE_CODE.catchment
					: chirps[t] != null
						? RAIN_SOURCE_CODE.chirps
						: forecast[t] != null
							? RAIN_SOURCE_CODE.forecast
							: NaN;
		}
	}
	let last = -1;
	for (let t = 0; t < days; t++) if (!Number.isNaN(source[t]!) && source[t] !== RAIN_SOURCE_CODE.forecast) last = t;
	let from = -1;
	if (last >= 0) {
		for (let t = last + 1; t < days; t++) {
			if (source[t] === RAIN_SOURCE_CODE.forecast) {
				from = t;
				break;
			}
		}
	}
	return {
		startDate: fromEpochDay(start),
		endDate: fromEpochDay(prep.end),
		forecastFrom: from >= 0 ? fromEpochDay(start + from) : null,
		lastObserved: last >= 0 ? fromEpochDay(start + last) : null,
		source
	};
}

/**
 * The input without its forecast tail: the forecast series cut to end the
 * day before forecastFrom (dropped when nothing is left) and the run ending
 * there too (settings.simulationEnd), so the days between the last observed
 * rain and forecastFrom, dry in both, stay in the run. Returns the input
 * itself when there is no tail. Forecast rain before forecastFrom (filling a
 * gap in the record) is kept: those days are history, however they were
 * filled.
 */
export function withoutForecastTail(input: ModelInput, split: ForecastSplit = forecastSplit(input)): ModelInput {
	if (!split.forecastFrom) return input;
	const cut = toEpochDay(split.forecastFrom);
	const series = { ...input.series };
	const f = series.rain_forecast_mm!;
	const keep = Math.max(0, Math.min(f.values.length, cut - toEpochDay(f.startDate)));
	if (keep > 0) series.rain_forecast_mm = { ...f, values: f.values.slice(0, keep) };
	else delete series.rain_forecast_mm;
	return { ...input, settings: { ...input.settings, simulationEnd: fromEpochDay(cut - 1) }, series };
}

/** One farm over the forecast days. Volumes m³ over the days, fractions 0–1. */
export interface ForecastFarm {
	nodeId: string;
	name: string;
	/** Lowest dam storage ÷ capacity on any forecast day; null without a dam. */
	minDamPct: number | null;
	/** The first forecast day at that lowest level (ISO); null without a dam. */
	minDamDate: string | null;
	/** Forecast days with a deficit (demand not met). */
	deficitDays: number;
	demandM3: number;
	suppliedM3: number;
	/** supplied ÷ demand; null with no demand over the days. */
	suppliedFraction: number | null;
}

/** summary.forecast: the forecast days, kept out of every other summary. */
export interface ForecastSummary {
	/** The first and last forecast day (ISO); `from` is ModelOutput.forecastFrom. */
	from: string;
	to: string;
	days: number;
	/** The last day of rain from another source (catchment, alternative gauge, CHIRPS, reanalysis). */
	lastObserved: string;
	/** Forecast rain the model used over the days (mm; days with no value count 0). */
	rainMm: number;
	/** Farms in the model's order. */
	perFarm: ForecastFarm[];
	/** Forecast days the outlet's EWR is not met (the outlet test, as ewrDaysNotMet). */
	outletEwrDaysAtRisk: number;
}

/** Run a forecast-mode output's per-farm and outlet figures over the days from `from`. */
function forecastSummary(input: ModelInput, full: ModelOutput, split: ForecastSplit & { forecastFrom: string; lastObserved: string }): ForecastSummary {
	const d0 = toEpochDay(full.startDate);
	const from = toEpochDay(split.forecastFrom) - d0;
	const to = full.days - 1;
	const get = (nodeId: string | null, key: string): number[] | undefined => full.series.find((s) => s.nodeId === nodeId && s.key === key)?.values;
	const perFarm: ForecastFarm[] = [];
	for (const n of input.model.nodes) {
		if (n.kind !== 'farm') continue;
		const demand = get(n.id, 'demand');
		const supplied = get(n.id, 'supplied');
		const deficit = get(n.id, 'deficit');
		const storage = get(n.id, 'dam_storage');
		let d = 0;
		let s = 0;
		let short = 0;
		let minPct = Infinity;
		let minAt = -1;
		const cap = n.damCapacityM3 ?? 0;
		for (let t = from; t <= to; t++) {
			d += fin(demand?.[t]);
			s += fin(supplied?.[t]);
			if (fin(deficit?.[t]) > NOISE_M3) short++;
			if (cap > 0 && storage && fin(storage[t]) / cap < minPct) {
				minPct = fin(storage[t]) / cap;
				minAt = t;
			}
		}
		perFarm.push({
			nodeId: n.id,
			name: n.name,
			minDamPct: cap > 0 && Number.isFinite(minPct) ? minPct : null,
			minDamDate: cap > 0 && minAt >= 0 ? fromEpochDay(d0 + minAt) : null,
			deficitDays: short,
			demandM3: d,
			suppliedM3: s,
			suppliedFraction: d > 0 ? s / d : null
		});
	}
	const shortfall = get(null, 'ewr_shortfall');
	const rain = get(null, 'rain_final');
	let atRisk = 0;
	let rainMm = 0;
	for (let t = from; t <= to; t++) {
		if (fin(shortfall?.[t]) < 0) atRisk++;
		rainMm += fin(rain?.[t]);
	}
	return {
		from: split.forecastFrom,
		to: full.endDate,
		days: to - from + 1,
		lastObserved: split.lastObserved,
		rainMm,
		perFarm,
		outletEwrDaysAtRisk: atRisk
	};
}

const fin = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * A forecast-mode run, with the engine's self-checks (what a saved forecast
 * run stores). Without a forecast tail it is runModelChecked(input), plus
 * `forecastFrom: null`. With one:
 * - every summary (farms, curtailment, EWR days, calibration, compliance,
 *   water balance, self-checks, warnings) is that of the run without the
 *   tail (withoutForecastTail), so the historical figures are those of an
 *   ordinary run to the bit;
 * - every series is the run without the tail's up to forecastFrom − 1 and
 *   the run with it from forecastFrom on (the model isn't causal, so the
 *   two runs' shared days can differ by float noise: see the head of this
 *   file), plus the `rain_source` column when the run has none, so every
 *   chart and export can mark the forecast days;
 * - summary.forecast covers the tail days, and summary.forecastRain is the
 *   full run's (it names the days that used forecast rain);
 * - a self-check the full run fails is added to the warnings, named as the
 *   run with the forecast tail.
 */
export function runForecastChecked(input: ModelInput): ModelOutput {
	const split = forecastSplit(input);
	if (!split.forecastFrom || !split.lastObserved) return { ...runModelChecked(input), forecastFrom: null };
	const hist = runModelChecked(withoutForecastTail(input, split));
	const full = runModelChecked(input);
	const cut = toEpochDay(split.forecastFrom) - toEpochDay(full.startDate);
	const history = new Map(hist.series.map((x) => [`${x.nodeId ?? ''}|${x.key}`, x.values]));
	const series: RunSeries[] = full.series.map((x) => {
		const h = history.get(`${x.nodeId ?? ''}|${x.key}`);
		return h ? { ...x, values: [...h.slice(0, cut), ...x.values.slice(cut)] } : x;
	});
	if (!series.some((s) => s.nodeId === null && s.key === RAIN_SOURCE_COLUMN.key)) {
		series.push({ nodeId: null, key: RAIN_SOURCE_COLUMN.key, label: RAIN_SOURCE_COLUMN.label, unit: RAIN_SOURCE_COLUMN.unit, values: Array.from(split.source) });
	}
	const warnings = [...hist.summary.warnings];
	for (const c of full.summary.verification?.checks ?? []) {
		if (!c.passed) warnings.push(`self-check failed on the run with the forecast tail (${c.label}): ${c.detail}`);
	}
	const withTail = split as ForecastSplit & { forecastFrom: string; lastObserved: string };
	return {
		...full,
		series,
		forecastFrom: split.forecastFrom,
		summary: {
			...hist.summary,
			...(full.summary.forecastRain !== undefined ? { forecastRain: full.summary.forecastRain } : {}),
			forecast: forecastSummary(input, full, withTail),
			warnings
		}
	};
}
