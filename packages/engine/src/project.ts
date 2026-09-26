// Shape of a project's model configuration, shared by the backend (storage +
// validation) and the frontend (forms). See docs/data-model.md for how each
// field maps onto the b023 workbook.
import type { ForecastSummary } from './forecast';
import type { CalibrationExclusion, ExclusionRange, FitRecord } from './calibrate/provenance';
import type { Monthly } from './calendar';
import type { AreaMismatch, ObservedAgreement, SeriesCheck } from './quality';
import type { DoubleMass } from './doublemass';
import type { PlausibilityChecks } from './plausibility';
import type { ChirpsCorrection, ZeroRainInfill } from './rain';
import type { RainSourceInfo } from './rainSourcePeriods';
import type { RainAccumulationInfo } from './accumulation';
import type { Gr4jParams } from './runoff/gr4j';
import type { RunoffModelId } from './runoff/types';
import type { SeriesProvenance } from './seriesProvenance';
import { defaultWr2012Settings, type Wr2012Report, type Wr2012Settings } from './reference/wr2012';
import type { EwrRuleTable } from './reserve/rules';
import type { EwrAssuranceSite } from './reserve/assurance';
import type { SupplyAssurance } from './network/reliability';

/** How each farm's share of catchment natural flow is derived (b023 [Farm spec]). */
export type FlowShareMethod = 'area' | 'hiLo' | 'manual';

/**
 * How CHIRPS rain is corrected where it stands in for blank catchment rain
 * (settings.chirpsBiasCorrection, ./rain.ts). 'monthly' scales it by a
 * per-calendar-month catchment / CHIRPS factor fitted on the days both have a
 * reading; 'none' uses raw CHIRPS (for a series that is already corrected).
 */
export const CHIRPS_BIAS_MODES = ['monthly', 'none'] as const;
export type ChirpsBiasMode = (typeof CHIRPS_BIAS_MODES)[number];

/**
 * Which part of the record the CHIRPS factors are fitted on
 * (settings.chirpsFitPeriod, engine ≥ 0.29.0, ./rain.ts, issue #40 (a),
 * docs/model.md §2.4b):
 * - 'all' (default): one set of monthly factors over the whole record;
 * - a list of water-year ranges, each with a reason: one set per range,
 *   fitted only on that range; a gap outside every range takes the nearest.
 * The double-mass breaks only ever *propose* ranges (proposeChirpsFitRanges,
 * ./doublemass.ts) for the hydrologist to confirm: an automatic break can
 * land a year or two off the real network change (issue #40 amendments).
 */
export const CHIRPS_FIT_PERIOD_MODES = ['all'] as const;
/** One listed fit range: water years `fromWaterYear` … `toWaterYear` (each the calendar year its 1 October falls in), inclusive. */
export interface ChirpsFitRange {
	fromWaterYear: number;
	toWaterYear: number;
	reason: string;
}
export type ChirpsFitPeriod = (typeof CHIRPS_FIT_PERIOD_MODES)[number] | ChirpsFitRange[];

/**
 * Per-period forcing source (settings.rainSource, engine ≥ 0.30.0,
 * ./rainSourcePeriods.ts, issue #40 (b), docs/model.md §2.4e). Over each period,
 * catchment rain comes from `series` × its month's factor instead of the
 * primary catchment series; a day the series lacks falls through to the
 * named `fallback` (default CHIRPS × the §2.4b factors), then forecast rain.
 */
export const RAIN_SOURCE_SERIES = ['rain_catchment_alt_mm'] as const;
export type RainSourceSeries = (typeof RAIN_SOURCE_SERIES)[number];
/** Series a 'fit' can be measured against, and a fallback can name. */
export const RAIN_SOURCE_REFERENCES = ['rain_reanalysis_mm', 'rain_chirps_mm'] as const;
export type RainSourceReference = (typeof RAIN_SOURCE_REFERENCES)[number];
/** Series a period's gaps can fall through to by name; absent = CHIRPS × the §2.4b factors. */
export const RAIN_SOURCE_FALLBACKS = ['rain_reanalysis_mm'] as const;
export type RainSourceFallback = (typeof RAIN_SOURCE_FALLBACKS)[number];

/** Where fixed factors came from (the amendment's provenance): who, over which dates, how. */
export interface RainSourceFactorProvenance {
	source: string;
	/** The dates the factors were fitted on (ISO, inclusive). */
	fittedFrom: string;
	fittedTo: string;
	method: string;
}

/** A reference series and the water years it is read over (the reference era). */
export interface RainSourceReferenceEra {
	series: RainSourceReference;
	fromWaterYear: number;
	toWaterYear: number;
}

export interface RainSourcePeriod {
	/** ISO dates, inclusive. */
	start: string;
	end: string;
	series: RainSourceSeries;
	/**
	 * 12 fixed factors in water-year order (Oct … Sep), as the other monthly
	 * settings, with `provenance`; or 'fit', measured against `fitReference`.
	 */
	factors: number[] | 'fit';
	provenance?: RainSourceFactorProvenance;
	/**
	 * 'fit' only: factor(m) = (catchment ÷ reference over the reference era) ÷
	 * (series ÷ reference over the period). The reference must not contain the
	 * series: CHIRPS is refused when `gaugeInChirps` is set.
	 */
	fitReference?: RainSourceReferenceEra;
	/**
	 * Where a day the series lacks takes its rain. Absent = CHIRPS × the §2.4b
	 * factors (the fit period's). A reanalysis fallback needs the era its
	 * factors (catchment ÷ reanalysis per month) are fitted on.
	 */
	fallback?: { series: RainSourceFallback; fromWaterYear: number; toWaterYear: number };
	/** The series' gauge reports to CHIRPS in this period: CHIRPS can be neither the fit reference nor the fallback. */
	gaugeInChirps?: boolean;
	reason: string;
}

/**
 * What a run does with the zero runs the catchment-rain check flags as
 * probable missing data (settings.zeroRainRuns, ./rain.ts, CR-20). 'missing'
 * treats them as blank, so corrected CHIRPS then forecast rain fill them;
 * 'asRecorded' runs them as the dry days they say they are.
 */
export const ZERO_RAIN_MODES = ['missing', 'asRecorded'] as const;
export type ZeroRainMode = (typeof ZERO_RAIN_MODES)[number];

/**
 * What a run does with untagged multi-day accumulations in the catchment rain
 * (settings.zeroRainRuns.accumulationMode, engine ≥ 0.20.0, ./accumulation.ts,
 * audit B4): 'spread' keeps the recorded total and spreads it over the days it
 * covers in proportion to bias-corrected CHIRPS; 'asRecorded' leaves the
 * reading on its day, as up to 0.19 and as the workbook does.
 */
export const ACCUMULATION_MODES = ['spread', 'asRecorded'] as const;
export type AccumulationMode = (typeof ACCUMULATION_MODES)[number];

/**
 * settings.zeroRainRuns (engine ≥ 0.15.0). Periods use the calibration
 * exclusions' shape: a water year or a date range, each with a reason.
 */
export interface ZeroRainSettings {
	/** For flagged zero runs. Default 'missing'. */
	mode: ZeroRainMode;
	/** Flagged zero runs confirmed as real dry spells: their days stay 0 even in 'missing' mode. */
	keepDry: CalibrationExclusion[];
	/** Extra periods whose catchment rain is treated as missing whatever it reads, in either mode. */
	missing: CalibrationExclusion[];
	/** For detected multi-day accumulations (engine ≥ 0.20.0). Default 'spread'. */
	accumulationMode: AccumulationMode;
	/** Detected accumulations confirmed as real one-day rain (e.g. a storm CHIRPS missed): a detection whose reading day falls in one stays as recorded. */
	keepReadings: CalibrationExclusion[];
	/** Accumulation windows listed by hand (the reading is the period's last day): spread like a detected one, in 'spread' mode. */
	addAccumulations: CalibrationExclusion[];
}

export const defaultZeroRainSettings = (): ZeroRainSettings => ({
	mode: 'missing',
	keepDry: [],
	missing: [],
	accumulationMode: 'spread',
	keepReadings: [],
	addAccumulations: []
});

/**
 * Rain → natural-flow calibration (b023 [Flow Calibration Cfg]); consumed by
 * computeNaturalFlow() in flow.ts. Workbook named range in brackets.
 */
