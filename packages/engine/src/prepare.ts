// Everything a run does before natural flow: merge the stored settings over
// the defaults, work out the run window, and align the input series to it
// (rain gap-fill, CHIRPS bias correction, accumulations, rain-source
// periods). The model (./run.ts), calibration and the Data tab's series
// preview all start here. A module of its own so the preview doesn't load
// the network simulation and the checks (issue #9).
import { resolveDataQuality } from './quality';
import { DEFAULT_ALLOCATION_TOLERANCE } from './allocations/compare';
import { resolveAllocationMode } from './allocations/mode';
import {
	accumulationWarnings,
	applyAccumulations,
	finishSetAside,
	claimsDays,
	fitExcludedWindows,
	rainAccumulations,
	spreadAccumulations,
	type AccumulationRun
} from './accumulation';
import {
	applyRainSource,
	finishRainSource,
	hasRainInput,
	rainSourceFactors,
	rainSourceSpans,
	rainSourcePeriodWarnings,
	resolveRainSource,
	type RainSourceInfo
} from './rainSourcePeriods';
import {
	applyChirpsCorrection,
	blankMasked,
	chirpsBiasFactors,
	chirpsCorrectionWarning,
	chirpsQuantileMapFallbackWarning,
	finishZeroRainInfill,
	keepDryDoubtWarnings,
	resolveChirpsFitPeriod,
	resolveZeroRain,
	zeroRainMask,
	zeroRainWarnings,
	type ChirpsCorrection,
	type ZeroRainMask
} from './rain';
import { apanDailyInfo, type ApanDailyInfo } from './evaporation/apanDaily';
import { et0DailyInfo, type Et0DailyInfo } from './evaporation/et0Daily';
import { applyGapRain, fitGapProducts, gapRainKeys, type GapRainFits, type GapRainRun } from './gapRain';
import { doubleMass as doubleMassOf, doubleMassRunWarning, type DoubleMass } from './doublemass';
import { dayText, fromEpochDay, monthOfEpochDay, toEpochDay, type Monthly } from './calendar';
import { DEFAULT_ANNUAL_THRESHOLD } from './network/reliability';
import { sanitizeExclusions } from './calibrate/provenance';
import { resolveChecksKept, resolveFlowMissing, withRecordPeriods } from './recordPeriods';
import { resolveWarningsKept } from './checkItems';
import { EWR_CHARGE_SOURCES, LOW_FLOW_MEASURES, resolveEwrRules } from './reserve/rules';
import { resolveEwrDailySource } from './reserve/dailySource';
import { RUNOFF_MODELS } from './runoff/types';
import {
	CALIBRATION_FLOW_KINDS,
	CHIRPS_BIAS_MODES,
	defaultProjectSettings,
	LEGACY_UPGRADED_WARNING,
	RETIRED_CALIBRATION_KEYS,
	RETIRED_SETTINGS_KEYS,
	flowShareMethodRetiredWarning,
	panCoefficientOutOfRange,
	resolvePe,
	resolveArealRain,
	resolveUnitRain,
	resolveChirpsQuantileMap,
	resolveGapRain,
	AREAL_RAIN_FITTED_WARNING,
	PE_SOURCE_MAX,
	PAN_COEFFICIENT_TYPICAL_MAX,
	PAN_COEFFICIENT_TYPICAL_MIN,
	type DailySeries,
	type ModelInput,
	type ProjectSettings,
	type SeriesKind
} from './project';
import { resolveWr2012 } from './reference/wr2012Resolve';
import {
	fillFlowGaps,
	gapFillLowFlow,
	fillSummaryInWindow,
	flowFillWarning,
	GAP_FILL_KINDS,
	gapFillRecordLabel,
	hasReadingBefore,
	resolveFlowGapFill,
	specFills,
	type FlowFillSummary,
	type GapFillKind
} from './flowGapFill';
import { resolveQualityFlags } from './calibrate/qualityFlagSettings';
import { clonePlain, stableStringify } from './warmstart/plain';
import {
	catchmentStationForcing,
	catchmentStationPlan,
	pairingFactors,
	resolveRainStations,
	stationContext,
	withPinnedStationFactors,
	type CatchmentStationPlan,
	type StationAreaDays,
	type StationContext
} from './runoff/stationForcing';
import type { StationAreaForcing } from './project';
import { warn } from './warningCodes';

/** One rain-source period's fitted factors (rainSourceFactors), keyed by the period's stable JSON. */
export type RainSourceFactorsOf = ReturnType<typeof rainSourceFactors>[number];

/**
 * The rain handling's fits from the whole stored record: the CHIRPS bias
 * factors (before a run counts its fallback days) and each rain-source
 * period's factors. A model-state snapshot pins them (engine ≥ 1.1.0,
 * ./warmstart), so a run resumed from it uses the capture run's fits.
 */
export interface PreparedFits {
	chirpsCorrection: ChirpsCorrection | null;
	rainSourceFactors: { key: string; factors: RainSourceFactorsOf }[];
	/**
	 * The rainfall stations' pairing factors (engine ≥ 1.91.0, issue #553,
	 * docs/model.md §2.4i): stationPairingKey(station, area) → 12 monthly
	 * factors (per area since 1.105.0, issue #612; a snapshot from an older
	 * engine is refused by its engine version), for every pairing the run used
	 * and didn't refuse. Absent on a snapshot from before, and
	 * without settings.rainStations.
	 */
	stationFactors?: Record<string, number[]>;
	/**
	 * The gap-filling products' fits by input key (engine ≥ 1.101.0, ./gapRain.ts,
	 * settings.gapRain): ERA5-Land's and each IMERG version's. Absent on a
	 * snapshot from before, and with CHIRPS alone.
	 */
	gapRain?: GapRainFits;
}

export interface PrepareOptions {
	/** Use these fits instead of fitting the input's record (a CHIRPS series or a period the fits lack is still fitted). */
	pinned?: PreparedFits;
	/** Return the fits the run used as PreparedRun.fits. */
	captureFits?: boolean;
	/**
	 * A resumed run (../run.ts runModelFrom): the records whose gap fill read readings before the snapshot's day
	 * (ModelState.flowFillHistory). One whose input has neither the record's nor its donor's readings before the
	 * run's start can't be filled as the uninterrupted run filled it, so it is left unfilled, with a warning.
	 */
	resumedFill?: { kinds: readonly GapFillKind[] };
}

/**
 * A filled record over the run's days (PreparedRun.flowFill). `code` is
 * FLOW_FILL_CODE per run day (0 = measured or still missing), `values` the
 * record with its filled days (m³/s, null = missing), `summary` counted over
 * the run. `any`: the fill filled a day anywhere in the stored record, so the
 * run carries its columns (a resumed run of the same record keeps them).
 */
export interface WindowFill {
	code: Uint8Array;
	values: (number | null)[];
	summary: FlowFillSummary;
	any: boolean;
}

