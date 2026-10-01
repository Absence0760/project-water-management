// Development that changes during a run (engine ≥ 1.30.0, issue #67,
// docs/model.md §2.7g): a dam losing capacity to sediment, a dam in service
// from a date, and abstraction from a date. Each is off unless set, so a
// model without them runs as before.
//
//   capacity on day t = the entered capacity × k(t), with
//   k(t) = MAX(0, 1 − rate × (t − survey date) ÷ 365.25) × [t ≥ in service from]
//
// The rate (damSedimentPctPerYear, a share of the surveyed capacity a year)
// runs linearly both ways from the survey date: before it the dam held
// more, after it less, never below empty. Dead storage, the survey curve's
// volumes and the dam-level triggers (the supply rule's, a drought
// borehole's, a transfer's reserve) are shares of the capacity and scale
// with it; the full-supply area doesn't. Before the in-service date the unit
// has no dam: what is routed to it passes, as on a unit without one. Before
// the abstraction date (abstractionFrom) the unit takes nothing: its crops',
// its demand objects' and a water user's own demand are 0.
//
// Pure: runModel's plan (../run.ts buildNetworkPlan) reads these, the
// simulation (./simulate.ts) scales by k, the self-checks read the run's
// `dam_capacity` column.
import { fromEpochDay, toEpochDay } from '../calendar';
import type { NetworkNode } from '../project';

/** Days per year for the sediment rate (a mean year, leap days included). */
export const SEDIMENT_YEAR_DAYS = 365.25;
/** The most capacity a dam may lose to sediment a year (a share of the surveyed capacity): 20 %. */
export const DAM_SEDIMENT_MAX_PER_YEAR = 0.2;

/** A dam larger than this × its surveyed capacity at some point of a run (sediment run back from the survey) is warned about. */
export const DAM_SEDIMENT_WARN_FACTOR = 1.25;

/** The run series that carries a dam's capacity on each day, when it changes over the run. */
export const DAM_CAPACITY_SERIES = { key: 'dam_capacity', label: 'Dam capacity on the day (sediment, in service from)', unit: 'm³' } as const;

const isIso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && fromEpochDay(toEpochDay(v)) === v;

/** A problem with a node's development fields, for the model rules and the API; null when there is none. */
export function developmentProblem(n: Pick<NetworkNode, 'kind' | 'damSurveyDate' | 'damSedimentPctPerYear' | 'damInServiceFrom' | 'abstractionFrom'>): string | null {
	const r = n.damSedimentPctPerYear;
	if (r !== null && r !== undefined && !(typeof r === 'number' && Number.isFinite(r) && r >= 0 && r <= DAM_SEDIMENT_MAX_PER_YEAR))
		return `the sediment rate must be 0 to ${DAM_SEDIMENT_MAX_PER_YEAR * 100} % of the capacity a year`;
	for (const [k, label] of [
		['damSurveyDate', 'survey date'],
		['damInServiceFrom', 'in-service date'],
		['abstractionFrom', 'abstraction start date']
	] as const) {
		const v = n[k];
		if (v !== null && v !== undefined && !isIso(v)) return `the ${label} must be a date (YYYY-MM-DD)`;
	}
	if (typeof r === 'number' && r > 0 && !n.damSurveyDate) return 'a sediment rate needs the date the capacity was surveyed';
	if (n.kind !== 'farm' && (n.damSurveyDate || (typeof r === 'number' && r > 0) || n.damInServiceFrom)) return 'only a farm has a dam';
	if (n.kind === 'gauge' && n.abstractionFrom) return 'a gauge takes no water';
	return null;
}

/**
 * A farm dam's capacity factor k on epoch day `day` (1 for a dam whose
 * capacity doesn't change, and for a node whose fields don't read; 0 for no
 * dam). Pure in the node, so a view can read a stored run's dam level
 * against the day's capacity without the run: storage ÷ damCapacityOn.
 */
export function damCapacityFactor(n: Pick<NetworkNode, 'kind' | 'damCapacityM3' | 'damSurveyDate' | 'damSedimentPctPerYear' | 'damInServiceFrom' | 'abstractionFrom'>, day: number): number {
	if (n.kind !== 'farm' || !(n.damCapacityM3 > 0)) return 0;
	if (developmentProblem(n)) return 1;
	if (n.damInServiceFrom && day < toEpochDay(n.damInServiceFrom)) return 0;
	const rate = n.damSedimentPctPerYear ?? 0;
	if (!(rate > 0) || !n.damSurveyDate) return 1;
	return Math.max(0, 1 - (rate * (day - toEpochDay(n.damSurveyDate))) / SEDIMENT_YEAR_DAYS);
}

