// EWR rule tables (engine ≥ 0.21.0, hydrologist Q6): the Ecological
// Reserve's assurance rules for an EWR site, entered by the user from a
// Reserve determination or its gazette notice. Types, validation (shared by
// the backend's zod schema, the Settings form and the engine) and the
// resolver the run uses. The assessment itself is ./assurance.ts. Pure: no I/O.
//
// A South African Reserve determination (the Desktop Reserve Model, Hughes &
// Hannart 2003; its revised form, Hughes et al. 2014) gives its flow
// requirement as a set of monthly flows at fixed assurance levels, "% points"
// (10 %, 20 % … 90 %, 99 %): the EWR flow that should be equalled or exceeded
// that share of the time. Low % points are the wet-condition flows, high ones
// the drought flows. The gazette pairs each table with the natural flow
// duration curve at the same points, so a month's natural flow picks the
// point it sits at, and the EWR is read at that point (Hughes & Münster 2000;
// Pollard et al. 2011). docs/model.md §2.9c has the method and the sources.
import { regroup } from '../format';

/** Units a rule table is entered in: Mm³ per month, or the month's mean flow in m³/s. */
export const EWR_RULE_UNITS = ['mcm', 'm3s'] as const;
export type EwrRuleUnit = (typeof EWR_RULE_UNITS)[number];

/**
 * Where the natural-flow condition (the percentile) of a month comes from:
 * 'run' ranks the month's simulated natural flow at the site among the same
 * calendar month in every complete year of the run; 'table' places it on the
 * natural flow duration curve entered with the rule table (the gazette's).
 */
export const EWR_NATURAL_SOURCES = ['run', 'table'] as const;
export type EwrNaturalSource = (typeof EWR_NATURAL_SOURCES)[number];

/**
 * Which requirement the table is (a label: the method is the same): the total
 * flow (maintenance low flows plus high flows), or low flows only. Monthly
 * volumes judge low flows best; a total table in a wet month also counts the
 * high flows (Pollard et al. 2011).
 */
export const EWR_RULE_COMPONENTS = ['total', 'lowFlow'] as const;
export type EwrRuleComponent = (typeof EWR_RULE_COMPONENTS)[number];

/**
 * What kind of source a table is (engine ≥ 1.5.0, WP-3.7): a gazetted
 * Reserve, a desktop estimate (the Desktop Reserve Model or similar, low
 * confidence), or something else. Optional: a table without it is shown
 * unlabelled, as before. A label for the reader; the method is the same.
 */
export const EWR_RULE_SOURCE_KINDS = ['gazetted', 'desktop', 'other'] as const;
export type EwrRuleSourceKind = (typeof EWR_RULE_SOURCE_KINDS)[number];

const SOURCE_KIND_LINE: Record<EwrRuleSourceKind, string> = {
	gazetted: 'Gazetted Reserve',
	desktop: 'Desktop estimate, low confidence',
	other: 'Other source, confidence not stated'
};

/** The confidence line for a table's source kind; null when the kind isn't set (or isn't one). */
export function ewrSourceConfidence(kind: EwrRuleSourceKind | null | undefined): string | null {
	return kind && Object.hasOwn(SOURCE_KIND_LINE, kind) ? SOURCE_KIND_LINE[kind] : null;
}

/**
 * The Reserve's recommended ecological category at the site (REC, ER9,
 * issue #71): one class A (natural) … F (critically modified), or a band of
 * two neighbouring classes like "B/C", as a Reserve determination states it
 * (Kleynhans & Louw 2007). Metadata for the reader: no result depends on it.
 */
export const EWR_CATEGORY_PATTERN = /^[A-F](\/[A-F])?$/;

/** Whether a REC is one class A … F or a band of two neighbouring ones ("B/C"). */
export function isEwrCategory(v: unknown): v is string {
	if (typeof v !== 'string' || !EWR_CATEGORY_PATTERN.test(v)) return false;
	return v.length === 1 || v.charCodeAt(2) === v.charCodeAt(0) + 1;
}

