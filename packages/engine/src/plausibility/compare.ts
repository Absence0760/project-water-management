// The plausibility checks of two runs side by side (engine ≥ 1.4.0 compares
// them; docs/run-comparison.md § Plausibility checks). Per check, each run's
// own result, never re-computed: the water years that fail check 1 (natural
// flow ≥ observed + abstraction) and the Q90 ratio of check 4 (dry-season low
// flows), with pass or fail, at the outlet and at each gauge node with a
// record of its own; the good-rain and fallback-rain split of check 2; and
// the breaks of check 3 the model doesn't share. A run saved before engine
// 0.25.0 has no checks: its side is null.
import type { CalibrationFlowKind, RunSummary } from '../project';
import { RAIN_SOURCE_WARN_DIFF } from './rainSource';
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

export interface PlausibilityComparison {
	/** Checks 1 and 4 per site: the outlet first, then gauges matched by node id, then name. */
	sites: PlausibilitySiteDelta[];
	rainSource: RainSourceDelta | null;
	flowDoubleMass: FlowDoubleMassDelta | null;
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

	return { sites, rainSource, flowDoubleMass };
}