/** The run's settings, window and aligned inputs: everything before natural flow. */
export interface PreparedRun {
	warnings: string[];
	settings: ProjectSettings;
	series: ModelInput['series'];
	/** First and last simulated epoch day. */
	start: number;
	end: number;
	days: number;
	startDate: string;
	/**
	 * A project series cut/padded to the run window (null where missing). CHIRPS
	 * comes back bias-corrected on the days it stands in for blank catchment
	 * rain (./rain.ts); every other series, and CHIRPS on other days, as stored.
	 */
	aligned: (kind: SeriesKind) => (number | null)[];
	/** Calendar month (1–12) of each simulated day. */
	month: Uint8Array;
	/** The CHIRPS fallback correction (null without a CHIRPS series). */
	chirpsCorrection: ChirpsCorrection | null;
	/** Catchment rain days set aside as missing (CR-20; null without a catchment rain series). */
	zeroRain: ZeroRainMask | null;
	/** Multi-day accumulations and the days they spread over (engine ≥ 0.20.0, audit B4; null without a catchment rain series). */
	accumulation: AccumulationRun | null;
	/** The double-mass check of catchment rain against CHIRPS (engine ≥ 0.18.0; null without both or too few years). */
	doubleMass: DoubleMass | null;
	/** settings.rainSource as applied, and the per-day `rain_source` column (engine ≥ 0.30.0; null without periods). */
	rainSource: { info: RainSourceInfo; column: Float64Array } | null;
	/** How the daily A-pan series is used (engine ≥ 0.38.0, issue #45; null without one). */
	apanDaily: ApanDailyInfo | null;
	/** The daily reference ET series' use (engine ≥ 1.104.0, ./evaporation/et0Daily.ts); null without one. */
	et0Daily: Et0DailyInfo | null;
	/**
	 * settings.gapRain as applied (engine ≥ 1.101.0, ./gapRain.ts): which
	 * product filled each blank day of the catchment rain, the products' fits
	 * and checks. Null with CHIRPS alone (the default), so such a run is as
	 * before; `aligned('rain_chirps_mm')` is the whole gap fill either way.
	 */
	gapRain: GapRainRun | null;
	/**
	 * The observed flow records settings.flowGapFill fills (engine ≥ 1.23.0,
	 * ./flowGapFill.ts), each aligned to the run: null when no record is
	 * filled. `aligned` returns the filled record only when
	 * settings.qualityFlags.infilled is 'include'; this is where every other reader
	 * (the run's fill columns, the per-day quality flags) finds the fill.
	 */
	flowFill: Partial<Record<GapFillKind, WindowFill>> | null;
	/** The fits, with PrepareOptions.captureFits. */
	fits?: PreparedFits;
	/**
	 * The rainfall stations (engine ≥ 1.91.0, issue #553, docs/model.md
	 * §2.4i): the run's station records and pairings (shared with the units'
	 * forcing), and the catchment's station forcing when
	 * settings.rainStations.catchment applies (then `aligned` reads it as the
	 * catchment rain). Null without settings.rainStations.
	 */
	stations: { context: StationContext; catchment: StationAreaForcing | null; catchmentDays?: StationAreaDays | null; plan: CatchmentStationPlan | null } | null;
}

/** Merge the settings, work out the run window and align the input series to it. */
export function prepareRun(input: ModelInput, options: PrepareOptions = {}): PreparedRun {
	const warnings: string[] = [];
	// A resumed run's pairing factors (engine ≥ 1.91.0) stand in for a fit, as its CHIRPS factors do.
	let settings = withPinnedStationFactors(mergeSettings(input.settings, warnings), options.pinned?.stationFactors);
	// A record's own periods (engine ≥ 1.102.0, issue #611, ./recordPeriods.ts): settings.flowMissing on a flow record and
	// settings.rainStations.unreliable on the alternative gauge are gaps from here on, for every reader of the run.
	const series = withRecordPeriods(settings, input.series ?? {}, warnings);
	// Rainfall stations (engine ≥ 1.91.0, issue #553, docs/model.md §2.4i): with a station for the catchment, its rule
	// is the catchment rain. The catchment gauge's own handling (§2.4b's fit, §2.4c–§2.4e) then reads no gauge: the
	// station's record went through its checks in ./runoff/stationRecord.ts. Without settings.rainStations: as before.
	const stationCtx = settings.rainStations ? stationContext({ settings, series, stations: input.stations, nodes: input.model?.nodes ?? [] }, warnings) : null;
	const plan = stationCtx ? catchmentStationPlan(stationCtx, warnings) : null;
	// The station × catchment MAP ÷ station MAP already takes the point rain to the catchment's level: the areal
	// correction (§2.4g) on top would count that twice, so it is off under a catchment station.
	if (plan && settings.arealRain) {
		warnings.push(`station: the catchment runs on "${plan.ctx.name(plan.assignment.stationId)}" × the catchment MAP ÷ its MAP, so the areal rainfall correction (Calibration → Flow calibration → Rain into GR4J → Areal rainfall correction) is not applied`);
		settings = { ...settings, arealRain: null };
	}
	const work = plan ? stationWork(settings, series, plan, input, warnings) : { settings, series };

	// --- run window ---------------------------------------------------------
	// First the span of every rain series that can drive the run (catchment,
	// CHIRPS, forecast, a rain-source period's series inside its period), as
	// before engine 0.45.0; an explicit simulationStart / End replaces its end.
	// The catchment's station drives it in the catchment gauge's place (engine ≥ 1.91.0).
	const drivers: (DailySeries | undefined)[] = [plan ? plan.record : series.rain_catchment_mm, series.rain_chirps_mm, series.rain_forecast_mm];
	let first = Infinity;
	let last = -Infinity;
	for (const s of drivers) {
		if (!s || s.values.length === 0) continue;
		const d0 = toEpochDay(s.startDate);
		first = Math.min(first, d0);
		last = Math.max(last, d0 + s.values.length - 1);
	}
	// The gap-filling products extend its end, never its start (engine ≥ 1.101.0, settings.gapRain): IMERG Late's recent
	// days reach past CHIRPS', while a product record longer than the rain's (ERA5-Land from 1950) doesn't pull the start back.
	if (settings.gapRain && !plan && Number.isFinite(first))
		for (const k of gapRainKeys(settings.gapRain, series)) {
			const s = (series as Record<string, DailySeries | undefined>)[k.key];
			if (s && s.values.length) last = Math.max(last, toEpochDay(s.startDate) + s.values.length - 1);
		}
	// A rain-source period's series drives the run too, inside its period (engine ≥ 0.30.0).
	for (const p of work.settings.rainSource) {
		const s = series[p.series];
		if (!s || s.values.length === 0) continue;
		const d0 = toEpochDay(s.startDate);
		const a = Math.max(d0, toEpochDay(p.start));
		const b = Math.min(d0 + s.values.length - 1, toEpochDay(p.end));
		if (a > b) continue;
		first = Math.min(first, a);
		last = Math.max(last, b);
	}
	let start = settings.simulationStart ? toEpochDay(settings.simulationStart) : first;
	let end = settings.simulationEnd ? toEpochDay(settings.simulationEnd) : last;
	if (!Number.isFinite(start) || !Number.isFinite(end)) {
		throw new Error('no rainfall series: cannot work out the simulation period');
	}
	if (end < start) throw new Error(`simulation end ${fromEpochDay(end)} is before start ${fromEpochDay(start)}`);
	let prep = alignToWindow(work.settings, work.series, start, end, options, plan);
	// Then (engine ≥ 0.45.0, issue #54) an end left unset moves in to the
	// first / last day whose final rain (catchment, a rain-source period's
	// series, bias-corrected CHIRPS or the forecast, after the zero-run and
	// accumulation handling) has a value: a rain series padded with blanks to
	// a longer flow record would otherwise run decades of 0 mm. Without any
	// rain value the window stays as it was. The second pass only runs when
	// the window moved, so a project whose rain fills its span runs as before.
	if (!settings.simulationStart || !settings.simulationEnd) {
		const [a, b] = rainedDays(prep);
		const s = a >= 0 && !settings.simulationStart ? start + a : start;
		const e = b >= 0 && !settings.simulationEnd ? start + b : end;
		if (s !== start || e !== end) {
			start = s;
			end = e;
			prep = alignToWindow(work.settings, work.series, start, end, options, plan);
		}
		const note = defaultWindowWarning(series, settings, start, end);
		if (note) warnings.push(note);
	}
	warnings.push(...prep.warnings);
	const stations = stationCtx ? { context: stationCtx, catchment: prep.stationForcing, catchmentDays: prep.stationDays, plan } : null;
	const { stationForcing: _f, stationDays: _d, ...rest } = prep;
	if (rest.fits && stationCtx) rest.fits = { ...rest.fits, stationFactors: pairingFactors(stationCtx) };
	return { ...rest, warnings, settings, series, stations };
}