export interface CalibrationParams {
	/** Peak flow coefficient in a·Rain^b [rCalibration_PeakCoef_a]. */
	a: number;
	/** Peak flow exponent in a·Rain^b [rCalibration_PeakExp_b]. */
	b: number;
	/** Rain at or below this (mm) produces no rain-driven flow [rCalibration_RainThreshold]. */
	rainThresholdMm: number;
	/** Rain-to-flow multiplier in summer [rCalibration_FactorSummer]. */
	summerFactor: number;
	/** Rain-to-flow multiplier in winter [rCalibration_FactorWinter]. */
	winterFactor: number;
	/** Calendar months (1–12) always treated as summer [rCalibration_SummerMths]. */
	summerMonths: number[];
	/** Base flow (m³/day) in the row before the first simulated day ([Flow data] S20). */
	baseFlowInitial: number;
	/**
	 * Catchment area (km²) that rain falls on [rFarmSpec_AreaTotal]. null (the
	 * default) = the sum of the farm nodes' areas, which is what the workbook's
	 * total is; set it only to override.
	 */
	catchmentAreaKm2: number | null;
	/** Rain flow / receded base flow above this resets the base flow [rCalibration_MinFlowRatioToResetBase]. */
	baseResetRatio: number;
	/** Outside summer months: rain today ≥ this (mm) switches to winter the same day [rCalibration_WinterTodayThresh]. */
	winterTodayRainMm: number;
	/** Outside summer months: rain yesterday ≥ this (mm) switches to winter today [rCalibration_WinterNextDayThresh]. */
	winterNextDayRainMm: number;
	/** Recession index a rain event of amplitudeM3Day starts at [rCalibration_ShiftPeakIndexLo]. */
	shiftPeakIndexLo: number;
	/** Recession index a vanishingly small rain event starts at [rCalibration_ShiftPeakIndexHi]. */
	shiftPeakIndexHi: number;
	/** Rain → flow amplitude (m³/day) that maps to shiftPeakIndexLo [rCalibration_Amplitude]. */
	amplitudeM3Day: number;
	/** Highest recession index used (days) [rCalibration_DaysMax]. */
	recessionDaysMax: number;
	/** Daily recession factor per 1-based index [rCalibration_RecessionFactors]. */
	recessionFactors: number[];
	/** Smoothed recession flow (m³/day) per index, descending [rCalibration_Curve]. */
	recessionCurveM3Day: number[];
}

/** GR4J parameters (./runoff/gr4j.ts) plus the warm-up before day 1. */
export interface Gr4jSettings extends Gr4jParams {
	/**
	 * Days run before the first simulated day to fill the stores, cycling the
	 * run's own forcing from its first day; never output or scored. Default 365.
	 */
	warmupDays: number;
}

export interface ProjectSettings {
	/** Days used for February when converting monthly volumes to per-day. */
	februaryDays: number;
	/** Fraction of rainfall on cropped land that offsets irrigation demand. */
	effectiveRainFraction: number;
	/**
	 * Size of each farm's soil-water store, mm over the cropped area (engine ≥
	 * 0.14.0, docs/engine-audit.md N3): effective rain the crop can't use on
	 * the day it falls is kept for the following days, up to this depth
	 * (./demand.ts farmDailyDemand). Default 25 mm, the readily available water
	 * of 0.5 m of roots in a soil holding 100 mm/m with p = 0.5 (FAO-56 Tables
	 * 19 and 22). 0 = no carry-over, the b023 workbook's rule.
	 */
	effectiveRainStoreMm: number;
	/**
	 * Open-water evaporation from a farm dam as a fraction of **A-pan**
	 * evaporation (engine ≥ 0.16.0, docs/engine-audit.md N2): the dam loses
	 * lakeEvapFactor × A-pan × its surface area each day. Default 0.75 (0.7–0.8
	 * × Class-A pan, Linsley et al. 1982). The WR90 / WR2012 lake factors are
	 * ratios to S-pan evaporation and must not be applied to A-pan directly.
	 * 0 = no dam evaporation.
	 */
	lakeEvapFactor: number;
	/**
	 * Annual assurance of supply (engine ≥ 0.32.0, WP-3.4): a water year counts
	 * as met when a farm's Σ supplied ÷ Σ demand reaches this fraction. A
	 * project choice, not a standard; default 0.9 (network/reliability.ts
	 * DEFAULT_ANNUAL_THRESHOLD). Optional so settings stored before it still type.
	 */
	assuranceAnnualThreshold?: number;
	/** WR90 A-pan evaporation, mm per water-year month (Oct–Sep). */
	apanMm: Monthly;
	flowShareMethod: FlowShareMethod;
	/** Pitman high/low MAP split used by the `hiLo` flow-share method. */
	hiLoSplit: { hi: number; lo: number };
	/**
	 * Rain → natural-flow model (./runoff). 'gr4j' (the default since engine
	 * 0.11.0) or 'legacy', the b023 recession model (./flow.ts), kept
	 * selectable to compare with the workbook (issue #4).
	 */
	runoffModel: RunoffModelId;
	/** Parameters of the GR4J runoff model (used when runoffModel = 'gr4j'). */
	gr4j: Gr4jSettings;
	/**
	 * Pan coefficient per water-year month (Oct–Sep): potential evaporation =
	 * coefficient × A-pan. Drives the conceptual runoff models (GR4J), not the
	 * legacy one or irrigation demand. Default 0.7 every month. Stays editable
	 * per month; `PAN_COEFFICIENT_PRESETS` are starting points a form can fill
	 * the row with, not stored settings. A month outside
	 * `PAN_COEFFICIENT_TYPICAL_MIN`–`PAN_COEFFICIENT_TYPICAL_MAX` is a run
	 * warning, not a validation error (the API keeps the wider 0–2).
	 */
	panCoefficient: Monthly;
	/**
	 * Where the pan-coefficient row came from (engine ≥ 0.31.1, issue #39):
	 * free text, e.g. the FAO-56 Table 5 cells and the humidity and wind
	 * behind them, which the Settings helper fills in. Provenance only: the
	 * model never reads it, and editing it is not a forcing change. '' = none.
	 */
	panCoefficientSource: string;
	/**
	 * Where GR4J's potential evaporation comes from (engine ≥ 0.31.0, issue
	 * #39). `{ kind: 'pan' }` (the default, and what every earlier run did):
	 * PE = `panCoefficient` × `apanMm`. `{ kind: 'monthly' }`: PE is `mm` per
	 * water-year month directly (e.g. a station FAO-56 ET₀), with `source`
	 * saying where it came from; `panCoefficient` is then unused. Either way
	 * irrigation demand and dam evaporation read `apanMm` only, so a
	 * `monthly` PE changes the runoff model and nothing else.
	 */
	pe: PeInput;
	/**
	 * Bias correction of CHIRPS rain where it fills in for blank catchment rain
	 * (engine ≥ 0.7.0, ./rain.ts, docs/engine-audit.md B1). Default 'monthly'.
	 */
	chirpsBiasCorrection: ChirpsBiasMode;
	/**
	 * Which part of the record the CHIRPS factors are fitted on, and so which
	 * factors fill a gap (engine ≥ 0.29.0, ./rain.ts, issue #40). Default 'all'.
	 */
	chirpsFitPeriod: ChirpsFitPeriod;
	/**
	 * Periods whose catchment rain comes from another series × monthly factors
	 * (engine ≥ 0.30.0, ./rain.ts, issue #40 (b)). Default none.
	 */
	rainSource: RainSourcePeriod[];
	/**
	 * Flagged zero runs in the catchment rain, and other periods the
	 * hydrologist marks, treated as missing (engine ≥ 0.15.0, ./rain.ts, CR-20).
	 */
	zeroRainRuns: ZeroRainSettings;
	calibration: CalibrationParams;
	/** Pragmatic EWR at the outflow gauge, m³/day per water-year month. */
	ewrPragmaticM3PerDay: Monthly;
	/**
	 * The Reserve's assurance rules per EWR site (engine ≥ 0.21.0, hydrologist
	 * Q6; ./reserve/rules.ts): at most one table per site (the outlet, or a
	 * gauge). Each run then judges monthly compliance against them
	 * (summary.ewrAssurance, docs/model.md §2.9c). Empty (the default) = none;
	 * the daily pragmatic EWR above still drives the shortfall charge and
	 * curtailment either way.
	 */
	ewrRules: EwrRuleTable[];
	/** Optional simulation window (ISO dates); defaults to the full series. */
	simulationStart: string | null;
	simulationEnd: string | null;
	/**
	 * Reporting window (ISO dates, inclusive) for the curtailment report, the
	 * b023 [Shortfalls] "Set reporting period" cells. null = the run's start /
	 * end. Clipped to the simulation period.
	 */
	reportStart: string | null;
	reportEnd: string | null;
	/**
	 * Optional calibration window (ISO dates, inclusive): calibration statistics
	 * only score days inside it. null = the whole overlap of simulated and
	 * observed flow. The workbook's [Flow Calibration Cfg] zCalibration_Date1/DateN.
	 */
	calibrationStart: string | null;
	calibrationEnd: string | null;
	/**
	 * Flow record to calibrate against ([Flow data] rUseFlow: Flow A/B/C).
	 * null = observed gauge flow if present, else the logger.
	 */
	calibrationFlowKind: CalibrationFlowKind | null;
	/**
	 * Periods left out of every calibration score (automatic calibration and
	 * the run's calibration statistics): whole water years or date ranges,
	 * each with a reason (./calibrate/provenance.ts). Default none.
	 */
	calibrationExclusions: CalibrationExclusion[];
	/**
	 * The automatic fit whose parameters "Apply to form" wrote, with its
	 * validation (./calibrate/provenance.ts). null = none: the parameters were
	 * set by hand or imported. Never changes model results.
	 */
	fitRecord: FitRecord | null;
	/** Thresholds of the input data-quality checks (./quality.ts). They never change model results. */
	dataQuality: DataQualitySettings;
	/**
	 * Optional WR2012 check (./reference/wr2012.ts): the quaternary's
	 * naturalised flow, entered by the user, compared with simulated natural
	 * flow in every run. reference null = no check.
	 */
	wr2012: Wr2012Settings;
}

/**
 * Gauge-vs-logger agreement thresholds (observedAgreement): a water year is
 * flagged when gauge / logger volume on shared days falls outside
 * agreementMinRatio … agreementMaxRatio, on at least agreementMinDays shared days.
 */
