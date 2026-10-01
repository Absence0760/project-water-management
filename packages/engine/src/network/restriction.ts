// The drought restriction rule (engine ≥ 1.54.0, WP-3.8, docs/model.md
// §2.7i): "cut demand by x % when storage falls below y %". On each review
// date the level is chosen from the total farm dam storage at the start of
// the day, as a share of the total capacity (the review triggers' basis,
// ../outlook/triggers.ts), and holds until the next review or lift date. A
// level cuts each part of a unit's demand (its crops, its demand objects of
// one category: DEMAND_PARTS, the parts demand.scale scales) by its share;
// a domestic or municipal object never goes below its basic-needs floor
// (./demandObjects.ts, §2.7f). Pure; the simulation (./simulate.ts), the run
// summary (../run.ts), the self-check (../verify/checks.ts), the settings
// save and the scenario op all read the rule through these functions.
import { fromEpochDay } from '../calendar';
import { DEMAND_OBJECT_CATEGORY_LABEL, DEMAND_PARTS, DROUGHT_RESTRICTION_BASES, type DemandPart, type DroughtRestrictionLevel, type DroughtRestrictionRule } from '../project';
import { cmpStr } from '../order';
import { dayFloor } from './demandObjects';

/** Most levels a rule may have (DWS restriction schedules have 3–5). */
export const RESTRICTION_LEVELS_MAX = 6;
/** Most review or lift dates (a monthly review is 12). */
export const RESTRICTION_DATES_MAX = 12;
export const RESTRICTION_LABEL_MAX = 60;
export const RESTRICTION_SOURCE_MAX = 500;
/** Most node ids in a rule's dam or unit list. */
export const RESTRICTION_NODES_MAX = 500;

/**
 * The run series the rule adds (only when it is on): the level in force each
 * day and each part's cut that day on the catchment, and each unit's demand
 * after the cut.
 */
export const RESTRICTION_SERIES = {
	level: { key: 'restriction_level', label: 'Drought restriction level in force (the model rule; 0 = none)', unit: '' },
	/** The catchment column under the 'own' basis, and each unit's (engine ≥ 1.54.0). */
	deepestLabel: 'Deepest drought restriction level any unit is at (the model rule, each unit by its own dam; 0 = none)',
	unitLabel: 'Drought restriction level of this unit (the model rule, by its own dam; 0 = none)',
	cutPrefix: 'restriction_cut@',
	cutLabel: (part: DemandPart) => `Drought restriction cut on ${DEMAND_PART_WORDS[part]} (share of demand, 0–1)`,
	cutUnit: '',
	restricted: { key: 'restricted_demand', label: 'Demand after the drought restriction (abstraction; what the unit asks its sources for)', unit: 'm³/day' }
} as const;

export const restrictionCutKey = (part: DemandPart): string => `${RESTRICTION_SERIES.cutPrefix}${part}`;

/** Each part of demand in plain words, for labels and the run comparison. */
export const DEMAND_PART_WORDS: Record<DemandPart, string> = {
	crops: 'crops',
	...(Object.fromEntries(Object.entries(DEMAND_OBJECT_CATEGORY_LABEL).map(([k, v]) => [k, `${v.toLowerCase()} demand objects`])) as Record<Exclude<DemandPart, 'crops'>, string>)
};

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "MM-DD" as [month, day], or null when it isn't one (29 February isn't: it would move every other year). */
export function parseMonthDay(v: unknown): [number, number] | null {
	if (typeof v !== 'string' || !/^\d{2}-\d{2}$/.test(v)) return null;
	const m = Number(v.slice(0, 2));
	const d = Number(v.slice(3, 5));
	if (m < 1 || m > 12 || d < 1 || d > MONTH_DAYS[m - 1]!) return null;
	return [m, d];
}

/** "01-15" → "15 Jan". */
export function monthDayText(md: string): string {
	const p = parseMonthDay(md);
	return p ? `${p[1]} ${MONTHS[p[0] - 1]}` : md;
}