/**
 * The settings and series the catchment rain handling reads under a catchment
 * station: no catchment gauge (its rain is the station's), so no §2.4b fit
 * against it (the station's pairing corrects the CHIRPS), no §2.4c/§2.4d on
 * it and no §2.4e periods (they name the gauge's days; a station that is the
 * catchment gauge, RainStationInput.isCatchmentGauge, gets them through its
 * own checks).
 */
function stationWork(settings: ProjectSettings, series: ModelInput['series'], plan: CatchmentStationPlan, input: ModelInput, warnings: string[]): { settings: ProjectSettings; series: ModelInput['series'] } {
	const gauge = (input.stations?.[plan.assignment.stationId] as { isCatchmentGauge?: boolean } | undefined)?.isCatchmentGauge === true;
	if (settings.rainSource.length && !gauge)
		warnings.push(
			`station: the catchment runs on "${plan.ctx.name(plan.assignment.stationId)}", so the rain-source periods (Model settings → Rain gaps), which name days of the catchment rain series, are not read`
		);
	const { rain_catchment_mm: _gauge, ...rest } = series;
	return { settings: { ...settings, rainSource: [], chirpsBiasCorrection: 'none', chirpsQuantileMap: null }, series: rest };
}

/**
 * The first and last run day (indexes) with rain; −1 when none has any. A day
 * has rain when its final rain has a value, or when it is a recorded
 * catchment reading the zero-run handling set aside and nothing filled (it
 * runs as 0 mm, with its own warning): a recorded zero run at the end of the
 * record is suspect data, not a blank, so it doesn't move the window.
 */
function rainedDays(prep: Pick<PreparedRun, 'aligned' | 'days' | 'zeroRain'>): [number, number] {
	const c = prep.aligned('rain_catchment_mm');
	const ch = prep.aligned('rain_chirps_mm');
	const f = prep.aligned('rain_forecast_mm');
	const setAside = prep.zeroRain?.mask;
	const has = (t: number) => (c[t] ?? ch[t] ?? f[t] ?? null) !== null || !!setAside?.[t];
	let a = 0;
	while (a < prep.days && !has(a)) a++;
	if (a === prep.days) return [-1, -1];
	let b = prep.days - 1;
	while (!has(b)) b--;
	return [a, b];
}

/** The series a run reads besides rain, as the default-window warning names them. */
const OTHER_SERIES_LABEL: [SeriesKind, string][] = [
	['flow_observed_m3s', 'observed flow'],
	['flow_logger_m3s', 'logger flow'],
	['flow_reference_m3s', 'reference flow'],
	['evap_apan_mm', 'daily A-pan evaporation'],
	['evap_et0_mm', 'daily reference evapotranspiration']
];

/**
 * The warning when the default window (an end left unset) leaves out days on
 * which a flow or evaporation series has values, so it is never silent that
 * the run follows the rain rather than, say, a longer gauge record. Null when
 * nothing is left out.
 */
export function defaultWindowWarning(series: ModelInput['series'], settings: Pick<ProjectSettings, 'simulationStart' | 'simulationEnd'>, start: number, end: number): string | null {
	const before: string[] = [];
	const after: string[] = [];
	for (const [kind, label] of OTHER_SERIES_LABEL) {
		const s = series[kind];
		if (!s) continue;
		const d0 = toEpochDay(s.startDate);
		let nBefore = 0;
		let nAfter = 0;
		for (let i = 0; i < s.values.length; i++) {
			const v = s.values[i];
			if (typeof v !== 'number' || !Number.isFinite(v)) continue;
			const day = d0 + i;
			if (day < start) nBefore++;
			else if (day > end) nAfter++;
		}
		if (nBefore && !settings.simulationStart) before.push(`${nBefore} ${nBefore === 1 ? 'day' : 'days'} of ${label}`);
		if (nAfter && !settings.simulationEnd) after.push(`${nAfter} ${nAfter === 1 ? 'day' : 'days'} of ${label}`);
	}
	if (!before.length && !after.length) return null;
	const left = [before.length ? `${before.join(', ')} before it` : '', after.length ? `${after.join(', ')} after it` : ''].filter(Boolean);
	const which = before.length && after.length ? 'start and end' : before.length ? 'start' : 'end';
	return (
		`the run covers the rain record, ${dayText(fromEpochDay(start))} to ${dayText(fromEpochDay(end))}, and leaves out ${left.join(', and ')} ` +
		`(no rain there): set the simulation ${which} (Model settings → Simulation period) to include them`
	);
}

