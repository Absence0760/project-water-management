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
import type { ApanDailyInfo } from './evaporation/apanDaily';
import type { RainAccumulationInfo } from './accumulation';
import type { Gr4jParams } from './runoff/params';
import type { RunoffModelId } from './runoff/types';
import type { SeriesProvenance } from './seriesProvenance';
import type { Wr2012Report } from './reference/wr2012';
import type { EwrChargeSource, EwrRuleTable, LowFlowMeasure } from './reserve/rules';
import type { EwrAssuranceSite } from './reserve/assurance';
import type { SupplyAssurance } from './network/reliability';
import type { AllocationEntry, AllocationWaterSource } from './allocations/compare';
import type { AllocationMode } from './allocations/mode';
import { defaultWr2012Settings, type Wr2012Settings } from './reference/wr2012Settings';

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
 * Catchment settings from b023 [Flow Calibration Cfg] that outlived its
 * recession model (removed in engine 1.0.0, issue #16). The key keeps its
 * workbook name; the legacy model's other keys (a, b, the season factors and
 * thresholds, the recession tables) are dropped when settings are read
 * (migration 064). Workbook named range in brackets.
 */
export interface CalibrationParams {
	/**
	 * Rain at or below this (mm) counts as no rain for irrigation demand's
	 * effective rain [rCalibration_RainThreshold].
	 */
	rainThresholdMm: number;
	/**
	 * Catchment area (km²) that rain falls on [rFarmSpec_AreaTotal]. null (the
	 * default) = the sum of the farm nodes' areas, which is what the workbook's
	 * total is; set it only to override.
	 */
	catchmentAreaKm2: number | null;
}

/**
 * The warning a run carries when its settings still named the legacy runoff
 * model, which engine 1.0.0 removed (issue #16): it ran GR4J instead.
 */
export const LEGACY_UPGRADED_WARNING =
	'LEGACY_UPGRADED: this project was set to the legacy runoff model (b023 workbook), removed in engine 1.0.0; it ran GR4J. Check the GR4J parameters (Settings → Flow calibration) or refit them.';