/**
 * What the daily EWR charge and curtailment follow at an EWR site
 * (settings.ewrChargeSource, engine ≥ 1.3.0, issue #64; docs/model.md
 * §2.9c): 'pragmatic' (the default, every earlier run) = the daily pragmatic
 * EWR; 'ruleTable' = at a site with a Reserve rule table, the month's
 * requirement from the table spread over its days (the `ewr_rule` series),
 * the pragmatic EWR on days outside a complete month and at sites without a
 * table. The water account's EWR required vs met follows the same choice.
 * Pending the hydrologist and the assessor (plan.md question 17).
 */
export const EWR_CHARGE_SOURCES = ['pragmatic', 'ruleTable'] as const;
export type EwrChargeSource = (typeof EWR_CHARGE_SOURCES)[number];

/**
 * What a month's flow is judged by against a low-flow requirement (a
 * `lowFlow` table, or the low-flow grid of a total table)
 * (settings.lowFlowMeasure, engine ≥ 1.3.0, issue #64; docs/model.md §2.9d):
 * 'total' (the default, every earlier run) = the month's total volume;
 * 'baseflow' = the month's base flow, from a recursive digital filter
 * (./baseflow.ts), so a flood month can't pass its low flows on the flood.
 * Pending the hydrologist (plan.md question 17).
 */
export const LOW_FLOW_MEASURES = ['total', 'baseflow'] as const;
export type LowFlowMeasure = (typeof LOW_FLOW_MEASURES)[number];

/** The % points DRM and gazetted rule tables use. */
export const DEFAULT_ASSURANCE_POINTS: readonly number[] = [10, 20, 30, 40, 50, 60, 70, 80, 90, 99];

export const EWR_RULE_POINTS_MIN = 2;
export const EWR_RULE_POINTS_MAX = 20;
/** At most one table per EWR site, and at most this many. */
export const EWR_RULE_TABLES_MAX = 20;
/** Largest value accepted in a table (Mm³/month or m³/s). */
export const EWR_RULE_VALUE_MAX = 1e6;
export const EWR_RULE_SCALE_MAX = 1000;
export const EWR_RULE_SOURCE_MAX = 500;
/** At most this many high-flow (freshet / flood) components per table (engine ≥ 0.33.0). */
export const EWR_HIGH_FLOWS_MAX = 12;
export const EWR_HIGH_FLOW_LABEL_MAX = 100;
/** Longest event duration a high-flow component may ask for, days. */
export const EWR_HIGH_FLOW_DURATION_MAX = 90;
/** Most events a component may ask for in one water year. */
export const EWR_HIGH_FLOW_PER_YEAR_MAX = 12;

/**
 * A high-flow component of a Reserve (engine ≥ 0.33.0, WP-3.7, docs/model.md
 * §2.9d): a freshet or flood the river should carry, `perYear` times a water
 * year, each a hydrograph that reaches `peakM3s` (× the table's scale) in
 * one of `months` and lasts `durationDays` from rise to recession (engine
 * ≥ 1.9.0: counted as a run at or above half the peak for at least half the
 * duration, `countHighFlowEvents` in assurance.ts). The requirement in a
 * water year is capped by what the site's natural flow did that year: a flood
 * that would not have happened naturally is not asked of the river.
 */
export interface EwrHighFlowEvent {
	/** "Class II freshet", "1:2-year flood". */
	label: string;
	/** Calendar months (1–12) an event may peak in (its first day at the peak), each once. */
	months: number[];
	/** Daily mean flow the event reaches, m³/s (> 0). */
	peakM3s: number;
	/** The event's duration from rise to recession, days, 1 … 90 (not days held at the peak; §2.9d). */
	durationDays: number;
	/** Events required in a water year, 1 … 12. */
	perYear: number;
}

