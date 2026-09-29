// Recession diagnostics on a run (engine ≥ 1.19.0, docs/model.md §2.10d
// "Recession diagnostics"; calibration-research.md CR-13): the calibration
// record's recession segments (./segments.ts), −dQ/dt against Q on them for
// the observed flow and for the simulated outflow on the same days, and the
// power law fitted to each (./analysis.ts). It checks GR4J's simulated
// recessions against the river's. Like the other plausibility checks it only
// reports and warns.
//
// Warnings (indicative thresholds, for the hydrologist to confirm):
// - fewer than RECESSION_MIN_SEGMENTS segments: too few for a stable fit
//   (CR-15: don't trust a recession table from fewer than about 8; TOSSH
//   itself warns below 10), so not judged (no warning; the panel says so);
// - with enough segments, the simulated recession differs from the observed
//   by more than RECESSION_B_WARN_DIFF in b, or its recession rate
//   −dQ/dt ÷ Q at the observed points' median flow by more than a factor
//   RECESSION_RATE_WARN_FACTOR. b is sensitive to how −dQ/dt is estimated
//   (a few tenths between methods, Stoelzle et al. 2013; Jachens et al.
//   2020), so a difference of 0.5 is beyond that noise; a factor of 2 in the
//   rate is a recession that halves its flow in half or twice the time.
import type { CalibrationFlowKind } from '../project';
import { fitRecession, recessionPoints, recessionRateAt, type RecessionFit } from './analysis';
import { RECESSION_DEFAULTS, recessionSegments, type RecessionOptions, type RecessionSegment } from './segments';

const SEC_PER_DAY = 86_400;

/** Fewer segments than this: the fit is too thin to judge, and the run warns. */
export const RECESSION_MIN_SEGMENTS = 8;
/** Warn when the simulated b differs from the observed by more than this (indicative). */
export const RECESSION_B_WARN_DIFF = 0.5;
/** Warn when the simulated recession rate at the reference flow is more than this factor from the observed (indicative). */
export const RECESSION_RATE_WARN_FACTOR = 2;

/** RunSummary.plausibility.recession (engine ≥ 1.19.0). */
export interface RecessionCheck {
	/** The record the segments come from: the run's calibration record. */
	flowKind: CalibrationFlowKind;
	/** The settings used (RECESSION_DEFAULTS). */
	options: RecessionOptions;
	/** The segments, as [first, last] run-day indices (day 0 = the run's start), inclusive. */
	segments: RecessionSegment[];
	/** −dQ/dt = a·Q^b through the observed points; null with too few. */
	observed: RecessionFit | null;
	/** The same through the simulated outflow on the same segments; null with too few. */
	simulated: RecessionFit | null;
	/** Median Q of the observed points, m³/s: where the two recession rates are compared. */
	referenceFlowM3s: number | null;
	/** −dQ/dt ÷ Q at the reference flow, per day, on each fit. */
	observedRate: number | null;
	simulatedRate: number | null;
	/** simulatedRate ÷ observedRate. */
	rateRatio: number | null;
	/** simulated b − observed b. */
	bDiff: number | null;
	/**
	 * Whether the simulated recession agrees within the indicative limits;
	 * false too when the simulated flow gives no fit (it barely falls on those
	 * days); null when not judged (fewer than RECESSION_MIN_SEGMENTS segments,
	 * or no observed fit).
	 */
	agrees: boolean | null;
}

export interface RecessionCheckInput {
	flowKind: CalibrationFlowKind;
	/** The calibration record, m³/s aligned to the run (null = missing). */
	observedM3s: ArrayLike<number | null>;
	/** The simulated outflow, m³/day. */
	simulatedM3Day: ArrayLike<number>;
	/** The run's final catchment rain, mm (null = none). */
	rainMm: ArrayLike<number | null>;
	/** 1 on days the calibration exclusions (and, later, CR-18's flow quality flags) leave out. */
	excluded: ArrayLike<number>;
	options?: Partial<RecessionOptions>;
}

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** The simulated outflow in m³/s. */
const simulatedM3s = (m3Day: ArrayLike<number>): number[] => Array.from(m3Day, (v) => v / SEC_PER_DAY);

