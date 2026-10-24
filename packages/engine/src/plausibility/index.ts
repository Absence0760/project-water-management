// Hydrologist plausibility checks on a run (engine ≥ 0.25.0, docs/model.md
// §2.10d; issue #4 phase 6, docs/followups.md). Four checks a reviewing
// hydrologist makes by hand, each a pure function in its own module:
//   1. natural flow ≥ observed + net abstraction, per water year (./naturalised.ts);
//   2. EWR results split by good-rain and fallback-rain years (./rainSource.ts);
//   3. the double-mass curve of observed flow against rain (./flowDoubleMass.ts);
//   4. dry-season low-flow duration curves (./lowFlow.ts), in the dry season
//      of ./season.ts;
//   and, from engine 1.19.0, the recession diagnostics (../recession, CR-13):
//   the calibration record's rain-free recessions against the simulated
//   outflow's on the same days; and, from engine 1.55.0, the validation
//   signatures (./signatures.ts, CR-16) of the scored record: base-flow index
//   by two filters, the low-flow FDC's slope and bias, and the skill on
//   withheld recession segments.
// They only report and warn: none changes a model result.
//
// Checks 1 and 4 also run at each gauge node inside the network that has an
// observed record of its own (engine ≥ 1.4.0, a GaugeSeriesKey series),
// against the simulated flow there, reported per site in `gauges`. Checks 2
// and 3 stay catchment-wide: the rain is the catchment's.
import { CALIBRATION_FLOW_KINDS, gaugeCheckKind, type CalibrationFlowKind } from '../project';
import { calibrationStats } from '../network/stats';
import type { EwrAssuranceSite } from '../reserve/assurance';
import type { RunoffModelId } from '../runoff/types';
import { flowDoubleMass, flowDoubleMassWarning, type FlowDoubleMass } from './flowDoubleMass';
import { lowFlowCurves, lowFlowWarning, type LowFlowCurves } from './lowFlow';
import { recessionCheck, recessionWarnings, type RecessionCheck } from '../recession/check';
import { signatureWarnings, validationSignatures, type ValidationSignatures } from './signatures';
import { naturalisedCheck, naturalisedWarning, type NaturalisedCheck } from './naturalised';
import { rainSourceEwr, rainSourceWarnings, type RainSourceEwr } from './rainSource';
import { drySeason, seasonMask, type DrySeason } from './season';

export * from './compare';
export * from './flowDoubleMass';
export * from './lowFlow';
export * from './naturalised';
export * from './rainSource';
export * from './season';
export * from './signatures';

/** RunSummary.plausibility. Each part is null when the run lacks what it needs. */
export interface PlausibilityChecks {
	/** The dry season checks 3 and 4 use; null when no record covers every calendar month. */
	drySeason: DrySeason | null;
	/** Check 1, on the calibration record; null without one. */
	naturalised: NaturalisedCheck | null;
	/** Check 2; null without any rain series. */
	rainSource: RainSourceEwr | null;
	/** Check 3, on the calibration record; null without one, a catchment area, or enough judged years. */
	flowDoubleMass: FlowDoubleMass | null;
	/** Check 4; null without a dry season. */
	lowFlow: LowFlowCurves | null;
	/**
	 * Recession diagnostics on the calibration record (engine ≥ 1.19.0,
	 * ../recession); null without one or without rain, absent on runs made
	 * before 1.19.0.
	 */
	recession?: RecessionCheck | null;
	/**
	 * Validation signatures of the scored record (engine ≥ 1.55.0,
	 * ./signatures.ts, CR-16): the calibration site's record when the run
	 * scores a gauge inside the network, else the outlet's. null without an
	 * observed record; absent on runs made before 1.55.0.
	 */
	signatures?: ValidationSignatures | null;
	/**
	 * Checks 1 and 4 at each gauge node with an observed record of its own
	 * (engine ≥ 1.4.0), in node-id order; absent when none has one (every
	 * project before 1.4.0, and any whose records are all the outlet's).
	 */
	gauges?: GaugePlausibility[];
}

