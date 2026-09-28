// Hydrologist plausibility checks on a run (engine ≥ 0.25.0, docs/model.md
// §2.10d; issue #4 phase 6, docs/followups.md). Four checks a reviewing
// hydrologist makes by hand, each a pure function in its own module:
//   1. natural flow ≥ observed + net abstraction, per water year (./naturalised.ts);
//   2. EWR results split by good-rain and fallback-rain years (./rainSource.ts);
//   3. the double-mass curve of observed flow against rain (./flowDoubleMass.ts);
//   4. dry-season low-flow duration curves (./lowFlow.ts), in the dry season
//      of ./season.ts;
//   and, from engine 1.18.0, the recession diagnostics (../recession, CR-13):
//   the calibration record's rain-free recessions against the simulated
//   outflow's on the same days.
// They only report and warn: none changes a model result.
//
// Checks 1 and 4 also run at each gauge node inside the network that has an
// observed record of its own (engine ≥ 1.4.0, a GaugeSeriesKey series),
// against the simulated flow there, reported per site in `gauges`. Checks 2
// and 3 stay catchment-wide: the rain is the catchment's.
import type { CalibrationFlowKind } from '../project';
import type { EwrAssuranceSite } from '../reserve/assurance';
import type { RunoffModelId } from '../runoff/types';
import { flowDoubleMass, flowDoubleMassWarning, type FlowDoubleMass } from './flowDoubleMass';
import { lowFlowCurves, lowFlowWarning, type LowFlowCurves } from './lowFlow';
import { recessionCheck, recessionWarnings, type RecessionCheck } from '../recession/check';
import { naturalisedCheck, naturalisedWarning, type NaturalisedCheck } from './naturalised';
import { rainSourceEwr, rainSourceWarnings, type RainSourceEwr } from './rainSource';
import { drySeason, seasonMask, type DrySeason } from './season';

export * from './compare';
export * from './flowDoubleMass';
export * from './lowFlow';
export * from './naturalised';
export * from './rainSource';
export * from './season';

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
	 * Recession diagnostics on the calibration record (engine ≥ 1.18.0,
	 * ../recession); null without one or without rain, absent on runs made
	 * before 1.18.0.
	 */
	recession?: RecessionCheck | null;
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
	/** 1 on days the calibration exclusions leave out. */
	excluded: Uint8Array;
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
	/** Gauge nodes with a record of their own (engine ≥ 1.4.0), in node-id order; absent or empty = none. */
	gauges?: readonly GaugePlausibilityInput[];
	/** Warnings about gauge records the run can't place (a node gone, or no longer a gauge), in order. */
	gaugeRecordWarnings?: readonly string[];
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
			? recessionCheck({ flowKind: cal, observedM3s: obs, simulatedM3Day: x.simulatedM3Day, rainMm: x.rainMm, excluded: x.excluded })
			: null;
	const gauges = (x.gauges ?? []).map((g) => gaugeChecks(g, x, season, inSeason));
	const atGauges = gauges.flatMap((g) => [naturalisedWarning(g.naturalised), lowFlowWarning(g.lowFlow)].flatMap((w) => (w ? [atGauge(g.name, w)] : [])));
	const warnings = [
		naturalisedWarning(naturalised),
		...rainSourceWarnings(rainSource),
		flowDoubleMassWarning(dm),
		lowFlowWarning(lowFlow),
		...recessionWarnings(recession),
		...(x.gaugeRecordWarnings ?? []),
		...atGauges
	].filter((w): w is string => w !== null);
	return {
		checks: { drySeason: season, naturalised, rainSource, flowDoubleMass: dm, lowFlow, recession, ...(gauges.length ? { gauges } : {}) },
		warnings
	};
}

/** A check's warning, said of a gauge: `At gauge "Upper weir": natural flow below …`. */
const atGauge = (name: string, w: string) => `At gauge "${name}": ${w[0]!.toLowerCase()}${w.slice(1)}`;

/** Checks 1 and 4 at one gauge, on the catchment's dry season and the run's exclusions. */
function gaugeChecks(g: GaugePlausibilityInput, x: PlausibilityInput, season: DrySeason | null, inSeason: Uint8Array | null): GaugePlausibility {
	const cal = x.calibrationKind;
	const flowKind: CalibrationFlowKind =
		cal && g.observed[cal] ? cal : g.observed.flow_observed_m3s ? 'flow_observed_m3s' : 'flow_logger_m3s';
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
	return { nodeId: g.nodeId, name: g.name, flowKind, naturalShare: g.naturalShare, naturalised, lowFlow };
}