export interface DataQualitySettings {
	/** 0 < min ≤ 1. Default 2/3. */
	agreementMinRatio: number;
	/** ≥ 1. Default 1.5. */
	agreementMaxRatio: number;
	/** Whole days, 1–366. Default 90. */
	agreementMinDays: number;
}

/** Series that calibration statistics can compare simulated outflow with. */
export const CALIBRATION_FLOW_KINDS = ['flow_observed_m3s', 'flow_logger_m3s'] as const;
export type CalibrationFlowKind = (typeof CALIBRATION_FLOW_KINDS)[number];

const zeros: Monthly = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

/** Defaults taken from the blank b023 workbook. */
export function defaultProjectSettings(): ProjectSettings {
	return {
		februaryDays: 28.25,
		effectiveRainFraction: 0.65,
		effectiveRainStoreMm: 25,
		lakeEvapFactor: 0.75,
		assuranceAnnualThreshold: 0.9,
		apanMm: zeros,
		flowShareMethod: 'area',
		hiLoSplit: { hi: 0.81, lo: 0.19 },
		runoffModel: 'gr4j',
		gr4j: { x1: 350, x2: 0, x3: 90, x4: 1.7, warmupDays: 365 },
		panCoefficient: [0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7],
		panCoefficientSource: '',
		pe: { kind: 'pan' },
		chirpsBiasCorrection: 'monthly',
		chirpsFitPeriod: 'all',
		rainSource: [],
		zeroRainRuns: defaultZeroRainSettings(),
		calibration: {
			a: 0.09,
			b: 1.2,
			rainThresholdMm: 2,
			summerFactor: 0.1,
			winterFactor: 1,
			summerMonths: [1, 2, 3, 4, 5, 11, 12],
			baseFlowInitial: 300,
			catchmentAreaKm2: null,
			baseResetRatio: 1.5,
			winterTodayRainMm: 35,
			winterNextDayRainMm: 9,
			shiftPeakIndexLo: 0.9,
			shiftPeakIndexHi: 3.5,
			amplitudeM3Day: 2343944,
			recessionDaysMax: 79,
			// prettier-ignore
			recessionFactors: [
				0.255, 0.396, 0.511, 0.718, 0.829, 0.876, 0.902, 0.9283, 0.9396, 0.9492,
				0.9577, 0.9583, 0.9613, 0.9634, 0.965, 0.9664, 0.9675, 0.9685, 0.9694, 0.9701,
				0.9708, 0.9715, 0.9721, 0.9726, 0.9731, 0.9736, 0.974, 0.9745, 0.9749, 0.9753,
				0.9756, 0.976, 0.9763, 0.9766, 0.9769, 0.9772, 0.9775, 0.9778, 0.978, 0.9783,
				0.9785, 0.9787, 0.979, 0.9792, 0.9794, 0.9796, 0.9798, 0.98, 0.9802, 0.9804,
				0.9806, 0.9808, 0.9809, 0.9811, 0.9813, 0.9814, 0.9816, 0.9818, 0.9819, 0.9821,
				0.9822, 0.9824, 0.9825, 0.9826, 0.9828, 0.9829, 0.983, 0.9832, 0.9833, 0.9834,
				0.9836, 0.9837, 0.9838, 0.9839, 0.984, 0.9841, 0.9843, 0.9844, 0.9845, 0.9845
			],
			// prettier-ignore
			recessionCurveM3Day: [
				10000000, 2553249, 1011087, 516665, 370965, 307530, 269396, 242995, 225572, 211947,
				201180, 192670, 184636, 177491, 170995, 165010, 159466, 154283, 149423, 144851,
				140520, 136417, 132529, 128831, 125301, 121930, 118711, 115625, 112677, 109849,
				107136, 104522, 102013, 99595, 97264, 95017, 92851, 90762, 88747, 86795,
				84912, 83086, 81316, 79608, 77952, 76346, 74789, 73278, 71812, 70390,
				69010, 67671, 66372, 65104, 63874, 62680, 61514, 60382, 59283, 58210,
				57168, 56150, 55162, 54197, 53254, 52338, 51443, 50568, 49718, 48888,
				48076, 47288, 46517, 45763, 45026, 44306, 43602, 42917, 42247, 0
			]
		},
		ewrPragmaticM3PerDay: zeros,
		ewrRules: [],
		simulationStart: null,
		simulationEnd: null,
		reportStart: null,
		reportEnd: null,
		calibrationStart: null,
		calibrationEnd: null,
		calibrationFlowKind: null,
		calibrationExclusions: [],
		fitRecord: null,
		dataQuality: { agreementMinRatio: 2 / 3, agreementMaxRatio: 1.5, agreementMinDays: 90 },
		wr2012: defaultWr2012Settings()
	};
}

/**
 * FAO-56's usual range for a Class A pan (Allen et al. 1998, Table 5). Not a
 * hard bound — the API keeps the wider 0–2 (stored projects must still load
 * and save) — only a plausibility check: `panCoefficientOutOfRange` names the
 * months a run and Settings warn about.
 */
export const PAN_COEFFICIENT_TYPICAL_MIN = 0.6;
export const PAN_COEFFICIENT_TYPICAL_MAX = 0.85;

/** Water-year month indices (0 = Oct … 11 = Sep) whose coefficient falls outside the FAO-56 typical range. */
export function panCoefficientOutOfRange(values: readonly number[]): number[] {
	const out: number[] = [];
	for (let i = 0; i < values.length; i++) {
		const v = values[i]!;
		if (v < PAN_COEFFICIENT_TYPICAL_MIN || v > PAN_COEFFICIENT_TYPICAL_MAX) out.push(i);
	}
	return out;
}

/** GR4J's potential-evaporation input (`ProjectSettings.pe`, issue #39). */
export type PeInput = { kind: 'pan' } | { kind: 'monthly'; mm: Monthly; source: string };

export const PE_KINDS = ['pan', 'monthly'] as const;
export type PeKind = (typeof PE_KINDS)[number];

/** Longest `source` note a `monthly` PE input keeps (the API's limit too). */
export const PE_SOURCE_MAX = 600;

/**
 * GR4J's potential evaporation per water-year month (mm): pan coefficient ×
 * A-pan under `kind: 'pan'` (or no `pe`, a project saved before it), else the
 * `monthly` row. Irrigation demand and dam evaporation never read this.
 */
export function gr4jPeMonthlyMm(s: {
	apanMm: readonly number[];
	panCoefficient: readonly number[];
	pe?: PeInput | null;
}): number[] {
	const pe = s.pe;
	if (pe?.kind === 'monthly') return Array.from({ length: 12 }, (_, m) => pe.mm[m] ?? 0);
	return Array.from({ length: 12 }, (_, m) => (s.panCoefficient[m] ?? 0) * (s.apanMm[m] ?? 0));
}

/**
 * A stored `pe` as the engine runs it: absent (a project saved before engine
 * 0.31.0) is `{ kind: 'pan' }`, what those runs did; anything unreadable
 * warns and falls back to it too. A `monthly` row's non-finite or negative
 * months count as 0, with a warning.
 */
export function resolvePe(raw: unknown, warnings: string[]): PeInput {
	if (raw == null) return { kind: 'pan' };
	const r = raw as { kind?: unknown; mm?: unknown; source?: unknown };
	if (r.kind === 'pan') return { kind: 'pan' };
	if (r.kind !== 'monthly' || !Array.isArray(r.mm)) {
		warnings.push(`unknown potential-evaporation input ${JSON.stringify(raw).slice(0, 80)}; using pan coefficient × A-pan`);
		return { kind: 'pan' };
	}
	if (r.mm.length !== 12) warnings.push(`monthly PE should have 12 values, has ${r.mm.length}; missing months are 0`);
	const bad: number[] = [];
	const mm = Array.from({ length: 12 }, (_, i) => {
		const x = Number(r.mm && (r.mm as unknown[])[i]);
		if (i < (r.mm as unknown[]).length && !(Number.isFinite(x) && x >= 0)) bad.push(i);
		return Number.isFinite(x) && x >= 0 ? x : 0;
	}) as unknown as Monthly;
	if (bad.length) warnings.push(`monthly PE is not a number ≥ 0 in month(s) ${bad.map((i) => i + 1).join(', ')} of the water year; using 0`);
	return { kind: 'monthly', mm, source: typeof r.source === 'string' ? r.source.slice(0, PE_SOURCE_MAX) : '' };
}

/** A named set of monthly pan-coefficient values (water-year order, Oct–Sep). */
export interface PanCoefficientPreset {
	id: string;
	label: string;
	values: Monthly;
}

/**
 * Shown next to the preset picker (Settings): these are a starting point, not
 * a substitute for local judgement.
 */
export const PAN_COEFFICIENT_PRESET_SOURCE =
	'indicative, from FAO-56 Table 5 climate classes (Allen et al. 1998); confirm against local humidity and wind';

/**
 * Indicative monthly pan-coefficient presets (water-year order, Oct–Sep;
 * question 4 for the hydrologist). Picking one only fills the editable
 * `panCoefficient` row — nothing stores which preset (or whether one) was
 * used, so an edit afterwards leaves no trace of its starting point.
 */