/** Checks 1 and 4 at one gauge node inside the network (engine ≥ 1.4.0). */
export interface GaugePlausibility {
	nodeId: string;
	name: string;
	/** The record checked: the run's calibration kind when the gauge has one, else the gauge's other record. */
	flowKind: CalibrationFlowKind;
	/** The gauge's share of the catchment's natural flow: Σ flow shares of the gauge and every node above it. */
	naturalShare: number;
	/** Check 1 at the gauge; null without an observed day. */
	naturalised: NaturalisedCheck | null;
	/** Check 4 at the gauge, in the catchment's dry season; null without one. */
	lowFlow: LowFlowCurves | null;
	/**
	 * The record's fit against the simulated flow at the gauge (engine ≥
	 * 1.90.0, issue #554, docs/model.md §2.10k): NSE, KGE and PBIAS with the
	 * run's calibration statistics' formulas (network/stats.ts
	 * calibrationStats) on every day with a reading outside the run's
	 * calibration exclusions and before a forecast run's forecast, no
	 * calibration window. A check, never the
	 * calibration score (unless this gauge is the calibration site, whose
	 * score is RunSummary.calibration). null when no day is read; absent on a
	 * run made before 1.90.0.
	 */
	fit?: GaugeFitCheck | null;
}

/** A gauge record's fit as a check (GaugePlausibility.fit). */
export interface GaugeFitCheck {
	/** Days with a reading outside the exclusions. */
	days: number;
	nse: number | null;
	kge: number | null;
	/** %, positive = the model under-estimates (calibrationStats). */
	pbias: number | null;
}

/** One gauge's inputs: its records and the network's flows at it, m³/day aligned to the run. */
export interface GaugePlausibilityInput {
	nodeId: string;
	name: string;
	naturalShare: number;
	/** The gauge's own records, m³/s aligned to the run; at least one. */
	observed: Partial<Record<CalibrationFlowKind, ArrayLike<number | null>>>;
	/** Natural flow at the gauge: the catchment's × naturalShare. */
	naturalM3Day: ArrayLike<number>;
	/** The simulated flow at the gauge (its outflow). */
	simulatedM3Day: ArrayLike<number>;
	/** The dams above the gauge only (as PlausibilityInput.damsM3Day). */
	damsM3Day: ArrayLike<number>;
	/** The land-cover reduction above the gauge only (empty without land cover). */
	landCoverM3Day: ArrayLike<number>;
}

export interface PlausibilityInput {
	/** Epoch day of run day 0. */
	start: number;
	days: number;
	runoffModel: RunoffModelId;
	naturalM3Day: ArrayLike<number>;
	simulatedM3Day: ArrayLike<number>;
	/** Observed records present in the project, m³/s aligned to the run. */
	observed: Partial<Record<CalibrationFlowKind, ArrayLike<number | null>>>;
	calibrationKind: CalibrationFlowKind | null;
	/**
	 * The kind of the record the run's calibration statistics score, wherever
	 * they score it (the calibration site's when the run scores one, engine ≥
	 * 1.90.0): the gauges' checks read that kind where a gauge has it
	 * (gaugeCheckKind, engine-audit.md G2); without a record scored, the kind
	 * asked for in Settings, else null.
	 */
	scoredKind: CalibrationFlowKind | null;
	/**
	 * The days before a forecast run's forecast (engine-audit.md K1); absent:
	 * every day. The gauges' fit checks (GaugePlausibility.fit) read only
	 * these, as the flow-duration curves beside them on Runs & results do.
	 */
	historyDays?: number;
	/** 1 on days the calibration exclusions leave out. */
	excluded: Uint8Array;
	/**
	 * 1 on days the calibration record's quality flags mark extrapolated,
	 * suspect or infilled (engine ≥ 1.22.0, CR-18, ../calibrate/dayFlags.ts
	 * flaggedDayMask): the recession segments leave them out too. Absent = none.
	 */
	flowFlagged?: Uint8Array;
	/** The dams' daily storage gain + evaporation − rain on them, m³. */
	damsM3Day: ArrayLike<number>;
	/** The land-cover reduction per day, m³ (empty without land cover). */
	landCoverM3Day: ArrayLike<number>;
	/** The run's final rain (null = none), or null without any rain series. */
	rainMm: (number | null)[] | null;
	/** 1 on station-rain days (./rainSource.ts). */
	station: Uint8Array;
	hasStation: boolean;
	ewrShortfall: ArrayLike<number>;
	reserve: readonly EwrAssuranceSite[];
	areaKm2: number;
	/**
	 * The record the run's calibration statistics score (engine ≥ 1.55.0): the
	 * calibration site's (settings.calibrationSiteNodeId) or the outlet's, with
	 * the simulated outflow where it is and the recession segments' day mask
	 * (the exclusions and that record's flagged days). Absent or null without
	 * an observed record: no validation signatures.
	 */
	scored?: ScoredRecordInput | null;
	/** Gauge nodes with a record of their own (engine ≥ 1.4.0), in node-id order; absent or empty = none. */
	gauges?: readonly GaugePlausibilityInput[];
	/** Warnings about gauge records the run can't place (a node gone, or no longer a gauge), in order. */
	gaugeRecordWarnings?: readonly string[];
}