/** The legacy runoff model's keys under settings.calibration, dropped since engine 1.0.0 (issue #16). */
export const RETIRED_CALIBRATION_KEYS = [
	'a',
	'b',
	'summerFactor',
	'winterFactor',
	'summerMonths',
	'baseFlowInitial',
	'baseResetRatio',
	'winterTodayRainMm',
	'winterNextDayRainMm',
	'shiftPeakIndexLo',
	'shiftPeakIndexHi',
	'amplitudeM3Day',
	'recessionDaysMax',
	'recessionFactors',
	'recessionCurveM3Day'
] as const;

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
	 * Effective-rain fractions per water-year month (Oct–Sep), each 0–1
	 * (engine ≥ 0.43.0, issue #54). null / absent = the one
	 * `effectiveRainFraction` in every month. When set it replaces that
	 * fraction month by month; the soil-water store still carries the
	 * effective rain over (./demand.ts farmDailyDemand). Never defaulted to 0:
	 * a row of zeros means rain never offsets demand, and the run warns.
	 */
	effectiveRainFractionMonthly?: Monthly | null;
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
	/**
	 * Monthly lake-evaporation factors, × A-pan per water-year month (Oct–Sep)
	 * (engine ≥ 0.35.0, WP-3.5, docs/model.md §2.7a). null / absent = the one
	 * `lakeEvapFactor` in every month. Open water lags the pan through the
	 * seasons (a deep dam stores heat in autumn and evaporates relative to the
	 * pan more in winter), which one factor can't show.
	 */
	lakeEvapFactorMonthly?: Monthly | null;
	/**
	 * What the project's registered volumes (ProjectModel.allocations) do to a
	 * run (engine ≥ 1.18.0, issue #72, ./allocations/mode.ts, docs/model.md
	 * §2.12a): 'none' (the default) compares only; 'cap' keeps each unit's
	 * surface and groundwater use per water year within its registered
	 * volumes; 'fullAllocation' scales each unit's demand to them. Optional
	 * so settings stored before it still type; absent = 'none'.
	 */
	allocationMode?: AllocationMode;
	/**
	 * The band around a registered volume counted as "within" when modelled
	 * use is compared with it (RunSummary.allocations, the Allocations tab),
	 * a fraction in [0, 1) (engine ≥ 1.18.0, issue #72). Default 0.1 (±10 %),
	 * pending the hydrologist. Absent = the default.
	 */
	allocationTolerance?: number;
	/** WR90 A-pan evaporation, mm per water-year month (Oct–Sep). */
	apanMm: Monthly;
	flowShareMethod: FlowShareMethod;
	/** Pitman high/low MAP split used by the `hiLo` flow-share method. */
	hiLoSplit: { hi: number; lo: number };
	/**
	 * Rain → natural-flow model (./runoff): 'gr4j', the only one since engine
	 * 1.0.0 removed the legacy b023 recession model (issue #16). Not a choice
	 * any more but the run's record of its model: a stored run whose settings
	 * don't say 'gr4j' ran the legacy model (StoredRunoffModelId). Reading
	 * settings maps a stored 'legacy' to 'gr4j', with a warning.
	 */
	runoffModel: RunoffModelId;
	/** Parameters of the GR4J runoff model (used when runoffModel = 'gr4j'). */
	gr4j: Gr4jSettings;
	/**
	 * Pan coefficient per water-year month (Oct–Sep): potential evaporation =
	 * coefficient × A-pan. Drives the runoff model (GR4J), not irrigation
	 * demand. Default 0.7 every month. Stays editable
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
	 * Areal rainfall correction (engine ≥ 1.13.0, docs/model.md §2.4g): the
	 * rain GR4J runs on (catchment rain, else corrected CHIRPS, else
	 * forecast) × a factor per water-year month, turning a point or gridded
	 * series into the catchment's areal rain (orographic rain a valley gauge
	 * or a 0.05° product misses). Runoff only: irrigation demand's effective
	 * rain and rain on the dams keep the uncorrected rain. A fixed input with
	 * its provenance, never a calibrated parameter. Optional so settings
	 * stored before it still type; absent or null = no correction (× 1).
	 */
	arealRain?: ArealRain | null;
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
	 * the daily pragmatic EWR above drives the shortfall charge and
	 * curtailment unless `ewrChargeSource` is 'ruleTable'.
	 */
	ewrRules: EwrRuleTable[];
	/**
	 * What the daily EWR charge, curtailment and the water account's EWR
	 * required vs met follow at an EWR site (engine ≥ 1.3.0, issue #64,
	 * ./reserve/rules.ts EWR_CHARGE_SOURCES): 'pragmatic' (the default) or
	 * 'ruleTable' (the site's Reserve rule table, where it has one). Pending
	 * the hydrologist. Optional so settings stored before it still type;
	 * absent = 'pragmatic'.
	 */
	ewrChargeSource?: EwrChargeSource;
	/**
	 * What a month's flow is judged by against a low-flow requirement (engine
	 * ≥ 1.3.0, issue #64, ./reserve/rules.ts LOW_FLOW_MEASURES): 'total' (the
	 * default, the month's volume) or 'baseflow' (its base flow, from the
	 * Lyne–Hollick filter). Pending the hydrologist. Absent = 'total'.
	 */
	lowFlowMeasure?: LowFlowMeasure;
	/** Optional simulation window (ISO dates); defaults to the full series. */
	simulationStart: string | null;
	simulationEnd: string | null;
	/**
	 * The first day (ISO) the nodes' demand factors (NetworkNode.demandFactor,
	 * the demand.scale scenario op) apply (engine ≥ 0.44.0, issue #53 R5):
	 * before it every factor is 1. null / absent = every day of the run. Set
	 * only by the seasonal outlook (./outlook), so a demand level changes the
	 * season after the decision date and not the history that sets the state
	 * the season starts from. Not a project setting: no form or save carries it.
	 */
	demandFactorFrom?: string | null;
	/**
	 * Set farm dam storage at the start of one day (engine ≥ 0.46.0, issue
	 * #53 R6, docs/model.md §2.15a): on `date` each listed farm dam starts
	 * the day holding `storageM3[nodeId]` (clamped to 0 … its capacity)
	 * instead of what the day before left, and the run publishes the step as
	 * `dam_storage_set` (m³, + added / − taken) so every balance still
	 * closes. Everything else carries on (soil water, GR4J's stores, stream
	 * depletion, the supply switch). null / absent = none. Set only by the
	 * review triggers' members (./outlook/triggers.ts); not a project
	 * setting: no form or save carries it.
	 */
	damStorageReset?: { date: string; storageM3: Record<string, number> } | null;
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

/**
 * The key of an observed record attached to a gauge node inside the network
 * (engine ≥ 1.4.0, docs/model.md §2.10d): `<kind>@<node id>` in
 * ModelInput.series, beside the outlet's records (plain kinds). The backend
 * builds it from time_series.site_node_id (084_gauge_records.sql). Only the
 * plausibility checks read it: calibration, the EWR agreement and every other
 * check stay on the outlet's records.
 */
export type GaugeSeriesKey = `${CalibrationFlowKind}@${string}`;
export const gaugeSeriesKey = (kind: CalibrationFlowKind, nodeId: string): GaugeSeriesKey => `${kind}@${nodeId}`;
/** The kind and node of a gauge record's key; null for any other key. */
export function parseGaugeSeriesKey(key: string): { kind: CalibrationFlowKind; nodeId: string } | null {
	const at = key.indexOf('@');
	if (at < 0) return null;
	const kind = key.slice(0, at);
	const nodeId = key.slice(at + 1);
	return (CALIBRATION_FLOW_KINDS as readonly string[]).includes(kind) && nodeId ? { kind: kind as CalibrationFlowKind, nodeId } : null;
}

/**
 * The label of a run's observed-flow series by the record it holds: the
 * calibration record (`observed_flow`) and, when the project has both, the
 * other one (`observed_flow_other`, engine ≥ 0.39.0). A caller can tell the
 * gauge from the logger by it (the stored series ref carries the label).
 */
export const OBSERVED_SERIES_LABEL: Record<CalibrationFlowKind, string> = {
	flow_observed_m3s: 'Observed flow',
	flow_logger_m3s: 'Observed flow (logger)'
};

const zeros: Monthly = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

/** Neutral starting values for a new project; each is set per project. */
export function defaultProjectSettings(): ProjectSettings {
	return {
		februaryDays: 28.25,
		effectiveRainFraction: 0.65,
		effectiveRainFractionMonthly: null,
		effectiveRainStoreMm: 25,
		lakeEvapFactor: 0.75,
		assuranceAnnualThreshold: 0.9,
		allocationMode: 'none',
		allocationTolerance: 0.1,
		lakeEvapFactorMonthly: null,
		apanMm: zeros,
		flowShareMethod: 'area',
		hiLoSplit: { hi: 0.5, lo: 0.5 },
		runoffModel: 'gr4j',
		gr4j: { x1: 350, x2: 0, x3: 90, x4: 1.7, warmupDays: 365 },
		panCoefficient: [0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7],
		panCoefficientSource: '',
		pe: { kind: 'pan' },
		arealRain: null,
		chirpsBiasCorrection: 'monthly',
		chirpsFitPeriod: 'all',
		rainSource: [],
		zeroRainRuns: defaultZeroRainSettings(),
		calibration: { rainThresholdMm: 2, catchmentAreaKm2: null },
		ewrPragmaticM3PerDay: zeros,
		ewrRules: [],
		ewrChargeSource: 'pragmatic',
		lowFlowMeasure: 'total',
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

/**
 * How an areal rainfall factor was derived (engine ≥ 1.13.0, docs/model.md
 * §2.4g). 'map': an independent mean annual precipitation for the catchment
 * (a WR2012 quaternary MAP, an isohyetal or gridded MAP averaged over the
 * catchment) ÷ the forcing's own mean annual rain, the preferred basis.
 * 'stations': ratios against rain gauges in or near the catchment. 'fitted':
 * chosen by fitting to the flow record, which makes the rain level a
 * calibrated multiplier (it trades off against X1 and PE); allowed, but a run
 * says so.
 */
export const AREAL_RAIN_METHODS = ['map', 'stations', 'fitted'] as const;
export type ArealRainMethod = (typeof AREAL_RAIN_METHODS)[number];

/** `settings.arealRain` (engine ≥ 1.13.0): the rain GR4J runs on × `factors` (water-year months, Oct–Sep). */
export interface ArealRain {
	factors: Monthly;
	method: ArealRainMethod;
	/** Where the factors come from (the MAP and its reference, the period compared); required, at most PE_SOURCE_MAX characters. */
	source: string;
}

/**
 * Bounds on one areal rainfall factor: the CHIRPS bias-correction clamp
 * (docs/model.md §2.4b). A factor beyond 4 either way is more likely two
 * series that don't describe the same area, or a unit error, than a real
 * areal difference.
 */
export const AREAL_RAIN_FACTOR_MIN = 0.25;
export const AREAL_RAIN_FACTOR_MAX = 4;

/** Why a stored `arealRain` can't be used, or null. The API applies the same rules. */
export function arealRainError(raw: unknown): string | null {
	if (raw === null || raw === undefined) return null;
	if (typeof raw !== 'object' || Array.isArray(raw)) return 'not an areal rainfall correction';
	const r = raw as { factors?: unknown; method?: unknown; source?: unknown };
	if (!Array.isArray(r.factors) || r.factors.length !== 12) return 'needs 12 monthly factors (water-year order, Oct–Sep)';
	const bad = r.factors.findIndex((x) => !(typeof x === 'number' && Number.isFinite(x) && x >= AREAL_RAIN_FACTOR_MIN && x <= AREAL_RAIN_FACTOR_MAX));
	if (bad >= 0) return `factor ${bad + 1} is not a number from ${AREAL_RAIN_FACTOR_MIN} to ${AREAL_RAIN_FACTOR_MAX}`;
	if (!(AREAL_RAIN_METHODS as readonly unknown[]).includes(r.method)) return `method must be one of ${AREAL_RAIN_METHODS.join(', ')}`;
	if (typeof r.source !== 'string' || !r.source.trim()) return 'needs its source';
	if (r.source.length > PE_SOURCE_MAX) return `source longer than ${PE_SOURCE_MAX} characters`;
	return null;
}

/**
 * A stored `arealRain` as the engine runs it: absent, null or unusable (with a
 * warning) = none. A correction whose factors are all 1 is kept (it records
 * the decision), and changes nothing.
 */
export function resolveArealRain(raw: unknown, warnings: string[]): ArealRain | null {
	if (raw === null || raw === undefined) return null;
	const err = arealRainError(raw);
	if (err) {
		warnings.push(`areal rainfall correction ignored (${err}): GR4J runs on the rain as recorded`);
		return null;
	}
	const r = raw as ArealRain;
	return { factors: [...r.factors] as unknown as Monthly, method: r.method, source: r.source.trim() };
}

/** The run's areal rain column (engine ≥ 1.13.0): rain_final × the month's areal factor, output only with a correction. */
export const AREAL_RAIN_COLUMN = { key: 'rain_areal', label: 'Areal catchment rainfall (final rainfall × areal factor, the rain GR4J runs on)', unit: 'mm' } as const;

/** The run warning for an areal factor fitted to the flow record (method 'fitted'). */
export const AREAL_RAIN_FITTED_WARNING =
	'the areal rainfall correction was fitted to the flow record, so the rain level is a calibrated multiplier: it trades off against GR4J’s production store and the evaporation, and the fit cannot tell a rain error from a parameter error. Prefer a factor from an independent MAP or rain gauges (docs/model.md §2.4g)';

/** The areal factor per water-year month (Oct–Sep), or null for none. */
export const arealRainFactors = (a: ArealRain | null | undefined): readonly number[] | null => (a ? a.factors : null);

/**
 * The areal factor from an independent MAP (method 'map'): `mapMm` ÷ the
 * forcing's mean annual rain over its complete water years (Oct–Sep, every
 * day with a value). `rainMm` is the forcing before any areal correction,
 * day by day from `startDate` (null or NaN = no value). Null when the series
 * holds no complete water year or no rain. One flat factor: an annual MAP
 * says nothing about the seasons, so the same value goes in every month.
 */
export function arealFactorFromMap(
	mapMm: number,
	rainMm: ArrayLike<number | null>,
	startDate: string
): { factor: number; meanAnnualMm: number; waterYears: number[] } | null {
	if (!(Number.isFinite(mapMm) && mapMm > 0)) return null;
	const [y0, m0, d0] = startDate.split('-').map(Number) as [number, number, number];
	const t0 = Date.UTC(y0, m0 - 1, d0);
	const sums = new Map<number, { mm: number; days: number; expected: number }>();
	for (let t = 0; t < rainMm.length; t++) {
		const d = new Date(t0 + t * 86_400_000);
		const wy = d.getUTCMonth() >= 9 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
		let s = sums.get(wy);
		if (!s) {
			const expected = Math.round((Date.UTC(wy + 1, 9, 1) - Date.UTC(wy, 9, 1)) / 86_400_000);
			sums.set(wy, (s = { mm: 0, days: 0, expected }));
		}
		const v = rainMm[t];
		if (v !== null && v !== undefined && Number.isFinite(v)) {
			s.mm += Math.max(0, v);
			s.days++;
		}
	}
	const full = [...sums.entries()].filter(([, s]) => s.days === s.expected).sort((a, b) => a[0] - b[0]);
	if (!full.length) return null;
	const meanAnnualMm = full.reduce((a, [, s]) => a + s.mm, 0) / full.length;
	if (!(meanAnnualMm > 0)) return null;
	return { factor: mapMm / meanAnnualMm, meanAnnualMm, waterYears: full.map(([y]) => y) };
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
 *
 * `evap_apan_mm` (engine ≥ 0.38.0, issue #45) is a daily Class-A pan
 * evaporation record (mm/day), e.g. from a nearby weather station. On the
 * days it has a value it replaces `settings.apanMm[month] ÷ days in the
 * month` wherever A-pan is read: GR4J's PE under `pe.kind: 'pan'`, crop
 * demand and dam evaporation; every other day falls back to the monthly
 * mean (./evaporation/apanDaily.ts, docs/model.md §2.3a).
 */
export const SERIES_KINDS = [
	'rain_catchment_mm',
	'rain_catchment_alt_mm',
	'rain_chirps_mm',
	'rain_reanalysis_mm',
	'rain_forecast_mm',
	'flow_observed_m3s',
	'flow_logger_m3s',
	'flow_reference_m3s',
	'evap_apan_mm'
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
	 * Dam survey curve (engine ≥ 0.35.0, WP-3.5, docs/model.md §2.7a): level,
	 * area and volume rows, as on the DWS dam technical data form (DW789).
	 * With two or more rows the dam's surface area on a day is interpolated
	 * linearly in volume and replaces the power law (damAreaFullM2,
	 * damAreaExponent). null / absent = the power law.
	 */
	damCurve?: DamCurvePoint[] | null;
	/** Release rule from the dam, before irrigation (WP-3.5). Default 'none'. */
	damReleaseRule?: DamReleaseRule;
	/**
	 * m³/day per water-year month (Oct–Sep) for the release rule: the release
	 * under 'fixed', the flow to keep below the dam under 'passInflow'. null =
	 * under 'passInflow', the EWR required at this node (its own and upstream
	 * shares); under 'fixed', no release.
	 */
	damReleaseM3Day?: number[] | null;
	/** Most the dam's outlet can release per day (m³/day); null / absent = no limit (WP-3.5). */
	damOutletCapacityM3Day?: number | null;
	/**
	 * Share (0–1) of the dam's seepage that returns to the river below the
	 * dam the same day (WP-3.5); the rest is lost from the catchment (to deep
	 * groundwater). Default 1, every engine before 0.35.0.
	 */
	damSeepageReturnPct?: number;
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
	 * Demand factor (engine ≥ 0.41.0, issue #53 R1): a multiplier on the
	 * node's demand per water-year month (Oct–Sep), for a farm its crop water
	 * requirement F (so the abstraction D = F ÷ e scales with it, and the
	 * efficiency and loss return are unchanged), for an other water user its
	 * monthly demand. null / absent = 1 in every month; a gauge ignores it.
	 * Only the `demand.scale` scenario op sets it (docs/scenarios.md): the
	 * model editor and a model save don't carry it.
	 */
	demandFactor?: number[] | null;
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
	/**
	 * Farms only (engine ≥ 0.42.0, WP-3.8, issue #54 item 2c, docs/model.md
	 * §2.7e): where irrigation water comes from. Default 'damFirst', every
	 * engine before 0.42.0: the dam only, never a pump on the river.
	 */
	supplyRule?: SupplyRule;
	/**
	 * Farms only: the river pump's capacity, m³/day (pumps × m³/h × 24). It
	 * limits what the farm pumps from the river under 'riverFirst', 'trigger'
	 * and 'runOfRiver'; inert under 'damFirst'. null / absent = no limit (the
	 * run warns); 0 = no river pump.
	 */
	pumpCapacityM3Day?: number | null;
	/** 'trigger' only: switch to the river when the dam holds less than this fraction of its capacity (start of the day). Default 0.4. */
	supplyTriggerPct?: number;
	/** 'trigger' only: switch back to the dam once it holds at least this fraction (≥ the trigger). Default 0.6. */
	supplyStopPct?: number;
	/**
	 * Gauges only (engine ≥ 1.5.0, audit Q17 follow-on, WP-3.7, docs/model.md
	 * §2.7b): whether the EWR is assessed at this gauge. An EWR site's
	 * shortfall is charged to the farms and other users upstream of it, and a
	 * Reserve rule table can sit there. false = the gauge only measures (a
	 * flow-record station that is no Reserve site): it keeps its flow and
	 * EWR-shortfall series but charges nobody. Absent / true = an EWR site,
	 * every engine before 1.5.0. The outlet is always one, and only a gauge
	 * can be taken off the list (model rules).
	 */
	ewrSite?: boolean;
	/**
	 * Farms and other users with boreholes (engine ≥ 1.12.0, WP-3.9, issue #46
	 * item 7, docs/model.md §2.7d): the size of the property the groundwater
	 * is taken on, ha (land registered separately in a Deeds Office). With
	 * `gaRateM3HaYear` it gives the GN 538 general authorisation's volume for
	 * the property, context only. null / absent = unknown: the run shows the
	 * 40 000 m³/a ceiling and warns.
	 */
	gaPropertyAreaHa?: number | null;
	/**
	 * The GN 538 Table 2 (Appendix B) abstraction rate for the property's
	 * quaternary catchment, m³/ha/a: one of GA538_GROUNDWATER_RATES. null /
	 * absent = not looked up yet (see `gaPropertyAreaHa`).
	 */
	gaRateM3HaYear?: number | null;
}

/**
 * Where a farm's irrigation water comes from (engine ≥ 0.42.0, WP-3.8,
 * docs/model.md §2.7e), an experimental node-based workbook's pump scenarios:
 * 'damFirst' — the dam only, as every engine before 0.42.0 (the default);
 * 'riverFirst' — pump from the river below the dam up to the pump capacity, the dam covers the rest;
 * 'trigger' — the dam only, until it falls below the trigger %; then river first until it is back at the stop %;
 * 'runOfRiver' — no dam: pump from the river up to the pump capacity; the rest is a deficit.
 * The river pump takes only the flow below the dam (S) above what the farm
 * must pass: the senior users' requirement and a pass-inflow release's target.
 */
export const SUPPLY_RULES = ['damFirst', 'riverFirst', 'trigger', 'runOfRiver'] as const;
export type SupplyRule = (typeof SUPPLY_RULES)[number];

/** Each supply rule in plain words, as run comparison, the scenario form and the node form show it. */
export const SUPPLY_RULE_LABEL: Record<SupplyRule, string> = {
	damFirst: 'dam only',
	riverFirst: 'river first',
	trigger: 'dam, river when low',
	runOfRiver: 'run of river'
};

/** What a node without the supply fields runs as: the dam only, no river pump (WP-3.8). */
export const SUPPLY_DEFAULTS = {
	supplyRule: 'damFirst',
	pumpCapacityM3Day: null,
	supplyTriggerPct: 0.4,
	supplyStopPct: 0.6
} as const;

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

/** One row of a dam's survey curve (WP-3.5): water level (m), surface area (m²) and volume stored (m³) at that level. */
export interface DamCurvePoint {
	levelM: number;
	areaM2: number;
	volumeM3: number;
}

/**
 * How a dam releases water below its wall before irrigation (WP-3.5,
 * docs/model.md §2.7a):
 * 'none' — no release;
 * 'passInflow' — pass today's inflow to the dam, up to what the river below
 *   the dam still needs (a compensation or EWR flow), capped by the outlet;
 * 'fixed' — release a fixed m³/day by month from storage above dead storage, capped by the outlet.
 */
export const DAM_RELEASE_RULES = ['none', 'passInflow', 'fixed'] as const;
export type DamReleaseRule = (typeof DAM_RELEASE_RULES)[number];

/** What a node without the WP-3.5 dam fields runs as: the power law, no release, all seepage returning. */
export const DAM_STORAGE_DEFAULTS = {
	damCurve: null,
	damReleaseRule: 'none',
	damReleaseM3Day: null,
	damOutletCapacityM3Day: null,
	damSeepageReturnPct: 1
} as const;

/** Most rows a dam survey curve may have. */
export const DAM_CURVE_MAX_ROWS = 200;

/** Default exponent of the dam area–storage relation (Liebe et al. 2005). */
export const DAM_AREA_EXPONENT = 0.7;

/**
 * Mean depth used to estimate a dam's full-supply area when none is entered:
 * area = capacity ÷ 3 m, about the median mean depth of South African minor
 * dams (Mantel & Hughes 2023). A run that uses it says so (warning W6).
 */
export const ESTIMATED_DAM_DEPTH_M = 3;

/** An irrigation system with its SABI 2021 efficiency range and the value the app offers for it. */
export interface IrrigationSystem {
	id: string;
	label: string;
	/** SABI Table 4's minimum and maximum "proposed default system efficiency" (net to gross), as fractions. */
	min: number;
	max: number;
	/**
	 * The value offered for the system (issue #54 Q10's recommendation): inside
	 * [min, max] but not always the midpoint (drip is its minimum).
	 */
	efficiency: number;
}

/**
 * Application efficiency by irrigation system (audit N1, issue #54 Q10): SABI
 * Agricultural Design Norms 2021, Table 4 "System efficiency" (pp. 9–10,
 * adapted from Reinders et al. 2010). Surface spans its three rows (piped
 * 80–95, lined canal 70–90, earth canal 60–83). The one table the node form's
 * system helper and the crop library's Load crop factors dialog both offer; a
 * scheme's own measurement is better.
 */
export const IRRIGATION_SYSTEMS = [
	{ id: 'drip', label: 'Drip', min: 0.9, max: 0.95, efficiency: 0.9 },
	{ id: 'micro', label: 'Micro-sprinkler', min: 0.8, max: 0.85, efficiency: 0.82 },
	{ id: 'pivot', label: 'Centre pivot / linear move', min: 0.8, max: 0.9, efficiency: 0.85 },
	{ id: 'sprinkler', label: 'Sprinkler (permanent)', min: 0.75, max: 0.9, efficiency: 0.8 },
	{ id: 'movable', label: 'Sprinkler (movable)', min: 0.7, max: 0.83, efficiency: 0.75 },
	{ id: 'surface', label: 'Surface', min: 0.6, max: 0.95, efficiency: 0.7 }
] as const satisfies readonly IrrigationSystem[];

/** An IRRIGATION_SYSTEMS id. */
export type IrrigationSystemId = (typeof IRRIGATION_SYSTEMS)[number]['id'];

/** The system a new farm starts on: drip, confirmed by the client (issue #90, #54 Q10). */
export const NEW_FARM_IRRIGATION_SYSTEM: IrrigationSystemId = 'drip';

/**
 * Irrigation settings of a new farm (audit N1): drip's efficiency (0.90,
 * NEW_FARM_IRRIGATION_SYSTEM; migration 099 sets the column default to match),
 * half of its losses returning. Only a newly created farm takes it: a saved
 * farm keeps its stored efficiency, and the run never reads this, so it is
 * not a model change.
 */
export const NEW_FARM_IRRIGATION = { irrigationEfficiency: 0.9, lossReturnFraction: 0.5 } as const;

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
 * gets its position in the list (the order it ran in), no monthly rates
 * (`monthlyRateM3s` null: its one max rate in its months) and the dam source
 * (OFFTAKE_DEFAULTS: not a river off-take). Fields already
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
				// Dam curve, releases and seepage destination (WP-3.5): off unless set.
				if (n.damCurve === undefined) n.damCurve = DAM_STORAGE_DEFAULTS.damCurve;
				n.damReleaseRule ??= DAM_STORAGE_DEFAULTS.damReleaseRule;
				if (n.damReleaseM3Day === undefined) n.damReleaseM3Day = DAM_STORAGE_DEFAULTS.damReleaseM3Day;
				if (n.damOutletCapacityM3Day === undefined) n.damOutletCapacityM3Day = DAM_STORAGE_DEFAULTS.damOutletCapacityM3Day;
				n.damSeepageReturnPct ??= DAM_STORAGE_DEFAULTS.damSeepageReturnPct;
				// Supply rule and river pump (WP-3.8): the dam only unless set.
				n.supplyRule ??= SUPPLY_DEFAULTS.supplyRule;
				if (n.pumpCapacityM3Day === undefined) n.pumpCapacityM3Day = SUPPLY_DEFAULTS.pumpCapacityM3Day;
				n.supplyTriggerPct ??= SUPPLY_DEFAULTS.supplyTriggerPct;
				n.supplyStopPct ??= SUPPLY_DEFAULTS.supplyStopPct;
				// EWR site flag (engine ≥ 1.5.0): every gauge was one.
				n.ewrSite ??= true;
				// GN 538 property area and rate (engine ≥ 1.12.0): unknown unless set.
				if (n.gaPropertyAreaHa === undefined) n.gaPropertyAreaHa = null;
				if (n.gaRateM3HaYear === undefined) n.gaRateM3HaYear = null;
				return n;
			})
		: model.nodes;
	// Transfer priority (Q18): the order the rules ran in before, as migration 006 sets it.
	// Monthly rates and the river off-take fields (engine ≥ 1.14.0): none unless set, a dam
	// transfer, as migrations 090 and 091 store them.
	const transfers = Array.isArray(model.transfers)
		? model.transfers.map((raw, i) => {
				if (!raw || typeof raw !== 'object') return raw;
				const t = raw as Record<string, unknown>;
				const missing = t.priority === undefined || t.monthlyRateM3s === undefined || Object.keys(OFFTAKE_DEFAULTS).some((k) => t[k] === undefined);
				if (!missing) return raw;
				const out: Record<string, unknown> = { ...t };
				if (out.priority === undefined) out.priority = i;
				if (out.monthlyRateM3s === undefined) out.monthlyRateM3s = null;
				for (const [k, v] of Object.entries(OFFTAKE_DEFAULTS)) if (out[k] === undefined) out[k] = v;
				return out;
			})
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
	/**
	 * This crop's irrigation application efficiency, 0 < e ≤ 1 (engine ≥
	 * 0.43.0, issue #54): the irrigation system it is under. null / absent =
	 * the farm's own `irrigationEfficiency`. A farm's efficiency is then its
	 * crops' efficiencies combined, weighted by each crop's annual water
	 * requirement (./demand.ts farmIrrigationEfficiency, docs/model.md §2.3).
	 */
	irrigationEfficiency?: number | null;
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
	/**
	 * The maximum rate per water-year month (Oct–Sep), m³/s (engine ≥ 1.14.0,
	 * ./network/transferRates.ts); a month with 0 is a month the rule is off.
	 * null / absent = `maxRateM3s` in the listed `months`, as b023 has it. When
	 * set it is what runs, and `months` (the months with a rate above 0) and
	 * `maxRateM3s` (the largest rate) must agree with it (modelRuleIssues).
	 */
	monthlyRateM3s?: number[] | null;
	/**
	 * Where the rule takes its water (engine ≥ 1.14.0, docs/model.md §2.6a).
	 * 'dam' (the default; absent on every older document): from the source
	 * farm's dam, out of yesterday's storage (§2.6). 'river': a river
	 * off-take, from the flow leaving the source unit today, carried to the
	 * destination; its capacity is the month's rate × 86 400, capped by the
	 * daily cap, as a dam rule's limit. The fields below apply to 'river'
	 * only; `minStoragePct` is inert on a river rule.
	 */
	source?: TransferSource;
	/** river: a hands-off flow (m³/day) left in the river below the source before the off-take takes anything; null / absent = none. */
	handsOffM3Day?: number | null;
	/** river: also leave the EWR at the source (its cumulative requirement) in the river. Absent = false. */
	handsOffEwr?: boolean;
	/** river: conveyance losses, the share 0 ≤ l < 1 of what is taken that never arrives (lost from the catchment). Absent = 0. */
	lossPct?: number;
	/**
	 * river: how much it takes. 'demand' (default): what the destination needs
	 * today (its demand, plus its dam's room with `topUpDam`). 'capacity': up
	 * to its capacity whatever the destination needs, like a canal that runs
	 * full; what the destination doesn't use flows on down its river.
	 */
	sizing?: TransferSizing;
	/** river: what is left once the destination's demand is met tops up its dam (true) or flows on below it (false, the default). */
	topUpDam?: boolean;
}

export const TRANSFER_SOURCES = ['dam', 'river'] as const;
export type TransferSource = (typeof TRANSFER_SOURCES)[number];
export const TRANSFER_SIZINGS = ['demand', 'capacity'] as const;
export type TransferSizing = (typeof TRANSFER_SIZINGS)[number];

/** What a transfer without the river off-take fields (engine < 1.14.0) runs as: a dam transfer. */
export const OFFTAKE_DEFAULTS = {
	source: 'dam',
	handsOffM3Day: null,
	handsOffEwr: false,
	lossPct: 0,
	sizing: 'demand',
	topUpDam: false
} as const;

export interface ProjectModel {
	nodes: NetworkNode[];
	crops: CropDef[];
	cropAreas: CropArea[];
	transfers: Transfer[];
	/** Land-cover patches that reduce runoff (engine ≥ 0.24.0, WP-1.35). Absent on older documents = none. */
	landCover?: LandCoverPatch[];
	/**
	 * Individual boreholes on farms and other users (engine ≥ 0.36.0, WP-3.9,
	 * docs/model.md §2.7d): each with its own capacity, annual cap, supply
	 * mode, target and depletion factor. Absent on older documents = none.
	 * They add to a node's combined borehole capacity (WP-1.34), if it has one.
	 */
	boreholes?: Borehole[];
	/**
	 * Demand objects on units (engine ≥ 1.7.0, issue #54 item 2b,
	 * docs/model.md §2.7f): a town's, a household's, livestock's or any other
	 * demand that isn't a crop, added to the unit's crop demand and supplied
	 * from the same dam, river pump and boreholes. Absent on older documents = none.
	 */
	demandObjects?: DemandObject[];
	/**
	 * Registered and licensed water-use volumes (engine ≥ 1.18.0, issue #72,
	 * docs/allocations.md): what settings.allocationMode caps or scales a run
	 * to, and what RunSummary.allocations compares its use with. Not part of
	 * the model document: the backend adds the project's allocations to a
	 * run's input (no names, only what the engine reads). Absent = none.
	 */
	allocations?: AllocationEntry[];
}

/**
 * What a demand object is for (issue #54 item 2b), the client's register
 * categories. It sets the defaults a new one gets and how it reads; the
 * engine treats every category alike.
 */
export const DEMAND_OBJECT_CATEGORIES = ['domestic', 'municipal', 'industrial', 'livestock', 'irrigation', 'external', 'other'] as const;
export type DemandObjectCategory = (typeof DEMAND_OBJECT_CATEGORIES)[number];

/** Each category in plain words (the node form, run results). */
export const DEMAND_OBJECT_CATEGORY_LABEL: Record<DemandObjectCategory, string> = {
	domestic: 'Domestic',
	municipal: 'Municipal (town)',
	industrial: 'Industrial',
	livestock: 'Livestock',
	irrigation: 'Irrigation (not from crops)',
	external: 'External (piped out)',
	other: 'Other'
};

/**
 * How a demand object's volume is given (docs/model.md §2.7f):
 * 'monthly' — m³/day per water-year month (a meter record, a reconciliation
 *   strategy's AADD, a workbook's typed-over demand);
 * 'perUnit' — a count (people, head of livestock, stands) × litres per unit
 *   per day, grossed up for distribution losses, × a monthly profile.
 */
export const DEMAND_OBJECT_SIZINGS = ['monthly', 'perUnit'] as const;
export type DemandObjectSizing = (typeof DEMAND_OBJECT_SIZINGS)[number];

/**
 * When a demand object is supplied against the unit's crops on a short day
 * (docs/model.md §2.7f): 'first' before them, 'shared' pro rata with them,
 * 'last' after them. Within one class, objects share pro rata.
 */
export const DEMAND_OBJECT_PRIORITIES = ['first', 'shared', 'last'] as const;
export type DemandObjectPriority = (typeof DEMAND_OBJECT_PRIORITIES)[number];

/**
 * Where a demand object's water ends up: 'internal' — used in the catchment,
 * its return share goes back to the river below the unit the same day;
 * 'external' — piped out of the catchment, so none of it comes back.
 */
export const DEMAND_OBJECT_DESTINATIONS = ['internal', 'external'] as const;
export type DemandObjectDestination = (typeof DEMAND_OBJECT_DESTINATIONS)[number];

/**
 * Which days a demand object's schedule window covers (engine ≥ 1.17.0,
 * docs/model.md §2.7f): 'always' every day (with weekdays, a weekly
 * pattern); 'yearly' a calendar span each year, `from`–`to` as MM-DD,
 * wrapping the year end when `from` is later; 'range' once, `from`–`to` as
 * YYYY-MM-DD; 'easter' `easterFrom`–`easterTo` days from Easter Sunday
 * (−2 Good Friday, +1 Family Day). Every bound is inclusive.
 */
export const DEMAND_SCHEDULE_SPANS = ['always', 'yearly', 'range', 'easter'] as const;
export type DemandScheduleSpan = (typeof DEMAND_SCHEDULE_SPANS)[number];

/**
 * One window of a demand object's schedule: on the days it covers, the
 * object's demand is its month's demand × `factor` (0 = off). Set by date,
 * never by river flow (issue #90 Q12). The later of two overlapping windows
 * wins; a day no window covers runs at 1.
 */
export interface DemandScheduleWindow {
	/** What it is, e.g. "Weekends" or "Christmas shutdown"; may be empty. */
	label: string;
	span: DemandScheduleSpan;
	/** 'yearly': MM-DD; 'range': YYYY-MM-DD; null otherwise. */
	from: string | null;
	to: string | null;
	/** 'easter': whole days from Easter Sunday; null otherwise. */
	easterFrom: number | null;
	easterTo: number | null;
	/** ISO weekdays it covers (1 = Monday … 7 = Sunday); null = every day. */
	weekdays: number[] | null;
	/** × the demand on those days, 0–10; 0 = off. */
	factor: number;
}

export interface DemandObject {
	id: string;
	/** The unit (a farm node) whose water supplies it. */
	nodeId: string;
	name: string;
	category: DemandObjectCategory;
	sizing: DemandObjectSizing;
	/** 'monthly': abstraction demand, m³/day per water-year month (Oct–Sep); null under 'perUnit'. */
	monthlyM3Day: number[] | null;
	/** 'perUnit': how many (people, head, stands); null under 'monthly'. */
	count: number | null;
	/** 'perUnit': litres per unit per day at the tap or trough; null under 'monthly'. */
	litresPerUnitDay: number | null;
	/** 'perUnit': distribution losses as a share (0 ≤ l < 1) of what is abstracted: abstraction = use ÷ (1 − l). */
	lossPct: number;
	/** 'perUnit': a factor per water-year month (Oct–Sep) on the daily use, e.g. holiday peaks; null = 1 every month. */
	monthlyFactor: number[] | null;
	/** Share (0–1) of what it is supplied that returns to the river below the unit the same day (treated wastewater). 0 when external. */
	returnPct: number;
	priority: DemandObjectPriority;
	destination: DemandObjectDestination;
	/** false = kept on record but not modelled (no demand, no results). */
	enabled: boolean;
	/**
	 * Date windows with a factor on its daily demand (engine ≥ 1.17.0): 0 =
	 * off that day, so no supply and no return. Null or absent = every day
	 * at its month's demand.
	 */
	schedule?: DemandScheduleWindow[] | null;
	/** Where the number comes from (meter records, a reconciliation strategy, a norm, the workbook), for the report. */
	note: string;
}

/**
 * Sizing norms for a new per-unit demand object (issue #54, 2b research,
 * docs/model.md §2.7f): the Red Book §J (CSIR 2005) house connection of
 * 230 l per person per day, and KZN DARD livestock needs (cattle 40–50 l per
 * head per day). Starting points for the modeller, never applied silently.
 */
export const DEMAND_NORMS = {
	litresPerPersonDay: 230,
	basicLitresPerPersonDay: 25,
	litresPerCattleDay: 45
} as const;

/** A new demand object's fields by category (the node form's Add demand), from the 2b research table. */
export function newDemandObjectDefaults(category: DemandObjectCategory): Pick<DemandObject, 'sizing' | 'litresPerUnitDay' | 'lossPct' | 'returnPct' | 'priority' | 'destination'> {
	switch (category) {
		case 'domestic':
			return { sizing: 'perUnit', litresPerUnitDay: DEMAND_NORMS.litresPerPersonDay, lossPct: 0, returnPct: 0, priority: 'first', destination: 'internal' };
		case 'municipal':
			return { sizing: 'monthly', litresPerUnitDay: null, lossPct: 0, returnPct: 0.5, priority: 'first', destination: 'internal' };
		case 'livestock':
			return { sizing: 'perUnit', litresPerUnitDay: DEMAND_NORMS.litresPerCattleDay, lossPct: 0, returnPct: 0, priority: 'shared', destination: 'internal' };
		case 'external':
			return { sizing: 'monthly', litresPerUnitDay: null, lossPct: 0, returnPct: 0, priority: 'shared', destination: 'external' };
		default:
			return { sizing: 'monthly', litresPerUnitDay: null, lossPct: 0, returnPct: 0, priority: 'shared', destination: 'internal' };
	}
}

/**
 * When an individual borehole runs (WP-3.9, docs/model.md §2.7d):
 * 'none' — never (kept on record, e.g. a borehole not equipped);
 * 'supplemental' — only for the demand the dam and river leave unmet;
 * 'primary' — first, before the dam and river;
 * 'emergency' — supplemental, but only while the farm dam holds less than
 *   `emergencyBelowPct` of its capacity at the start of the day (farms with a dam only).
 */
export const BOREHOLE_MODES = ['none', 'supplemental', 'primary', 'emergency'] as const;
export type BoreholeMode = (typeof BOREHOLE_MODES)[number];

/**
 * Where an individual borehole's water goes (WP-3.9): 'direct' to the crop or
 * user (part of supplied), or 'dam' into the farm dam (farms with a dam only),
 * from which irrigation then draws.
 */
export const BOREHOLE_TARGETS = ['direct', 'dam'] as const;
export type BoreholeTarget = (typeof BOREHOLE_TARGETS)[number];

/**
 * The GN 538 (2016) general authorisation's upper limit on groundwater taken
 * per property, m³ per year (roadmap WP-3.9, [GA538]). What a property may
 * take under the GA depends on its size and where it is; this is the ceiling,
 * shown beside modelled use for context. The app never decides legality.
 */
export const GA538_GROUNDWATER_LIMIT_M3_YEAR = 40_000;

/**
 * The abstraction rates of GN 538 (2016) Table 2 (Appendix B), m³ per ha of
 * property per year. Each quaternary catchment is listed under one of them;
 * the property's GA volume is its size × that rate, capped at
 * GA538_GROUNDWATER_LIMIT_M3_YEAR (engine ≥ 1.12.0, docs/model.md §2.7d). The
 * app doesn't carry the quaternary → rate schedule: the gazette's table is a
 * scanned list of ranges, and a mis-read row would give a wrong legal
 * number, so the modeller looks the rate up and enters it.
 */
export const GA538_GROUNDWATER_RATES = [0, 45, 75, 150, 275, 400] as const;
export type Ga538Rate = (typeof GA538_GROUNDWATER_RATES)[number];

/**
 * A borehole whose stream depletion share is at least this (0–1) most likely
 * draws on an alluvial aquifer connected to the stream, which GN 538 counts
 * as a surface water resource, not groundwater: the run warns that the
 * groundwater GA may not cover it (engine ≥ 1.12.0). A judgement, pending the
 * hydrologist (issue #46 item 7).
 */
export const GA538_ALLUVIAL_DEPLETION_FRAC = 0.8;

/** Whether `v` is one of the GN 538 Table 2 rates. */
export const isGa538Rate = (v: unknown): v is Ga538Rate => typeof v === 'number' && (GA538_GROUNDWATER_RATES as readonly number[]).includes(v);

/**
 * A node's GN 538 groundwater volume, m³/a (engine ≥ 1.12.0): min(property
 * area ha × Table 2 rate, 40 000). `basis` 'property' when both are known
 * (a valid area ≥ 0 and one of the six rates); otherwise the 40 000 ceiling
 * with `basis` 'ceiling'. Context only, never a decision on legality.
 */
export function ga538VolumeM3(n: Pick<NetworkNode, 'gaPropertyAreaHa' | 'gaRateM3HaYear'>): { limitM3: number; basis: 'property' | 'ceiling' } {
	const a = n.gaPropertyAreaHa;
	const r = n.gaRateM3HaYear;
	if (typeof a === 'number' && Number.isFinite(a) && a >= 0 && isGa538Rate(r)) return { limitM3: Math.min(a * r, GA538_GROUNDWATER_LIMIT_M3_YEAR), basis: 'property' };
	return { limitM3: GA538_GROUNDWATER_LIMIT_M3_YEAR, basis: 'ceiling' };
}

export interface Borehole {
	id: string;
	/** The farm or other user it supplies. */
	nodeId: string;
	/** A label, e.g. the borehole number on the geohydrology report. */
	name: string;
	/** Most it can pump per day, m³/day (the specialist's sustainable yield). */
	capacityM3Day: number;
	/** Most it may pump in a water year (Oct–Sep), m³; null = no annual cap. */
	annualCapM3: number | null;
	mode: BoreholeMode;
	/** 'emergency' only: it runs while the dam holds less than this fraction (0–1) of its capacity at the start of the day. */
	emergencyBelowPct: number;
	target: BoreholeTarget;
	/** Share d (0–1) of what it pumps that is eventually taken from the river at its node (the node's lag applies). */
	depletionFactor: number;
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
	/**
	 * The last day with a value (null: every day is blank): how far the data
	 * reaches, where startDate + length − 1 counts the blank days a logger's
	 * "no reading" stores. Absent from older clients' fixtures.
	 */
	lastValueDate?: string | null;
	/** Sub-daily readings added up into days in this window (033_series_day_boundary.sql); null = daily values as uploaded. */
	dayBoundary?: DayBoundary | null;
	/** What the values are (032_series_provenance.sql): e.g. CHIRPS / 2.0; null = not recorded. */
	product?: string | null;
	productVersion?: string | null;
	/** A data feed is backfilling a confirmed replacement of this series; its values stay as they are until it swaps in (feed_stage, 032). */
	rebuilding?: boolean;
	/**
	 * A flow record's site (084_gauge_records, engine ≥ 1.4.0): the gauge node
	 * it was measured at; null / absent = the outlet. Only the plausibility
	 * checks read a gauge's record.
	 */
	siteNodeId?: string | null;
}

// ---------------------------------------------------------------------------
// Engine I/O contract — runModel(input: ModelInput): ModelOutput.
// ---------------------------------------------------------------------------

export interface ModelInput {
	/** Raw project settings; the engine merges them over defaultProjectSettings(). */
	settings: Partial<ProjectSettings> & Record<string, unknown>;
	model: ProjectModel;
	/**
	 * Keyed by SeriesKind; only the first series of each kind is used. A gauge
	 * node's own observed records (engine ≥ 1.4.0) are keyed GaugeSeriesKey.
	 */
	series: Partial<Record<SeriesKind, DailySeries>> & { [key: GaugeSeriesKey]: DailySeries };
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
	/** Mean groundwater pumped into the farm dam (engine ≥ 0.36.0, WP-3.9); only with dam-target boreholes. Not part of supplied. */
	avgGroundwaterToDamM3Day?: number;
	/** Mean pumped from the river, part of supplied (engine ≥ 0.42.0, WP-3.8); only for a farm whose supply rule can pump from the river. */
	avgRiverAbstractionM3Day?: number;
	/**
	 * The farm dam's storage figures (engine ≥ 1.2.0, issue #55,
	 * network/damLevel.ts): storage on the run's last day, m³, and
	 * DAM_AGO_DAYS (30) before it (null when the run is shorter); the lowest
	 * storage in the run's last 365 days and its first day; and the days in
	 * that window at or below the minimum operating level. Absent for a farm
	 * with no dam, and on older runs.
	 */
	damEndM3?: number;
	damAgoM3?: number | null;
	damLowM3?: number;
	damLowDate?: string;
	damDaysAtMin?: number;
	/**
	 * The unit's enabled demand objects (engine ≥ 1.7.0, issue #54 item 2b,
	 * docs/model.md §2.7f), in id order: each one's share of the unit's
	 * demand, supply, deficit and return. Their demand is part of
	 * avgDemandM3Day; the irrigation part is avgDemandM3Day − Σ theirs.
	 * Absent for a unit without any, and on older runs.
	 */
	demandObjects?: DemandObjectSummary[];
}

/** One demand object over the whole run (engine ≥ 1.7.0), m³/day means like FarmSummary. */
export interface DemandObjectSummary {
	id: string;
	name: string;
	category: DemandObjectCategory;
	priority: DemandObjectPriority;
	destination: DemandObjectDestination;
	avgDemandM3Day: number;
	avgSuppliedM3Day: number;
	avgDeficitM3Day: number;
	/** avg supplied / avg demand, 0–1 (1 without demand). */
	fractionSupplied: number;
	/** Returned to the river below the unit (0 for an external object). */
	avgReturnedM3Day: number;
	/** Days it got less than its demand (beyond float noise). */
	daysShort: number;
	/** Days its schedule switched it off (factor 0; engine ≥ 1.17.0, only on an object with a schedule). Never counted as short. */
	daysOff?: number;
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
	/**
	 * Whether these are in-sample scores: were the run's parameters fitted on
	 * the days scored? (engine ≥ 0.39.0, calibrationFitStatus in
	 * ./calibrate/provenance.ts). Absent on older runs.
	 */
	fitStatus?: CalibrationFitStatus;
}

/**
 * How a run's parameters relate to its calibration period:
 * - `fitted`: fitted automatically on these days (the run's fit record, for
 *   its runoff model, its window, exclusions and record, parameters as
 *   fitted): the scores are in-sample.
 * - `notFitted`: no fit record for the run's runoff model; the parameters
 *   were set by hand, imported or left at their defaults.
 * - `edited`: a fit exists but parameters were changed by hand since.
 * - `otherPeriod`: fitted, but on another window, other exclusions or the
 *   other flow record, so the days scored are not the days fitted.
 */
export type CalibrationFitStatus = 'fitted' | 'notFitted' | 'edited' | 'otherPeriod';

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
	/** [H] Average abstraction demand D = F / e (engine ≥ 0.16.0; the workbook: net irrigation demand F). */
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
	/**
	 * 'ruleTable' when the site's shortfall, and so its charge, follows the
	 * site's Reserve rule table (engine ≥ 1.3.0, settings.ewrChargeSource,
	 * docs/model.md §2.9c); absent = the pragmatic EWR.
	 */
	ewrSource?: 'ruleTable';
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
 * The runoff model's water balance over the run (engine ≥ 0.5.0; absent on a
 * stored legacy run, engine < 1.0.0), in mm over the catchment:
 *   rain − aet − flow + exchange = storageEnd − storageStart.
 * The stores start the run at the level the warm-up left them.
 */
export interface RunoffBalance {
	model: RunoffModelId;
	/** The parameters the run used (after validation). */
	params: Record<string, number>;
	warmupDays: number;
	/** Area the mm are spread over (km²). */
	areaKm2: number;
	/** Rain the model ran on: after the areal rainfall correction when there is one. */
	rainMm: number;
	/**
	 * The areal rainfall correction the run applied (engine ≥ 1.13.0,
	 * settings.arealRain, docs/model.md §2.4g) and the rain before it; absent
	 * without one.
	 */
	arealRain?: ArealRain & { rainBeforeMm: number };
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

/** RunSummary.allocations (engine ≥ 1.18.0, issue #72). */
export interface RunAllocations {
	mode: AllocationMode;
	/** The band compareAllocations used (settings.allocationTolerance). */
	tolerance: number;
	/** Allocations the run used (a volume, a source, dates that read), matched to one of its farms or water users. */
	used: number;
	/** Allocations not matched to a node, or matched to one this run doesn't have. */
	notMatched: number;
	/** Per farm or water user with an allocation (node-id order), per water source it has one for. */
	nodes: RunAllocationNode[];
}

export interface RunAllocationNode {
	nodeId: string;
	name: string;
	/** Per water source the unit has an allocation for (surface first). */
	sources: RunAllocationSource[];
	/**
	 * 'fullAllocation' only: per water year of the run, the unit's abstraction
	 * demand before scaling (m³) and the registered volume (both sources, over
	 * the run's days of the year) it was scaled to.
	 */
	scaled?: { waterYear: number; demandM3: number; registeredM3: number }[];
}

export interface RunAllocationSource {
	waterSource: AllocationWaterSource;
	/** Whole water years compared, and how many of them modelled use was above the registered volume plus the tolerance. */
	wholeYears: number;
	yearsOver: number;
	/** Mean modelled use and registered volume per whole water year (m³); null without a whole year. */
	meanModelledM3PerYear: number | null;
	meanRegisteredM3PerYear: number | null;
	/**
	 * 'cap' only: the water years (part years included) whose use reached the
	 * cap, each with its budget (the whole year's registered volume) and the
	 * use (m³). Empty when the cap never bound.
	 */
	capReached?: { waterYear: number; budgetM3: number; usedM3: number }[];
}

/** One node's groundwater abstraction in one water year (WP-3.9, RunSummary.groundwaterAnnualUse). */
export interface GroundwaterAnnualUse {
	nodeId: string;
	name: string;
	kind: 'farm' | 'user';
	/** The water year's starting calendar year: 2003 = 1 Oct 2003 – 30 Sep 2004. */
	waterYear: number;
	/** e.g. "2003/04". */
	label: string;
	/** Run days in this water year (a run's first and last years may be partial). */
	days: number;
	/** Everything pumped, m³: to the crop or user plus into the dam. */
	abstractionM3: number;
	/** The part pumped into the farm dam, m³ (0 without dam-target boreholes). */
	toDamM3: number;
	/** Stream depletion taken from the river at the node this water year, m³ (lagged, so it can include earlier years' pumping). */
	streamDepletionM3: number;
	/** Σ of the boreholes' annual caps, m³; null when any borehole that can pump has no cap. */
	annualCapM3: number | null;
	/**
	 * The GN 538 general authorisation's groundwater volume for the property,
	 * m³/a, for context, not a decision on legality: min(area × Table 2 rate,
	 * 40 000) from the node's `gaPropertyAreaHa` and `gaRateM3HaYear` (engine
	 * ≥ 1.12.0, ga538VolumeM3), else the 40 000 ceiling. Every engine before
	 * 1.12.0: the ceiling.
	 */
	gaLimitM3: number;
	/** How gaLimitM3 was found (engine ≥ 1.12.0): 'property' = area × rate; 'ceiling' = area or rate unknown, the 40 000 ceiling only. Absent on older runs (the ceiling). */
	gaBasis?: 'property' | 'ceiling';
	/**
	 * The most pumped (to the crop and into the dam) in any 12 consecutive
	 * calendar months ending in this water year, m³ (engine ≥ 1.12.0). GN 538's
	 * "year" is any 12 consecutive months, so a use split across 1 October can
	 * pass both water years and still exceed the GA. null when the run has no
	 * full 12 months ending in this year (its first months). Absent on older runs.
	 */
	rolling12MaxM3?: number | null;
	/** Per borehole, in id order; `id` null = the node's combined borehole capacity (WP-1.34). */
	boreholes: { id: string | null; name: string; abstractionM3: number; annualCapM3: number | null; capReached: boolean }[];
}

export interface RunSummary {
	farms: FarmSummary[];
	/** Other water users (engine ≥ 0.22.0, WP-1.33); absent when the network has none. */
	users?: UserSummary[];
	/** Land-cover streamflow reductions (engine ≥ 0.24.0, WP-1.35); absent without land cover. */
	landCover?: LandCoverSummary;
	/**
	 * Groundwater abstraction per farm or other user and water year (engine ≥
	 * 0.36.0, WP-3.9, docs/model.md §2.7d): what its boreholes pumped (to the
	 * crop and into the dam), against their annual caps and the GN 538
	 * general-authorisation ceiling. One entry per node with boreholes per
	 * water year the run touches, nodes in id order, years ascending. The
	 * licensing comparisons (WARMS, WP-3.10) read their volumes here. Absent
	 * without boreholes, and on older runs.
	 */
	groundwaterAnnualUse?: GroundwaterAnnualUse[];
	/**
	 * Registered volumes against the run's use (engine ≥ 1.18.0, issue #72,
	 * ./allocations, docs/model.md §2.12a): the allocation mode the run ran
	 * with and, per farm or water user with an allocation, the whole water
	 * years compared (compareAllocations with settings.allocationTolerance).
	 * Absent when the input carries no allocations.
	 */
	allocations?: RunAllocations;
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
	 * How the daily A-pan series was used (engine ≥ 0.38.0, issue #45,
	 * ./evaporation/apanDaily.ts): the run days it covered and the days that
	 * fell back to the monthly means. Absent when the project has no daily
	 * A-pan series, and on older runs.
	 */
	apanDaily?: ApanDailyInfo;
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
	 * The forecast days of a forecast-mode run (engine ≥ 0.37.0, WP-2.12,
	 * ./forecast.ts runForecastChecked): every other figure in this summary covers the days
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

export type VerificationCheckId = 'balance' | 'workings' | 'soilWater' | 'runoff' | 'transfers' | 'reports' | 'ewrAttribution' | 'groundwater' | 'landCover' | 'allocations';

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
	/** Catchment rain after gap-filling (rain_final, mm; rain_areal with an areal rainfall correction, engine ≥ 1.13.0); null when the run has no rain series. */
	rainMm: number | null;
	/** Natural flow as depth over the catchment (mm); null without an area. */
	naturalFlowMm: number | null;
	/** naturalFlowMm / rainMm; null without rain or an area. */
	runoffCoefficient: number | null;
	/** Runoff model store balance (null on a stored legacy run, engine < 1.0.0). */
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
	/** Groundwater pumped into supply and (engine ≥ 0.36.0, WP-3.9) into the dams, a gain to the surface balance (engine ≥ 0.23.0, WP-1.34); absent without boreholes. */
	groundwaterM3?: number;
	/** Stream depletion taken from the river (WP-1.34); absent without boreholes. */
	streamDepletionM3?: number;
	/** Storage set into (+) or out of (−) the dams by settings.damStorageReset (engine ≥ 0.46.0, the review triggers), a gain; absent without it. */
	storageSetM3?: number;
	/** Runoff removed by land cover before it reached the farms (engine ≥ 0.24.0, WP-1.35); absent without land cover. */
	landCoverReductionM3?: number;
	/** Dam seepage lost from the catchment rather than returned below the dam (engine ≥ 0.35.0, WP-3.5); absent when all seepage returns. */
	damSeepageLostM3?: number;
	/** Released below the dams before irrigation (WP-3.5); part of the outflow, shown for information. Absent without a release rule. */
	damReleaseM3?: number;
	/** Lost on the way by river off-takes (engine ≥ 1.14.0): taken − delivered, a loss from the catchment; absent without off-takes. */
	conveyanceLossM3?: number;
	spillM3: number;
	outflowM3: number;
	closingStorageM3: number;
	/** opening + runoff + transfers + rain on dams + groundwater (+ storage set) − consumptive use − dam evaporation − other use − stream depletion − seepage lost − conveyance losses − outflow − closing. */
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
	 * Forecast mode only (engine ≥ 0.37.0, WP-2.12, ./forecast.ts): the first day whose rain
	 * came from the forecast after the last observed rain day, null when the
	 * run has no forecast tail. Absent on ordinary runs.
	 */
	forecastFrom?: string | null;
}