/** Everything prepareRun does once the window is fixed: align the series to it and apply the rain handling. */
function alignToWindow(
	settings: ProjectSettings,
	series: ModelInput['series'],
	start: number,
	end: number,
	options: PrepareOptions = {},
	plan: CatchmentStationPlan | null = null
): Omit<PreparedRun, 'settings' | 'series' | 'stations'> & { stationForcing: StationAreaForcing | null; stationDays: StationAreaDays | null } {
	const warnings: string[] = [];
	const days = end - start + 1;
	const startDate = fromEpochDay(start);
	const month = new Uint8Array(days);
	for (let t = 0; t < days; t++) month[t] = monthOfEpochDay(start + t);

	// Rain used = catchment ?? CHIRPS ?? forecast; CHIRPS is bias-corrected
	// where it fills in (audit B1). Catchment rain is blanked first on the days
	// settings.zeroRainRuns sets aside (CR-20), so they fall back too, and a
	// multi-day accumulation's recorded total is spread over the days it
	// covers (audit B4), which the zero-run fill then leaves alone. Every
	// consumer (runoff models, demand, calibration, the runoff coefficient)
	// reads the rain through `aligned`.
	// settings.chirpsFitPeriod (engine ≥ 0.29.0, issue #40): which years the CHIRPS factors are fitted on.
	// settings.rainSource (engine ≥ 0.30.0, issue #40 (b), ./rainSourcePeriods.ts):
	// periods whose catchment rain comes from another series × monthly
	// factors. Their primary reading is left out of every fit and of the
	// zero-run handling, and replaced after the accumulations are applied.
	// settings.dataQuality (engine ≥ 1.20.0): its zero-run and low-vs-CHIRPS limits decide which rain is suspect, everywhere below.
	const dq = settings.dataQuality;
	const doubleMass = doubleMassOf(series, settings.zeroRainRuns, dq);
	const { chirpsCorrection, chirpsFit, zeroRain, catchment, accumulation, rsFit, rainSource, gapFits, gapFitsCaptured } = checkedRain(
		plan && settings.gapRain ? { ...settings, gapRain: null } : settings,
		series,
		start,
		days,
		options
	);
	// settings.gapRain (engine ≥ 1.101.0, ./gapRain.ts): not under a catchment station, whose pairing fills its own gaps (§2.4i).
	const gap = settings.gapRain && !plan ? settings.gapRain : null;
	if (settings.gapRain && plan) warnings.push('gap-filling product ignored: the catchment runs on a rainfall station, whose pairing fills its gaps with CHIRPS (Model settings → Rain gaps)');
	// CHIRPS has no negative rain: a value below 0 is a no-data code (the product's −9999), missing as the factor
	// fit and the accumulation check already read it, so it neither blocks the forecast fallback nor runs as rain
	// (engine ≥ 1.69.0, §2.4b). The series checks already warn about each negative value.
	const chirpsClean = alignSeries(series.rain_chirps_mm, start, days).map((v) => (v !== null && !(v >= 0) ? null : v));
	const chirpsRaw = chirpsClean.slice();
	if (rainSource) for (let t = 0; t < days; t++) if (rainSource.blockChirps[t]) chirpsRaw[t] = null;
	// ERA5-Land in CHIRPS' place: CHIRPS fills no gap (its fit is still reported, against the same catchment rain).
	if (gap?.product === 'era5l') chirpsRaw.fill(null);
	const chirpsCorrected = chirpsCorrection ? applyChirpsCorrection(chirpsCorrection, catchment, chirpsRaw, month, start, series.rain_chirps_mm) : null;
	// The catchment's station (engine ≥ 1.91.0, §2.4i): its days × the MAP ratio are the catchment rain, and the CHIRPS
	// × its pairing's factors fills the others (null where it can't, so the forecast does).
	const station = plan ? catchmentStationForcing(plan, start, days, chirpsClean, alignSeries(series.rain_forecast_mm, start, days)) : null;
	if (station) {
		for (let t = 0; t < days; t++) catchment[t] = station.catchment[t]!;
		warnings.push(...station.warnings);
	}
	const chirpsBase = station ? station.chirps : chirpsCorrected;
	// The other products write into CHIRPS' blank gap days, so every reader of the gap fill (rain used, the zero-run fill,
	// the rain-source fallback, the accumulations) reads the whole fill through aligned('rain_chirps_mm').
	const gapRain = gap
		? applyGapRain({
				gap,
				fits: gapFits,
				series,
				base: chirpsBase ?? (gap.product === 'era5l' ? chirpsRaw : chirpsClean),
				catchment,
				block: rainSource?.blockChirps ?? null,
				month,
				start,
				days,
				zeroRain: settings.zeroRainRuns,
				dq,
				align: alignSeries,
				warnings
			})
		: null;
	const chirpsUsed = gapRain ? gapRain.values : chirpsBase;
	// Gap filling of the observed flow records (engine ≥ 1.23.0, ./flowGapFill.ts): read in place of the record only when settings.qualityFlags.infilled scores infilled days.
	const flowFill = flowFillsFor(settings, series, start, days, warnings, options.resumedFill);
	// One control for scoring filled days (engine ≥ 1.23.0): the quality flags' infilled treatment.
	const readFilled = settings.qualityFlags.infilled === 'include';
	const aligned = (kind: SeriesKind) =>
		kind === 'rain_catchment_mm'
			? catchment.slice()
			: kind === 'rain_chirps_mm'
				? (chirpsUsed ?? chirpsClean).slice()
				: readFilled && flowFill?.[kind as GapFillKind]
					? flowFill[kind as GapFillKind]!.values.slice()
					: FLOW_KINDS.has(kind)
						? alignFlow(series[kind], start, days)
						: alignSeries(series[kind], start, days);
	const chirpsNote = chirpsCorrectionWarning(chirpsCorrection);
	if (chirpsNote) warnings.push(chirpsNote);
	const qmNote = chirpsQuantileMapFallbackWarning(chirpsCorrection);
	if (qmNote) warnings.push(qmNote);
	warnings.push(...keepDryDoubtWarnings(chirpsCorrection));
	// A double-mass break: does CHIRPS fill days in an era whose ratio differs from the fit's?
	// Under ERA5-Land in its place (engine ≥ 1.101.0) CHIRPS fills no day, so its break warns of none; ERA5-Land's own check warns.
	const dmNote = doubleMassRunWarning(doubleMass, chirpsCorrection, catchment, gap?.product === 'era5l' ? chirpsRaw : alignSeries(series.rain_chirps_mm, start, days), start);
	if (dmNote) warnings.push(dmNote);
	if (zeroRain) {
		const chirps = aligned('rain_chirps_mm');
		const forecast = aligned('rain_forecast_mm');
		finishZeroRainInfill(zeroRain, (t) => chirps[t] ?? forecast[t] ?? null);
		warnings.push(...zeroRainWarnings(zeroRain.infill));
	}
	const rainSourceColumn = rainSource ? finishRainSource(rainSource, catchment, aligned('rain_chirps_mm'), aligned('rain_forecast_mm'), start, gapRain?.code) : null;
	if (rainSource) warnings.push(...rainSourcePeriodWarnings(rainSource.info));
	if (accumulation) {
		// What CHIRPS (then forecast) put on a reading set aside after a blank outage (engine ≥ 1.70.0, §2.4d).
		const chirps = aligned('rain_chirps_mm');
		const forecast = aligned('rain_forecast_mm');
		finishSetAside(accumulation, start, (t) => chirps[t] ?? forecast[t] ?? null);
		// Left as recorded while CHIRPS fills the days before it: a detected window's run days (engine ≥ 1.84.0,
		// blank days or a flagged zero run's), a listed window's flagged zero-run days, or the blank outage it ends.
		// That rain may count twice.
		const filled = (w: { start: string; end: string; source: 'detected' | 'listed' }) => {
			if (w.source === 'detected') return true;
			if (!zeroRain) return false;
			for (let d = Math.max(toEpochDay(w.start), start); d <= Math.min(toEpochDay(w.end), end); d++) if (zeroRain.mask[d - start]) return true;
			return false;
		};
		const doubled = accumulation.info.windows.filter((w) => w.status === 'asRecorded' && (w.outageDays != null || filled(w)));
		warnings.push(...accumulationWarnings(accumulation.info, doubled));
	}

	// Daily A-pan (issue #45): every consumer reads it through `aligned`; this only counts and warns.
	const apanDaily = apanDailyInfo(series.evap_apan_mm, alignSeries(series.evap_apan_mm, start, days), start, settings.apanMm.every((v) => v === 0), warnings);
	// Daily reference ET (issue #604 R5-E): GR4J reads it through `aligned` under a monthly PE row; this only counts and warns.
	const et0Daily = et0DailyInfo(
		series.evap_et0_mm,
		alignSeries(series.evap_et0_mm, start, days),
		start,
		settings.pe,
		settings.pe?.kind === 'monthly' && settings.pe.mm.every((v) => v === 0),
		warnings
	);

	if (!plan && !hasRainInput(series, settings.rainSource)) {
		warnings.push(warn('rain.none', {}, 'no rainfall series: natural flow is only what drains from the stores the warm-up filled, and demand is not reduced by rain'));
	}

	return {
		warnings,
		start,
		end,
		days,
		startDate,
		aligned,
		month,
		chirpsCorrection,
		zeroRain,
		accumulation,
		doubleMass,
		rainSource: rainSource ? { info: rainSource.info, column: rainSourceColumn! } : null,
		apanDaily,
		et0Daily,
		flowFill,
		gapRain,
		stationForcing: station?.forcing ?? null,
		stationDays: station?.days ?? null,
		...(options.captureFits ? { fits: { chirpsCorrection: chirpsFit, rainSourceFactors: rsFit, ...(gapFitsCaptured ? { gapRain: gapFitsCaptured } : {}) } } : {})
	};
}

