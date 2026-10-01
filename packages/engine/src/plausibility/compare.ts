// The plausibility checks of two runs side by side (engine ≥ 1.4.0 compares
// them; docs/run-comparison.md § Plausibility checks). Per check, each run's
// own result, never re-computed: the water years that fail check 1 (natural
// flow ≥ observed + abstraction) and the Q90 ratio of check 4 (dry-season low
// flows), with pass or fail, at the outlet and at each gauge node with a
// record of its own; the good-rain and fallback-rain split of check 2; and
// the breaks of check 3 the model doesn't share; the recession diagnostics'
// rate ratio and b difference (engine ≥ 1.19.0) and the validation signatures
// (engine ≥ 1.55.0, CR-16): BFI by both filters, the low-flow slope bias and
// %BiasFLV, and the held-out recession skill. A run saved before engine
// 0.25.0 has no checks: its side is null. A run saved before the engine that
// added the recession diagnostics or the signatures says so (`missing`
// 'older', against 'none' when the run made the check but had nothing to
// make it on), and a change is given only when both runs have the check on
// the same record: two different records' numbers differ for that reason
// alone.
import type { CalibrationFlowKind, RunSummary } from '../project';
import { RECESSION_MIN_SEGMENTS, type RecessionCheck } from '../recession/check';
import { RAIN_SOURCE_WARN_DIFF } from './rainSource';
import { BFI_WARN_DIFF, FDC_LOW_WARN_PCT, type BfiPair, type ValidationSignatures } from './signatures';
import type { FlowBreakHint } from './flowDoubleMass';
import type { LowFlowCurves } from './lowFlow';
import type { NaturalisedCheck } from './naturalised';

/** A number in both runs; delta = b − a, null when either is missing (as compare.ts MetricDelta). */
export interface PlausibilityMetric {
	a: number | null;
	b: number | null;
	delta: number | null;
}

/** Check 1 in both runs at one site. */
export interface NaturalisedDelta {
	flowKindA: CalibrationFlowKind | null;
	flowKindB: CalibrationFlowKind | null;
	judgedYears: PlausibilityMetric;
	/** Failing water years (by the calendar year each starts in); null = the check did not run on that side. */
	failedA: number[] | null;
	failedB: number[] | null;
	/** Water years that fail in B but not in A, and that fail in A but pass in B (judged in both). */
	newlyFailing: number[];
	nowPassing: number[];
	/** No failing year; null = not checked on that side. */
	passedA: boolean | null;
	passedB: boolean | null;
}

/** Check 4's Q90 comparison in both runs at one site. */
export interface LowFlowDelta {
	flowKindA: CalibrationFlowKind | null;
	flowKindB: CalibrationFlowKind | null;
	days: PlausibilityMetric;
	observedQ90M3s: PlausibilityMetric;
	simulatedQ90M3s: PlausibilityMetric;
	/** Simulated ÷ observed Q90. */
	ratio: PlausibilityMetric;
	/** Within the factor (LOW_FLOW_WARN_FACTOR); null = no comparison on that side. */
	withinA: boolean | null;
	withinB: boolean | null;
}

/** Checks 1 and 4 at one site in both runs. */
export interface PlausibilitySiteDelta {
	/** The gauge's name in B, else A; the outlet's is 'Outlet'. */
	name: string;
	/** A's name when a matched gauge was renamed. */
	nameA: string | null;
	isOutlet: boolean;
	/** The gauge node (B's, else A's); null for the outlet. */
	nodeId: string | null;
	/** The site has checks in one run only (a gauge record added or removed, or an older run). */
	onlyIn: 'a' | 'b' | null;
	naturalised: NaturalisedDelta | null;
	lowFlow: LowFlowDelta | null;
}

/** Check 2 in both runs: days the outlet EWR was not met, good-rain against fallback-rain years. */
export interface RainSourceDelta {
	goodYears: PlausibilityMetric;
	fallbackYears: PlausibilityMetric;
	goodFractionNotMet: PlausibilityMetric;
	fallbackFractionNotMet: PlausibilityMetric;
	/** |fallback − good| is RAIN_SOURCE_WARN_DIFF or more (the run warning); null without both groups. */
	warnsA: boolean | null;
	warnsB: boolean | null;
	fallbackWaterYearsA: number[] | null;
	fallbackWaterYearsB: number[] | null;
}