/** PlausibilityInput.scored. */
export interface ScoredRecordInput {
	flowKind: CalibrationFlowKind;
	/** The calibration site; null at the outlet. */
	site: { nodeId: string; name: string } | null;
	/** m³/s aligned to the run (null = missing). */
	observedM3s: ArrayLike<number | null>;
	/** The simulated outflow at the record, m³/day. */
	simulatedM3Day: ArrayLike<number>;
	/** 1 on days the recession segments leave out: the calibration exclusions and the record's flagged days. */
	segmentMask: Uint8Array;
}

/** 1 where either mask is; `a` itself without `b`. */
function orMask(a: Uint8Array, b: Uint8Array | undefined): Uint8Array {
	if (!b) return a;
	return Uint8Array.from(a, (v, t) => (v || b[t] ? 1 : 0));
}

/** Run the four checks; returns the summary block and the run warnings (in check order). */
export function plausibilityChecks(x: PlausibilityInput): { checks: PlausibilityChecks; warnings: string[] } {
	const cal = x.calibrationKind;
	const other: CalibrationFlowKind | null = cal === 'flow_observed_m3s' ? 'flow_logger_m3s' : cal === 'flow_logger_m3s' ? 'flow_observed_m3s' : null;
	const candidates = [
		...(cal && x.observed[cal] ? [{ source: cal, values: x.observed[cal]! }] : []),
		...(other && x.observed[other] ? [{ source: other, values: x.observed[other]! }] : []),
		{ source: 'natural_flow' as const, values: Array.from(x.naturalM3Day) }
	];
	const season = drySeason(candidates, x.start);
	const inSeason = season ? seasonMask(season, x.start, x.days) : null;
	const obs = cal ? x.observed[cal] : undefined;
	const naturalised = cal && obs
		? naturalisedCheck({
				flowKind: cal,
				start: x.start,
				naturalM3Day: x.naturalM3Day,
				simulatedM3Day: x.simulatedM3Day,
				observedM3s: obs,
				damsM3Day: x.damsM3Day,
				landCoverM3Day: x.landCoverM3Day,
				excluded: x.excluded
			})
		: null;
	const rainSource = x.rainMm
		? rainSourceEwr({ start: x.start, rainMm: x.rainMm, station: x.station, hasStation: x.hasStation, ewrShortfall: x.ewrShortfall, reserve: x.reserve })
		: null;
	const dm =
		cal && obs && x.rainMm
			? flowDoubleMass({ flowKind: cal, start: x.start, observedM3s: obs, simulatedM3Day: x.simulatedM3Day, rainMm: x.rainMm, areaKm2: x.areaKm2, inSeason, excluded: x.excluded })
			: null;
	const lowFlow = lowFlowCurves({
		season,
		inSeason: inSeason ?? new Uint8Array(x.days),
		runoffModel: x.runoffModel,
		observed: x.observed,
		calibrationKind: cal,
		simulatedM3Day: x.simulatedM3Day,
		naturalM3Day: x.naturalM3Day,
		excluded: x.excluded
	});
	const recession =
		cal && obs && x.rainMm
			? recessionCheck({ flowKind: cal, observedM3s: obs, simulatedM3Day: x.simulatedM3Day, rainMm: x.rainMm, excluded: orMask(x.excluded, x.flowFlagged) })
			: null;
	const signatures = x.scored ? validationSignatures({ ...x.scored, excluded: x.excluded, rainMm: x.rainMm }) : null;
	const gauges = (x.gauges ?? []).map((g) => gaugeChecks(g, x, season, inSeason));
	const atGauges = gauges.flatMap((g) => [naturalisedWarning(g.naturalised), lowFlowWarning(g.lowFlow)].flatMap((w) => (w ? [atGauge(g.name, w)] : [])));
	const warnings = [
		naturalisedWarning(naturalised),
		...rainSourceWarnings(rainSource),
		flowDoubleMassWarning(dm),
		lowFlowWarning(lowFlow),
		...recessionWarnings(recession),
		...signatureWarnings(signatures),
		...(x.gaugeRecordWarnings ?? []),
		...atGauges
	].filter((w): w is string => w !== null);
	return {
		checks: { drySeason: season, naturalised, rainSource, flowDoubleMass: dm, lowFlow, recession, signatures, ...(gauges.length ? { gauges } : {}) },
		warnings
	};
}