export interface RestrictionIssue {
	field: string;
	message: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function dateListIssues(v: unknown, field: string, min: number, out: RestrictionIssue[]): string[] {
	if (!Array.isArray(v)) {
		out.push({ field, message: 'must be a list of month-days ("MM-DD")' });
		return [];
	}
	if (v.length < min) out.push({ field, message: min === 1 ? 'needs at least one review date' : `needs at least ${min} dates` });
	if (v.length > RESTRICTION_DATES_MAX) out.push({ field, message: `at most ${RESTRICTION_DATES_MAX} dates` });
	const seen = new Set<string>();
	v.forEach((d, i) => {
		if (!parseMonthDay(d)) out.push({ field: `${field}[${i}]`, message: `"${String(d)}" is not a month and day ("MM-DD"; 29 February can't be one)` });
		else if (seen.has(d as string)) out.push({ field: `${field}[${i}]`, message: `${monthDayText(d as string)} is listed twice` });
		else seen.add(d as string);
	});
	return [...seen];
}

/**
 * Why a drought restriction rule can't be used, one issue per problem (none
 * = usable). The backend's settings save, the scenario op and the settings
 * form all check a rule with this, so they agree with the run.
 */
export function droughtRestrictionIssues(raw: unknown): RestrictionIssue[] {
	const out: RestrictionIssue[] = [];
	if (!isObj(raw)) return [{ field: '', message: 'must be a rule ({ reviewDates, levels }) or null' }];
	const extra = Object.keys(raw).filter((k) => !['reviewDates', 'liftDates', 'levels', 'source', 'basis', 'damNodeIds', 'nodeIds', 'ewrTrigger'].includes(k));
	if (extra.length) out.push({ field: '', message: `unknown field(s) ${extra.join(', ')}` });
	const reviews = dateListIssues(raw.reviewDates, 'reviewDates', 1, out);
	if (raw.liftDates !== undefined) {
		const lifts = dateListIssues(raw.liftDates, 'liftDates', 0, out);
		for (const d of lifts) if (reviews.includes(d)) out.push({ field: 'liftDates', message: `${monthDayText(d)} is both a review date and a lift date` });
	}
	if (raw.source !== undefined && (typeof raw.source !== 'string' || raw.source.length > RESTRICTION_SOURCE_MAX))
		out.push({ field: 'source', message: `must be a text of at most ${RESTRICTION_SOURCE_MAX} characters` });
	// Which storage, which units, and the EWR trigger (engine ≥ 1.54.0); the ids are checked against the model by
	// droughtRestrictionNodeIssues (the run and the form), since the rule alone doesn't know the network.
	if (raw.basis !== undefined && !(DROUGHT_RESTRICTION_BASES as readonly unknown[]).includes(raw.basis))
		out.push({ field: 'basis', message: `must be one of ${DROUGHT_RESTRICTION_BASES.join(', ')}` });
	const ids = (v: unknown, field: string, what: string) => {
		if (!Array.isArray(v) || !v.length) return out.push({ field, message: `must list at least one ${what}` });
		if (v.length > RESTRICTION_NODES_MAX) out.push({ field, message: `at most ${RESTRICTION_NODES_MAX} ${what}s` });
		if (v.some((x) => typeof x !== 'string' || !x || x.length > 100)) out.push({ field, message: `must be ${what} ids` });
		else if (new Set(v).size !== v.length) out.push({ field, message: `lists a ${what} twice` });
	};
	if (raw.basis === 'dams') ids(raw.damNodeIds, 'damNodeIds', 'dam');
	else if (raw.damNodeIds !== undefined) out.push({ field: 'damNodeIds', message: "only with the basis 'dams'" });
	if (raw.nodeIds !== undefined) ids(raw.nodeIds, 'nodeIds', 'hydrological unit');
	const levels = raw.levels;
	if (raw.ewrTrigger !== undefined) {
		const e = raw.ewrTrigger;
		if (!isObj(e) || Object.keys(e).some((k) => k !== 'siteNodeId' && k !== 'level')) out.push({ field: 'ewrTrigger', message: 'must be { siteNodeId, level }' });
		else {
			if (!(e.siteNodeId === null || (typeof e.siteNodeId === 'string' && e.siteNodeId && e.siteNodeId.length <= 100))) out.push({ field: 'ewrTrigger.siteNodeId', message: 'must be an EWR site (a gauge id, or null for the outlet)' });
			const n = Array.isArray(levels) ? levels.length : 0;
			if (!(Number.isInteger(e.level) && (e.level as number) >= 1 && (e.level as number) <= Math.max(n, 1))) out.push({ field: 'ewrTrigger.level', message: `must be a level of the rule (1–${Math.max(n, 1)})` });
		}
	}
	if (!Array.isArray(levels) || levels.length < 1) {
		out.push({ field: 'levels', message: 'needs at least one level' });
		return out;
	}
	if (levels.length > RESTRICTION_LEVELS_MAX) out.push({ field: 'levels', message: `at most ${RESTRICTION_LEVELS_MAX} levels` });
	let prev: Record<string, unknown> | null = null;
	levels.forEach((l, i) => {
		const f = `levels[${i}]`;
		if (!isObj(l)) {
			out.push({ field: f, message: 'must be a level ({ belowPct, cuts })' });
			prev = null;
			return;
		}
		const bad = Object.keys(l).filter((k) => !['label', 'belowPct', 'cuts'].includes(k));
		if (bad.length) out.push({ field: f, message: `unknown field(s) ${bad.join(', ')}` });
		if (l.label !== undefined && (typeof l.label !== 'string' || l.label.length > RESTRICTION_LABEL_MAX)) out.push({ field: `${f}.label`, message: `must be a text of at most ${RESTRICTION_LABEL_MAX} characters` });
		if (!finite(l.belowPct) || !(l.belowPct > 0 && l.belowPct <= 1)) out.push({ field: `${f}.belowPct`, message: 'must be a share of capacity above 0 and at most 1 (100 %)' });
		else if (prev && finite(prev.belowPct) && !(l.belowPct < prev.belowPct))
			out.push({ field: `${f}.belowPct`, message: `level ${i + 1} must start below level ${i}'s ${Math.round(prev.belowPct * 1000) / 10} % (deeper levels at lower storage)` });
		if (!isObj(l.cuts)) out.push({ field: `${f}.cuts`, message: 'must be the cut per part of demand ({ crops: 0.2, … })' });
		else
			for (const [part, c] of Object.entries(l.cuts)) {
				if (!(DEMAND_PARTS as readonly string[]).includes(part)) {
					out.push({ field: `${f}.cuts`, message: `"${part}" is not a part of demand (${DEMAND_PARTS.join(', ')})` });
					continue;
				}
				if (!finite(c) || c < 0 || c > 1) {
					out.push({ field: `${f}.cuts.${part}`, message: 'must be a share from 0 to 1 (100 %)' });
					continue;
				}
				const was = prev && isObj(prev.cuts) ? prev.cuts[part] : undefined;
				if (finite(was) && c < was) out.push({ field: `${f}.cuts.${part}`, message: `level ${i + 1} cuts ${DEMAND_PART_WORDS[part as DemandPart]} less than level ${i} (a deeper level cuts at least as much)` });
			}
		// A part a milder level cuts must be cut by every deeper one too.
		if (prev && isObj(prev.cuts) && isObj(l.cuts))
			for (const [part, was] of Object.entries(prev.cuts))
				if (finite(was) && was > 0 && !(part in l.cuts)) out.push({ field: `${f}.cuts.${part}`, message: `level ${i + 1} doesn't cut ${DEMAND_PART_WORDS[part as DemandPart] ?? part}, which level ${i} does` });
		prev = l;
	});
	return out;
}

/**
 * The rule a run applies (settings.droughtRestriction): null when it is off
 * (null or absent) or can't be used, with a warning naming its first problem
 * (a save refuses such a rule, so only a hand-made input reaches this).
 */
export function resolveDroughtRestriction(raw: unknown, warnings: string[]): DroughtRestrictionRule | null {
	if (raw === null || raw === undefined) return null;
	const issues = droughtRestrictionIssues(raw);
	if (issues.length) {
		warnings.push(`the drought restriction rule is not applied: ${issues[0]!.field ? `${issues[0]!.field} ` : ''}${issues[0]!.message}`);
		return null;
	}
	return raw as DroughtRestrictionRule;
}

/** The level for a storage share: the deepest whose threshold the share is below; 0 = none. */
export function restrictionLevelFor(share: number, thresholds: ArrayLike<number>): number {
	let k = 0;
	while (k < thresholds.length && share < thresholds[k]!) k++;
	return k;
}

/** A level's cut on one part (0 at level 0 or for a part it doesn't cut). */
export function levelCut(rule: Pick<DroughtRestrictionRule, 'levels'>, level: number, part: DemandPart): number {
	if (level <= 0) return 0;
	const c = rule.levels[level - 1]?.cuts[part];
	return finite(c) ? c : 0;
}

/**
 * Why a rule's node ids don't fit the network (engine ≥ 1.54.0), one issue
 * per problem: a dam in `damNodeIds` that isn't a farm with a dam, a unit in
 * `nodeIds` that isn't a farm, an EWR site that isn't a gauge. The run warns
 * and leaves each out; the Settings form blocks Save.
 */
export function droughtRestrictionNodeIssues(rule: DroughtRestrictionRule, nodes: readonly { id: string; kind: string; damCapacityM3: number; name?: string; ewrSite?: boolean }[]): RestrictionIssue[] {
	const out: RestrictionIssue[] = [];
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const name = (id: string) => byId.get(id)?.name ?? id;
	if (rule.basis === 'dams')
		for (const id of rule.damNodeIds ?? []) {
			const n = byId.get(id);
			if (!n || n.kind !== 'farm' || !(n.damCapacityM3 > 0)) out.push({ field: 'damNodeIds', message: n ? `“${name(id)}” has no dam` : `the dam ${id} isn't in the model` });
		}
	for (const id of rule.nodeIds ?? []) {
		const n = byId.get(id);
		if (!n || n.kind !== 'farm') out.push({ field: 'nodeIds', message: n ? `“${name(id)}” isn't a hydrological unit` : `the unit ${id} isn't in the model` });
	}
	const site = rule.ewrTrigger?.siteNodeId;
	if (typeof site === 'string') {
		const n = byId.get(site);
		// A gauge whose EWR site flag is off isn't an EWR site (topology.ts isEwrSite): its EWR is never reported.
		if (!n || n.kind !== 'gauge' || n.ewrSite === false) out.push({ field: 'ewrTrigger.siteNodeId', message: !n ? `the EWR site ${site} isn't in the model` : n.kind !== 'gauge' ? `“${name(site)}” isn't a gauge` : `“${name(site)}” isn't an EWR site` });
	}
	return out;
}

/**
 * A rule from the WUA's published restriction notice (engine ≥ 1.54.0, WP-2.3,
 * a starting point: "a scenario may copy the current notice into the rule,
 * never the reverse"). A notice is one cut for the season, not a table by
 * storage, so the rule has one level in force whenever the dams aren't full
 * (below 100 %), cutting every part by the notice's %, reviewed on the day it
 * was published and lifted on the day the WUA expects to publish next. null
 * (with the reason) for a notice that cuts nothing: no restriction, or an
 * advisory or restriction without a %. `publishedOn` is the calendar day it
 * was published in the project's time zone (YYYY-MM-DD), not the UTC
 * timestamp: a notice published just after midnight there is that day's.
 */
export function restrictionRuleFromNotice(notice: { level: string; pct: number | null; publishedOn: string; nextExpectedOn: string | null }): { rule: DroughtRestrictionRule | null; reason: string | null } {
	if (notice.level === 'none') return { rule: null, reason: 'The published notice has no restriction.' };
	if (!(typeof notice.pct === 'number' && notice.pct > 0)) return { rule: null, reason: 'The published notice gives no % cut to copy.' };
	const md = (iso: string) => (iso.slice(5, 10) === '02-29' ? '03-01' : iso.slice(5, 10));
	const review = md(notice.publishedOn);
	const lift = notice.nextExpectedOn ? md(notice.nextExpectedOn) : null;
	const cut = Math.min(1, notice.pct / 100);
	return {
		rule: {
			reviewDates: [review],
			...(lift && lift !== review ? { liftDates: [lift] } : {}),
			levels: [{ label: notice.level === 'advisory' ? 'Advisory notice' : 'Published notice', belowPct: 1, cuts: Object.fromEntries(DEMAND_PARTS.map((p) => [p, cut])) }],
			source: `The WUA's published restriction notice of ${notice.publishedOn.slice(0, 10)} (${notice.pct} %)`
		},
		reason: null
	};
}

/**
 * A demand object's demand after a cut `cut`: d × (1 − cut), never below
 * MIN(its basic-needs floor, d) when it has one (engine ≥ 1.44.0's floor, as
 * against any restriction). With no cut it is d, to the bit.
 */
export function restrictedObjectDemand(d: number, cut: number, floor: number | null): number {
	if (!(cut > 0)) return d;
	const r = d * (1 - cut);
	return floor === null ? r : Math.max(r, dayFloor(floor, d));
}

/** The simulation's form of a rule (NetworkPlan.restriction). */
export interface PlanRestriction {
	/** Per run day: 0 = no event, 1 = a review (the level is decided), 2 = a lift (the level is 0). */
	event: Uint8Array;
	/** A fresh run's first day without an event is decided when the latest date before it is a review (else it starts at 0). */
	startDecides: boolean;
	/** belowPct of each level, mildest first. */
	thresholds: Float64Array;
	/** cut[level][part index in DEMAND_PARTS]; level 0 is all zeros. */
	cut: Float64Array[];
	/** One level for every unit ('total', 'dams') or one per unit ('own'). */
	shared: boolean;
	/** Shared: the farm dams the storage is read from (node indices, in node-id order so the sum doesn't depend on the listing). */
	dams: Int32Array;
	/** 'own': each unit's dam (its own index), -1 for a unit without one. */
	ownDam: Int32Array;
	/** 1 for each unit the rule cuts (farms only). */
	inScope: Uint8Array;
	/**
	 * The EWR trigger's site (a node index) and its level; -1 = none. At the
	 * outlet (`ewrAtOutlet`) the trigger reads the catchment's EWR, the
	 * outflow against the whole pragmatic EWR (the `ewr_shortfall` catchment
	 * column the compliance report counts), not the outflow node's own
	 * share-weighted one, which differs when the flow shares sum below 1.
	 */
	ewrSite: number;
	ewrAtOutlet: boolean;
	ewrLevel: number;
	/** The level each unit held on the day before the first day (a resumed run, engine ≥ 1.54.0); absent = a fresh start. */
	initialLevels?: Uint8Array;
	/** Whether the EWR trigger's site failed on the day before the first day (a resumed run); absent = no. */
	initialEwrFailed?: boolean;
}

/** The review and lift day of each run day from `start`, and whether a fresh run decides its first day. */
export function restrictionEvents(rule: Pick<DroughtRestrictionRule, 'reviewDates' | 'liftDates'>, start: number, days: number): { event: Uint8Array; startDecides: boolean } {
	const reviews = new Set(rule.reviewDates);
	const lifts = new Set(rule.liftDates ?? []);
	const eventOn = (day: number): number => {
		const md = fromEpochDay(day).slice(5);
		return reviews.has(md) ? 1 : lifts.has(md) ? 2 : 0;
	};
	const event = new Uint8Array(days);
	for (let t = 0; t < days; t++) event[t] = eventOn(start + t);
	// The latest date before the run's first day: a review decides its level, a lift (or none in a year) leaves none.
	let startDecides = false;
	for (let back = 1; back <= 366; back++) {
		const e = eventOn(start - back);
		if (e) {
			startDecides = e === 1;
			break;
		}
	}
	return { event, startDecides };
}

/**
 * A rule resolved against a run: its events per day from `start` (epoch
 * day), the dams its storage reads (every farm dam for 'total', the listed
 * ones for 'dams', each unit's own for 'own'), the units it cuts, and the EWR
 * trigger's site (`outlet` = the outflow node's index). Ids that don't fit
 * the network are left out with a warning (droughtRestrictionNodeIssues);
 * null, with a warning, when no unit is left to cut.
 */
export function planRestriction(
	rule: DroughtRestrictionRule,
	nodes: readonly { id: string; kind: string; damCapacityM3: number; name?: string; ewrSite?: boolean }[],
	start: number,
	days: number,
	warnings: string[] = [],
	outlet = -1
): PlanRestriction | null {
	for (const i of droughtRestrictionNodeIssues(rule, nodes)) warnings.push(`drought restriction rule: ${i.message}; left out`);
	const { event, startDecides } = restrictionEvents(rule, start, days);
	const cut = [new Float64Array(DEMAND_PARTS.length), ...rule.levels.map((l) => Float64Array.from(DEMAND_PARTS, (p) => (finite(l.cuts[p]) ? l.cuts[p]! : 0)))];
	const isDam = (n: (typeof nodes)[number]) => n.kind === 'farm' && n.damCapacityM3 > 0;
	const basis = rule.basis ?? 'total';
	const listed = basis === 'dams' ? new Set(rule.damNodeIds ?? []) : null;
	const dams = basis === 'own' ? [] : nodes.flatMap((n, i) => (isDam(n) && (!listed || listed.has(n.id)) ? [i] : [])).sort((a, b) => cmpStr(nodes[a]!.id, nodes[b]!.id));
	const scope = rule.nodeIds ? new Set(rule.nodeIds) : null;
	const inScope = Uint8Array.from(nodes, (n) => (n.kind === 'farm' && (!scope || scope.has(n.id)) ? 1 : 0));
	if (!inScope.some((x) => x)) {
		warnings.push('the drought restriction rule cuts no hydrological unit (none of its units is in the model): not applied');
		return null;
	}
	const ownDam = Int32Array.from(nodes, (n, i) => (basis === 'own' && inScope[i] && isDam(n) ? i : -1));
	if (basis !== 'own' && !dams.length) warnings.push('the drought restriction rule reads the farm dams’ storage, and no dam it reads is in the model: no level is ever in force from storage');
	if (basis === 'own') {
		// In node-id order, so the warning doesn't depend on how the nodes are listed.
		const without = nodes.filter((n, i) => inScope[i] && !isDam(n)).sort((a, b) => cmpStr(a.id, b.id));
		if (without.length) warnings.push(`the drought restriction rule reads each unit's own dam, and ${without.map((n) => n.name ?? n.id).join(', ')} ${without.length === 1 ? 'has' : 'have'} none: never restricted by storage`);
	}
	let ewrSite = -1;
	if (rule.ewrTrigger) {
		const id = rule.ewrTrigger.siteNodeId;
		const i = id === null ? outlet : nodes.findIndex((n) => n.id === id && n.kind === 'gauge' && n.ewrSite !== false);
		if (i < 0) warnings.push('the drought restriction rule’s EWR trigger has no site in the model: left out');
		else ewrSite = i;
	}
	return {
		event,
		startDecides,
		thresholds: Float64Array.from(rule.levels, (l) => l.belowPct),
		cut,
		shared: basis !== 'own',
		dams: Int32Array.from(dams),
		ownDam,
		inScope,
		ewrSite,
		ewrAtOutlet: ewrSite >= 0 && ewrSite === outlet,
		ewrLevel: ewrSite >= 0 ? rule.ewrTrigger!.level : 0
	};
}

/** Index of each part in DEMAND_PARTS (the cut arrays' order). */
export const PART_INDEX: Record<DemandPart, number> = Object.fromEntries(DEMAND_PARTS.map((p, i) => [p, i])) as Record<DemandPart, number>;

/** One level in words: "Level 2 (below 40 %): crops 30 %, domestic demand objects 10 %". */
export function describeRestrictionLevel(l: DroughtRestrictionLevel, i: number): string {
	const pct = (x: number) => `${Math.round(x * 1000) / 10} %`;
	const cuts = DEMAND_PARTS.flatMap((p) => (finite(l.cuts[p]) && l.cuts[p]! > 0 ? [`${DEMAND_PART_WORDS[p]} ${pct(l.cuts[p]!)}`] : []));
	return `${l.label?.trim() || `Level ${i + 1}`} (below ${pct(l.belowPct)}): ${cuts.length ? cuts.join(', ') : 'no cut'}`;
}

/** The rule in words, for the run comparison and the scenario list: "off", or its dates and levels. */
export function describeDroughtRestriction(rule: DroughtRestrictionRule | null | undefined, name: (id: string) => string = (id) => id): string {
	if (!rule) return 'off';
	const lifts = rule.liftDates?.length ? `, lifted ${rule.liftDates.map(monthDayText).join(', ')}` : '';
	const extra = [basisText(rule, name), rule.nodeIds ? `cutting ${rule.nodeIds.map(name).join(', ')} only` : null, ewrText(rule, name)].filter(Boolean);
	return `reviewed ${rule.reviewDates.map(monthDayText).join(', ')}${lifts}; ${rule.levels.map(describeRestrictionLevel).join('; ')}${extra.length ? `; ${extra.join('; ')}` : ''}`;
}

/** Which storage in words, or null for the default (every farm dam's total). */
function basisText(rule: DroughtRestrictionRule, name: (id: string) => string): string | null {
	if (rule.basis === 'own') return "each unit's own dam";
	if (rule.basis === 'dams') return `the storage of ${(rule.damNodeIds ?? []).map(name).join(', ')}`;
	return null;
}
function ewrText(rule: DroughtRestrictionRule, name: (id: string) => string): string | null {
	const e = rule.ewrTrigger;
	if (!e) return null;
	return `at least level ${e.level} when the EWR at ${e.siteNodeId === null ? 'the outlet' : name(e.siteNodeId)} wasn't met the day before a review`;
}

/**
 * What changed between two rules, for the run comparison (one text per
 * change, none when they are the same): switched on or off, the review and
 * lift dates, each level's threshold, name and cuts, levels added or removed,
 * and the source note. A rule a run couldn't use counts as off.
 */
export function droughtRestrictionChanges(ra: unknown, rb: unknown, name: (id: string) => string = (id) => id): string[] {
	const a = resolveDroughtRestriction(ra ?? null, []);
	const b = resolveDroughtRestriction(rb ?? null, []);
	if (!a && !b) return [];
	if (!a || !b) return [`${describeDroughtRestriction(a, name)} → ${describeDroughtRestriction(b, name)}`];
	const out: string[] = [];
	const dates = (x: readonly string[] | undefined) => (x?.length ? [...x].sort().map(monthDayText).join(', ') : 'none');
	if (dates(a.reviewDates) !== dates(b.reviewDates)) out.push(`review dates ${dates(a.reviewDates)} → ${dates(b.reviewDates)}`);
	if (dates(a.liftDates) !== dates(b.liftDates)) out.push(`lift dates ${dates(a.liftDates)} → ${dates(b.liftDates)}`);
	const pct = (x: number) => `${Math.round(x * 1000) / 10} %`;
	for (let i = 0; i < Math.max(a.levels.length, b.levels.length); i++) {
		const la = a.levels[i];
		const lb = b.levels[i];
		if (!la) out.push(`added ${describeRestrictionLevel(lb!, i)}`);
		else if (!lb) out.push(`removed ${describeRestrictionLevel(la, i)}`);
		else {
			const name = `level ${i + 1}`;
			if ((la.label ?? '').trim() !== (lb.label ?? '').trim()) out.push(`${name} name "${la.label?.trim() ?? ''}" → "${lb.label?.trim() ?? ''}"`);
			if (la.belowPct !== lb.belowPct) out.push(`${name} starts below ${pct(la.belowPct)} → ${pct(lb.belowPct)}`);
			for (const p of DEMAND_PARTS) {
				const ca = finite(la.cuts[p]) ? la.cuts[p]! : 0;
				const cb = finite(lb.cuts[p]) ? lb.cuts[p]! : 0;
				if (ca !== cb) out.push(`${name} cut on ${DEMAND_PART_WORDS[p]} ${pct(ca)} → ${pct(cb)}`);
			}
		}
	}
	if ((a.source ?? '').trim() !== (b.source ?? '').trim()) out.push(`source "${a.source?.trim() ?? ''}" → "${b.source?.trim() ?? ''}"`);
	const basisA = basisText(a, name) ?? 'every farm dam';
	const basisB = basisText(b, name) ?? 'every farm dam';
	if (basisA !== basisB) out.push(`storage read ${basisA} → ${basisB}`);
	const scope = (r: DroughtRestrictionRule) => (r.nodeIds ? r.nodeIds.map(name).sort().join(', ') : 'every unit');
	if (scope(a) !== scope(b)) out.push(`units cut ${scope(a)} → ${scope(b)}`);
	const ewrA = ewrText(a, name) ?? 'no EWR trigger';
	const ewrB = ewrText(b, name) ?? 'no EWR trigger';
	if (ewrA !== ewrB) out.push(`${ewrA} → ${ewrB}`);
	return out;
}