/** One break of check 3 the model doesn't share (hint other than 'rain'). */
export interface FlowBreakLine {
	afterWaterYear: number;
	change: number;
	unexplained: number | null;
	hint: Exclude<FlowBreakHint, 'rain'>;
}

/** Check 3 in both runs. */
export interface FlowDoubleMassDelta {
	flowKindA: CalibrationFlowKind | null;
	flowKindB: CalibrationFlowKind | null;
	wholeSlope: PlausibilityMetric;
	/** Breaks the simulated outflow doesn't share; null = not checked on that side. */
	breaksA: FlowBreakLine[] | null;
	breaksB: FlowBreakLine[] | null;
}

/**
 * Why a run has no result for a check: 'older' = the run was made before
 * the engine that added it (the key is absent from its summary, or the run
 * has no checks at all); 'none' = the run made the check but had nothing to
 * make it on (no observed record, no rain).
 */
export type PlausibilityMissing = 'older' | 'none';

/** The recession diagnostics (engine ≥ 1.19.0) in both runs, at the outlet's calibration record. */
export interface RecessionDelta {
	flowKindA: CalibrationFlowKind | null;
	flowKindB: CalibrationFlowKind | null;
	missingA: PlausibilityMissing | null;
	missingB: PlausibilityMissing | null;
	/** Both runs have the diagnostics on the same kind of record: only then are the deltas given. */
	comparable: boolean;
	segments: PlausibilityMetric;
	/** Simulated ÷ observed recession rate at the reference flow. */
	rateRatio: PlausibilityMetric;
	/** Simulated − observed b. */
	bDiff: PlausibilityMetric;
	/** A fit through the observed and the simulated points; null = no diagnostics on that side. */
	observedFitA: boolean | null;
	observedFitB: boolean | null;
	simulatedFitA: boolean | null;
	simulatedFitB: boolean | null;
	/** Each run's stored verdict (RecessionCheck.agrees); null = not judged or no diagnostics. */
	agreesA: boolean | null;
	agreesB: boolean | null;
	/** RECESSION_MIN_SEGMENTS, for the "not judged" wording. */
	minSegments: number;
}

/** One filter's base-flow index in both runs. */
export interface BfiDelta {
	observed: PlausibilityMetric;
	simulated: PlausibilityMetric;
	/** Simulated − observed. */
	difference: PlausibilityMetric;
	/** |difference| ≤ BFI_WARN_DIFF; null = not computed on that side. */
	withinA: boolean | null;
	withinB: boolean | null;
}

/** The validation signatures (engine ≥ 1.55.0, CR-16) in both runs, each on its scored record. */
export interface SignaturesDelta {
	flowKindA: CalibrationFlowKind | null;
	flowKindB: CalibrationFlowKind | null;
	/** The scored gauge's node and name; null = the outlet (or no signatures on that side). */
	siteNodeIdA: string | null;
	siteNodeIdB: string | null;
	siteNameA: string | null;
	siteNameB: string | null;
	missingA: PlausibilityMissing | null;
	missingB: PlausibilityMissing | null;
	/** Both runs have signatures of the same record (kind and site): only then are the deltas given. */
	comparable: boolean;
	bfiDays: PlausibilityMetric;
	hughes: BfiDelta;
	eckhardt: BfiDelta;
	/** Computed on that side at all (the BFI needs a year of record in 30-day stretches); null = no signatures. */
	baseflowA: boolean | null;
	baseflowB: boolean | null;
	lowFlowDays: PlausibilityMetric;
	/** The Q70–Q95 slope bias, %. */
	slopeBiasPct: PlausibilityMetric;
	slopeWithinA: boolean | null;
	slopeWithinB: boolean | null;
	/** %BiasFLV. */
	lowVolumeBiasPct: PlausibilityMetric;
	lowVolumeWithinA: boolean | null;
	lowVolumeWithinB: boolean | null;
	lowFlowFdcA: boolean | null;
	lowFlowFdcB: boolean | null;
	/** The held-out recessions: the model's skill, the river's own fitted law's, and the segments. */
	holdoutModelSkill: PlausibilityMetric;
	holdoutLawSkill: PlausibilityMetric;
	holdoutSegments: PlausibilityMetric;
	/** Each run's stored verdict (RecessionHoldout.agrees); null = not judged or not computed. */
	holdoutAgreesA: boolean | null;
	holdoutAgreesB: boolean | null;
	recessionHoldoutA: boolean | null;
	recessionHoldoutB: boolean | null;
	/** The limits the within flags use (the engine's warning limits, provisional). */
	bfiLimit: number;
	lowFlowLimitPct: number;
	holdoutMinSegments: number;
}

