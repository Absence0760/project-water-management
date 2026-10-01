// Dry-season low-flow duration curves (engine ≥ 0.25.0, docs/model.md §2.10d,
// issue #4 phase 6 plausibility check 4; calibration-research.md CR-16).
//
// The flow duration curve of the dry-season days only, for every flow the run
// knows at the outlet: the observed gauge and logger records (each on its own
// days), the simulated outflow and the simulated natural flow (every dry-season
// day of the run), and the simulated outflow again on each observed record's
// days, so a curve can be compared with the record over the same days. The
// dry season is ./season.ts's. The results page overlays them, and the latest
// run of each other runoff model, so a hydrologist can see which model's low
// flows sit with the river's.
//
// The check warns when, on the calibration record's own dry-season days, the
// simulated Q90 is more than a factor LOW_FLOW_WARN_FACTOR from the observed
// Q90. Low flows are where a gauge is least certain: a weir's rating is least
// sensitive near its crest and most exposed to silt and weed, and published
// reviews put low-flow discharge uncertainty at ±50–100 % (McMillan, Krueger
// & Freer 2012). A factor of 2 either way is outside that band, so a
// difference that big is the model's, not the gauge's.
import type { CalibrationFlowKind } from '../project';
import type { RunoffModelId, StoredRunoffModelId } from '../runoff/types';
import { isFlow, type DrySeason } from './season';
import { flowText } from './format';

const SEC_PER_DAY = 86_400;

/** Exceedance % points the curves are given at. */
export const LOW_FLOW_POINTS = [1, 2, 5, 10, 20, 30, 40, 50, 60, 70, 75, 80, 85, 90, 95, 98, 99] as const;
/** A curve needs at least this many dry-season days (half of one dry season). */
export const LOW_FLOW_MIN_DAYS = 90;
/** Warn when the simulated Q90 is more than this factor above or below the observed Q90 on the same days. */
export const LOW_FLOW_WARN_FACTOR = 2;
/** Flows below this (m³/s) count as this in the Q90 ratio: gauges publish whole thousandths of m³/s. */
export const LOW_FLOW_FLOOR_M3S = 0.001;

export type LowFlowSource = CalibrationFlowKind | 'simulated_outflow' | 'natural_flow';

export interface LowFlowCurve {
	source: LowFlowSource;
	/** For a simulated curve on an observed record's days: that record; else null. */
	pairedWith: CalibrationFlowKind | null;
	/** Dry-season days behind the curve. */
	days: number;
	/** Flow (m³/s) equalled or exceeded at each of LOW_FLOW_POINTS. */
	flowsM3s: number[];
}

export interface LowFlowComparison {
	flowKind: CalibrationFlowKind;
	days: number;
	observedQ90M3s: number;
	simulatedQ90M3s: number;
	/** MAX(simulated, floor) ÷ MAX(observed, floor). */
	ratio: number;
	/** 1 ÷ LOW_FLOW_WARN_FACTOR ≤ ratio ≤ LOW_FLOW_WARN_FACTOR. */
	withinFactor: boolean;
}

export interface LowFlowCurves {
	season: DrySeason;
	/** The run's runoff model, so curves from runs of different models (a stored legacy run, engine < 1.0.0) can be told apart when overlaid. */
	runoffModel: StoredRunoffModelId;
	points: number[];
	/** In order: gauge, logger, simulated outflow, natural flow, then simulated on the gauge's and the logger's days. Curves with too few days are left out. */
	curves: LowFlowCurve[];
	/** Simulated vs observed Q90 on the calibration record's dry-season days; null without one or with too few days. */
	comparison: LowFlowComparison | null;
}

export interface LowFlowInput {
	season: DrySeason | null;
	/** 1 on dry-season run days (./season.ts seasonMask). */
	inSeason: Uint8Array;
	runoffModel: RunoffModelId;
	/** Observed records at the outlet, m³/s aligned to the run (null = missing); absent when the project has none. */
	observed: Partial<Record<CalibrationFlowKind, ArrayLike<number | null>>>;
	/** The record the run calibrates against, or null. */
	calibrationKind: CalibrationFlowKind | null;
	simulatedM3Day: ArrayLike<number>;
	naturalM3Day: ArrayLike<number>;
	/** 1 on days the calibration exclusions leave out: left out of the observed records and their paired curves. */
	excluded: Uint8Array;
}

const KINDS: CalibrationFlowKind[] = ['flow_observed_m3s', 'flow_logger_m3s'];

/**
 * The flow equalled or exceeded p % of the time on a curve sorted largest
 * first: Weibull plotting positions, as reserve/assurance.ts durationQuantile
 * (the i-th highest at i ÷ (n + 1), linear between, held at the ends).
 */