export const PAN_COEFFICIENT_PRESETS: PanCoefficientPreset[] = [
	{ id: 'generic', label: 'Generic (flat 0.70)', values: [0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7] },
	{
		id: 'winter-rainfall',
		label: 'Winter rainfall (e.g. Western Cape)',
		values: [0.7, 0.65, 0.65, 0.65, 0.65, 0.7, 0.75, 0.8, 0.8, 0.8, 0.8, 0.75]
	},
	{
		id: 'summer-rainfall',
		label: 'Summer rainfall',
		values: [0.65, 0.7, 0.75, 0.75, 0.75, 0.75, 0.7, 0.7, 0.7, 0.65, 0.6, 0.6]
	}
];

/**
 * A b023 network element. A "farm" can also model a stand-alone dam or natural
 * area. A "user" (engine ≥ 0.22.0, WP-1.33) is any other abstraction from the
 * river: a town or municipal scheme, industry, an unlisted irrigator. It has a
 * monthly demand, a share returned downstream and a priority, and no land,
 * dam, crops or rain of its own (docs/model.md §2.7c).
 */
export type NodeKind = 'farm' | 'gauge' | 'user';

/**
 * An other water user's priority against the farms (WP-1.33, docs/model.md
 * §2.7c). 'senior' (the default: a municipal allocation is usually senior):
 * its demand is a requirement every farm and junior user upstream of it must
 * pass before filling its dam or taking water, fragmented to the farms by flow
 * share like the EWR; it is not curtailed for the EWR. 'junior': it takes only
 * what reaches it after the senior requirements below it, and its EWR charge
 * is curtailed like a farm's.
 */
export const USER_PRIORITIES = ['senior', 'junior'] as const;
export type UserPriority = (typeof USER_PRIORITIES)[number];

/**
 * Time-series kinds a project can hold. Values are daily, starting at `startDate`.
 *
 * `flow_reference_m3s` is a gauge on a *different* river (a neighbouring
 * sub-catchment), kept as a regional wet/dry index only. The engine never
 * reads it: it is not a driver, not a calibration or validation record, not
 * in the gauge-vs-logger agreement check and not in the EWR comparison, and
 * it is deliberately not in CALIBRATION_FLOW_KINDS (docs/model.md §2.10).
 *
 * `rain_catchment_alt_mm` (engine ≥ 0.30.0, issue #40 (b)) is a second
 * catchment-rain record, e.g. an in-catchment automatic station. The engine
 * reads it only inside a settings.rainSource period (docs/model.md §2.4e).
 * `rain_reanalysis_mm` is a gauge-free reanalysis (ERA5): a reference a
 * rain-source 'fit' can be measured against, and a named fallback for the
 * alternative series' gaps. Neither is ever read outside a period.
 */
export const SERIES_KINDS = [
	'rain_catchment_mm',
	'rain_catchment_alt_mm',
	'rain_chirps_mm',
	'rain_reanalysis_mm',
	'rain_forecast_mm',
	'flow_observed_m3s',
	'flow_logger_m3s',
	'flow_reference_m3s'
] as const;
export type SeriesKind = (typeof SERIES_KINDS)[number];

// ---------------------------------------------------------------------------
// Model data — the editable per-project configuration. Field names mirror the
// DB columns (camelCased); ids are UUIDs generated by whoever creates the row
// (the browser uses crypto.randomUUID()) so references survive a bulk save.
// ---------------------------------------------------------------------------

export interface NetworkNode {
	id: string;
	name: string;
	kind: NodeKind;
	/** Node this one drains into; null only for the outflow gauge. */
	downstreamNodeId: string | null;
	sortOrder: number;
	areaKm2: number;
	areaHiKm2: number;
	areaLoKm2: number;
	/** Used when settings.flowShareMethod === 'manual'. 0–1. */
	flowShareManual: number | null;
	/** Fraction of upstream inflow entering above the dam. 0–1. */
	pctUpstreamToDam: number;
	/** Fraction of the farm's own runoff entering above the dam. 0–1. */
	pctRunoffToDam: number;
	damCapacityM3: number;
	damInitialPct: number;
	/** Minimum operating level (dead storage), fraction of capacity: irrigation draws only above it (engine ≥ 0.16.0, audit Q5). */
	damMinPct: number;
	divertCapacityM3Day: number;
	/**
	 * Irrigation application efficiency e, 0 < e ≤ 1 (engine ≥ 0.16.0, audit
	 * N1): the share of the water abstracted that reaches the crop. Abstraction
	 * demand = crop requirement ÷ e.
	 */
	irrigationEfficiency: number;
	/**
	 * Share β (0–1) of the application losses, (1 − e) × supplied, that
	 * returns to the river below the farm the same day (engine ≥ 0.16.0). The
	 * rest leaves the catchment (evaporation, deep percolation).
	 */
	lossReturnFraction: number;
	/**
	 * Dam surface area when full, m² (engine ≥ 0.16.0, audit N2). null = not
	 * known: the run estimates capacity ÷ 3 m (ESTIMATED_DAM_DEPTH_M) and warns.
	 */
	damAreaFullM2: number | null;
	/**
	 * Exponent b of the dam's area–storage relation A = A_full × (S / capacity)^b
	 * (0 < b ≤ 3). Default 0.7 (Liebe et al. 2005, small reservoirs).
	 */
	damAreaExponent: number;
	/** Seepage per day, as a fraction of the dam's storage (0–1); it joins the outflow. Default 0. */
	damSeepagePerDay: number;
	/**
	 * kind 'user' only (engine ≥ 0.22.0, WP-1.33): demand from the river, m³/day
	 * per water-year month (Oct–Sep). null / absent = no demand.
	 */
	userDemandM3Day?: number[] | null;
	/** kind 'user' only: share (0–1) of what it takes that returns below it the same day (treated wastewater). Default 0. */
	userReturnPct?: number;
	/** kind 'user' only: priority against the farms. Default 'senior'. */
	userPriority?: UserPriority;
	/**
	 * Boreholes (engine ≥ 0.23.0, WP-1.34, docs/model.md §2.7d), farms and other
	 * users: the most that can be pumped per day, m³/day. null / absent / 0 = no
	 * boreholes, and the other borehole fields are inert.
	 */
	boreholeCapacityM3Day?: number | null;
	/** When the boreholes run. Default 'supplemental'. */
	boreholeRule?: BoreholeRule;
	/** 'drought' only: they run while the dam holds less than this fraction of its capacity (start of the day). Default 0.3. */
	boreholeTriggerPct?: number;
	/** Share d (0–1) of the pumped volume that is eventually taken from the river's flow at this node (stream depletion). Default 0. */
	streamDepletionFrac?: number;
	/** Time constant k (days, ≥ 0) of the linear-reservoir lag between pumping and depletion; 0 = the same day. Default 0. */
	streamDepletionLagDays?: number;
}

/**
 * When a node's boreholes run (WP-1.34, docs/model.md §2.7d):
 * 'supplemental' — only for the demand dam and river leave unmet;
 * 'primary' — first, the dam and river cover the rest;
 * 'drought' — supplemental, but only while the dam is below its trigger (farms with a dam only).
 */
export const BOREHOLE_RULES = ['supplemental', 'primary', 'drought'] as const;
export type BoreholeRule = (typeof BOREHOLE_RULES)[number];

/** What a node without the borehole fields runs as: no boreholes (WP-1.34). */
export const BOREHOLE_DEFAULTS = {
	boreholeCapacityM3Day: null,
	boreholeRule: 'supplemental',
	boreholeTriggerPct: 0.3,
	streamDepletionFrac: 0,
	streamDepletionLagDays: 0
} as const;

/** What a user node without the fields runs as (WP-1.33). */
export const USER_DEFAULTS = { userDemandM3Day: null, userReturnPct: 0, userPriority: 'senior' } as const;

/** Default exponent of the dam area–storage relation (Liebe et al. 2005). */
export const DAM_AREA_EXPONENT = 0.7;

/**
 * Mean depth used to estimate a dam's full-supply area when none is entered:
 * area = capacity ÷ 3 m, about the median mean depth of South African minor
 * dams (Mantel & Hughes 2023). A run that uses it says so (warning W6).
 */
export const ESTIMATED_DAM_DEPTH_M = 3;

/** Irrigation settings of a new farm (engine ≥ 0.16.0, audit N1): a typical mixed system, half of its losses returning. */
export const NEW_FARM_IRRIGATION = { irrigationEfficiency: 0.8, lossReturnFraction: 0.5 } as const;

/**
 * Indicative application efficiencies by irrigation system (audit N1), for
 * the node form's helper. Typical values from the irrigation design
 * literature; a scheme's own measurement is better.
 */
export const IRRIGATION_SYSTEMS = [
	{ id: 'drip', label: 'Drip', efficiency: 0.9 },
	{ id: 'micro', label: 'Micro-sprinkler', efficiency: 0.85 },
	{ id: 'pivot', label: 'Centre pivot', efficiency: 0.85 },
	{ id: 'sprinkler', label: 'Sprinkler (dragline, big gun)', efficiency: 0.75 },
	{ id: 'flood', label: 'Flood / furrow', efficiency: 0.65 }
] as const;

/**
 * The efficiency and loss return that replace an engine < 0.16.0 node's
 * `returnFlowPct` r (migration 006): r = 0 → e = 1, β = 0 (bit-identical
 * results); r > 0 → e = 1 − r (at least 0.01), β = 1, so the balance
 * (consumptive use = supplied − return flow) is as before per unit supplied,
 * and the crop is now fully supplied, at 1 / (1 − r) times the abstraction.
 */