/** The catchment rain checks' outputs over a window (checkedRain). */
export interface CheckedRain {
	chirpsCorrection: ChirpsCorrection | null;
	chirpsFit: ChirpsCorrection | null;
	zeroRain: ZeroRainMask | null;
	/** The catchment rain aligned to the window after §2.4c, §2.4d and §2.4e: null where it has no value or a check set the reading aside. */
	catchment: (number | null)[];
	accumulation: AccumulationRun | null;
	rsFit: PreparedFits['rainSourceFactors'];
	rainSource: ReturnType<typeof applyRainSource> | null;
	/** settings.gapRain's product fits (engine ≥ 1.101.0); empty with CHIRPS alone. */
	gapFits: GapRainFits;
	/** Their copy before any run counts, with PrepareOptions.captureFits and settings.gapRain; else null. */
	gapFitsCaptured: GapRainFits | null;
}

/**
 * The checked catchment rain over the window start … start + days − 1: the
 * stored reading with §2.4c's suspect zero runs and listed missing periods
 * set aside (null), §2.4d's accumulations spread or set aside, and §2.4e's
 * rain-source periods written in. Every check reads the whole stored record,
 * so a day's value doesn't depend on the window. The rain rule 2 of per-unit
 * rain scales, and (issue #500, 1c) the rain the reference gauge's factors
 * are fitted on.
 */
export function checkedRain(settings: ProjectSettings, series: ModelInput['series'], start: number, days: number, options: PrepareOptions = {}): CheckedRain {
	// The alternative gauge's unreliable periods (engine ≥ 1.102.0, issue #611): blank wherever its rain-source periods
	// read it, whoever calls (prepareRun has blanked them already and warned; this repeats nothing there).
	series = withRecordPeriods({ rainStations: settings.rainStations, flowMissing: null }, series, []);
	const dq = settings.dataQuality;
	const checks = { dq, chirps: series.rain_chirps_mm ?? null };
	const replaced = rainSourceSpans(settings.rainSource);
	const isReplaced = (day: number) => replaced.some((w) => day >= w.from && day <= w.to);
	const fitOpts = { fitPeriod: settings.chirpsFitPeriod, ...(replaced.length ? { replaced } : {}), dq };
	const acc = rainAccumulations(series, settings.zeroRainRuns, settings.chirpsBiasCorrection, fitOpts);
	const claimed = new Set<number>();
	for (const w of acc?.windows ?? []) if (claimsDays(w.status)) for (let d = w.from; d <= w.to; d++) claimed.add(d);
	const zeroRain = zeroRainMask(series.rain_catchment_mm, settings.zeroRainRuns, start, days, (day) => claimed.has(day), isReplaced, checks);
	const pinned = options.pinned;
	// A pinned fit (a resumed run) stands in for the input's own; without a CHIRPS series there is nothing to correct.
	const chirpsCorrection =
		pinned?.chirpsCorrection && series.rain_chirps_mm
			? clonePlain(pinned.chirpsCorrection)
			: chirpsBiasFactors(series, settings.chirpsBiasCorrection, settings.zeroRainRuns, fitExcludedWindows(acc), {
					...fitOpts,
					// The gap map (engine ≥ 1.53.0, CR-23): fitted with the factors, on the same days.
					...(settings.chirpsQuantileMap ? { quantileMap: settings.chirpsQuantileMap } : {})
				});
	const chirpsFit = options.captureFits && chirpsCorrection ? clonePlain(chirpsCorrection) : null;
	if (acc) spreadAccumulations(acc, series.rain_chirps_mm, chirpsCorrection);
	const catchment = blankMasked(alignSeries(series.rain_catchment_mm, start, days), zeroRain);
	const accumulation = acc ? applyAccumulations(acc, catchment, start) : null;
	const rsFactors = settings.rainSource.length ? rainSourceFactors(series, settings.rainSource, settings.zeroRainRuns, fitExcludedWindows(acc), dq) : [];
	const rsKeys = options.pinned || options.captureFits ? settings.rainSource.map((p) => stableStringify(p)) : [];
	if (pinned) {
		rsKeys.forEach((key, k) => {
			const pin = pinned.rainSourceFactors.find((f) => f.key === key);
			if (pin) rsFactors[k] = clonePlain(pin.factors);
		});
	}
	const rsFit = options.captureFits ? rsKeys.map((key, k) => ({ key, factors: clonePlain(rsFactors[k]!) })) : [];
	const rainSource = settings.rainSource.length ? applyRainSource(series, settings.rainSource, rsFactors, catchment, start) : null;
	// The gap-filling products' fits (engine ≥ 1.101.0, ./gapRain.ts): §2.4b's fit against each, on the same suspect days left out.
	const gapFits = settings.gapRain
		? fitGapProducts(settings.gapRain, series, settings.zeroRainRuns, fitExcludedWindows(acc), { ...(replaced.length ? { replaced } : {}), dq }, pinned?.gapRain)
		: [];
	const gapFitsCaptured = options.captureFits && settings.gapRain ? clonePlain(gapFits) : null;
	return { chirpsCorrection, chirpsFit, zeroRain, catchment, accumulation, rsFit, rainSource, gapFits, gapFitsCaptured };
}

/**
 * The checked catchment rain (checkedRain) over the whole stored record: the
 * catchment gauge's span and every rain-source period's days with a reading
 * of its series. Null without either. Issue #500 decision 1c: the reference
 * gauge's monthly factors (runoff/unitRain.ts referenceFit) are fitted on
 * this, not on the series as stored. `fitExcludeAccumulations` blanks every
 * accumulation window's days but a reading kept as recorded, as the §2.4b fit
 * leaves them out (fitExcludedWindows): a spread window's days are shaped
 * from CHIRPS, so fitting gauge against CHIRPS on them would pull a factor
 * towards 1.
 */
export function checkedCatchmentRainRecord(settings: ProjectSettings, series: ModelInput['series'], opts: { fitExcludeAccumulations?: boolean } = {}): DailySeries | null {
	let first = Infinity;
	let last = -Infinity;
	const s = series.rain_catchment_mm;
	if (s && s.values.length) {
		first = toEpochDay(s.startDate);
		last = first + s.values.length - 1;
	}
	for (const p of settings.rainSource) {
		const alt = series[p.series];
		if (!alt || alt.values.length === 0) continue;
		const d0 = toEpochDay(alt.startDate);
		const a = Math.max(d0, toEpochDay(p.start));
		const b = Math.min(d0 + alt.values.length - 1, toEpochDay(p.end));
		if (a > b) continue;
		first = Math.min(first, a);
		last = Math.max(last, b);
	}
	if (!Number.isFinite(first)) return null;
	// Only the catchment rain is read here, so no gap-filling product is fitted (engine ≥ 1.101.0).
	const r = checkedRain({ ...settings, gapRain: null }, series, first, last - first + 1);
	if (opts.fitExcludeAccumulations) blankFitExcluded(r, first);
	return { startDate: fromEpochDay(first), values: r.catchment };
}