/** A farm dam's capacity (m³) on epoch day `day`: the entered capacity × damCapacityFactor. */
export function damCapacityOn(n: Pick<NetworkNode, 'kind' | 'damCapacityM3' | 'damSurveyDate' | 'damSedimentPctPerYear' | 'damInServiceFrom' | 'abstractionFrom'>, day: number): number {
	const k = damCapacityFactor(n, day);
	return k === 1 ? n.damCapacityM3 : n.damCapacityM3 * k;
}

/**
 * Whether a farm's dam is there (capacity factor above 0) on every day from
 * `start` to `end` (epoch days, inclusive), and on any. k falls with sediment
 * and steps up on the in-service day, so its least is on the first or last
 * day and, when the dam comes into service inside the span, its most is on
 * that day: three reads, not one per day. Without a span, the entered
 * capacity alone decides (there throughout, or never). The run warning about
 * a dam-less farm (./supply.ts) and the evidence report's river checks
 * (../evidence/riverWorks.ts) both judge "no dam" by it.
 */
export function damPresence(
	n: Pick<NetworkNode, 'kind' | 'damCapacityM3' | 'damSurveyDate' | 'damSedimentPctPerYear' | 'damInServiceFrom' | 'abstractionFrom'>,
	span?: { start: number; end: number }
): { always: boolean; ever: boolean } {
	if (n.kind !== 'farm' || !(n.damCapacityM3 > 0)) return { always: false, ever: false };
	if (!span) return { always: true, ever: true };
	const days = [span.start, span.end];
	if (n.damInServiceFrom && !developmentProblem(n)) {
		const d = toEpochDay(n.damInServiceFrom);
		if (d > span.start && d <= span.end) days.push(d);
	}
	const k = days.map((d) => damCapacityFactor(n, d));
	return { always: k[0]! > 0 && k[1]! > 0, ever: k.some((x) => x > 0) };
}

/**
 * The day-by-day capacity factor k of a farm's dam over the run (`start`,
 * epoch day, for `days` days); undefined when it is 1 throughout (no rate,
 * no in-service date inside or after the run's start), so an unchanged dam
 * carries nothing. A field the run can't use is skipped with a warning.
 */
export function capacityScaleOf(n: NetworkNode, start: number, days: number, warnings: string[]): Float64Array | undefined {
	if (n.kind !== 'farm' || !(n.damCapacityM3 > 0)) return undefined;
	const bad = developmentProblem(n);
	if (bad) {
		warnings.push(`farm "${n.name}": ${bad}; its dam runs at its entered capacity throughout`);
		return undefined;
	}
	const rate = n.damSedimentPctPerYear ?? 0;
	const from = n.damInServiceFrom ? toEpochDay(n.damInServiceFrom) - start : -Infinity;
	if (!(rate > 0 && n.damSurveyDate) && !(from > 0)) return undefined;
	const k = new Float64Array(days);
	for (let t = 0; t < days; t++) k[t] = damCapacityFactor(n, start + t);
	// Linear back from a recent survey over a long record makes the dam far larger than surveyed, at the
	// same full-supply area: said. Provisional decision 2026-10-01 (engine-audit.md S1): the rate runs back to the in-service
	// date, which the modeller is asked for here, and no further cap is applied.
	const most = k.reduce((a, v) => Math.max(a, v), 0);
	if (most > DAM_SEDIMENT_WARN_FACTOR)
		warnings.push(
			`farm "${n.name}": with ${(rate * 100).toFixed(1)} % a year lost to sediment since ${n.damSurveyDate}, the dam holds up to ${most.toFixed(2)} × its surveyed capacity early in the run; check the rate and the survey date${n.damInServiceFrom ? '' : ', and enter the date it came into service (before it the dam holds nothing, so the rate runs back only that far)'}`
		);
	return k;
}

/**
 * The first run day a unit abstracts on (abstractionFrom): 0 when unset or
 * on or before the run's first day, `days` when after its last. A date that
 * doesn't read is ignored with a warning.
 */
export function abstractionStartDay(n: NetworkNode, start: number, days: number, warnings: string[]): number {
	const v = n.abstractionFrom;
	if (v === null || v === undefined) return 0;
	if (!isIso(v) || n.kind === 'gauge') {
		warnings.push(`${n.kind} "${n.name}": abstraction start ${JSON.stringify(v)} ignored (${n.kind === 'gauge' ? 'a gauge takes no water' : 'not a date, YYYY-MM-DD'})`);
		return 0;
	}
	return Math.min(Math.max(toEpochDay(v) - start, 0), days);
}