export function irrigationFromReturnFlow(r: number): { irrigationEfficiency: number; lossReturnFraction: number } {
	if (!(r > 0)) return { irrigationEfficiency: 1, lossReturnFraction: 0 };
	return { irrigationEfficiency: Math.max(1 - Math.min(r, 1), 0.01), lossReturnFraction: 1 };
}

/**
 * A model saved by an older engine (a project document, a run's input
 * snapshot, a workbook extract), brought to the current fields the way
 * migration 006 brings the database: a node without `irrigationEfficiency`
 * gets it from its `returnFlowPct` (irrigationFromReturnFlow), which is
 * dropped; a node without the dam evaporation fields gets their defaults
 * (area unknown, exponent 0.7, no seepage); a transfer without a priority
 * gets its position in the list (the order it ran in). Fields already
 * present are kept.
 * Pure; returns a copy.
 */
export function upgradeLegacyModel<M extends { nodes?: unknown; transfers?: unknown }>(model: M): M {
	const nodes = Array.isArray(model.nodes)
		? model.nodes.map((raw) => {
				if (!raw || typeof raw !== 'object') return raw;
				const { returnFlowPct, ...n } = raw as Record<string, unknown>;
				if (n.irrigationEfficiency === undefined || n.lossReturnFraction === undefined) {
					const up = irrigationFromReturnFlow(typeof returnFlowPct === 'number' ? returnFlowPct : 0);
					n.irrigationEfficiency ??= up.irrigationEfficiency;
					n.lossReturnFraction ??= up.lossReturnFraction;
				}
				// Dam evaporation and seepage (N2): unknown area, the default exponent, no seepage.
				if (n.damAreaFullM2 === undefined) n.damAreaFullM2 = null;
				n.damAreaExponent ??= DAM_AREA_EXPONENT;
				n.damSeepagePerDay ??= 0;
				// Other water users (WP-1.33): off unless set.
				if (n.userDemandM3Day === undefined) n.userDemandM3Day = USER_DEFAULTS.userDemandM3Day;
				n.userReturnPct ??= USER_DEFAULTS.userReturnPct;
				n.userPriority ??= USER_DEFAULTS.userPriority;
				// Boreholes (WP-1.34): none unless set.
				if (n.boreholeCapacityM3Day === undefined) n.boreholeCapacityM3Day = BOREHOLE_DEFAULTS.boreholeCapacityM3Day;
				n.boreholeRule ??= BOREHOLE_DEFAULTS.boreholeRule;
				n.boreholeTriggerPct ??= BOREHOLE_DEFAULTS.boreholeTriggerPct;
				n.streamDepletionFrac ??= BOREHOLE_DEFAULTS.streamDepletionFrac;
				n.streamDepletionLagDays ??= BOREHOLE_DEFAULTS.streamDepletionLagDays;
				return n;
			})
		: model.nodes;
	// Transfer priority (Q18): the order the rules ran in before, as migration 006 sets it.
	const transfers = Array.isArray(model.transfers)
		? model.transfers.map((raw, i) => (raw && typeof raw === 'object' && (raw as { priority?: unknown }).priority === undefined ? { ...(raw as object), priority: i } : raw))
		: model.transfers;
	return { ...model, nodes, transfers };
}

export interface CropDef {
	id: string;
	name: string;
	/** Display order (0-based); the model doesn't depend on it. */
	sortOrder?: number;
	/** Crop factor per water-year month (Oct–Sep), 12 values. */
	cropFactor: number[];
}

export interface CropArea {
	nodeId: string;
	cropId: string;
	areaM2: number;
}

export interface Transfer {
	id: string;
	fromNodeId: string;
	toNodeId: string;
	/** Calendar months 1–12 in which the transfer runs. */
	months: number[];
	maxRateM3s: number;
	dailyCapM3: number | null;
	minStoragePct: number;
	enabled: boolean;
	/**
	 * Integer, lower moves first (engine ≥ 0.16.0, audit Q18). Rules of equal
	 * priority from one source dam share its water pro rata to their limits,
	 * so the list order never matters.
	 */
	priority: number;
}

export interface ProjectModel {
	nodes: NetworkNode[];
	crops: CropDef[];
	cropAreas: CropArea[];
	transfers: Transfer[];
	/** Land-cover patches that reduce runoff (engine ≥ 0.24.0, WP-1.35). Absent on older documents = none. */
	landCover?: LandCoverPatch[];
}

/**
 * Land cover that uses more water than the natural vegetation it replaced
 * (engine ≥ 0.24.0, WP-1.35, docs/model.md §2.5a): invasive alien trees and
 * commercial forestry (a streamflow reduction activity under the National
 * Water Act). Each class's reductions are the share of the patch's runoff it
 * removes at full (100 %) condensed cover: `lowFlow` on the part of each day's
 * flow up to the unit's low-flow threshold (its natural flow exceeded 75 % of
 * the days), `mar` on the part above it. The defaults are indicative, from the
 * shape of the South African afforestation reduction curves at maturity
 * (Scott & Smith 1997: eucalypts reduce total flow more than pines, and low
 * flows proportionally more than total flow) and Le Maitre et al. (2016) for
 * invasive plants (riparian invasions × 1.5 of the dryland reduction); the
 * hydrologist confirms or overrides them per patch.
 */
export const LAND_COVER_CLASSES = [
	{ id: 'eucalyptus', label: 'Eucalyptus plantation (mature)', mar: 0.75, lowFlow: 0.9 },
	{ id: 'pine', label: 'Pine plantation (mature)', mar: 0.4, lowFlow: 0.55 },
	{ id: 'invasive', label: 'Invasive alien trees, dryland (wattle, pine, eucalypt)', mar: 0.5, lowFlow: 0.6 },
	{ id: 'invasiveRiparian', label: 'Invasive alien trees, riparian', mar: 0.75, lowFlow: 0.9 },
	{ id: 'other', label: 'Other (enter its reductions)', mar: 0, lowFlow: 0 }
] as const;
export type LandCoverClass = (typeof LAND_COVER_CLASSES)[number]['id'];

/** Where the indicative class reductions come from, shown next to them. */
export const LAND_COVER_DEFAULTS_SOURCE =
	'indicative, after Scott & Smith (1997) reduction curves at maturity and Le Maitre et al. (2016); confirm per catchment';

export interface LandCoverPatch {
	id: string;
	/** The farm (hydrological unit) the patch lies in. */
	nodeId: string;
	coverClass: LandCoverClass;
	/** Area of the patch, km². */
	areaKm2: number;
	/** Condensed (canopy) cover of the patch, 0–1: 1 = a closed stand. Its effective area is areaKm2 × density. */
	densityPct: number;
	/** Reductions overriding the class's (each 0–1 at full cover); null = the class defaults. */
	factors: { mar: number; lowFlow: number } | null;
}

/**
 * How an upload of sub-daily readings was added up into days
 * (time_series.day_boundary, 033_series_day_boundary.sql, issue #40 (b)):
 * '08:00' = 08:00 to 08:00, booked to the day it starts (the manual-gauge
 * convention); '00:00' = midnight to midnight.
 */
export const DAY_BOUNDARIES = ['00:00', '08:00'] as const;
export type DayBoundary = (typeof DAY_BOUNDARIES)[number];

/** A daily series: values[i] is the value on startDate + i days; null = missing. */
export interface DailySeries {
	startDate: string;
	values: (number | null)[];
	/**
	 * The product and version the values come from (time_series.product /
	 * product_version, 032_series_provenance.sql); null = not recorded, absent
	 * = not known here. The model never reads it: a run records it in its input
	 * snapshot, for the run comparison and the fit record's forcing.
	 */
	provenance?: SeriesProvenance | null;
}

export interface SeriesMeta {
	id: string;
	kind: string;
	name: string;
	unit: string;
	startDate: string;
	length: number;
	/** ISO timestamp of the last upload/merge that changed the values. */
	updatedAt?: string;
	/** Sub-daily readings added up into days in this window (033_series_day_boundary.sql); null = daily values as uploaded. */
	dayBoundary?: DayBoundary | null;
	/** What the values are (032_series_provenance.sql): e.g. CHIRPS / 2.0; null = not recorded. */
	product?: string | null;
	productVersion?: string | null;
	/** A data feed is backfilling a confirmed replacement of this series; its values stay as they are until it swaps in (feed_stage, 032). */
	rebuilding?: boolean;
}

// ---------------------------------------------------------------------------
// Engine I/O contract — runModel(input: ModelInput): ModelOutput.
// ---------------------------------------------------------------------------

export interface ModelInput {
	/** Raw project settings; the engine merges them over defaultProjectSettings(). */
	settings: Partial<ProjectSettings> & Record<string, unknown>;
	model: ProjectModel;
	/** Keyed by SeriesKind; only the first series of each kind is used. */
	series: Partial<Record<SeriesKind, DailySeries>>;
}

/** One daily output series. nodeId null = catchment level. */
export interface RunSeries {
	nodeId: string | null;
	/** Stable machine key, e.g. "natural_flow", "dam_storage", "ewr_shortfall". */
	key: string;
	label: string;
	unit: string;
	values: number[];
}