export interface PlausibilityComparison {
	/** Checks 1 and 4 per site: the outlet first, then gauges matched by node id, then name. */
	sites: PlausibilitySiteDelta[];
	rainSource: RainSourceDelta | null;
	flowDoubleMass: FlowDoubleMassDelta | null;
	/** null when neither run has the diagnostics (both older than 1.19.0, or neither has a record and rain). */
	recession: RecessionDelta | null;
	/** null when neither run has signatures (both older than 1.55.0, or neither has an observed record). */
	signatures: SignaturesDelta | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const metric = (a: unknown, b: unknown): PlausibilityMetric => {
	const x = num(a);
	const y = num(b);
	return { a: x, b: y, delta: x !== null && y !== null ? y - x : null };
};

function naturalisedDelta(x: NaturalisedCheck | null | undefined, y: NaturalisedCheck | null | undefined): NaturalisedDelta | null {
	if (!x && !y) return null;
	const judged = (c: NaturalisedCheck) => new Set(c.years.filter((v) => v.judged).map((v) => v.waterYear));
	const fa = x ? new Set(x.failedYears) : null;
	const fb = y ? new Set(y.failedYears) : null;
	const both = x && y ? [...judged(x)].filter((w) => judged(y).has(w)) : [];
	return {
		flowKindA: x?.flowKind ?? null,
		flowKindB: y?.flowKind ?? null,
		judgedYears: metric(x?.judgedYears, y?.judgedYears),
		failedA: x ? [...x.failedYears] : null,
		failedB: y ? [...y.failedYears] : null,
		newlyFailing: both.filter((w) => fb!.has(w) && !fa!.has(w)),
		nowPassing: both.filter((w) => fa!.has(w) && !fb!.has(w)),
		passedA: x ? x.judgedYears > 0 && !x.failedYears.length : null,
		passedB: y ? y.judgedYears > 0 && !y.failedYears.length : null
	};
}

function lowFlowDelta(x: LowFlowCurves | null | undefined, y: LowFlowCurves | null | undefined): LowFlowDelta | null {
	const a = x?.comparison ?? null;
	const b = y?.comparison ?? null;
	if (!a && !b) return null;
	return {
		flowKindA: a?.flowKind ?? null,
		flowKindB: b?.flowKind ?? null,
		days: metric(a?.days, b?.days),
		observedQ90M3s: metric(a?.observedQ90M3s, b?.observedQ90M3s),
		simulatedQ90M3s: metric(a?.simulatedQ90M3s, b?.simulatedQ90M3s),
		ratio: metric(a?.ratio, b?.ratio),
		withinA: a ? a.withinFactor : null,
		withinB: b ? b.withinFactor : null
	};
}

interface Site {
	nodeId: string | null;
	name: string;
	naturalised: NaturalisedCheck | null;
	lowFlow: LowFlowCurves | null;
}

const sitesOf = (p: RunSummary['plausibility']): Site[] =>
	p
		? [
				{ nodeId: null, name: 'Outlet', naturalised: p.naturalised, lowFlow: p.lowFlow },
				...(p.gauges ?? []).map((g) => ({ nodeId: g.nodeId, name: g.name, naturalised: g.naturalised, lowFlow: g.lowFlow }))
			]
		: [];

const breaksOf = (p: RunSummary['plausibility']): FlowBreakLine[] | null =>
	p?.flowDoubleMass
		? p.flowDoubleMass.breaks.flatMap((b) => (b.hint === 'rain' ? [] : [{ afterWaterYear: b.afterWaterYear, change: b.change, unexplained: b.unexplained, hint: b.hint }]))
		: null;

const missingOf = <T>(p: RunSummary['plausibility'], v: T | null | undefined): PlausibilityMissing | null =>
	!p || v === undefined ? 'older' : v === null ? 'none' : null;

/** The metric with its delta dropped when the two sides aren't comparable. */
const gated = (m: PlausibilityMetric, ok: boolean): PlausibilityMetric => (ok ? m : { ...m, delta: null });

export function recessionDelta(a: RunSummary['plausibility'], b: RunSummary['plausibility']): RecessionDelta | null {
	const x: RecessionCheck | null = a?.recession ?? null;
	const y: RecessionCheck | null = b?.recession ?? null;
	if (!x && !y) return null;
	const comparable = !!x && !!y && x.flowKind === y.flowKind;
	return {
		flowKindA: x?.flowKind ?? null,
		flowKindB: y?.flowKind ?? null,
		missingA: missingOf(a, a?.recession),
		missingB: missingOf(b, b?.recession),
		comparable,
		segments: gated(metric(x?.segments.length, y?.segments.length), comparable),
		rateRatio: gated(metric(x?.rateRatio, y?.rateRatio), comparable),
		bDiff: gated(metric(x?.bDiff, y?.bDiff), comparable),
		observedFitA: x ? !!x.observed : null,
		observedFitB: y ? !!y.observed : null,
		simulatedFitA: x ? !!x.simulated : null,
		simulatedFitB: y ? !!y.simulated : null,
		agreesA: x?.agrees ?? null,
		agreesB: y?.agrees ?? null,
		minSegments: RECESSION_MIN_SEGMENTS
	};
}

const inLimit = (v: number | null | undefined, limit: number): boolean | null => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.abs(v) <= limit);