/** A check's warning, said of a gauge: `At gauge "Upper weir": natural flow below …`. */
const atGauge = (name: string, w: string) => `At gauge "${name}": ${w[0]!.toLowerCase()}${w.slice(1)}`;

/** Checks 1 and 4 at one gauge, on the catchment's dry season and the run's exclusions. */
function gaugeChecks(g: GaugePlausibilityInput, x: PlausibilityInput, season: DrySeason | null, inSeason: Uint8Array | null): GaugePlausibility {
	const cal = x.scoredKind;
	// One rule with the checks-only series and the EWR test at a gauge in run.ts (gaugeCheckKind); a gauge here has at least one record.
	const flowKind = gaugeCheckKind(cal, CALIBRATION_FLOW_KINDS.filter((k) => g.observed[k]))!;
	const obs = g.observed[flowKind];
	const naturalised = obs
		? naturalisedCheck({
				flowKind,
				start: x.start,
				naturalM3Day: g.naturalM3Day,
				simulatedM3Day: g.simulatedM3Day,
				observedM3s: obs,
				damsM3Day: g.damsM3Day,
				landCoverM3Day: g.landCoverM3Day,
				excluded: x.excluded
			})
		: null;
	const lowFlow = lowFlowCurves({
		season,
		inSeason: inSeason ?? new Uint8Array(x.days),
		runoffModel: x.runoffModel,
		observed: g.observed,
		calibrationKind: flowKind,
		simulatedM3Day: g.simulatedM3Day,
		naturalM3Day: g.naturalM3Day,
		excluded: x.excluded
	});
	return { nodeId: g.nodeId, name: g.name, flowKind, naturalShare: g.naturalShare, naturalised, lowFlow, fit: obs ? gaugeFitCheck(g.simulatedM3Day, obs, x.excluded, x.historyDays) : null };
}

/**
 * GaugePlausibility.fit: the record (m³/s, null = no reading) against the
 * simulated flow (m³/day), the excluded days and a forecast run's forecast
 * days (from `historyDays`) left out.
 */
export function gaugeFitCheck(
	simulatedM3Day: ArrayLike<number>,
	observedM3s: ArrayLike<number | null>,
	excluded: ArrayLike<number> | null,
	historyDays: number = observedM3s.length
): GaugeFitCheck | null {
	const obs = Array.from(observedM3s, (v, t) => (excluded?.[t] || t >= historyDays ? null : v));
	const s = calibrationStats(simulatedM3Day, obs);
	return s.days ? { days: s.days, nse: s.nse, kge: s.kge ?? null, pbias: s.pbias } : null;
}