/** One EWR site's assurance rules. Rows are water-year months (Oct … Sep), columns the % points. */
export interface EwrRuleTable {
	/** The EWR site: null = the catchment outlet, else a gauge node's id. */
	siteNodeId: string | null;
	/** Where the table comes from (study, gazette notice, table number). Required. */
	source: string;
	/** What kind of source it is (engine ≥ 1.5.0): gazetted, desktop or other. Absent / null = not stated. */
	sourceKind?: EwrRuleSourceKind | null;
	/**
	 * The recommended ecological category (REC) the determination sets at the
	 * site: "A" … "F", or a band of two neighbouring ones ("B/C")
	 * (EWR_CATEGORY_PATTERN, isEwrCategory). Absent / null = not given. A
	 * label only: no result depends on it (ER9).
	 */
	category?: string | null;
	component: EwrRuleComponent;
	unit: EwrRuleUnit;
	/** Exceedance % points, rising: 0 < p ≤ 100. */
	points: number[];
	/** EWR flow at each point, 12 rows × points.length, ≥ 0. */
	ewr: number[][];
	naturalSource: EwrNaturalSource;
	/** Natural flow at each point, same shape; required when naturalSource = 'table', else null. */
	natural: number[][] | null;
	/**
	 * Multiplies every table value (EWR and natural), for a table given for a
	 * larger or smaller catchment than the site: e.g. the site's area ÷ the
	 * table's. Default 1.
	 */
	scale: number;
	/**
	 * The low-flow part of a total-flow table (engine ≥ 0.33.0, WP-3.7): the
	 * Desktop Reserve Model's low-flow assurance rules, maintenance low flows
	 * at the wetter points down to the drought low flow at the driest, same
	 * shape and unit as `ewr`, read at the same natural percentile. Only on a
	 * `total` table (a `lowFlow` table is the low flows already). Absent or
	 * null = none; the high-flow part of a month is then not split out.
	 */
	lowFlow?: number[][] | null;
	/** Freshet and flood components (engine ≥ 0.33.0). Absent = none. */
	highFlows?: EwrHighFlowEvent[];
	/**
	 * The natural mean annual runoff the determination gives at the site, Mm³
	 * a year (engine ≥ 1.11.0, issue #46), × `scale` like every table value.
	 * Optional: absent / null = not recorded. With it, the run compares its own
	 * natural MAR at the site and, when the percentile comes from the run,
	 * warns beyond EWR_NATURAL_MAR_TOLERANCE (./assurance.ts; model.md §2.9c).
	 */
	naturalMarMcm?: number | null;
}

export interface EwrRuleIssue {
	/** Field the problem is on (a key of EwrRuleTable). */
	field: string;
	message: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const WY_MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];

/** A new, empty table at the default points (the Settings form's starting point). */
export function blankEwrRuleTable(siteNodeId: string | null = null): EwrRuleTable {
	const points = [...DEFAULT_ASSURANCE_POINTS];
	return {
		siteNodeId,
		source: '',
		component: 'total',
		unit: 'mcm',
		points,
		ewr: Array.from({ length: 12 }, () => points.map(() => 0)),
		naturalSource: 'run',
		natural: null,
		scale: 1,
		lowFlow: null,
		highFlows: []
	};
}

function gridIssue(grid: unknown, cols: number, label: 'EWR' | 'natural flow' | 'low-flow'): string | null {
	if (!Array.isArray(grid) || grid.length !== 12) return `Enter 12 rows of ${label} values (Oct … Sep).`;
	for (let m = 0; m < 12; m++) {
		const row = grid[m];
		if (!Array.isArray(row) || row.length !== cols) return `Each ${label} row needs one value per % point (${WY_MONTHS[m]} has ${Array.isArray(row) ? row.length : 0} of ${cols}).`;
		if (!row.every((v) => isNum(v) && v >= 0 && v <= EWR_RULE_VALUE_MAX)) {
			return `${label === 'EWR' ? 'EWR' : label === 'low-flow' ? 'Low-flow' : 'Natural flow'} values must be numbers from 0 to ${regroup(EWR_RULE_VALUE_MAX.toLocaleString('en-US'))} (${WY_MONTHS[m]} has one that isn't).`;
		}
	}
	return null;
}

/**
 * Problems that make a table unusable (they block Save and the engine drops
 * the table): the source, the points (2–20, rising, in (0, 100]), the EWR
 * grid and, when the natural source is the table, the natural grid (12 rows
 * × points, 0 … 1e6), and the scale.
 */
