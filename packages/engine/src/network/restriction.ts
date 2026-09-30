// The drought restriction rule (engine ≥ 1.46.0, WP-3.8, docs/model.md
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
import { DEMAND_OBJECT_CATEGORY_LABEL, DEMAND_PARTS, type DemandPart, type DroughtRestrictionLevel, type DroughtRestrictionRule } from '../project';
import { cmpStr } from '../order';
import { dayFloor } from './demandObjects';

/** Most levels a rule may have (DWS restriction schedules have 3–5). */
export const RESTRICTION_LEVELS_MAX = 6;
/** Most review or lift dates (a monthly review is 12). */
export const RESTRICTION_DATES_MAX = 12;
export const RESTRICTION_LABEL_MAX = 60;
export const RESTRICTION_SOURCE_MAX = 500;

/**
 * The run series the rule adds (only when it is on): the level in force each
 * day and each part's cut that day on the catchment, and each unit's demand
 * after the cut.
 */
export const RESTRICTION_SERIES = {
	level: { key: 'restriction_level', label: 'Drought restriction level in force (the model rule; 0 = none)', unit: '' },
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
	const extra = Object.keys(raw).filter((k) => !['reviewDates', 'liftDates', 'levels', 'source'].includes(k));
	if (extra.length) out.push({ field: '', message: `unknown field(s) ${extra.join(', ')}` });
	const reviews = dateListIssues(raw.reviewDates, 'reviewDates', 1, out);
	if (raw.liftDates !== undefined) {
		const lifts = dateListIssues(raw.liftDates, 'liftDates', 0, out);
		for (const d of lifts) if (reviews.includes(d)) out.push({ field: 'liftDates', message: `${monthDayText(d)} is both a review date and a lift date` });
	}
	if (raw.source !== undefined && (typeof raw.source !== 'string' || raw.source.length > RESTRICTION_SOURCE_MAX))
		out.push({ field: 'source', message: `must be a text of at most ${RESTRICTION_SOURCE_MAX} characters` });
	const levels = raw.levels;
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
	/** The farm dams the storage is read from (node indices, in node-id order so the sum doesn't depend on the listing). */
	dams: Int32Array;
	/** The level held on the day before the first day (a run resumed from a snapshot, engine ≥ 1.46.0); absent = a fresh start. */
	initialLevel?: number;
}

/**
 * A rule resolved against a run: its events per day from `start` (epoch
 * day), and the farm dams its storage reads (every farm with a dam, as the
 * review triggers' total farm dam storage).
 */
export function planRestriction(rule: DroughtRestrictionRule, nodes: readonly { id: string; kind: string; damCapacityM3: number }[], start: number, days: number): PlanRestriction {
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
	const cut = [new Float64Array(DEMAND_PARTS.length), ...rule.levels.map((l) => Float64Array.from(DEMAND_PARTS, (p) => (finite(l.cuts[p]) ? l.cuts[p]! : 0)))];
	const dams = nodes.flatMap((n, i) => (n.kind === 'farm' && n.damCapacityM3 > 0 ? [i] : [])).sort((a, b) => cmpStr(nodes[a]!.id, nodes[b]!.id));
	return { event, startDecides, thresholds: Float64Array.from(rule.levels, (l) => l.belowPct), cut, dams: Int32Array.from(dams) };
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
export function describeDroughtRestriction(rule: DroughtRestrictionRule | null | undefined): string {
	if (!rule) return 'off';
	const lifts = rule.liftDates?.length ? `, lifted ${rule.liftDates.map(monthDayText).join(', ')}` : '';
	return `reviewed ${rule.reviewDates.map(monthDayText).join(', ')}${lifts}; ${rule.levels.map(describeRestrictionLevel).join('; ')}`;
}

/**
 * What changed between two rules, for the run comparison (one text per
 * change, none when they are the same): switched on or off, the review and
 * lift dates, each level's threshold, name and cuts, levels added or removed,
 * and the source note. A rule a run couldn't use counts as off.
 */
export function droughtRestrictionChanges(ra: unknown, rb: unknown): string[] {
	const a = resolveDroughtRestriction(ra ?? null, []);
	const b = resolveDroughtRestriction(rb ?? null, []);
	if (!a && !b) return [];
	if (!a || !b) return [`${describeDroughtRestriction(a)} → ${describeDroughtRestriction(b)}`];
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
	return out;
}