/**
 * Blank (in place) the days of `r.catchment` (aligned from epoch day `start`)
 * in an accumulation window the §2.4b fit leaves out: every window but a
 * reading kept as recorded (fitExcludedWindows' rule).
 */
export function blankFitExcluded(r: Pick<CheckedRain, 'catchment' | 'accumulation'>, start: number): void {
	for (const w of r.accumulation?.info.windows ?? []) {
		if (w.status === 'kept') continue;
		const from = Math.max(toEpochDay(w.start), start);
		const to = Math.min(toEpochDay(w.end), start + r.catchment.length - 1);
		for (let d = from; d <= to; d++) r.catchment[d - start] = null;
	}
}

/** Each record settings.flowGapFill fills, aligned to the run, with its warning; null when none is. */
function flowFillsFor(
	settings: ProjectSettings,
	series: ModelInput['series'],
	start: number,
	days: number,
	warnings: string[],
	resumed?: PrepareOptions['resumedFill']
): Partial<Record<GapFillKind, WindowFill>> | null {
	let out: Partial<Record<GapFillKind, WindowFill>> | null = null;
	for (const kind of GAP_FILL_KINDS) {
		const spec = settings.flowGapFill[kind];
		const record = series[kind];
		if (!specFills(spec) || !record) continue;
		const donor = spec.donor ? (series[spec.donor] ?? null) : null;
		// The fill reads the whole record (a gap's bounds, the highest reading it clamps to) and the donor's overlap
		// with it (the ratio). Resumed without the history it read, it would fill other values: leave it out, and say so.
		if (resumed?.kinds.includes(kind) && !hasReadingBefore(record, start) && !hasReadingBefore(donor, start)) {
			warnings.push(
				`Resumed from ${dayText(fromEpochDay(start))} without the ${gapFillRecordLabel(kind)} record's history: its gap fill is left out (the fill reads the whole record: the gaps' bounds, the highest reading and the donor ratio). Include the history in the input, or run from the start, to fill it.`
			);
			continue;
		}
		// A reading above a low-flow period's threshold anchors nothing and is out of the ratio and the clamp (issue #567).
		const f = fillFlowGaps(kind, record, spec, donor, gapFillLowFlow(settings.qualityFlags.lowFlowPeriods, kind, record, spec.donor, donor));
		const summary = fillSummaryInWindow(f, start, days);
		const code = new Uint8Array(days);
		const offset = toEpochDay(f.startDate) - start;
		for (let i = Math.max(0, -offset); i < Math.min(f.code.length, days - offset); i++) code[i + offset] = f.code[i]!;
		const note = flowFillWarning(summary, settings.qualityFlags.infilled === 'include');
		if (note) warnings.push(note);
		(out ??= {})[kind] = {
			code,
			values: alignSeries({ startDate: f.startDate, values: f.values }, start, days),
			summary,
			any: f.summary.interpolatedDays + f.summary.donorDays > 0
		};
	}
	return out;
}

/** The flow series kinds (m³/s): a record a gauge or logger reads, never below zero. */
const FLOW_KINDS: ReadonlySet<SeriesKind> = new Set(['flow_observed_m3s', 'flow_logger_m3s', 'flow_reference_m3s']);

/**
 * A flow record aligned to the run, a negative value as missing (engine
 * 1.16.0, issue #51). A flow is never below zero, so a negative one is a
 * placeholder, the -999 of a re-saved DWS export or a logger's -1 "no
 * reading", and the DWS import already reads it as a gap (dws.ts). Scored
 * as a value it dragged every calibration statistic towards it; now the
 * calibration, the fit, the plausibility checks and the observed_flow
 * series all skip it, and the negative-values data-quality warning says so.
 */
export function alignFlow(s: DailySeries | undefined, start: number, days: number): (number | null)[] {
	const out = alignSeries(s, start, days);
	for (let t = 0; t < days; t++) if (out[t] !== null && out[t]! < 0) out[t] = null;
	return out;
}

export function alignSeries(s: DailySeries | undefined, start: number, days: number): (number | null)[] {
	const out = new Array<number | null>(days).fill(null);
	if (!s) return out;
	const offset = toEpochDay(s.startDate) - start;
	const from = Math.max(0, -offset);
	const to = Math.min(s.values.length, days - offset);
	for (let i = from; i < to; i++) {
		const v = s.values[i];
		out[i + offset] = typeof v === 'number' && Number.isFinite(v) ? v : null;
	}
	return out;
}

const WATER_YEAR_MONTH_NAMES = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];

export function monthly(v: unknown, name: string, warnings: string[]): Monthly {
	const arr = Array.isArray(v) ? v : [];
	if (arr.length !== 12) warnings.push(`${name} should have 12 monthly values, has ${arr.length}; missing months are 0`);
	return Array.from({ length: 12 }, (_, i) => {
		const x = Number(arr[i]);
		return Number.isFinite(x) ? x : 0;
	}) as unknown as Monthly;
}