export function exceedanceFlow(sortedDesc: ArrayLike<number>, p: number): number {
	const n = sortedDesc.length;
	const h = (p / 100) * (n + 1);
	if (h <= 1) return sortedDesc[0]!;
	if (h >= n) return sortedDesc[n - 1]!;
	const i = Math.floor(h);
	return sortedDesc[i - 1]! + (h - i) * (sortedDesc[i]! - sortedDesc[i - 1]!);
}

function curve(source: LowFlowSource, pairedWith: CalibrationFlowKind | null, values: number[]): LowFlowCurve | null {
	if (values.length < LOW_FLOW_MIN_DAYS) return null;
	const x = Float64Array.from(values).sort().reverse();
	return { source, pairedWith, days: x.length, flowsM3s: LOW_FLOW_POINTS.map((p) => exceedanceFlow(x, p)) };
}

/** The dry-season low-flow duration curves and the Q90 comparison; null without a dry season. */
export function lowFlowCurves(x: LowFlowInput): LowFlowCurves | null {
	if (!x.season) return null;
	const days = x.inSeason.length;
	const sim: number[] = [];
	const nat: number[] = [];
	for (let t = 0; t < days; t++) {
		if (!x.inSeason[t]) continue;
		sim.push(x.simulatedM3Day[t]! / SEC_PER_DAY);
		nat.push(x.naturalM3Day[t]! / SEC_PER_DAY);
	}
	const own: LowFlowCurve[] = [];
	const paired: LowFlowCurve[] = [];
	let comparison: LowFlowComparison | null = null;
	for (const kind of KINDS) {
		const o = x.observed[kind];
		if (!o) continue;
		const obs: number[] = [];
		const onDays: number[] = [];
		for (let t = 0; t < days; t++) {
			const v = o[t];
			if (!x.inSeason[t] || x.excluded[t] || !isFlow(v)) continue;
			obs.push(v);
			onDays.push(x.simulatedM3Day[t]! / SEC_PER_DAY);
		}
		const a = curve(kind, null, obs);
		const b = curve('simulated_outflow', kind, onDays);
		if (a) own.push(a);
		if (b) paired.push(b);
		if (kind === x.calibrationKind && a && b) {
			const q90 = LOW_FLOW_POINTS.indexOf(90);
			const oq = a.flowsM3s[q90]!;
			const sq = b.flowsM3s[q90]!;
			const ratio = Math.max(sq, LOW_FLOW_FLOOR_M3S) / Math.max(oq, LOW_FLOW_FLOOR_M3S);
			comparison = {
				flowKind: kind,
				days: a.days,
				observedQ90M3s: oq,
				simulatedQ90M3s: sq,
				ratio,
				withinFactor: ratio >= 1 / LOW_FLOW_WARN_FACTOR && ratio <= LOW_FLOW_WARN_FACTOR
			};
		}
	}
	const whole = [curve('simulated_outflow', null, sim), curve('natural_flow', null, nat)].filter((c): c is LowFlowCurve => c !== null);
	return { season: x.season, runoffModel: x.runoffModel, points: [...LOW_FLOW_POINTS], curves: [...own, ...whole, ...paired], comparison };
}

const RECORD: Record<CalibrationFlowKind, string> = { flow_observed_m3s: 'observed gauge', flow_logger_m3s: 'logger' };

/** The run warning when the simulated dry-season Q90 is outside a factor LOW_FLOW_WARN_FACTOR of the observed; null otherwise. */
export function lowFlowWarning(lf: LowFlowCurves | null): string | null {
	const c = lf?.comparison;
	if (!c || c.withinFactor) return null;
	const high = c.ratio > 1;
	return (
		`Dry-season low flows: on the ${c.days} dry-season days of the ${RECORD[c.flowKind]} record, the simulated outflow's Q90 is ${flowText(c.simulatedQ90M3s)} m³/s against ${flowText(c.observedQ90M3s)} m³/s observed ` +
		`(${high ? `${c.ratio.toFixed(1)}× higher` : `${(1 / c.ratio).toFixed(1)}× lower`}), more than the factor of ${LOW_FLOW_WARN_FACTOR} that low-flow gauging error can explain. ` +
		(high
			? 'The model keeps too much water in the river in the dry season: check the base flow (GR4J X3), dam releases and the abstraction. '
			: 'The model dries the river out faster than it did: check the base flow (GR4J X3), abstraction and dam capture. ') +
		'The Plausibility checks panel overlays the curves.'
	);
}