export interface FarmSummary {
	nodeId: string;
	name: string;
	/** Mean abstraction demand D = crop requirement ÷ irrigation efficiency (engine ≥ 0.16.0; before, the crop requirement). */
	avgDemandM3Day: number;
	avgSuppliedM3Day: number;
	avgDeficitM3Day: number;
	/** avg supplied / avg demand, 0–1: also the share of the crop requirement met (crop use = e × supplied). */
	fractionSupplied: number;
	/** Mean crop water requirement F (net irrigation need, engine ≥ 0.16.0); absent on older runs. */
	avgCropRequirementM3Day?: number;
	/**
	 * The farm's share of the catchment flow and of the EWR, 0–1 (docs/model.md
	 * §2.5, the workbook's [Fragmented flow] / [Fragmented EWR] factor), as the
	 * run applied it (engine ≥ 0.27.0); absent on older runs.
	 */
	flowShare?: number;
	/**
	 * Mean EWR charge (positive): this farm's share of the shortfall at the EWR
	 * sites below it (engine ≥ 0.17.0, audit Q17). Engines before 0.17.0 stored
	 * the mean incremental shortfall (Element sheet AB).
	 */
	avgEwrShortfallM3Day: number;
	/** Days the farm was charged (engine ≥ 0.17.0); before, days its AB was below 0. */
	daysEwrNotMet: number;
	/** Mean groundwater pumped, part of supplied (engine ≥ 0.23.0, WP-1.34); only for a node with boreholes. */
	avgGroundwaterM3Day?: number;
	/** Mean stream depletion taken from the river below it (WP-1.34); only for a node with boreholes. */
	avgBaseflowDepletionM3Day?: number;
}

/**
 * An other water user over the whole run (engine ≥ 0.22.0, WP-1.33), m³/day
 * means like FarmSummary.
 */
export interface UserSummary {
	nodeId: string;
	name: string;
	priority: UserPriority;
	avgDemandM3Day: number;
	/** Taken from the river. */
	avgSuppliedM3Day: number;
	avgDeficitM3Day: number;
	/** avg supplied / avg demand, 0–1 (1 without demand). */
	fractionSupplied: number;
	/** Returned below it (treated wastewater). */
	avgReturnedM3Day: number;
	/** Mean EWR charge (positive): its share of the shortfall at the EWR sites below it, net-impact pro rata like a farm's. */
	avgEwrChargeM3Day: number;
	daysEwrNotMet: number;
	/** Mean groundwater pumped, part of supplied (WP-1.34); only with boreholes. */
	avgGroundwaterM3Day?: number;
	/** Mean stream depletion taken from the river below it (WP-1.34); only with boreholes. */
	avgBaseflowDepletionM3Day?: number;
}

/**
 * An other water user's row of the curtailment report (engine ≥ 0.22.0,
 * WP-1.33, docs/model.md §2.11). Other users are outside the irrigation
 * equitable-share benchmark (their demand is not irrigation). A junior user
 * is curtailed for its EWR charge like a farm (supply cut = charge ÷ its
 * consumptive share, never more than it took); a senior one is not: its
 * charge is reported and left standing. Window means, m³/day; ≤ 0 = reduce.
 */
export interface CurtailmentUser {
	nodeId: string;
	name: string;
	priority: UserPriority;
	demandM3Day: number;
	suppliedM3Day: number;
	/** supplied − demand, ≤ 0. */
	deficitM3Day: number;
	fractionSupplied: number | null;
	returnedM3Day: number;
	/** Mean EWR charge, ≤ 0. */
	ewrChargeM3Day: number;
	/** Junior users only. */
	curtailed: boolean;
	/** −ΔG ≤ 0: the cut in what it takes that removes the charge (0 for a senior user). */
	supplyCutM3Day: number;
	supplyCutLs: number;
	/** The charge the cut does not remove, ≤ 0: all of it for a senior user, the part beyond what it took for a junior one. */
	uncurtailedChargeM3Day: number;
}

/**
 * What land cover took from the river over the run (engine ≥ 0.24.0, WP-1.35).
 * mm per year over the condensed area is the figure Le Maitre et al. (2016)
 * report (97 mm/yr nationally for invasive plants) to compare with.
 */
export interface LandCoverSummary {
	/** The low-flow threshold: catchment natural flow exceeded 75 % of the days (m³/day). */
	lowFlowThresholdM3Day: number;
	/** Mean reduction, m³/day. */
	reductionM3Day: number;
	/** Σ reduction / Σ natural flow over the run (0–1); null without natural flow. */
	fractionOfNatural: number | null;
	byClass: {
		coverClass: LandCoverClass;
		/** Σ area × density of the patches, km². */
		condensedKm2: number;
		reductionM3Day: number;
		/** Mean annual reduction over the condensed area, mm/yr (365.25 days). */
		mmPerYear: number | null;
	}[];
}

/** Observed vs simulated volume in one water year (paired days only). */
export interface AnnualVolume {
	/** Water year, labelled by the calendar year it starts in (2001 = Oct 2001 – Sep 2002). */
	waterYear: number;
	/** Days with an observation (the days the volumes cover). */
	days: number;
	/** Days of this water year inside the calibration window; < 365 marks a part year. */
	daysInWindow: number;
	observedMm3: number;
	simulatedMm3: number;
	/** 100 × (simulated − observed) / observed; null when nothing was observed. */
	diffPct: number | null;
}

/**
 * Fit of simulated outflow to observed flow (network/stats.ts). Fields after
 * `meanSimulatedM3s` were added in engine 0.3.0 and are absent on runs saved
 * by older engines.
 */
export interface CalibrationStats {
	/** Days inside the window where both observed and simulated outflow exist. */
	days: number;
	nse: number | null;
	pbias: number | null;
	rmseM3s: number | null;
	meanObservedM3s: number | null;
	meanSimulatedM3s: number | null;
	/** The window that was scored, clamped to the run (ISO, inclusive). */
	windowStart?: string | null;
	windowEnd?: string | null;
	/** First and last day inside the window with an observation. */
	firstObservedDate?: string | null;
	lastObservedDate?: string | null;
	/** Kling–Gupta efficiency (Gupta et al. 2009) and its components. */
	kge?: number | null;
	/** Pearson correlation of observed and simulated flow. */
	kgeR?: number | null;
	/** Variability ratio σ_sim / σ_obs. */
	kgeAlpha?: number | null;
	/** Bias ratio mean_sim / mean_obs. */
	kgeBeta?: number | null;
	/** Coefficient of determination, r². */
	r2?: number | null;
	/** NSE on ln(Q + ε): sensitive to low flows. */
	logNse?: number | null;
	/** ε used by logNse (m³/s): 1% of the mean observed flow. */
	logEpsilonM3s?: number | null;
	/** 100 × (Σsim − Σobs) / Σobs; positive = model too wet (= −PBIAS). */
	volumeErrorPct?: number | null;
	/** Annual water balance: observed vs simulated volume per water year. */
	annualVolumes?: AnnualVolume[];
	/** The series simulated outflow was compared with (set by runModel). */
	flowKind?: CalibrationFlowKind;
	/**
	 * The simulated series that was scored: always `simulated_outflow`, since
	 * gauge and logger records measure impacted flow. Engines 0.4.0–0.9.0 scored
	 * `natural_flow` against a Pitman record, which engine 0.10.0 removed (audit P1).
	 */
	simulatedKey?: 'natural_flow' | 'simulated_outflow';
	/**
	 * The stored calibration exclusions the run applied (engine ≥ 0.8.0), as
	 * dates with their reasons; absent when none. Excluded days are not scored.
	 */
	exclusions?: ExclusionRange[];
	/** Observed days inside the window that the exclusions left out (engine ≥ 0.8.0). */
	excludedDays?: number;
}

/** EWR compliance of one site as a water-year × month grid (see EwrCompliance). */
export interface EwrComplianceGrid {
	/** null = the catchment outlet (simulated outflow vs the full pragmatic EWR). */
	nodeId: string | null;
	name: string;
	/** Days the EWR was not met, [water-year row][month 0 = Oct … 11 = Sep]. */
	daysNotMet: number[][];
	/** Volume short of the EWR (m³, positive), same shape. */
	shortfallM3: number[][];
}

/**
 * EWR compliance per water year × month (network/ewr.ts), the app's version of
 * the workbook's [EWR shortfalls Pivot Data] / [EWR analysis] pivot. A day
 * counts as "not met" when that day's shortfall is below zero (the workbook's
 * pivot counts differently; see docs/model.md §2.8).
 */
export interface EwrCompliance {
	/** Row labels: water years, by the calendar year they start in (Oct). */
	waterYears: number[];
	/** Days simulated in each cell (0 outside the run), same shape as the grids. */
	days: number[][];
	outlet: EwrComplianceGrid;
	/**
	 * Per farm, from its EWR charge (`ewr_charge`, engine ≥ 0.17.0, audit Q17):
	 * the days it was charged and the volume charged to it. Engines before
	 * 0.17.0 gridded the incremental shortfall (`ewr_shortfall_incremental`).
	 */
	farms: EwrComplianceGrid[];
}

/**
 * One 2×2 table of "simulated outflow below the EWR" against "observed flow
 * below the EWR" (network/ewrAgreement.ts), with its scores. Ratios are null
 * when their denominator is 0.
 */