/** The recession diagnostics of a run's calibration record against its simulated outflow. */
export function recessionCheck(x: RecessionCheckInput): RecessionCheck {
	const options: RecessionOptions = { ...RECESSION_DEFAULTS, ...x.options };
	const segments = recessionSegments({ flowM3s: x.observedM3s, rainMm: x.rainMm, excluded: x.excluded }, options);
	const obsPoints = recessionPoints(x.observedM3s, segments, options.dQdtMethod);
	const observed = fitRecession(obsPoints);
	const simulated = fitRecession(recessionPoints(simulatedM3s(x.simulatedM3Day), segments, options.dQdtMethod));
	const referenceFlowM3s = obsPoints.length ? median(obsPoints.map((p) => p.qM3s)) : null;
	// Every number the summary keeps is finite (JSON has no Infinity): an overflowing rate or ratio is null, not judged.
	const finite = (v: number | null) => (v !== null && Number.isFinite(v) ? v : null);
	const observedRate = observed && referenceFlowM3s !== null ? finite(recessionRateAt(observed, referenceFlowM3s)) : null;
	const simulatedRate = simulated && referenceFlowM3s !== null ? finite(recessionRateAt(simulated, referenceFlowM3s)) : null;
	const rateRatio = observedRate && simulatedRate !== null ? finite(simulatedRate / observedRate) : null;
	const bDiff = observed && simulated ? simulated.b - observed.b : null;
	const agrees =
		segments.length < RECESSION_MIN_SEGMENTS || !observed
			? null
			: // Enough segments but no simulated fit: the model barely falls on the river's recession days.
				!simulated
				? false
				: rateRatio === null || bDiff === null
					? null
					: Math.abs(bDiff) <= RECESSION_B_WARN_DIFF && rateRatio >= 1 / RECESSION_RATE_WARN_FACTOR && rateRatio <= RECESSION_RATE_WARN_FACTOR;
	return { flowKind: x.flowKind, options, segments, observed, simulated, referenceFlowM3s, observedRate, simulatedRate, rateRatio, bDiff, agrees };
}

const RECORD: Record<CalibrationFlowKind, string> = { flow_observed_m3s: 'observed gauge', flow_logger_m3s: 'logger' };
const fix = (v: number, d: number) => v.toFixed(d);

/** The run warnings of the recession diagnostics: only when the comparison is judged and fails (8+ segments); empty otherwise. */
export function recessionWarnings(r: RecessionCheck | null | undefined): string[] {
	if (!r) return [];
	const n = r.segments.length;
	// Too few segments to judge: the Plausibility checks panel says "Not judged"; a run warning
	// would fire on most short records and say nothing about the model.
	if (n < RECESSION_MIN_SEGMENTS) return [];
	if (r.agrees !== false) return [];
	if (!r.simulated) {
		return [
			`Recession diagnostics (indicative): on the ${n} rain-free recession segments of the ${RECORD[r.flowKind]} record, the simulated outflow barely falls ` +
				'(too few falling days to fit). The model holds its flow up where the river recedes: check the groundwater exchange and routing store (GR4J X2, X3), and dam releases. ' +
				'The Plausibility checks panel plots −dQ/dt against Q for both.'
		];
	}
	const parts: string[] = [];
	if (r.bDiff !== null && Math.abs(r.bDiff) > RECESSION_B_WARN_DIFF) {
		parts.push(`b is ${fix(r.simulated!.b, 2)} simulated against ${fix(r.observed!.b, 2)} observed (more than ${RECESSION_B_WARN_DIFF} apart)`);
	}
	if (r.rateRatio !== null && (r.rateRatio > RECESSION_RATE_WARN_FACTOR || r.rateRatio < 1 / RECESSION_RATE_WARN_FACTOR)) {
		const faster = r.rateRatio > 1;
		parts.push(
			`at ${r.referenceFlowM3s!.toPrecision(2)} m³/s the simulated flow recedes ${faster ? fix(r.rateRatio, 1) : fix(1 / r.rateRatio, 1)}× ${faster ? 'faster' : 'slower'} than the observed`
		);
	}
	return [
		`Recession diagnostics (indicative): on the ${n} rain-free recession segments of the ${RECORD[r.flowKind]} record, ${parts.join(', and ')}. ` +
			'The model drains its stores at a different pace from the river: check the routing and groundwater parameters (GR4J X2, X3), and abstraction during dry spells. ' +
			'The Plausibility checks panel plots −dQ/dt against Q for both.'
	];
}
