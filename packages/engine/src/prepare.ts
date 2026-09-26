// Everything a run does before natural flow: merge the stored settings over
// the defaults, work out the run window, and align the input series to it
// (rain gap-fill, CHIRPS bias correction, accumulations, rain-source
// periods). The model (./run.ts), calibration and the Data tab's series
// preview all start here. A module of its own so the preview doesn't load
// the network simulation and the checks (issue #9).
import { resolveDataQuality } from './quality';
import {
	accumulationWarnings,
	applyAccumulations,
	claimsDays,
	fitExcludedWindows,
	rainAccumulations,
	spreadAccumulations,
	type AccumulationRun
} from './accumulation';
import {
	applyRainSource,
	finishRainSource,
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
import { doubleMass as doubleMassOf, doubleMassRunWarning, type DoubleMass } from './doublemass';
import { fromEpochDay, monthOfEpochDay, toEpochDay, type Monthly } from './calendar';
import { DEFAULT_ANNUAL_THRESHOLD } from './network/reliability';
import { sanitizeExclusions } from './calibrate/provenance';
import { resolveEwrRules } from './reserve/rules';
import { RUNOFF_MODELS } from './runoff/types';
import {
	CALIBRATION_FLOW_KINDS,
	CHIRPS_BIAS_MODES,
	defaultProjectSettings,
	panCoefficientOutOfRange,
	resolvePe,
	PE_SOURCE_MAX,
	PAN_COEFFICIENT_TYPICAL_MAX,
	PAN_COEFFICIENT_TYPICAL_MIN,
	type DailySeries,
	type ModelInput,
	type ProjectSettings,
	type SeriesKind
} from './project';
import { resolveWr2012 } from './reference/wr2012Resolve';

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
}