export interface EwrAgreementScores {
	/** Observed days counted. */
	days: number;
	/** Both below the EWR (a hit). */
	bothBelow: number;
	/** The model is below, the river was not (a false alarm). */
	falseAlarm: number;
	/** The river was below, the model is not (a miss). */
	miss: number;
	/** Both at or above the EWR. */
	bothAbove: number;
	/** Probability of detection: bothBelow ÷ (bothBelow + miss). */
	hitRate: number | null;
	/** falseAlarm ÷ (bothBelow + falseAlarm). */
	falseAlarmRatio: number | null;
	/** Model share of days below ÷ observed share: (bothBelow + falseAlarm) ÷ (bothBelow + miss). 1 = unbiased. */
	frequencyBias: number | null;
	/** Share of the counted days the model is below the EWR. */
	modelFractionBelow: number | null;
	/** Share of the counted days the observed flow is below the EWR. */
	observedFractionBelow: number | null;
}

/**
 * Does the model fail the EWR on the days the river did (engine ≥ 0.5.3,
 * issue #4)? The outlet EWR test applied to the observed gauge/logger record
 * and to the simulated outflow on every day with an observation.
 */
export interface EwrAgreement {
	/** Days counted (observed, inside any window, outside every exclusion). */
	days: number;
	/** Observed days left out by an exclusion. */
	excludedDays: number;
	firstObservedDate: string | null;
	lastObservedDate: string | null;
	overall: EwrAgreementScores;
	/** Per calendar month, water-year order: index 0 = Oct … 11 = Sep. */
	byMonth: EwrAgreementScores[];
	/** Per water year (labelled by the calendar year it starts in), years with counted days only. */
	byWaterYear: (EwrAgreementScores & { waterYear: number })[];
}

/**
 * One farm's row of the curtailment report (b023 [Shortfalls], workbook column
 * in brackets). Averages are over the reporting window. Nothing is rounded
 * (the sheet rounds and truncates; docs/engine-audit.md R1) — round for display.
 * Signs follow the workbook: negative = reduce / shortfall, positive = gain.
 * See docs/model.md §2.11.
 */
export interface CurtailmentFarm {
	nodeId: string;
	name: string;
	/** [H] Average net irrigation demand. */
	demandM3Day: number;
	/** [I] Average irrigation supplied. */
	suppliedM3Day: number;
	/** [J] supplied − demand (≤ 0: the average deficit). */
	deficitM3Day: number;
	/** [K] supplied / demand; null when demand is 0 (the workbook shows "-"). */
	fractionSupplied: number | null;
	/** [M] demand × catchment equitableFraction: this farm's equitable share of the water actually supplied. */
	targetM3Day: number;
	/** [N] target − supplied. Negative = reduce, positive = may gain. */
	reduceGainM3Day: number;
	/** [O] reduceGainM3Day / 86.4, l/s. */
	reduceGainLs: number;
	/** [P] target / demand; null when demand is 0. */
	targetFraction: number | null;
	/**
	 * [R] Average EWR charge, ≤ 0: the farm's share of the shortfall at the EWR
	 * sites below it, net-impact pro rata (engine ≥ 0.17.0, audit Q17). Engines
	 * before 0.17.0: the average incremental shortfall (Element sheet AB).
	 */
	ewrShortfallM3Day: number;
	/**
	 * [S] Negative = total cut in supply needed to balance irrigation and meet
	 * the EWR. Engine ≥ 0.17.0 (audit Q13): reduceGain + ewrSupplyCut, so only
	 * the part of the charge irrigation can meet; before: reduceGain + ewrShortfall.
	 */
	totalChangeM3Day: number;
	/** [T] totalChangeM3Day / 86.4, l/s. */
	totalChangeLs: number;
	/**
	 * [U] Irrigation volume left once balanced and the EWR is met. Engine ≥
	 * 0.17.0 (audit Q13): MAX(target + ewrSupplyCut, 0), never below 0; before:
	 * target + ewrShortfall, which could be negative.
	 */
	volumeLeftM3Day: number;
	/**
	 * [V] volumeLeft / demand: share of demand that is left (the workbook labels
	 * it "reduction of demand required"), in 0–1 from engine 0.17.0. null when
	 * demand is 0. Below DEMAND_PCT_FLOOR_M3_DAY of demand the UI shows "—".
	 */
	fractionOfDemandLeft: number | null;
	/**
	 * The part of R met by irrigating less (R_irr, ≤ 0; engine ≥ 0.17.0, audit
	 * Q17): the mean of A · c / (c + MAX(o, 0)) with c = G − T the farm's
	 * consumptive irrigation and o = e − c its storage gain and net export.
	 */
	ewrChargeIrrigationM3Day?: number;
	/** R − R_irr (≤ 0): the part met by storing less or passing inflow (audit Q13). */
	ewrChargeStorageM3Day?: number;
	/** −ΔG (≤ 0): the cut in supply that removes R_irr of consumptive use, R_irr ÷ (1 − β(1 − e)). */
	ewrSupplyCutM3Day?: number;
	/** ewrSupplyCutM3Day / 86.4, l/s. */
	ewrSupplyCutLs?: number;
	/** The EWR site (node id) that set most of the charge over the window; null when not charged. */
	ewrBindingSiteId?: string | null;
	/** MAX(ΔG − target, 0) ≥ 0: how far the EWR supply cut exceeds the farm's equitable share (audit Q13); flagged when > 0. */
	ewrCutBeyondShareM3Day?: number;
}

/**
 * One EWR site over the reporting window (engine ≥ 0.17.0, audit Q17): the
 * outlet and every gauge. Volumes are window means in m³/day, ≤ 0;
 * charged + natural = shortfall.
 */
export interface EwrSiteSummary {
	/** The site's node (the outlet node for the outlet). */
	nodeId: string;
	name: string;
	/** The catchment outlet: its shortfall is the simulated outflow against the full pragmatic EWR. */
	isOutlet: boolean;
	/** Farms whose outflow reaches the site. */
	farmCount: number;
	daysNotMet: number;
	shortfallM3Day: number;
	/** The part charged to the farms upstream (D* = MIN(D, Σ net impact)). */
	chargedM3Day: number;
	/** The natural part: natural flow was already below the EWR. */
	naturalM3Day: number;
}

/** b023 [Shortfalls] over a reporting window: per-farm targets and cuts, plus the totals row. */
export interface CurtailmentSummary {
	/** Inclusive reporting window actually used (ISO dates). */
	reportStart: string;
	reportEnd: string;
	days: number;
	/** [K total] Σ supplied / Σ demand over all farms; null when total demand is 0 (the workbook shows #DIV/0!). */
	equitableFraction: number | null;
	farms: CurtailmentFarm[];
	/** The rule that set R (engine ≥ 0.17.0): net-impact pro rata at the EWR sites (audit Q17). Absent on older runs. */
	ewrAttribution?: 'netImpactProRata';
	/** The EWR sites (outlet first, then gauges by node id) over the window; absent on older runs. */
	ewrSites?: EwrSiteSummary[];
	/** Other water users (engine ≥ 0.22.0, WP-1.33); absent when the network has none. Not in the totals row. */
	otherUsers?: CurtailmentUser[];
	/** The workbook's totals row: plain sums of the farm columns. */
	totals: {
		demandM3Day: number;
		suppliedM3Day: number;
		deficitM3Day: number;
		targetM3Day: number;
		reduceGainM3Day: number;
		reduceGainLs: number;
		ewrShortfallM3Day: number;
		ewrChargeIrrigationM3Day?: number;
		ewrChargeStorageM3Day?: number;
		ewrSupplyCutM3Day?: number;
		ewrCutBeyondShareM3Day?: number;
		totalChangeM3Day: number;
		volumeLeftM3Day: number;
	};
}

/**
 * The runoff model's water balance over the run (engine ≥ 0.5.0; conceptual
 * models only, absent for the legacy model), in mm over the catchment:
 *   rain − aet − flow + exchange = storageEnd − storageStart.
 * The stores start the run at the level the warm-up left them.
 */
export interface RunoffBalance {
	model: Exclude<RunoffModelId, 'legacy'>;
	/** The parameters the run used (after validation). */
	params: Record<string, number>;
	warmupDays: number;
	/** Area the mm are spread over (km²). */
	areaKm2: number;
	rainMm: number;
	petMm: number;
	aetMm: number;
	flowMm: number;
	/** Net groundwater exchange (+ = gained); 0 when X2 = 0. */
	exchangeMm: number;
	storageStartMm: number;
	storageEndMm: number;
}

export interface ForecastRainDays {
	/** Days whose rain used is the forecast. */
	days: number;
	/** The first and last such day. */
	from: string;
	to: string;
	/** How many fall inside the reporting window (curtailment, EWR sites). */
	inReport: number;
	/** The last day with recorded rain (catchment or CHIRPS); null when none. */
	lastRecorded: string | null;
}