export function ewrRuleTableIssues(t: EwrRuleTable): EwrRuleIssue[] {
	const out: EwrRuleIssue[] = [];
	if (typeof t.source !== 'string' || !t.source.trim()) out.push({ field: 'source', message: 'Say where the table comes from (Reserve determination, gazette notice, table).' });
	else if (t.source.length > EWR_RULE_SOURCE_MAX) out.push({ field: 'source', message: `Keep the source under ${EWR_RULE_SOURCE_MAX} characters.` });
	if (t.sourceKind !== undefined && t.sourceKind !== null && !(EWR_RULE_SOURCE_KINDS as readonly unknown[]).includes(t.sourceKind)) {
		out.push({ field: 'sourceKind', message: 'Pick what kind of source it is: gazetted Reserve, desktop estimate or other.' });
	}
	if (t.category !== undefined && t.category !== null && !isEwrCategory(t.category)) {
		out.push({ field: 'category', message: 'The REC is one category A to F, or a band of two neighbouring ones such as B/C, or left blank.' });
	}
	if (!(EWR_RULE_UNITS as readonly unknown[]).includes(t.unit)) out.push({ field: 'unit', message: 'Pick the unit the table is in.' });
	if (!(EWR_RULE_COMPONENTS as readonly unknown[]).includes(t.component)) out.push({ field: 'component', message: 'Pick what the table covers.' });
	if (!(EWR_NATURAL_SOURCES as readonly unknown[]).includes(t.naturalSource)) out.push({ field: 'naturalSource', message: 'Pick how the natural-flow percentile is found.' });
	if (!(isNum(t.scale) && t.scale > 0 && t.scale <= EWR_RULE_SCALE_MAX)) out.push({ field: 'scale', message: `The scale must be above 0 and at most ${EWR_RULE_SCALE_MAX}.` });
	const p = Array.isArray(t.points) ? t.points : [];
	if (p.length < EWR_RULE_POINTS_MIN || p.length > EWR_RULE_POINTS_MAX) {
		out.push({ field: 'points', message: `Enter ${EWR_RULE_POINTS_MIN} to ${EWR_RULE_POINTS_MAX} % points.` });
		return out;
	}
	if (!p.every((v) => isNum(v) && v > 0 && v <= 100)) out.push({ field: 'points', message: 'Each % point must be above 0 and at most 100.' });
	else if (!p.every((v, i) => i === 0 || v > p[i - 1]!)) out.push({ field: 'points', message: 'The % points must rise from left to right, each once.' });
	const e = gridIssue(t.ewr, p.length, 'EWR');
	if (e) out.push({ field: 'ewr', message: e });
	if (t.naturalSource === 'table') {
		const n = t.natural === null || t.natural === undefined ? 'Enter the natural flow at each point, or find the percentile from the run.' : gridIssue(t.natural, p.length, 'natural flow');
		if (n) out.push({ field: 'natural', message: n });
	} else if (t.natural !== null && t.natural !== undefined) {
		const n = gridIssue(t.natural, p.length, 'natural flow');
		if (n) out.push({ field: 'natural', message: n });
	}
	if (t.lowFlow !== null && t.lowFlow !== undefined) {
		if (t.component !== 'total') out.push({ field: 'lowFlow', message: 'A low-flow table already is the low flows: clear the separate low-flow values, or say the table covers the total flow.' });
		else {
			const l = gridIssue(t.lowFlow, p.length, 'low-flow');
			if (l) out.push({ field: 'lowFlow', message: l });
		}
	}
	const h = highFlowsIssue(t.highFlows);
	if (h) out.push({ field: 'highFlows', message: h });
	if (t.naturalMarMcm !== undefined && t.naturalMarMcm !== null && !(isNum(t.naturalMarMcm) && t.naturalMarMcm > 0 && t.naturalMarMcm <= EWR_RULE_VALUE_MAX)) {
		out.push({ field: 'naturalMarMcm', message: `The natural MAR must be above 0 and at most ${regroup(EWR_RULE_VALUE_MAX.toLocaleString('en-US'))} Mm³ a year, or left blank.` });
	}
	return out;
}

const isInt = (v: unknown, lo: number, hi: number): v is number => isNum(v) && Number.isInteger(v) && v >= lo && v <= hi;