/** Merge the settings, work out the run window and align the input series to it. */
export function prepareRun(input: ModelInput): PreparedRun {
	const warnings: string[] = [];
	const settings = mergeSettings(input.settings, warnings);
	const series = input.series ?? {};

	// --- run window ---------------------------------------------------------
	const drivers: SeriesKind[] = ['rain_catchment_mm', 'rain_chirps_mm', 'rain_forecast_mm'];
	let first = Infinity;
	let last = -Infinity;
	for (const k of drivers) {
		const s = series[k];
		if (!s || s.values.length === 0) continue;
		const d0 = toEpochDay(s.startDate);
		first = Math.min(first, d0);
		last = Math.max(last, d0 + s.values.length - 1);
	}
	// A rain-source period's series drives the run too, inside its period (engine ≥ 0.30.0).
	for (const p of settings.rainSource) {
		const s = series[p.series];
		if (!s || s.values.length === 0) continue;
		const d0 = toEpochDay(s.startDate);
		const a = Math.max(d0, toEpochDay(p.start));
		const b = Math.min(d0 + s.values.length - 1, toEpochDay(p.end));
		if (a > b) continue;
		first = Math.min(first, a);
		last = Math.max(last, b);
	}
	const start = settings.simulationStart ? toEpochDay(settings.simulationStart) : first;
	const end = settings.simulationEnd ? toEpochDay(settings.simulationEnd) : last;
	if (!Number.isFinite(start) || !Number.isFinite(end)) {
		throw new Error('no rainfall series: cannot work out the simulation period');
	}
	if (end < start) throw new Error(`simulation end ${fromEpochDay(end)} is before start ${fromEpochDay(start)}`);
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
	const doubleMass = doubleMassOf(series, settings.zeroRainRuns);
	const replaced = rainSourceSpans(settings.rainSource);
	const isReplaced = (day: number) => replaced.some((w) => day >= w.from && day <= w.to);
	const fitOpts = { fitPeriod: settings.chirpsFitPeriod, ...(replaced.length ? { replaced } : {}) };
	const acc = rainAccumulations(series, settings.zeroRainRuns, settings.chirpsBiasCorrection, fitOpts);
	const claimed = new Set<number>();
	for (const w of acc?.windows ?? []) if (claimsDays(w.status)) for (let d = w.from; d <= w.to; d++) claimed.add(d);
	const zeroRain = zeroRainMask(series.rain_catchment_mm, settings.zeroRainRuns, start, days, (day) => claimed.has(day), isReplaced);
	const chirpsCorrection = chirpsBiasFactors(series, settings.chirpsBiasCorrection, settings.zeroRainRuns, fitExcludedWindows(acc), fitOpts);
	if (acc) spreadAccumulations(acc, series.rain_chirps_mm, chirpsCorrection);
	const catchment = blankMasked(alignSeries(series.rain_catchment_mm, start, days), zeroRain);
	const accumulation = acc ? applyAccumulations(acc, catchment, start) : null;
	const rainSource = settings.rainSource.length
		? applyRainSource(series, settings.rainSource, rainSourceFactors(series, settings.rainSource, settings.zeroRainRuns, fitExcludedWindows(acc)), catchment, start)
		: null;
	const chirpsRaw = alignSeries(series.rain_chirps_mm, start, days);
	if (rainSource) for (let t = 0; t < days; t++) if (rainSource.blockChirps[t]) chirpsRaw[t] = null;
	const chirpsUsed = chirpsCorrection ? applyChirpsCorrection(chirpsCorrection, catchment, chirpsRaw, month, start) : null;
	const aligned = (kind: SeriesKind) =>
		kind === 'rain_catchment_mm'
			? catchment.slice()
			: kind === 'rain_chirps_mm' && chirpsUsed
				? chirpsUsed.slice()
				: alignSeries(series[kind], start, days);
	const chirpsNote = chirpsCorrectionWarning(chirpsCorrection);
	if (chirpsNote) warnings.push(chirpsNote);
	warnings.push(...keepDryDoubtWarnings(chirpsCorrection));
	// A double-mass break: does CHIRPS fill days in an era whose ratio differs from the fit's?
	const dmNote = doubleMassRunWarning(doubleMass, chirpsCorrection, catchment, alignSeries(series.rain_chirps_mm, start, days), start);
	if (dmNote) warnings.push(dmNote);
	if (zeroRain) {
		const chirps = aligned('rain_chirps_mm');
		const forecast = aligned('rain_forecast_mm');
		finishZeroRainInfill(zeroRain, (t) => chirps[t] ?? forecast[t] ?? null);
		warnings.push(...zeroRainWarnings(zeroRain.infill));
	}
	const rainSourceColumn = rainSource ? finishRainSource(rainSource, catchment, aligned('rain_chirps_mm'), aligned('rain_forecast_mm'), start) : null;
	if (rainSource) warnings.push(...rainSourcePeriodWarnings(rainSource.info));
	if (accumulation) {
		// Left as recorded while CHIRPS fills the zero run it ends: that rain counts twice.
		const filled = (w: { start: string; end: string }) => {
			if (!zeroRain) return false;
			for (let d = Math.max(toEpochDay(w.start), start); d <= Math.min(toEpochDay(w.end), end); d++) if (zeroRain.mask[d - start]) return true;
			return false;
		};
		const doubled = accumulation.info.windows.filter((w) => w.status === 'asRecorded' && filled(w));
		warnings.push(...accumulationWarnings(accumulation.info, doubled));
	}

	// Daily A-pan (issue #45): every consumer reads it through `aligned`; this only counts and warns.
	const apanDaily = apanDailyInfo(series.evap_apan_mm, alignSeries(series.evap_apan_mm, start, days), start, settings.apanMm.every((v) => v === 0), warnings);

	if (!series.rain_catchment_mm && !series.rain_chirps_mm && !series.rain_forecast_mm) {
		warnings.push(
			settings.runoffModel === 'legacy'
				? 'no rainfall series: natural flow is only the receding initial base flow, and demand is not reduced by rain'
				: 'no rainfall series: natural flow is only what drains from the stores the warm-up filled, and demand is not reduced by rain'
		);
	}

	return {
		warnings,
		settings,
		series,
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
		apanDaily
	};
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

function mergeSettings(raw: ModelInput['settings'], warnings: string[]): ProjectSettings {
	const d = defaultProjectSettings();
	const s = { ...d, ...(raw ?? {}) } as ProjectSettings;
	s.calibration = { ...d.calibration, ...((raw?.calibration as object | undefined) ?? {}) };
	s.hiLoSplit = { ...d.hiLoSplit, ...((raw?.hiLoSplit as object | undefined) ?? {}) };
	s.gr4j = { ...d.gr4j, ...((raw?.gr4j as object | undefined) ?? {}) };
	s.panCoefficient = monthly(s.panCoefficient, 'pan coefficient', warnings);
	s.dataQuality = resolveDataQuality(raw?.dataQuality, warnings);
	s.zeroRainRuns = resolveZeroRain(raw?.zeroRainRuns, warnings);
	s.wr2012 = resolveWr2012(raw?.wr2012, warnings);
	s.ewrRules = resolveEwrRules(raw?.ewrRules, warnings);
	s.apanMm = monthly(s.apanMm, 'A-pan evaporation', warnings);
	s.ewrPragmaticM3PerDay = monthly(s.ewrPragmaticM3PerDay, 'pragmatic EWR', warnings);
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
	// Monthly effective-rain fractions (engine ≥ 0.41.0, issue #54): 12 numbers in [0, 1], or none.
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
	if (typeof s.effectiveRainStoreMm !== 'number' || !Number.isFinite(s.effectiveRainStoreMm) || s.effectiveRainStoreMm < 0) {
		warnings.push(`soil-water store "${String(s.effectiveRainStoreMm)}" mm is not a size ≥ 0; using ${d.effectiveRainStoreMm} mm`);
		s.effectiveRainStoreMm = d.effectiveRainStoreMm;
	}
	if (s.calibrationFlowKind != null && !CALIBRATION_FLOW_KINDS.includes(s.calibrationFlowKind)) {
		warnings.push(`unknown calibration flow series "${String(s.calibrationFlowKind)}"; using the default`);
		s.calibrationFlowKind = null;
	}
	s.calibrationFlowKind ??= null;
	s.calibrationExclusions = sanitizeExclusions(raw?.calibrationExclusions, warnings);
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
	if (s.calibrationStart && s.calibrationEnd && s.calibrationStart > s.calibrationEnd) {
		warnings.push(`calibration window ${s.calibrationStart} … ${s.calibrationEnd} ends before it starts; scoring the whole record`);
		s.calibrationStart = null;
		s.calibrationEnd = null;
	}
	if (!(RUNOFF_MODELS as readonly string[]).includes(s.runoffModel)) {
		warnings.push(`unknown runoff model "${String(s.runoffModel)}"; using ${d.runoffModel}`);
		s.runoffModel = d.runoffModel;
	}
	s.pe = resolvePe(raw?.pe, warnings);
	// Provenance only (never read by the model): a string, capped like the PE source.
	s.panCoefficientSource = typeof raw?.panCoefficientSource === 'string' ? raw.panCoefficientSource.slice(0, PE_SOURCE_MAX) : '';
	// The Kp plausibility check only means something when GR4J's PE is Kp × A-pan.
	if (s.runoffModel === 'gr4j' && s.pe.kind === 'pan') {
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
	if (s.assuranceAnnualThreshold !== undefined && !(typeof s.assuranceAnnualThreshold === 'number' && s.assuranceAnnualThreshold > 0 && s.assuranceAnnualThreshold <= 1)) {
		warnings.push(`annual assurance threshold "${String(s.assuranceAnnualThreshold)}" is not a fraction in (0, 1]; using ${DEFAULT_ANNUAL_THRESHOLD}`);
		delete s.assuranceAnnualThreshold;
	}
	if (!['area', 'hiLo', 'manual'].includes(s.flowShareMethod)) {
		warnings.push(`unknown flow share method "${String(s.flowShareMethod)}"; using area`);
		s.flowShareMethod = 'area';
	}
	return s;
}
