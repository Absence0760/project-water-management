// Validation signatures (engine ≥ 1.50.0, docs/model.md §2.10d "Validation
// signatures"; calibration-research.md CR-16): three signatures of the scored
// record (the calibration site's when settings.calibrationSiteNodeId picks a
// gauge, else the outlet's) against the simulated outflow on the same days.
// Like the other plausibility checks they only report and warn; none changes
// a simulated flow.
//
// 1. Base-flow index (BFI = Σ base flow ÷ Σ flow) by two filters
//    (../reserve/baseflow.ts): Hughes, Hannart & Watkins (2003) as South
//    African practice applies it to daily flows, and Eckhardt (2005). Each
//    filter runs over every stretch of BFI_MIN_RUN_DAYS or more consecutive
//    recorded, non-excluded days, the observed and the simulated flow over the
//    same stretches.
// 2. The low-flow duration curve: its slope between Q70 and Q95 on log flow,
//    ln(Q70 ÷ Q95) ÷ 0.25, and the slope's bias in the form of Yilmaz, Gupta &
//    Wagener's (2008) %BiasFMS (their mid-segment is 20–70 %; this is the low
//    segment the Reserve's low flows sit on), with their %BiasFLV (the bottom
//    30 %'s volume in log space, ../calibrate/objective.ts fdcSignatures, the
//    fit's and the ensemble's definition).
// 3. Skill on withheld recession segments: the record's rain-free recession
//    segments (../recession/segments.ts, with the recession check's settings
//    and day mask), every HOLDOUT_EVERY-th one held out. The power law
//    −dQ/dt = a·Q^b is fitted to the others (../recession/analysis.ts); on each
//    held-out segment, the simulated outflow's fall and the law's (started
//    from the segment's first observed flow) are scored against the observed
//    fall, ln(Q_t ÷ Q_start), by a skill score against no recession at all:
//    1 − Σ(predicted − observed)² ÷ Σ observed².
//
// Days: the BFI and the FDC use every recorded day the calibration exclusions
// leave in, flagged or not. A filter needs the continuous hydrograph (an
// extrapolated flood is still a flood), and the days below the lowest gauging
// are the low-flow curve itself. The recession segments leave out the days
// the record's quality flags mark (CR-18), as the recession check does: the
// caller passes that mask (a run: the exclusions and the scored record's
// flagged days, the classes it stores as observed_flow_quality).
import type { CalibrationFlowKind } from '../project';
import { fdcSignatures } from '../calibrate/objective';
import { ECKHARDT_FILTER, HUGHES_FILTER, filterBaseflow, type BaseflowFilter, type EckhardtFilter, type QuickflowFilter } from '../reserve/baseflow';
import { fitRecession, recessionPoints, type RecessionFit } from '../recession/analysis';
import { RECESSION_MIN_SEGMENTS } from '../recession/check';
import { RECESSION_DEFAULTS, recessionSegments, type RecessionSegment } from '../recession/segments';
import { flowText } from './format';
import { exceedanceFlow, LOW_FLOW_FLOOR_M3S } from './lowFlow';
import { isFlow } from './season';

const SEC_PER_DAY = 86_400;

/** The BFI and the low-flow FDC need at least this many scored days (a year, so every season is in). */
export const SIGNATURE_MIN_DAYS = 365;
/** A stretch of consecutive scored days shorter than this is left out of the BFI (the filter's start-up would dominate it). */
export const BFI_MIN_RUN_DAYS = 30;
/** Warn when the simulated BFI is more than this (absolute) from the observed, by either filter (indicative). */
export const BFI_WARN_DIFF = 0.15;
/** The low-flow FDC segment whose slope is compared: exceedance %, [upper flow, lower flow]. */
export const FDC_LOW_SLOPE_RANGE: readonly [number, number] = [70, 95];
/** Warn when the low-flow slope bias or %BiasFLV exceeds this, % (indicative; the ensemble's default low-flow limit, §2.10e). */
export const FDC_LOW_WARN_PCT = 50;
/** Every this-many-th recession segment in date order (the 3rd, 6th, …) is held out: a third of them. */
export const HOLDOUT_EVERY = 3;
/** Warn when the simulated recessions' skill on the held-out segments is below this: no better than no recession at all (indicative). */
export const HOLDOUT_SKILL_WARN = 0;
/** A law-predicted flow is floored at this fraction of the segment's first flow (a b < 1 law reaches zero in finite time). */
const LAW_FLOOR = 1e-6;