function bfiDelta(x: BfiPair | null | undefined, y: BfiPair | null | undefined, comparable: boolean): BfiDelta {
	return {
		observed: gated(metric(x?.observed, y?.observed), comparable),
		simulated: gated(metric(x?.simulated, y?.simulated), comparable),
		difference: gated(metric(x?.difference, y?.difference), comparable),
		withinA: inLimit(x?.difference, BFI_WARN_DIFF),
		withinB: inLimit(y?.difference, BFI_WARN_DIFF)
	};
}

export function signaturesDelta(a: RunSummary['plausibility'], b: RunSummary['plausibility']): SignaturesDelta | null {
	const x: ValidationSignatures | null = a?.signatures ?? null;
	const y: ValidationSignatures | null = b?.signatures ?? null;
	if (!x && !y) return null;
	// The same record: its kind and its site (the outlet, or the same gauge node).
	const comparable = !!x && !!y && x.flowKind === y.flowKind && (x.siteNodeId ?? null) === (y.siteNodeId ?? null);
	const g = (m: PlausibilityMetric) => gated(m, comparable);
	const fx = x?.lowFlowFdc ?? null;
	const fy = y?.lowFlowFdc ?? null;
	const hx = x?.recessionHoldout ?? null;
	const hy = y?.recessionHoldout ?? null;
	return {
		flowKindA: x?.flowKind ?? null,
		flowKindB: y?.flowKind ?? null,
		siteNodeIdA: x?.siteNodeId ?? null,
		siteNodeIdB: y?.siteNodeId ?? null,
		siteNameA: x?.siteName ?? null,
		siteNameB: y?.siteName ?? null,
		missingA: missingOf(a, a?.signatures),
		missingB: missingOf(b, b?.signatures),
		comparable,
		bfiDays: g(metric(x?.baseflow?.days, y?.baseflow?.days)),
		hughes: bfiDelta(x?.baseflow?.hughes, y?.baseflow?.hughes, comparable),
		eckhardt: bfiDelta(x?.baseflow?.eckhardt, y?.baseflow?.eckhardt, comparable),
		baseflowA: x ? !!x.baseflow : null,
		baseflowB: y ? !!y.baseflow : null,
		lowFlowDays: g(metric(fx?.days, fy?.days)),
		slopeBiasPct: g(metric(fx?.slopeBiasPct, fy?.slopeBiasPct)),
		slopeWithinA: inLimit(fx?.slopeBiasPct, FDC_LOW_WARN_PCT),
		slopeWithinB: inLimit(fy?.slopeBiasPct, FDC_LOW_WARN_PCT),
		lowVolumeBiasPct: g(metric(fx?.lowVolumeBiasPct, fy?.lowVolumeBiasPct)),
		lowVolumeWithinA: inLimit(fx?.lowVolumeBiasPct, FDC_LOW_WARN_PCT),
		lowVolumeWithinB: inLimit(fy?.lowVolumeBiasPct, FDC_LOW_WARN_PCT),
		lowFlowFdcA: x ? !!fx : null,
		lowFlowFdcB: y ? !!fy : null,
		holdoutModelSkill: g(metric(hx?.modelSkill, hy?.modelSkill)),
		holdoutLawSkill: g(metric(hx?.lawSkill, hy?.lawSkill)),
		holdoutSegments: g(metric(hx?.segments, hy?.segments)),
		holdoutAgreesA: hx?.agrees ?? null,
		holdoutAgreesB: hy?.agrees ?? null,
		recessionHoldoutA: x ? !!hx : null,
		recessionHoldoutB: y ? !!hy : null,
		bfiLimit: BFI_WARN_DIFF,
		lowFlowLimitPct: FDC_LOW_WARN_PCT,
		holdoutMinSegments: RECESSION_MIN_SEGMENTS
	};
}