/** Why a table's high-flow components aren't usable, or null (absent is fine). */
export function highFlowsIssue(list: unknown): string | null {
	if (list === undefined) return null;
	if (!Array.isArray(list)) return 'The high-flow components must be a list.';
	if (list.length > EWR_HIGH_FLOWS_MAX) return `At most ${EWR_HIGH_FLOWS_MAX} high-flow components per table.`;
	for (const [i, e] of list.entries()) {
		const n = `High flow ${i + 1}`;
		if (!isObj(e)) return `${n} isn't a component.`;
		if (typeof e.label !== 'string' || !e.label.trim()) return `${n}: name it (e.g. “Class II freshet”).`;
		if (e.label.length > EWR_HIGH_FLOW_LABEL_MAX) return `${n}: keep the name under ${EWR_HIGH_FLOW_LABEL_MAX} characters.`;
		const months = e.months;
		if (!Array.isArray(months) || !months.length || !months.every((m) => isInt(m, 1, 12)) || new Set(months).size !== months.length) {
			return `${n}: pick the months it may peak in (each once).`;
		}
		if (!(isNum(e.peakM3s) && e.peakM3s > 0 && e.peakM3s <= EWR_RULE_VALUE_MAX)) return `${n}: the peak must be above 0 and at most ${regroup(EWR_RULE_VALUE_MAX.toLocaleString('en-US'))} m³/s.`;
		if (!isInt(e.durationDays, 1, EWR_HIGH_FLOW_DURATION_MAX)) return `${n}: the duration must be a whole number of days from 1 to ${EWR_HIGH_FLOW_DURATION_MAX}.`;
		if (!isInt(e.perYear, 1, EWR_HIGH_FLOW_PER_YEAR_MAX)) return `${n}: the events per year must be a whole number from 1 to ${EWR_HIGH_FLOW_PER_YEAR_MAX}.`;
		if (e.durationDays * e.perYear > 366) return `${n}: ${e.perYear} events of ${e.durationDays} days don't fit in a year.`;
	}
	return null;
}

/** Problems with the list: at most EWR_RULE_TABLES_MAX, one table per site. */
export function ewrRuleListIssues(list: readonly Pick<EwrRuleTable, 'siteNodeId'>[]): string | null {
	if (list.length > EWR_RULE_TABLES_MAX) return `At most ${EWR_RULE_TABLES_MAX} rule tables.`;
	const seen = new Set<string>();
	for (const t of list) {
		const k = t.siteNodeId ?? '(outlet)';
		if (seen.has(k)) return 'Each EWR site can have one rule table.';
		seen.add(k);
	}
	return null;
}

/**
 * Plausibility notes on a valid table: they don't block Save (a gazetted
 * table is entered as published), but the run repeats them as warnings.
 * - An EWR row that rises with the % point: a drought flow above a
 *   wetter-condition one.
 * - A natural row (table source) that rises: the engine uses its running
 *   minimum (a duration curve can't rise).
 * - An EWR above the natural flow (its running minimum) at the same point
 *   (table source): the
 *   Reserve asks for more than the river would carry, so even natural flow
 *   fails there (typically a table built on a larger natural MAR than the
 *   site's).
 */
export function ewrRuleTableNotes(t: EwrRuleTable): string[] {
	const out: string[] = [];
	const rising = (rows: number[][]) => rows.flatMap((row, m) => (row.some((v, i) => i > 0 && v > row[i - 1]! * (1 + 1e-9)) ? [WY_MONTHS[m]!] : []));
	const er = rising(t.ewr);
	if (er.length) out.push(`the EWR rises with the % point in ${er.join(', ')} (a drought flow above a wetter one); check the table`);
	if (t.lowFlow) {
		const lr = rising(t.lowFlow);
		if (lr.length) out.push(`the low flows rise with the % point in ${lr.join(', ')} (a drought flow above a maintenance one); check the table`);
		const above: string[] = [];
		t.lowFlow.forEach((row, m) => row.forEach((v, i) => {
			if (v > t.ewr[m]![i]! * (1 + 1e-9)) above.push(`${WY_MONTHS[m]} ${t.points[i]} %`);
		}));
		if (above.length) {
			out.push(
				`the low flows are above the total flow at ${above.length} point${above.length === 1 ? '' : 's'} (${above.slice(0, 4).join(', ')}${above.length > 4 ? ', …' : ''}), so the high flows there count as 0`
			);
		}
	}
	if (t.naturalSource === 'table' && t.natural) {
		const nr = rising(t.natural);
		if (nr.length) out.push(`the natural flow rises with the % point in ${nr.join(', ')}; the run uses each row's running minimum`);
		// Against the curve the run uses: each natural row's running minimum.
		const above: string[] = [];
		t.ewr.forEach((row, m) => {
			let min = Infinity;
			row.forEach((v, i) => {
				min = Math.min(min, t.natural![m]![i]!);
				if (v > min * (1 + 1e-9)) above.push(`${WY_MONTHS[m]} ${t.points[i]} %`);
			});
		});
		if (above.length) {
			out.push(
				`the EWR is above the natural flow at ${above.length} point${above.length === 1 ? '' : 's'} (${above.slice(0, 4).join(', ')}${above.length > 4 ? ', …' : ''}), so even natural flow fails there`
			);
		}
	}
	return out;
}