export interface BfiPair {
	observed: number;
	simulated: number;
	/** simulated − observed. */
	difference: number;
}

export interface BaseflowSignature {
	/** The filters' parameters (HUGHES_FILTER, ECKHARDT_FILTER). */
	hughesFilter: QuickflowFilter;
	eckhardtFilter: EckhardtFilter;
	/** Scored days in the stretches filtered, and how many stretches. */
	days: number;
	runs: number;
	/** null when the observed flow over those days sums to zero. */
	hughes: BfiPair | null;
	eckhardt: BfiPair | null;
	/** Both differences within BFI_WARN_DIFF; null when neither is computed. */
	withinLimit: boolean | null;
}

export interface LowFlowFdcSignature {
	days: number;
	/** FDC_LOW_SLOPE_RANGE. */
	range: [number, number];
	observedQ70M3s: number;
	observedQ95M3s: number;
	simulatedQ70M3s: number;
	simulatedQ95M3s: number;
	/** ln(Q70 ÷ Q95) ÷ 0.25, flows floored at LOW_FLOW_FLOOR_M3S. */
	observedSlope: number;
	simulatedSlope: number;
	/** 100 × (simulated − observed) ÷ observed slope; null when the observed slope is 0. */
	slopeBiasPct: number | null;
	/** %BiasFLV (Yilmaz et al. 2008), the fit's definition; null when it can't be computed. */
	lowVolumeBiasPct: number | null;
	/** Both within ±FDC_LOW_WARN_PCT; null when neither is computed. */
	withinLimit: boolean | null;
}

export interface RecessionHoldout {
	/** HOLDOUT_EVERY. */
	every: number;
	/** All the record's recession segments. */
	segments: number;
	/** The held-out segments, as [first, last] run-day indices, inclusive. */
	heldOut: RecessionSegment[];
	/** The power law fitted to the other segments; null with too few points. */
	law: RecessionFit | null;
	/** Held-out days scored (every day after a segment's first). */
	days: number;
	/** Held-out segments the simulated outflow is above zero on every day of, and their days. */
	modelSegments: number;
	modelDays: number;
	/** Skill against no recession, 1 − Σ(pred − obs)² ÷ Σ obs², on ln(Q ÷ Q_start); null when nothing is scored. */
	modelSkill: number | null;
	lawSkill: number | null;
	/** √(mean (pred − obs)²) of the same log falls. */
	modelLogRmse: number | null;
	lawLogRmse: number | null;
	/**
	 * modelSkill ≥ HOLDOUT_SKILL_WARN; false too when every held-out segment
	 * has a zero simulated day; null when not judged (fewer than
	 * RECESSION_MIN_SEGMENTS segments).
	 */
	agrees: boolean | null;
}

/** RunSummary.plausibility.signatures (engine ≥ 1.50.0). */
export interface ValidationSignatures {
	/** The scored record. */
	flowKind: CalibrationFlowKind;
	/** The calibration site, when the run scores a gauge inside the network; absent at the outlet. */
	siteNodeId?: string;
	siteName?: string;
	/** null with fewer than SIGNATURE_MIN_DAYS days in stretches of BFI_MIN_RUN_DAYS. */
	baseflow: BaseflowSignature | null;
	/** null with fewer than SIGNATURE_MIN_DAYS scored days. */
	lowFlowFdc: LowFlowFdcSignature | null;
	/** null without catchment rain (no recession segments). */
	recessionHoldout: RecessionHoldout | null;
}

export interface SignatureInput {
	flowKind: CalibrationFlowKind;
	site?: { nodeId: string; name: string } | null;
	/** The scored record, m³/s aligned to the run (null = missing). */
	observedM3s: ArrayLike<number | null>;
	/** The simulated outflow where the record is (the outlet's or the site's), m³/day. */
	simulatedM3Day: ArrayLike<number>;
	/** 1 on days the calibration exclusions leave out. */
	excluded: ArrayLike<number>;
	/** 1 on days the recession segments leave out: the exclusions and the record's flagged days. */
	segmentMask: ArrayLike<number>;
	/** The run's final catchment rain, mm (null = none), or null without rain. */
	rainMm: ArrayLike<number | null> | null;
}

/** The stretches of `ok` days at least `min` long, as [first, last] inclusive. */
function runsOf(ok: (t: number) => boolean, days: number, min: number): [number, number][] {
	const out: [number, number][] = [];
	let s = -1;
	for (let t = 0; t <= days; t++) {
		if (t < days && ok(t)) {
			if (s < 0) s = t;
			continue;
		}
		if (s >= 0 && t - s >= min) out.push([s, t - 1]);
		s = -1;
	}
	return out;
}