export function mergeSettings(raw: ModelInput['settings'], warnings: string[]): ProjectSettings {
	const d = defaultProjectSettings();
	const s = { ...d, ...(raw ?? {}) } as ProjectSettings;
	// Only the keys that outlived the legacy runoff model (engine 1.0.0): a stored project may still carry its others.
	const cal = { ...((raw?.calibration as Record<string, unknown> | undefined) ?? {}) };
	for (const k of RETIRED_CALIBRATION_KEYS) delete cal[k];
	s.calibration = { ...d.calibration, ...cal };
	s.gr4j = { ...d.gr4j, ...((raw?.gr4j as object | undefined) ?? {}) };
	s.panCoefficient = monthly(s.panCoefficient, 'pan coefficient', warnings);
	s.dataQuality = resolveDataQuality(raw?.dataQuality, warnings);
	s.zeroRainRuns = resolveZeroRain(raw?.zeroRainRuns, warnings);
	s.wr2012 = resolveWr2012(raw?.wr2012, warnings);
	s.ewrRules = resolveEwrRules(raw?.ewrRules, warnings);
	s.qualityFlags = resolveQualityFlags(raw?.qualityFlags, warnings);
	s.apanMm = monthly(s.apanMm, 'A-pan evaporation', warnings);
	// Evaporation is a loss: a negative month would make the dams and pools gain water (the daily series already treats
	// a negative day as missing; scenarios and the API refuse it). 0, with a warning (engine ≥ 1.69.0).
	if (s.apanMm.some((v) => v < 0)) {
		warnings.push('A-pan evaporation below 0 in some months; using 0 there');
		s.apanMm = s.apanMm.map((v) => Math.max(v, 0)) as unknown as Monthly;
	}
	s.ewrPragmaticM3PerDay = monthly(s.ewrPragmaticM3PerDay, 'pragmatic EWR', warnings);
	// A requirement below 0 would read as met by any flow; the API and scenarios refuse it (engine ≥ 1.69.0).
	if (s.ewrPragmaticM3PerDay.some((v) => v < 0)) {
		warnings.push('pragmatic EWR below 0 in some months; using 0 there');
		s.ewrPragmaticM3PerDay = s.ewrPragmaticM3PerDay.map((v) => Math.max(v, 0)) as unknown as Monthly;
	}
	// The daily outlet EWR's source (engine ≥ 1.77.0, ./reserve/dailySource.ts): null = the pragmatic EWR, as is an
	// unusable one (with a warning). Only when stored, so settings without it normalise as before.
	if (raw?.ewrDailySource !== undefined) s.ewrDailySource = resolveEwrDailySource(raw.ewrDailySource, warnings);
	if (typeof s.lakeEvapFactor !== 'number' || !Number.isFinite(s.lakeEvapFactor) || s.lakeEvapFactor < 0) {
		warnings.push(`dam evaporation factor "${String(s.lakeEvapFactor)}" is not a number ≥ 0; using ${d.lakeEvapFactor}`);
		s.lakeEvapFactor = d.lakeEvapFactor;
	}
	// Monthly lake factors (WP-3.5): 12 numbers ≥ 0, or none.
	if (s.lakeEvapFactorMonthly != null) {
		const k = s.lakeEvapFactorMonthly;
		if (!Array.isArray(k) || k.length !== 12 || !k.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0)) {
			warnings.push(`monthly dam evaporation factors should be 12 numbers ≥ 0; using ${s.lakeEvapFactor} in every month`);
			s.lakeEvapFactorMonthly = null;
		}
	}
	// The scalar first: the monthly row's fallback names it (engine ≥ 1.69.0, as the API and scenarios hold it).
	if (typeof s.effectiveRainFraction !== 'number' || !(s.effectiveRainFraction >= 0 && s.effectiveRainFraction <= 1)) {
		warnings.push(`effective rain fraction "${String(s.effectiveRainFraction)}" is not a number from 0 to 1; using ${d.effectiveRainFraction}`);
		s.effectiveRainFraction = d.effectiveRainFraction;
	}
	// Monthly effective-rain fractions (engine ≥ 0.43.0, issue #54): 12 numbers in [0, 1], or none.
	if (s.effectiveRainFractionMonthly != null) {
		const f = s.effectiveRainFractionMonthly;
		if (!Array.isArray(f) || f.length !== 12 || !f.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1)) {
			warnings.push(`monthly effective rain fractions should be 12 numbers from 0 to 1; using ${s.effectiveRainFraction} in every month`);
			s.effectiveRainFractionMonthly = null;
		} else if (f.every((x) => x === 0)) {
			// Allowed (it is the modeller's call), but never quietly: the AI workbook's all-zero row is this (issue #54).
			warnings.push('the monthly effective rain fraction is 0 in every month, so rain never reduces irrigation demand');
		}
	}
	// The same ranges the API and scenarios hold these to (scenario/ops.ts SETTINGS_CHECKS), so a direct input can't
	// make rain raise demand or February's demand NaN (engine ≥ 1.69.0).
	if (typeof s.februaryDays !== 'number' || !(s.februaryDays >= 28 && s.februaryDays <= 29)) {
		warnings.push(`February days "${String(s.februaryDays)}" is not a number from 28 to 29; using ${d.februaryDays}`);
		s.februaryDays = d.februaryDays;
	}
	if (typeof s.calibration.rainThresholdMm !== 'number' || !(s.calibration.rainThresholdMm >= 0 && s.calibration.rainThresholdMm <= 1000)) {
		warnings.push(`rain threshold "${String(s.calibration.rainThresholdMm)}" mm is not a number from 0 to 1000; using ${d.calibration.rainThresholdMm} mm`);
		s.calibration.rainThresholdMm = d.calibration.rainThresholdMm;
	}
	if (typeof s.effectiveRainStoreMm !== 'number' || !Number.isFinite(s.effectiveRainStoreMm) || s.effectiveRainStoreMm < 0) {
		warnings.push(`soil-water store "${String(s.effectiveRainStoreMm)}" mm is not a size ≥ 0; using ${d.effectiveRainStoreMm} mm`);
		s.effectiveRainStoreMm = d.effectiveRainStoreMm;
	}
	if (s.calibrationFlowKind != null && !CALIBRATION_FLOW_KINDS.includes(s.calibrationFlowKind)) {
		warnings.push(`unknown calibration flow series "${String(s.calibrationFlowKind)}"; using the default`);
		s.calibrationFlowKind = null;
	}
	s.calibrationFlowKind ??= null;
	// The calibration site (engine ≥ 1.41.0): a node id, or null for the outlet. Whether it is a gauge with a record is calibrate()'s to say.
	if (s.calibrationSiteNodeId != null && (typeof s.calibrationSiteNodeId !== 'string' || !s.calibrationSiteNodeId)) {
		warnings.push(`calibration site ${JSON.stringify(s.calibrationSiteNodeId)} is not a hydrological unit id; calibrating at the outlet`);
		s.calibrationSiteNodeId = null;
	}
	s.calibrationSiteNodeId ??= null;
	s.calibrationExclusions = sanitizeExclusions(raw?.calibrationExclusions, warnings);
	// One flow record's missing periods and the kept data checks (engine ≥ 1.102.0, issue #611, ./recordPeriods.ts):
	// only when stored, so settings without them normalise as before.
	if (raw?.flowMissing != null) {
		const fm = resolveFlowMissing(raw.flowMissing, warnings);
		if (fm) s.flowMissing = fm;
		else delete s.flowMissing;
	}
	if (raw?.checksKept != null) {
		const kept = resolveChecksKept(raw.checksKept, warnings);
		if (kept) s.checksKept = kept;
		else delete s.checksKept;
	}
	// The kept run warnings and problems (issue #611): the Warnings page's list, never read by the model.
	if (raw?.warningsKept != null) {
		const kept = resolveWarningsKept(raw.warningsKept, warnings);
		if (kept) s.warningsKept = kept;
		else delete s.warningsKept;
	}
	// Gap filling of the observed flow records (engine ≥ 1.23.0, ./flowGapFill.ts): off unless a record has a spec.
	s.flowGapFill = resolveFlowGapFill(raw?.flowGapFill, warnings);
	// Provenance only: never read by the model.
	s.fitRecord = (raw?.fitRecord as ProjectSettings['fitRecord'] | undefined) ?? null;
	for (const key of ['calibrationStart', 'calibrationEnd'] as const) {
		const v = s[key];
		if (v == null || v === '') {
			s[key] = null;
		} else if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
			warnings.push(`${key} "${String(v)}" is not an ISO date (YYYY-MM-DD); ignored`);
			s[key] = null;
		}
	}
	// The seasonal outlook's demand-factor start (engine ≥ 0.44.0, issue #53 R5).
	if (s.demandFactorFrom !== null && s.demandFactorFrom !== undefined) {
		const v = s.demandFactorFrom;
		if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
			warnings.push(`demandFactorFrom "${String(v)}" is not an ISO date (YYYY-MM-DD); demand factors apply on every day`);
			s.demandFactorFrom = null;
		}
	}
	// The review triggers' storage reset (engine ≥ 0.46.0, issue #53 R6): its shape here, its nodes and day in buildNetworkPlan.
	if (s.damStorageReset !== null && s.damStorageReset !== undefined) {
		const v = s.damStorageReset as unknown;
		const date = v && typeof v === 'object' ? (v as { date?: unknown }).date : undefined;
		const storage = v && typeof v === 'object' ? (v as { storageM3?: unknown }).storageM3 : undefined;
		if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || !storage || typeof storage !== 'object' || Array.isArray(storage)) {
			warnings.push('damStorageReset needs an ISO date (YYYY-MM-DD) and a storage per dam; ignored');
			s.damStorageReset = null;
		}
	}
	if (s.calibrationStart && s.calibrationEnd && s.calibrationStart > s.calibrationEnd) {
		warnings.push(
			warn(
				'calibration.windowReversed',
				{ start: s.calibrationStart, end: s.calibrationEnd },
				`calibration window ${dayText(s.calibrationStart)} … ${dayText(s.calibrationEnd)} ends before it starts; scoring the whole record`
			)
		);
		s.calibrationStart = null;
		s.calibrationEnd = null;
	}
	if ((s.runoffModel as string) === 'legacy') {
		warnings.push(LEGACY_UPGRADED_WARNING);
		s.runoffModel = d.runoffModel;
	} else if (!(RUNOFF_MODELS as readonly string[]).includes(s.runoffModel)) {
		warnings.push(`unknown runoff model "${String(s.runoffModel)}"; using ${d.runoffModel}`);
		s.runoffModel = d.runoffModel;
	}
	s.pe = resolvePe(raw?.pe, warnings);
	// The areal rainfall correction (engine ≥ 1.13.0, docs/model.md §2.4g).
	s.arealRain = resolveArealRain(raw?.arealRain, warnings);
	// Per-unit rain (engine ≥ 1.78.0, §2.4h): only when stored, so settings without it normalise as before.
	if (raw?.unitRain !== undefined) s.unitRain = resolveUnitRain(raw.unitRain, warnings);
	// Rainfall stations (engine ≥ 1.91.0, §2.4i): only when stored, likewise.
	if (raw?.rainStations !== undefined) s.rainStations = resolveRainStations(raw.rainStations, warnings);
	if (s.arealRain?.method === 'fitted') warnings.push(AREAL_RAIN_FITTED_WARNING);
	// Provenance only (never read by the model): a string, capped like the PE source.
	s.panCoefficientSource = typeof raw?.panCoefficientSource === 'string' ? raw.panCoefficientSource.slice(0, PE_SOURCE_MAX) : '';
	// Engine ≥ 1.49.0: where the dam evaporation factors came from (a lake-factor preset's note), provenance only.
	s.lakeEvapFactorSource = typeof raw?.lakeEvapFactorSource === 'string' ? raw.lakeEvapFactorSource.slice(0, PE_SOURCE_MAX) : '';
	// The Kp plausibility check only means something when GR4J's PE is Kp × A-pan.
	if (s.pe.kind === 'pan') {
		const months = panCoefficientOutOfRange(s.panCoefficient);
		if (months.length) {
			const names = months.map((i) => WATER_YEAR_MONTH_NAMES[i]).join(', ');
			warnings.push(
				`pan coefficient is outside FAO-56's typical Class A pan range (${PAN_COEFFICIENT_TYPICAL_MIN}–${PAN_COEFFICIENT_TYPICAL_MAX}) in ${names}: confirm against local humidity and wind`
			);
		}
	}
	s.chirpsFitPeriod = resolveChirpsFitPeriod(raw?.chirpsFitPeriod, warnings);
	s.rainSource = resolveRainSource(raw?.rainSource, warnings);
	if (!(CHIRPS_BIAS_MODES as readonly string[]).includes(s.chirpsBiasCorrection)) {
		warnings.push(`unknown CHIRPS bias correction "${String(s.chirpsBiasCorrection)}"; using ${d.chirpsBiasCorrection}`);
		s.chirpsBiasCorrection = d.chirpsBiasCorrection;
	}
	// The CHIRPS gap map (engine ≥ 1.53.0, CR-23): maps the factor-corrected CHIRPS, so it needs the monthly correction.
	s.chirpsQuantileMap = resolveChirpsQuantileMap(raw?.chirpsQuantileMap, warnings);
	// The gap-filling product (engine ≥ 1.101.0, issue #604 R4-B): null = CHIRPS alone, the default.
	s.gapRain = resolveGapRain(raw?.gapRain, warnings);
	if (s.chirpsQuantileMap && s.chirpsBiasCorrection !== 'monthly') {
		warnings.push('CHIRPS quantile map ignored: it maps bias-corrected CHIRPS, and CHIRPS bias correction is off (Model settings → Rain gaps → CHIRPS gap filling → CHIRPS bias correction)');
		s.chirpsQuantileMap = null;
	}
	if (s.assuranceAnnualThreshold !== undefined && !(typeof s.assuranceAnnualThreshold === 'number' && s.assuranceAnnualThreshold > 0 && s.assuranceAnnualThreshold <= 1)) {
		warnings.push(`annual assurance threshold "${String(s.assuranceAnnualThreshold)}" is not a fraction in (0, 1]; using ${DEFAULT_ANNUAL_THRESHOLD}`);
		delete s.assuranceAnnualThreshold;
	}
	// Reserve method choices (engine ≥ 1.3.0, issue #64): an unknown value runs today's default.
	if (!(EWR_CHARGE_SOURCES as readonly unknown[]).includes(s.ewrChargeSource)) {
		if (s.ewrChargeSource !== undefined) warnings.push(`unknown EWR charge source "${String(s.ewrChargeSource)}"; using pragmatic`);
		s.ewrChargeSource = 'pragmatic';
	}
	if (!(LOW_FLOW_MEASURES as readonly unknown[]).includes(s.lowFlowMeasure)) {
		if (s.lowFlowMeasure !== undefined) warnings.push(`unknown low-flow measure "${String(s.lowFlowMeasure)}"; using total`);
		s.lowFlowMeasure = 'total';
	}
	// Allocations (engine ≥ 1.18.0, issue #72): an unknown mode only compares; a tolerance outside [0, 1) takes the default.
	s.allocationMode = resolveAllocationMode(s.allocationMode, warnings);
	if (!(typeof s.allocationTolerance === 'number' && s.allocationTolerance >= 0 && s.allocationTolerance < 1)) {
		if (s.allocationTolerance !== undefined) warnings.push(`allocation tolerance "${String(s.allocationTolerance)}" is not a fraction in [0, 1); using ${DEFAULT_ALLOCATION_TOLERANCE}`);
		s.allocationTolerance = DEFAULT_ALLOCATION_TOLERANCE;
	}
	// A retired flow-share method the flow no longer follows (engine 1.105.0, issue #616): the run says so once. Area ran
	// the same way to within rounding while every unit ran on the catchment rain, so it needs no note.
	const method = (raw as Record<string, unknown> | undefined)?.flowShareMethod;
	if (method === 'hiLo' || method === 'manual') warnings.push(flowShareMethodRetiredWarning(method));
	// Retired settings (engine ≥ 1.105.0, RETIRED_SETTINGS_KEYS): ignored, as the legacy model's calibration keys are.
	for (const k of RETIRED_SETTINGS_KEYS) delete (s as unknown as Record<string, unknown>)[k];
	return s;
}