/**
 * Stored rule tables as the run uses them: anything that isn't an object or
 * fails ewrRuleTableIssues is dropped with a warning naming its site; a
 * site listed more than once has none of its tables used (order-independent); `natural` is ignored
 * unless the natural source is the table. The site's existence is checked by
 * the run, which knows the network.
 */
export function resolveEwrRules(raw: unknown, warnings: string[]): EwrRuleTable[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) {
		warnings.push('EWR rule tables are not a list; ignored');
		return [];
	}
	// Two usable tables for one site: which is meant can't be told, and keeping the first made
	// the result depend on the list's order (fuzz seeds 3238 …, engine 0.24.1). Neither is used.
	// The API refuses such a list (ewrRuleListIssues); this covers settings that bypassed it.
	const usable: EwrRuleTable[] = [];
	for (const r of raw.slice(0, EWR_RULE_TABLES_MAX)) {
		if (!isObj(r)) continue;
		const t: EwrRuleTable = {
			siteNodeId: typeof r.siteNodeId === 'string' ? r.siteNodeId : null,
			source: typeof r.source === 'string' ? r.source : '',
			// Only when set, so a table from before engine 1.5.0 resolves as it did.
			...(r.sourceKind !== undefined && r.sourceKind !== null ? { sourceKind: r.sourceKind as EwrRuleSourceKind } : {}),
			// The REC (ER9), only when set: a label, so a table without it resolves as it did.
			...(r.category !== undefined && r.category !== null ? { category: r.category as string } : {}),
			component: r.component as EwrRuleComponent,
			unit: r.unit as EwrRuleUnit,
			points: r.points as number[],
			ewr: r.ewr as number[][],
			naturalSource: r.naturalSource as EwrNaturalSource,
			natural: (r.natural as number[][] | null | undefined) ?? null,
			scale: r.scale === undefined ? 1 : (r.scale as number),
			lowFlow: (r.lowFlow as number[][] | null | undefined) ?? null,
			highFlows: r.highFlows === undefined ? [] : (r.highFlows as EwrHighFlowEvent[]),
			// Only when set (engine ≥ 1.11.0), so a table from before resolves as it did.
			...(r.naturalMarMcm !== undefined && r.naturalMarMcm !== null ? { naturalMarMcm: r.naturalMarMcm as number } : {})
		};
		const where = t.siteNodeId === null ? 'the outlet' : `site ${t.siteNodeId}`;
		const issues = ewrRuleTableIssues(t);
		if (issues.length) {
			warnings.push(`EWR rule table for ${where} skipped: it isn't usable (${issues.map((i) => i.message).join(' ')})`);
			continue;
		}
		usable.push(t);
	}
	const count = new Map<string, number>();
	for (const t of usable) count.set(t.siteNodeId ?? '', (count.get(t.siteNodeId ?? '') ?? 0) + 1);
	const out: EwrRuleTable[] = [];
	const warned = new Set<string>();
	for (const t of usable) {
		const key = t.siteNodeId ?? '';
		if ((count.get(key) ?? 0) > 1) {
			if (!warned.has(key)) warnings.push(`${count.get(key)} EWR rule tables for ${t.siteNodeId === null ? 'the outlet' : `site ${t.siteNodeId}`}: none is used, because each site has one`);
			warned.add(key);
			continue;
		}
		if (t.naturalSource === 'run') t.natural = null;
		// Copies, sorted: the months an event may peak in are a set.
		t.highFlows = t.highFlows!.map((e) => ({ label: e.label, months: [...e.months].sort((a, b) => a - b), peakM3s: e.peakM3s, durationDays: e.durationDays, perYear: e.perYear }));
		out.push(t);
	}
	if (raw.length > EWR_RULE_TABLES_MAX) warnings.push(`only the first ${EWR_RULE_TABLES_MAX} EWR rule tables are used`);
	return out;
}