/** Σ base flow ÷ Σ flow over the stretches, by one filter; null when the flow sums to zero. */
function bfi(flow: ArrayLike<number>, runs: readonly [number, number][], filter: BaseflowFilter): number | null {
	let b = 0;
	let q = 0;
	for (const [s, e] of runs) {
		const x = Array.from({ length: e - s + 1 }, (_, i) => Math.max(0, flow[s + i]!));
		const base = filterBaseflow(x, filter);
		for (let i = 0; i < x.length; i++) {
			b += base[i]!;
			q += x[i]!;
		}
	}
	return q > 0 ? b / q : null;
}

function bfiPair(obs: ArrayLike<number>, sim: ArrayLike<number>, runs: readonly [number, number][], filter: BaseflowFilter): BfiPair | null {
	const o = bfi(obs, runs, filter);
	const s = bfi(sim, runs, filter);
	return o === null || s === null ? null : { observed: o, simulated: s, difference: s - o };
}

const within = (xs: (number | null)[], limit: number): boolean | null => {
	const v = xs.filter((x): x is number => x !== null);
	return v.length ? v.every((x) => Math.abs(x) <= limit) : null;
};

/** The base-flow index by both filters, observed and simulated on the same stretches; null with too few days. */
export function baseflowSignature(obsM3s: ArrayLike<number | null>, simM3s: ArrayLike<number>, excluded: ArrayLike<number>): BaseflowSignature | null {
	const days = Math.min(obsM3s.length, simM3s.length);
	const runs = runsOf((t) => isFlow(obsM3s[t]) && !excluded[t], days, BFI_MIN_RUN_DAYS);
	const n = runs.reduce((a, [s, e]) => a + e - s + 1, 0);
	if (n < SIGNATURE_MIN_DAYS) return null;
	const obs = Float64Array.from({ length: days }, (_, t) => (isFlow(obsM3s[t]) ? obsM3s[t]! : 0));
	const hughes = bfiPair(obs, simM3s, runs, HUGHES_FILTER);
	const eckhardt = bfiPair(obs, simM3s, runs, ECKHARDT_FILTER);
	return {
		hughesFilter: { ...HUGHES_FILTER },
		eckhardtFilter: { ...ECKHARDT_FILTER },
		days: n,
		runs: runs.length,
		hughes,
		eckhardt,
		withinLimit: within([hughes?.difference ?? null, eckhardt?.difference ?? null], BFI_WARN_DIFF)
	};
}

/** ln(Q_hi ÷ Q_lo) ÷ (span of exceedance), flows floored at LOW_FLOW_FLOOR_M3S. */
const lowSlope = (qHi: number, qLo: number) =>
	(Math.log(Math.max(qHi, LOW_FLOW_FLOOR_M3S)) - Math.log(Math.max(qLo, LOW_FLOW_FLOOR_M3S))) / ((FDC_LOW_SLOPE_RANGE[1] - FDC_LOW_SLOPE_RANGE[0]) / 100);

/** The low-flow FDC's slope and biases on the scored days; null with too few. */
export function lowFlowFdcSignature(obsM3s: ArrayLike<number | null>, simM3s: ArrayLike<number>, excluded: ArrayLike<number>): LowFlowFdcSignature | null {
	const o: number[] = [];
	const s: number[] = [];
	const days = Math.min(obsM3s.length, simM3s.length);
	for (let t = 0; t < days; t++) {
		const v = obsM3s[t];
		if (!isFlow(v) || excluded[t]) continue;
		o.push(v);
		s.push(Math.max(0, simM3s[t]!));
	}
	if (o.length < SIGNATURE_MIN_DAYS) return null;
	const fo = Float64Array.from(o).sort().reverse();
	const fs = Float64Array.from(s).sort().reverse();
	const [hi, lo] = FDC_LOW_SLOPE_RANGE;
	const oHi = exceedanceFlow(fo, hi);
	const oLo = exceedanceFlow(fo, lo);
	const sHi = exceedanceFlow(fs, hi);
	const sLo = exceedanceFlow(fs, lo);
	const observedSlope = lowSlope(oHi, oLo);
	const simulatedSlope = lowSlope(sHi, sLo);
	const slopeBiasPct = observedSlope > 0 ? (100 * (simulatedSlope - observedSlope)) / observedSlope : null;
	const flv = fdcSignatures(o, s).fdcLowPct;
	const lowVolumeBiasPct = flv !== null && Number.isFinite(flv) ? flv : null;
	return {
		days: o.length,
		range: [hi, lo],
		observedQ70M3s: oHi,
		observedQ95M3s: oLo,
		simulatedQ70M3s: sHi,
		simulatedQ95M3s: sLo,
		observedSlope,
		simulatedSlope,
		slopeBiasPct,
		lowVolumeBiasPct,
		withinLimit: within([slopeBiasPct, lowVolumeBiasPct], FDC_LOW_WARN_PCT)
	};
}