/** The two runs' plausibility checks side by side; null when neither run has any (both before engine 0.25.0). */
export function comparePlausibility(a: RunSummary['plausibility'], b: RunSummary['plausibility']): PlausibilityComparison | null {
	if (!a && !b) return null;
	const sa = sitesOf(a);
	const sb = sitesOf(b);
	// The outlet with the outlet; a gauge by node id, then by name (a gauge deleted and re-added).
	const pairs: [Site | null, Site | null][] = [];
	const leftB = new Set(sb);
	const leftA: Site[] = [];
	for (const x of sa) {
		const y = sb.find((s) => leftB.has(s) && s.nodeId === x.nodeId);
		if (y) {
			pairs.push([x, y]);
			leftB.delete(y);
		} else leftA.push(x);
	}
	for (const x of leftA) {
		const y = [...leftB].find((s) => s.nodeId !== null && x.nodeId !== null && s.name.trim().toLowerCase() === x.name.trim().toLowerCase());
		if (y) leftB.delete(y);
		pairs.push([x, y ?? null]);
	}
	for (const y of leftB) pairs.push([null, y]);
	const sites = pairs
		.map(([x, y]): PlausibilitySiteDelta => {
			const s = (y ?? x)!;
			return {
				name: s.name,
				nameA: x && y && x.name !== y.name ? x.name : null,
				isOutlet: s.nodeId === null,
				nodeId: s.nodeId,
				onlyIn: x && y ? null : x ? 'a' : 'b',
				naturalised: naturalisedDelta(x?.naturalised, y?.naturalised),
				lowFlow: lowFlowDelta(x?.lowFlow, y?.lowFlow)
			};
		})
		// A site neither run could check (no record there on either side) says nothing.
		.filter((s) => s.naturalised || s.lowFlow)
		// The outlet first, then gauges by name.
		.sort((p, q) => Number(q.isOutlet) - Number(p.isOutlet) || (p.name < q.name ? -1 : p.name > q.name ? 1 : 0));

	const ra = a?.rainSource ?? null;
	const rb = b?.rainSource ?? null;
	const warns = (r: typeof ra) =>
		r && r.good.fractionNotMet !== null && r.fallback.fractionNotMet !== null ? Math.abs(r.fallback.fractionNotMet - r.good.fractionNotMet) >= RAIN_SOURCE_WARN_DIFF : null;
	const fallbackYears = (r: typeof ra) => (r ? r.years.filter((y) => y.fallback).map((y) => y.waterYear) : null);
	const rainSource: RainSourceDelta | null =
		ra || rb
			? {
					goodYears: metric(ra?.good.years, rb?.good.years),
					fallbackYears: metric(ra?.fallback.years, rb?.fallback.years),
					goodFractionNotMet: metric(ra?.good.fractionNotMet, rb?.good.fractionNotMet),
					fallbackFractionNotMet: metric(ra?.fallback.fractionNotMet, rb?.fallback.fractionNotMet),
					warnsA: warns(ra),
					warnsB: warns(rb),
					fallbackWaterYearsA: fallbackYears(ra),
					fallbackWaterYearsB: fallbackYears(rb)
				}
			: null;

	const da = a?.flowDoubleMass ?? null;
	const db = b?.flowDoubleMass ?? null;
	const flowDoubleMass: FlowDoubleMassDelta | null =
		da || db
			? { flowKindA: da?.flowKind ?? null, flowKindB: db?.flowKind ?? null, wholeSlope: metric(da?.wholeSlope, db?.wholeSlope), breaksA: breaksOf(a), breaksB: breaksOf(b) }
			: null;

	return { sites, rainSource, flowDoubleMass, recession: recessionDelta(a, b), signatures: signaturesDelta(a, b) };
}
