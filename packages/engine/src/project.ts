// Shape of a project's model configuration, shared by the backend (storage +
// validation) and the frontend (forms). See docs/data-model.md for how each
// field maps onto the b023 workbook.
import type { Monthly } from './calendar';
import type { ObservedAgreement } from './quality';

/** How each farm's share of catchment natural flow is derived (b023 [Farm spec]). */
export type FlowShareMethod = 'area' | 'hiLo' | 'manual';

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

export interface ProjectSettings {
	/** Days used for February when converting monthly volumes to per-day. */
	februaryDays: number;
	/** Fraction of rainfall on cropped land that offsets irrigation demand. */
	effectiveRainFraction: number;
	/** WR90 A-pan evaporation, mm per water-year month (Oct–Sep). */
	apanMm: Monthly;
	flowShareMethod: FlowShareMethod;
	/** Pitman high/low MAP split used by the `hiLo` flow-share method. */
	hiLoSplit: { hi: number; lo: number };
	calibration: CalibrationParams;
	/** Pragmatic EWR at the outflow gauge, m³/day per water-year month. */
	ewrPragmaticM3PerDay: Monthly;
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
}

/** Series that calibration statistics can compare simulated outflow with. */
export const CALIBRATION_FLOW_KINDS = ['flow_observed_m3s', 'flow_logger_m3s', 'flow_pitman_m3s'] as const;
export type CalibrationFlowKind = (typeof CALIBRATION_FLOW_KINDS)[number];

const zeros: Monthly = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

/** Defaults taken from the blank b023 workbook. */
export function defaultProjectSettings(): ProjectSettings {
	return {
		februaryDays: 28.25,
		effectiveRainFraction: 0.65,
		apanMm: zeros,
		flowShareMethod: 'area',
		hiLoSplit: { hi: 0.81, lo: 0.19 },
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
		simulationStart: null,
		simulationEnd: null,
		reportStart: null,
		reportEnd: null,
		calibrationStart: null,
		calibrationEnd: null,
		calibrationFlowKind: null
	};
}

/** A b023 network element. A "farm" can also model a stand-alone dam or natural area. */
export type NodeKind = 'farm' | 'gauge';

/** Time-series kinds a project can hold. Values are daily, starting at `startDate`. */
export const SERIES_KINDS = [
	'rain_catchment_mm',
	'rain_chirps_mm',
	'rain_forecast_mm',
	'flow_pitman_m3s',
	'flow_observed_m3s',
	'flow_logger_m3s'
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
	damMinPct: number;
	divertCapacityM3Day: number;
	returnFlowPct: number;
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
}

export interface ProjectModel {
	nodes: NetworkNode[];
	crops: CropDef[];
	cropAreas: CropArea[];
	transfers: Transfer[];
}

/** A daily series: values[i] is the value on startDate + i days; null = missing. */
export interface DailySeries {
	startDate: string;
	values: (number | null)[];
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
	avgDemandM3Day: number;
	avgSuppliedM3Day: number;
	avgDeficitM3Day: number;
	/** 0–1 */
	fractionSupplied: number;
	avgEwrShortfallM3Day: number;
	daysEwrNotMet: number;
}

/** Observed vs simulated volume in one water year (paired days only). */
export interface AnnualVolume {
	/** Water year, labelled by the calendar year it starts in (1981 = Oct 1981 – Sep 1982). */
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
	/** Per farm, from the shortfall the farm itself adds (ewr_shortfall_incremental). */
	farms: EwrComplianceGrid[];
}

/**
 * One farm's row of the curtailment report (b023 [Shortfalls], workbook column
 * in brackets). Averages are over the reporting window and rounded like the
 * workbook. Signs follow the workbook: negative = reduce / shortfall, positive
 * = gain. See docs/model.md §2.11.
 */
export interface CurtailmentFarm {
	nodeId: string;
	name: string;
	/** [H] ROUND(average net irrigation demand, 0). */
	demandM3Day: number;
	/** [I] ROUND(average irrigation supplied, 0). */
	suppliedM3Day: number;
	/** [J] supplied − demand (≤ 0: the average deficit). */
	deficitM3Day: number;
	/** [K] supplied / demand; null when demand is 0 (the workbook shows "-"). */
	fractionSupplied: number | null;
	/** [M] ROUND(demand × catchment equitableFraction, 1): this farm's equitable share of the water actually supplied. */
	targetM3Day: number;
	/** [N] target − supplied. Negative = reduce, positive = may gain. */
	reduceGainM3Day: number;
	/** [O] ROUNDDOWN(reduceGainM3Day / 86.4, 1), l/s (truncated toward zero). */
	reduceGainLs: number;
	/** [P] ROUND(target / demand, 3); null when demand is 0. */
	targetFraction: number | null;
	/** [R] ROUND(average incremental EWR shortfall, 0), ≤ 0. */
	ewrShortfallM3Day: number;
	/** [S] reduceGain + ewrShortfall. Negative = total cut needed to balance irrigation and meet the EWR. */
	totalChangeM3Day: number;
	/** [T] ROUNDDOWN(totalChangeM3Day / 86.4, 1), l/s. */
	totalChangeLs: number;
	/** [U] target + ewrShortfall: irrigation volume left once balanced and the EWR is met. */
	volumeLeftM3Day: number;
	/** [V] ROUND(volumeLeft / demand, 3): share of demand that is left (the workbook labels it "reduction of demand required"). null when demand is 0. */
	fractionOfDemandLeft: number | null;
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
	/** The workbook's totals row: plain sums of the farm columns (l/s is the sum of the truncated farm values). */
	totals: {
		demandM3Day: number;
		suppliedM3Day: number;
		deficitM3Day: number;
		targetM3Day: number;
		reduceGainM3Day: number;
		reduceGainLs: number;
		ewrShortfallM3Day: number;
		totalChangeM3Day: number;
		volumeLeftM3Day: number;
	};
}

export interface RunSummary {
	farms: FarmSummary[];
	catchment: {
		meanNaturalFlowM3Day: number;
		meanSimulatedOutflowM3Day: number;
		ewrDaysNotMet: number;
		ewrFractionDaysNotMet: number;
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
	 * Input data-quality checks (engine ≥ 0.3.1). observedAgreement is null when
	 * the project doesn't have both observed flow records.
	 */
	dataQuality?: { observedAgreement: ObservedAgreement | null };
	/** Non-fatal problems (flow shares not summing to 1, missing series, …). */
	warnings: string[];
}

export interface ModelOutput {
	engineVersion: string;
	startDate: string;
	endDate: string;
	days: number;
	series: RunSeries[];
	summary: RunSummary;
}