/** Flow τ days into a recession from q0 under −dQ/dt = a·Q^b, solved exactly. */
export function recessionLawFlow(law: Pick<RecessionFit, 'a' | 'b'>, q0: number, tau: number): number {
	const { a, b } = law;
	if (Math.abs(b - 1) < 1e-9) return q0 * Math.exp(-a * tau);
	const base = q0 ** (1 - b) + (b - 1) * a * tau;
	return base > 0 ? base ** (1 / (1 - b)) : 0;
}

/** Held-out segments: every HOLDOUT_EVERY-th in date order (indices 2, 5, 8 … of 0-based). */
export const isHeldOut = (i: number) => i % HOLDOUT_EVERY === HOLDOUT_EVERY - 1;

/** The skill of the simulated recessions (and of the other segments' law) on the held-out segments. */
export function recessionHoldout(obsM3s: ArrayLike<number | null>, simM3s: ArrayLike<number>, segments: readonly RecessionSegment[]): RecessionHoldout {
	const heldOut = segments.filter((_, i) => isHeldOut(i));
	const fitting = segments.filter((_, i) => !isHeldOut(i));
	const law = fitRecession(recessionPoints(obsM3s, fitting, RECESSION_DEFAULTS.dQdtMethod));
	let days = 0;
	let ssObs = 0;
	let ssLaw = 0;
	let modelSegments = 0;
	let modelDays = 0;
	let ssObsM = 0;
	let ssModel = 0;
	for (const [s, e] of heldOut) {
		const q0 = obsM3s[s]!;
		const m0 = simM3s[s]!;
		let simOk = m0 > 0 && Number.isFinite(m0);
		for (let t = s + 1; t <= e && simOk; t++) simOk = simM3s[t]! > 0 && Number.isFinite(simM3s[t]!);
		if (simOk) modelSegments++;
		for (let t = s + 1; t <= e; t++) {
			const lo = Math.log(obsM3s[t]! / q0);
			days++;
			ssObs += lo * lo;
			if (law) {
				const q = Math.max(recessionLawFlow(law, q0, t - s), q0 * LAW_FLOOR);
				ssLaw += (Math.log(q / q0) - lo) ** 2;
			}
			if (simOk) {
				modelDays++;
				ssObsM += lo * lo;
				ssModel += (Math.log(simM3s[t]! / m0) - lo) ** 2;
			}
		}
	}
	const finite = (v: number) => (Number.isFinite(v) ? v : null);
	const lawSkill = law && ssObs > 0 ? finite(1 - ssLaw / ssObs) : null;
	const modelSkill = ssObsM > 0 ? finite(1 - ssModel / ssObsM) : null;
	const judged = segments.length >= RECESSION_MIN_SEGMENTS && heldOut.length > 0;
	return {
		every: HOLDOUT_EVERY,
		segments: segments.length,
		heldOut: heldOut.map(([s, e]) => [s, e] as const),
		law,
		days,
		modelSegments,
		modelDays,
		modelSkill,
		lawSkill,
		modelLogRmse: modelDays ? finite(Math.sqrt(ssModel / modelDays)) : null,
		lawLogRmse: law && days ? finite(Math.sqrt(ssLaw / days)) : null,
		agrees: !judged ? null : modelSkill === null ? (modelSegments === 0 ? false : null) : modelSkill >= HOLDOUT_SKILL_WARN
	};
}

/** The three signatures of the scored record against the simulated outflow. */
export function validationSignatures(x: SignatureInput): ValidationSignatures {
	const sim = Array.from(x.simulatedM3Day, (v) => v / SEC_PER_DAY);
	const segments = x.rainMm ? recessionSegments({ flowM3s: x.observedM3s, rainMm: x.rainMm, excluded: x.segmentMask }, RECESSION_DEFAULTS) : null;
	return {
		flowKind: x.flowKind,
		...(x.site ? { siteNodeId: x.site.nodeId, siteName: x.site.name } : {}),
		baseflow: baseflowSignature(x.observedM3s, sim, x.excluded),
		lowFlowFdc: lowFlowFdcSignature(x.observedM3s, sim, x.excluded),
		recessionHoldout: segments ? recessionHoldout(x.observedM3s, sim, segments) : null
	};
}