export interface RunSummary {
	farms: FarmSummary[];
	/** Other water users (engine ≥ 0.22.0, WP-1.33); absent when the network has none. */
	users?: UserSummary[];
	/** Land-cover streamflow reductions (engine ≥ 0.24.0, WP-1.35); absent without land cover. */
	landCover?: LandCoverSummary;
	/** Water balance of the runoff model (engine ≥ 0.5.0, GR4J runs only). */
	runoff?: RunoffBalance;
	catchment: {
		meanNaturalFlowM3Day: number;
		meanSimulatedOutflowM3Day: number;
		/**
		 * Natural-flow volume / rain volume on the catchment over the run (engine
		 * ≥ 0.4.0); null without rain. Above 1 is physically impossible and warns.
		 */
		runoffCoefficient?: number | null;
		ewrDaysNotMet: number;
		ewrFractionDaysNotMet: number;
		/**
		 * The outlet EWR test on the observed record vs the simulated outflow
		 * (engine ≥ 0.5.3). null when the run has no gauge or logger record
		 * (Pitman flow is naturalised, so it can't take the outlet test); absent
		 * on older runs.
		 */
		ewrAgreement?: EwrAgreement | null;
	};
	calibration: CalibrationStats | null;
	/**
	 * Curtailment targets per farm over settings.reportStart…reportEnd. Absent
	 * on runs stored before engine 0.3.0.
	 */
	curtailment?: CurtailmentSummary;
	/** EWR compliance grid; absent on runs saved by engines before 0.3.0. */
	ewrCompliance?: EwrCompliance;
	/**
	 * Monthly compliance with the Reserve's assurance rules at each EWR site
	 * that has a rule table (engine ≥ 0.21.0, ./reserve/assurance.ts), outlet
	 * first then gauges in node-id order. Absent when the project has no table,
	 * and on older runs.
	 */
	ewrAssurance?: EwrAssuranceSite[];
	/**
	 * Simulated natural flow against the entered WR2012 reference (engine ≥
	 * 0.6.0); absent when the project has no reference, and on older runs.
	 */
	wr2012?: Wr2012Report;
	/**
	 * Input data-quality checks (engine ≥ 0.3.1). observedAgreement is null when
	 * the project doesn't have both observed flow records. seriesChecks and
	 * areaMismatches were added later and are absent on older runs.
	 */
	dataQuality?: {
		observedAgreement: ObservedAgreement | null;
		/**
		 * Negative values, outliers and flat-lines in the input series; from
		 * engine 0.5.2 also catchment-rain zero runs and water years far below
		 * CHIRPS (issue #2); from 0.18.0 also double-mass breaks against CHIRPS
		 * ('doublemass').
		 */
		seriesChecks?: SeriesCheck[];
		/** Farms whose area differs from high-MAP + low-MAP area by more than 1 %. */
		areaMismatches?: AreaMismatch[];
		/**
		 * The double-mass curve of catchment rain against CHIRPS (engine ≥
		 * 0.18.0, ./doublemass.ts); null without both series or with too few
		 * judged water years, absent on older runs.
		 */
		doubleMass?: DoubleMass | null;
	};
	/**
	 * Hydrologist plausibility checks (engine ≥ 0.25.0, ./plausibility,
	 * model.md §2.10d): natural ≥ observed + abstraction per water year, EWR
	 * results by rain source, the double-mass curve of observed flow against
	 * rain, and dry-season low-flow duration curves. Report and warn only.
	 * Absent on older runs.
	 */
	plausibility?: PlausibilityChecks;
	/**
	 * The CHIRPS fallback bias correction (engine ≥ 0.7.0, ./rain.ts): the
	 * factors fitted per calendar month and how many run days used them. null
	 * when the project has no CHIRPS series; absent on older runs.
	 */
	chirpsCorrection?: ChirpsCorrection | null;
	/**
	 * The days whose rain came from the forecast because neither catchment
	 * rain nor CHIRPS had a value (engine ≥ 0.28.0): a forecast can extend the
	 * run, and with it the reporting window, past the last recorded rain.
	 * null when the project has a forecast series but no day used it; absent
	 * without a forecast series and on older runs.
	 */
	forecastRain?: ForecastRainDays | null;
	/**
	 * Catchment rain treated as missing (engine ≥ 0.15.0, ./rain.ts, CR-20):
	 * the flagged zero runs and listed periods, and what filled them. null when
	 * the project has no catchment rain; absent on older runs.
	 */
	zeroRainInfill?: ZeroRainInfill | null;
	/** What settings.rainSource did (engine ≥ 0.30.0, ./rainSourcePeriods.ts); null without periods, absent before 0.30.0. */
	rainSource?: RainSourceInfo | null;
	/**
	 * Untagged multi-day accumulations in the catchment rain (engine ≥ 0.20.0,
	 * ./accumulation.ts, audit B4): the windows detected or listed, what the
	 * run did with each, and the days spread. null when the project has no
	 * catchment rain; absent on older runs.
	 */
	rainAccumulation?: RainAccumulationInfo | null;
	/**
	 * The engine's self-checks on this run's own output (engine ≥ 0.12.0,
	 * ./verify): the invariants the test suite asserts on random networks,
	 * run on the real catchment. Absent on older runs.
	 */
	verification?: RunVerification;
	/** Where the water went, per water year and over the run (engine ≥ 0.12.0). Absent on older runs. */
	waterBalance?: WaterBalance;
	/**
	 * The forecast days of a forecast-mode run (WP-2.12, ./forecast.ts
	 * runForecastChecked): every other figure in this summary covers the days
	 * before `forecast.from` only. Absent on ordinary runs and older runs.
	 */
	forecast?: ForecastSummary;
	/**
	 * Assurance of supply per farm and user, stress classes and the water
	 * account (engine ≥ 0.32.0, WP-3.4, ./network/reliability.ts, model.md
	 * §2.11a–b). Absent on older runs.
	 */
	supplyAssurance?: SupplyAssurance;
	/** Non-fatal problems (flow shares not summing to 1, missing series, …). */
	warnings: string[];
}

export type VerificationCheckId = 'balance' | 'workings' | 'soilWater' | 'runoff' | 'transfers' | 'reports' | 'ewrAttribution' | 'groundwater' | 'landCover';

export interface VerificationCheck {
	id: VerificationCheckId;
	/** What the check asserts, in words. */
	label: string;
	passed: boolean;
	/** The first broken property (node names and dates, not ids), null when passed. */
	detail: string | null;
}

export interface RunVerification {
	/** Every check passed. */
	passed: boolean;
	checks: VerificationCheck[];
	/**
	 * The largest |balance check| (column V) of any farm on any day, m³/day:
	 * float noise only, many orders of magnitude below the flows. null without farms.
	 */
	maxResidual: { valueM3Day: number; nodeId: string; name: string; date: string } | null;
}

/**
 * One water year's (or the whole run's) water balance. Volumes in m³ over the
 * period, depths in mm over the catchment. The network closes:
 * opening storage + farm runoff + transfers = consumptive use + outflow +
 * closing storage + residual, with consumptive use = supplied − return flow
 * and the residual float noise.
 */
export interface WaterBalanceRow {
	/** Start year of the water year (Oct–Sep); null for the whole-run row. */
	waterYear: number | null;
	days: number;
	/** Catchment rain after gap-filling (rain_final, mm); null when the run has no rain series. */
	rainMm: number | null;
	/** Natural flow as depth over the catchment (mm); null without an area. */
	naturalFlowMm: number | null;
	/** naturalFlowMm / rainMm; null without rain or an area. */
	runoffCoefficient: number | null;
	/** Runoff model store balance (GR4J only; null for legacy runs). */
	runoff: {
		aetMm: number;
		exchangeMm: number;
		storageChangeMm: number;
		/** Rain the model used (rain_used, missing days 0) − AET − flow + exchange − Δstorage. */
		residualMm: number;
	} | null;
	naturalFlowM3: number;
	/** Σ farm runoff (I). Equals the natural flow when the farm shares sum to 1. */
	farmRunoffM3: number;
	openingStorageM3: number;
	demandM3: number;
	suppliedM3: number;
	returnFlowM3: number;
	/** Supplied − return flow: the water that leaves the river. */
	consumptiveUseM3: number;
	/** Net transfers across all farms; 0 up to float noise. */
	transfersM3: number;
	/** Rain falling on the dams' surface (engine ≥ 0.16.0, audit N2); absent on older runs. */
	rainOnDamsM3?: number;
	/** Open-water evaporation from the dams (engine ≥ 0.16.0); absent on older runs. Seepage is in the outflow. */
	damEvaporationM3?: number;
	/** Other water users' consumptive use: taken − returned (engine ≥ 0.22.0, WP-1.33); absent without users. */
	otherUseM3?: number;
	/** Groundwater pumped into supply, a gain to the surface balance (engine ≥ 0.23.0, WP-1.34); absent without boreholes. */
	groundwaterM3?: number;
	/** Stream depletion taken from the river (WP-1.34); absent without boreholes. */
	streamDepletionM3?: number;
	/** Runoff removed by land cover before it reached the farms (engine ≥ 0.24.0, WP-1.35); absent without land cover. */
	landCoverReductionM3?: number;
	spillM3: number;
	outflowM3: number;
	closingStorageM3: number;
	/** opening + runoff + transfers + rain on dams + groundwater − consumptive use − dam evaporation − other use − stream depletion − outflow − closing. */
	residualM3: number;
}

export interface WaterBalance {
	areaKm2: number | null;
	years: WaterBalanceRow[];
	total: WaterBalanceRow;
}

export interface ModelOutput {
	engineVersion: string;
	startDate: string;
	endDate: string;
	days: number;
	series: RunSeries[];
	summary: RunSummary;
	/**
	 * Forecast mode only (WP-2.12, ./forecast.ts): the first day whose rain
	 * came from the forecast after the last observed rain day, null when the
	 * run has no forecast tail. Absent on ordinary runs.
	 */
	forecastFrom?: string | null;
}