const RECORD: Record<CalibrationFlowKind, string> = { flow_observed_m3s: 'observed gauge', flow_logger_m3s: 'logger' };
const f2 = (v: number) => v.toFixed(2);
const pct = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(0)} %`;

/** The run warnings of the validation signatures, in order: BFI, low-flow FDC, held-out recessions. */
export function signatureWarnings(sig: ValidationSignatures | null | undefined): string[] {
	if (!sig) return [];
	const where = `the ${RECORD[sig.flowKind]} record${sig.siteName ? ` at gauge "${sig.siteName}"` : ''}`;
	const out: string[] = [];
	const bf = sig.baseflow;
	if (bf && bf.withinLimit === false) {
		const parts = (
			[
				['Hughes et al. (2003)', bf.hughes],
				['Eckhardt (2005)', bf.eckhardt]
			] as const
		)
			.filter(([, p]) => p && Math.abs(p.difference) > BFI_WARN_DIFF)
			.map(([name, p]) => `${f2(p!.simulated)} simulated against ${f2(p!.observed)} observed by the ${name} filter`);
		const high = [bf.hughes, bf.eckhardt].some((p) => p && p.difference > BFI_WARN_DIFF);
		out.push(
			`Validation signatures (indicative): on the ${bf.days} scored days of ${where}, the base-flow index is ${parts.join(', and ')}, more than ${BFI_WARN_DIFF} apart. ` +
				(high ? 'The model gives too much of its flow as slow base flow' : 'The model gives too little of its flow as slow base flow') +
				': check the routing store and groundwater exchange (GR4J X2, X3) and the split between quick and slow flow. The Plausibility checks panel lists the signatures.'
		);
	}
	const fdc = sig.lowFlowFdc;
	if (fdc && fdc.withinLimit === false) {
		const parts: string[] = [];
		if (fdc.slopeBiasPct !== null && Math.abs(fdc.slopeBiasPct) > FDC_LOW_WARN_PCT) {
			parts.push(
				`the flow duration curve between Q${fdc.range[0]} and Q${fdc.range[1]} is ${fdc.slopeBiasPct > 0 ? 'steeper' : 'flatter'} simulated than observed (slope bias ${pct(fdc.slopeBiasPct)}; Q${fdc.range[1]} ${flowText(fdc.simulatedQ95M3s)} m³/s against ${flowText(fdc.observedQ95M3s)} m³/s)`
			);
		}
		if (fdc.lowVolumeBiasPct !== null && Math.abs(fdc.lowVolumeBiasPct) > FDC_LOW_WARN_PCT) {
			parts.push(`the low-flow volume bias (%BiasFLV) is ${pct(fdc.lowVolumeBiasPct)}`);
		}
		out.push(
			`Validation signatures (indicative): on the ${fdc.days} scored days of ${where}, ${parts.join(', and ')}, beyond ±${FDC_LOW_WARN_PCT} %. ` +
				'The model’s low flows fall away at a different pace from the river’s: check the base flow (GR4J X3), abstraction in dry spells and dam capture. The Plausibility checks panel lists the signatures.'
		);
	}
	const h = sig.recessionHoldout;
	if (h && h.agrees === false) {
		const law = h.lawSkill === null ? '' : ` (the river’s own recession curve, fitted on the other segments, scores ${f2(h.lawSkill)})`;
		out.push(
			h.modelSkill === null
				? `Validation signatures (indicative): on the ${h.heldOut.length} held-out recession segments of ${where}, the simulated outflow reaches zero on every one, so its recessions can’t be scored. The model dries the river out where it recedes: check the routing store (GR4J X3) and abstraction during dry spells.`
				: `Validation signatures (indicative): on the ${h.heldOut.length} held-out recession segments of ${where}, the simulated recessions score ${f2(h.modelSkill)} against no recession at all${law}: the simulated flow doesn’t fall the way the river does after rain. Check the routing and groundwater parameters (GR4J X2, X3) and dry-spell abstraction. The Plausibility checks panel lists the signatures.`
		);
	}
	return out;
}
