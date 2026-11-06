// The seasonal outlook's briefing (docs/ui.md § Seasonal outlook, issue #53
// R5/R6; the operator's mock-ups, 2026-11-03): the six parts a WUA reads
// first, above the outlook's tables, from figures the outlook and its base
// run already hold. Pure, so it is unit-tested without Svelte.
//
//   1. Where the season starts: the dams' storage on the decision date (of
//      capacity), the natural flow over the months before it against the
//      same months of the record's other years, and the natural flow of the
//      season in the analogue years as they happened (median, 10–90 %).
//   2. The planning figure (the engine's rule, never a recommendation).
//   3. What if more or less: per level, irrigation supplied over the season,
//      the dams at its end (of capacity) and the years met in full, marked
//      against the planning share.
//   4. A monthly plan, when the outlook has one: its months as typed. The
//      outlook doesn't work one out (planning-outputs.md: R1's months form is
//      the WUA's own plan), so with none the part says so.
//   5. The review triggers, each band set beside the planning figure.
//   6. A month-by-month water balance (engine ≥ 1.115.0, buildBalance): for
//      one level, each month's median irrigation and other users supplied,
//      EWR carried and dam losses, and the dams at its end (median, 10–90 %).
//      An outlook from before that engine has no months, so the part asks for
//      it to be run again.
//
// Plus a risk line from the planning rule (at the highest level run) and key
// messages for farmers, each a sentence about past seasons. The parts that
// read the base run's natural flow (1's inflow and season flow) are null
// until it has loaded, or when the record can't give them.
import type { Outlook, OutlookResult, OutlookTriggerTable } from '#lib/api/types.js';
import type { ScenarioOp } from '@water-management/engine';
import { monthName } from '#lib/format/months.js';
import { fmtDay, fmtNum } from '#lib/format/number.js';
import { levelDescription } from '#lib/format/demandLevel.js';

const DAY = 86_400_000;
const epoch = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / DAY;
const iso = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);
const pct = (v: number) => `${fmtNum(v * 100, 0)} %`;
/** Volumes as a WUA reads them: m³ below a million, million m³ above. */
export function volume(m3: number): string {
	if (!Number.isFinite(m3)) return '–';
	const a = Math.abs(m3);
	if (a < 1e6) return `${fmtNum(m3)} m³`;
	const m = m3 / 1e6;
	return `${fmtNum(m, a < 1e7 ? 2 : a < 1e8 ? 1 : 0)} million m³`;
}

/** Linear (type 7) quantile of sorted values. */
function quantile(sorted: readonly number[], p: number): number {
	const h = (sorted.length - 1) * p;
	const lo = Math.floor(h);
	return lo + 1 < sorted.length ? sorted[lo]! + (h - lo) * (sorted[lo + 1]! - sorted[lo]!) : sorted[lo]!;
}

/** Σ of a daily series over [from, to] (ISO, inclusive), or null when a day is outside it or missing. */
export function windowTotal(series: { startDate: string; values: readonly (number | null)[] }, from: string, to: string): number | null {
	const i0 = epoch(from) - epoch(series.startDate);
	const i1 = epoch(to) - epoch(series.startDate);
	if (i0 < 0 || i1 >= series.values.length || i1 < i0) return null;
	let s = 0;
	for (let t = i0; t <= i1; t++) {
		const v = series.values[t];
		if (v === null || v === undefined || !Number.isFinite(v)) return null;
		s += v;
	}
	return s;
}

/** The months before the decision date this part compares: the six before it, as the season's mirror. */
export const LEAD_MONTHS = 6;

/** The same day and month `years` earlier (29 February → 28 February). */
function yearsBefore(isoDate: string, years: number): string {
	const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
	const day = m === 2 && d === 29 ? 28 : d;
	return `${y - years}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function monthsBefore(isoDate: string, months: number): string {
	const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
	const t = new Date(Date.UTC(y, m - 1 - months, 1));
	const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
	return iso(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(d, last)) / DAY);
}

export type InflowClass = 'below' | 'near' | 'above';
export const INFLOW_CLASS_LABEL: Readonly<Record<InflowClass, string>> = Object.freeze({ below: 'Below normal', near: 'Near normal', above: 'Above normal' });

export interface LeadInflow {
	/** "Apr – Sep". */
	months: string;
	m3: number;
	text: string;
	/** This year's total ÷ the median of the other years' same months; null with too few years. */
	ofMedian: string | null;
	/** By the thirds of the other years' totals; null with fewer than 3 of them. */
	cls: InflowClass | null;
	nYears: number;
}

export interface SeasonNatural {
	median: string;
	band: string;
	nYears: number;
}

/**
 * The natural flow at the outlet before the season and over it in the
 * analogue years, from the base run's natural_flow: the six months before
 * the decision date against the same months in each earlier year of the
 * record, and the season's own window in each analogue year, as it happened
 * (not run from this season's start: that member flow isn't stored).
 */
export function naturalContext(
	natural: { startDate: string; values: readonly (number | null)[] },
	decisionDate: string,
	analogues: readonly { from: string; to: string }[]
): { inflow: LeadInflow | null; season: SeasonNatural | null } {
	const end = iso(epoch(decisionDate) - 1);
	const start = monthsBefore(decisionDate, LEAD_MONTHS);
	const now = windowTotal(natural, start, end);
	let inflow: LeadInflow | null = null;
	if (now !== null) {
		const others: number[] = [];
		for (let k = 1; k < 200; k++) {
			const from = yearsBefore(start, k);
			if (epoch(from) < epoch(natural.startDate)) break;
			const v = windowTotal(natural, from, iso(epoch(yearsBefore(decisionDate, k)) - 1));
			if (v !== null) others.push(v);
		}
		const sorted = [...others].sort((a, b) => a - b);
		const median = sorted.length ? quantile(sorted, 0.5) : null;
		const cls: InflowClass | null = sorted.length >= 3 ? (now < quantile(sorted, 1 / 3) ? 'below' : now > quantile(sorted, 2 / 3) ? 'above' : 'near') : null;
		const m0 = Number(start.slice(5, 7));
		const m1 = Number(end.slice(5, 7));
		inflow = {
			months: `${monthName(m0)} – ${monthName(m1)}`,
			m3: now,
			text: volume(now),
			ofMedian: median !== null && median > 0 ? pct(now / median) : null,
			cls,
			nYears: sorted.length
		};
	}
	const seasons = analogues.map((a) => windowTotal(natural, a.from, a.to)).filter((v): v is number => v !== null).sort((a, b) => a - b);
	const season: SeasonNatural | null = seasons.length
		? { median: volume(quantile(seasons, 0.5)), band: `${volume(quantile(seasons, 0.1))} – ${volume(quantile(seasons, 0.9))}`, nYears: seasons.length }
		: null;
	return { inflow, season };
}

export type OutlookRisk = 'lower' | 'increasing' | 'high';
export const OUTLOOK_RISK_LABEL: Readonly<Record<OutlookRisk, string>> = Object.freeze({ lower: 'Lower risk', increasing: 'Increasing risk', high: 'High risk' });

export interface LevelOutcome {
	id: string;
	label: string;
	/** "Today’s demand", "15 % less demand"; null for a monthly plan. */
	description: string | null;
	/** A monthly plan's months as typed ("Oct – Dec 100 %, Jan – Apr 80 %"); null for a plain level. */
	plan: string | null;
	/** Median irrigation supplied to the hydrological units over the season, across the years. */
	supplied: string;
	/** Median dams at the season's end, and as a share of capacity. */
	endStorage: string;
	endShare: string | null;
	/** "9 of 12 years". */
	met: string;
	/** Met in full in at least the planning share of years. */
	meetsShare: boolean;
	planning: boolean;
}

export interface TriggerAction {
	band: string;
	level: string | null;
	/** The band's level beside the planning figure, in words. */
	vsPlanning: string;
	tone: 'above' | 'same' | 'below' | 'none';
}

export interface Briefing {
	/** The season's months, "1 Oct 2018 – 30 Apr 2019". */
	season: string;
	decision: string;
	storage: { text: string; share: string | null } | null;
	risk: { level: OutlookRisk; label: string; text: string } | null;
	/** The planning figure's level; its sentence is the view's (describePlanningFigure). */
	planning: { label: string } | null;
	levels: LevelOutcome[];
	/** The monthly plans in the outlook; empty when it has none. */
	plans: { label: string; months: { month: string; pct: string }[] }[];
	triggers: TriggerAction[];
	messages: string[];
}

/** A level's ops in words (levelDescription) when it is one plain demand.scale on every unit; null otherwise (a monthly plan). */
export function levelWords(ops: readonly ScenarioOp[]): string | null {
	if (ops.length !== 1) return null;
	const op = ops[0] as { op: string; factor?: number; months?: unknown; nodeIds?: unknown };
	if (op.op !== 'demand.scale' || typeof op.factor !== 'number' || op.months !== undefined || op.nodeIds !== undefined) return null;
	return levelDescription(Math.round(op.factor * 1000) / 10);
}

/** A monthly plan's months, in season order, from its demand.scale ops with months. */
export function planMonths(ops: readonly ScenarioOp[], seasonMonths: readonly number[]): { month: string; pct: string }[] | null {
	const byMonth = new Map<number, number>();
	for (const o of ops as { op: string; factor?: number; months?: number[] }[]) {
		if (o.op !== 'demand.scale' || typeof o.factor !== 'number' || !Array.isArray(o.months)) return null;
		for (const m of o.months) byMonth.set(m, o.factor);
	}
	if (!byMonth.size) return null;
	return seasonMonths.map((m) => ({ month: monthName(m), pct: `${fmtNum((byMonth.get(m) ?? 1) * 100, 1, true)} %` }));
}

const median = (xs: number[]) => (xs.length ? quantile([...xs].sort((a, b) => a - b), 0.5) : null);

/** The briefing for a complete outlook. `seasonMonths`: the months of its season (view.ts seasonMonths). */
export function buildBriefing(
	outlook: Pick<Outlook, 'decisionDate' | 'seasonEnd' | 'levels' | 'reviewDate'> & { result: OutlookResult; triggers?: Outlook['triggers'] },
	seasonMonths: readonly number[]
): Briefing {
	const r = outlook.result;
	const p = r.planning;
	const opsOf = new Map(outlook.levels.map((l) => [l.id, l.ops] as const));
	const cap = r.capacityM3;
	const ran = r.levels.filter((l) => !l.problems.length);
	const reserve = r.metric === 'reserveMonthsMet';
	const req = reserve ? 'the Reserve' : 'the EWR';

	const levels: LevelOutcome[] = ran.map((l) => {
		const ops = opsOf.get(l.id) ?? [];
		const plan = planMonths(ops, seasonMonths);
		const supplied = median(l.years.map((y) => y.suppliedM3));
		const end = l.seasonEndStorageM3?.p50 ?? median(l.years.map((y) => y.seasonEndStorageM3).filter((v): v is number => v !== null));
		return {
			id: l.id,
			label: l.label,
			description: levelWords(ops),
			plan: plan ? plan.map((m) => `${m.month} ${m.pct}`).join(', ') : null,
			supplied: supplied === null ? '–' : volume(supplied),
			endStorage: end === null ? '–' : volume(end),
			endShare: end !== null && cap > 0 ? pct(end / cap) : null,
			met: `${l.yearsEwrMet} of ${l.nYears} years`,
			meetsShare: l.nYears > 0 && l.yearsEwrMet / l.nYears >= p.share - 1e-12,
			planning: p.reason === 'met' && p.levelId === l.id
		};
	});

	// The risk at the highest demand run: met in the share there (lower), only at a lower level (increasing), at none (high).
	let risk: Briefing['risk'] = null;
	if (p.reason === 'met' || p.reason === 'noLevelMeets') {
		const top = p.ranked[0]!;
		const share = pct(p.share);
		if (top.meets) risk = { level: 'lower', label: OUTLOOK_RISK_LABEL.lower, text: `At ${top.label}, the highest level run, ${req} was met in full in ${top.yearsMet} of ${top.nYears} past seasons: at least the planning share (${share}).` };
		else if (p.reason === 'met')
			risk = {
				level: 'increasing',
				label: OUTLOOK_RISK_LABEL.increasing,
				text: `At ${top.label}, ${req} was met in full in ${top.yearsMet} of ${top.nYears} past seasons, under the planning share (${share}); ${p.label} met it in ${p.yearsMet} of ${p.nYears}.`
			};
		else risk = { level: 'high', label: OUTLOOK_RISK_LABEL.high, text: `No level run met ${req} in full in the planning share (${share}) of past seasons; at ${top.label} it was met in ${top.yearsMet} of ${top.nYears}.` };
	}

	const plans = ran
		.map((l) => ({ label: l.label, months: planMonths(opsOf.get(l.id) ?? [], seasonMonths) }))
		.filter((x): x is { label: string; months: { month: string; pct: string }[] } => x.months !== null);

	// Each band's level beside the planning figure, by the ranking's order (highest demand first).
	const rank = new Map(p.ranked.map((x, i) => [x.label, i] as const));
	const table: OutlookTriggerTable | null | undefined = outlook.triggers?.table;
	const triggers: TriggerAction[] = (table?.rows ?? []).map((row) => {
		const band = row.band.fromM3 > 0 ? `At or above ${volume(row.band.fromM3)}` : `Below ${volume(row.band.toM3)}`;
		const lv = row.level?.label ?? null;
		if (!lv) return { band, level: null, vsPlanning: `No level met ${req} in the planning share from this storage`, tone: 'none' };
		if (p.reason !== 'met' || !p.label) return { band, level: lv, vsPlanning: 'No planning figure to compare with', tone: 'none' };
		const a = rank.get(lv);
		const b = rank.get(p.label);
		if (a === undefined || b === undefined) return { band, level: lv, vsPlanning: '–', tone: 'none' };
		return a === b
			? { band, level: lv, vsPlanning: 'The planning figure', tone: 'same' }
			: a < b
				? { band, level: lv, vsPlanning: `More than the planning figure (${p.label})`, tone: 'above' }
				: { band, level: lv, vsPlanning: `Less than the planning figure (${p.label})`, tone: 'below' };
	});

	const messages: string[] = [];
	if (p.reason === 'met' && p.label) messages.push(`In past seasons from this start, ${p.label} met ${req} in full in ${p.yearsMet} of ${p.nYears} years: the highest level to do so in at least ${pct(p.share)} of them.`);
	else if (p.reason === 'noLevelMeets') messages.push(`In past seasons from this start, no level run met ${req} in full in ${pct(p.share)} of the years.`);
	const top = ran[0] ? levels[0] : null;
	const topLevel = ran[0];
	if (top && topLevel?.demandMet) messages.push(`At ${top.label}, hydrological units got a median ${pct(topLevel.demandMet.p50)} of their demand over the season (10–90 %: ${pct(topLevel.demandMet.p10)} – ${pct(topLevel.demandMet.p90)}).`);
	const review = outlook.triggers?.reviewDate ?? outlook.reviewDate ?? null;
	if (review && triggers.length) messages.push(`On ${fmtDay(review)} the dams’ storage is read again: the review triggers give the level that met ${req} from each band of storage.`);
	messages.push('All of this is worked out from past weather, not a forecast or a promise. The WUA decides the season’s level and publishes it as the restriction notice.');

	return {
		season: `${fmtDay(outlook.decisionDate)} – ${fmtDay(outlook.seasonEnd)}`,
		decision: fmtDay(outlook.decisionDate),
		storage: r.startStorageM3 === null ? null : { text: volume(r.startStorageM3), share: cap > 0 ? pct(r.startStorageM3 / cap) : null },
		risk,
		planning: p.reason === 'met' && p.label ? { label: p.label } : null,
		levels,
		plans,
		triggers,
		messages
	};
}

// ─── 6. The projected water balance by month (engine ≥ 1.115.0) ─────────────

/** What the month-by-month part draws for one level, or why it can't. */
export type BalanceView =
	| {
			ok: true;
			levelId: string;
			label: string;
			/** The planning figure's level (the default shown). */
			planning: boolean;
			/** The axis unit: million m³ when the biggest month reaches a million, else thousand m³. */
			unit: { div: number; text: string };
			months: BalanceMonth[];
			/** The dams' capacity on the season's last day; 0 without a dam. */
			capacityM3: number;
	  }
	| { ok: false; reason: 'old' | 'fewYears' | 'none'; text: string };

/** One month: each figure's median across the analogue years (so the parts need not add up to one year's), and the storage's 10–90 % range. */
export interface BalanceMonth {
	month: string;
	/** "Oct", or "Oct (from 15th)" for a month the season only partly covers. */
	name: string;
	days: number;
	irrigation: number;
	irrigationDemand: number;
	otherUsers: number;
	ewr: number;
	ewrRequired: number;
	damLoss: number;
	storage: { p10: number; p50: number; p90: number } | null;
}

/** The parts drawn, bottom to top, with their words: the legend and the table read from this. */
export const BALANCE_PARTS = [
	{ key: 'irrigation', label: 'Irrigation supplied' },
	{ key: 'otherUsers', label: 'Other water users supplied' },
	{ key: 'ewr', label: 'EWR the river carried' },
	{ key: 'damLoss', label: 'Lost from the dams' }
] as const;

/**
 * The month-by-month balance of one level: `levelId` when given and run, else
 * the planning figure's, else the highest level run. Not drawn for an outlook
 * computed before engine 1.115.0 (its members have no months: run it again),
 * or with fewer than the minimum of years (no percentiles, as the rest).
 */
export function buildBalance(outlook: { result: OutlookResult }, levelId: string | null): BalanceView {
	const r = outlook.result;
	const ran = r.levels.filter((l) => !l.problems.length);
	if (!ran.length) return { ok: false, reason: 'none', text: 'No level ran, so there is no month to show.' };
	const planningId = r.planning.reason === 'met' ? r.planning.levelId : null;
	const l = ran.find((x) => x.id === levelId) ?? ran.find((x) => x.id === planningId) ?? ran[0]!;
	if (!r.enoughYears) return { ok: false, reason: 'fewYears', text: 'Too few analogue years for a median month by month, as for the rest of the outlook.' };
	// `months` is absent (not null) on a level stored before engine 1.115.0.
	const months = l.months ?? null;
	if (!months) return { ok: false, reason: 'old', text: 'This outlook was worked out before the app kept each season’s months. Run it again to see them.' };
	const rows: BalanceMonth[] = months.map((m, k) => {
		const mm = Number(m.month.slice(5, 7));
		const first = k === 0 && m.days < daysIn(m.month) ? Number(r.decisionDate.slice(8, 10)) : null;
		const last = k === months.length - 1 && m.days < daysIn(m.month) && first === null ? Number(r.seasonEnd.slice(8, 10)) : null;
		const name = monthName(mm) + (first !== null && first > 1 ? ` (from the ${ordinal(first)})` : last !== null ? ` (to the ${ordinal(last)})` : '');
		return {
			month: m.month,
			name,
			days: m.days,
			irrigation: m.suppliedM3.p50,
			irrigationDemand: m.demandM3.p50,
			otherUsers: m.userSuppliedM3.p50,
			ewr: m.ewrMetM3.p50,
			ewrRequired: m.ewrM3.p50,
			damLoss: m.damLossM3.p50,
			storage: m.storageEndM3
		};
	});
	const top = Math.max(...rows.map((m) => Math.max(m.irrigation + m.otherUsers + m.ewr + m.damLoss, m.storage?.p90 ?? 0, r.capacityM3)), 0);
	const unit = top >= 1e6 ? { div: 1e6, text: 'million m³' } : { div: 1e3, text: 'thousand m³' };
	return { ok: true, levelId: l.id, label: l.label, planning: l.id === planningId, unit, months: rows, capacityM3: r.capacityM3 };
}

const daysIn = (ym: string) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
const ordinal = (d: number) => `${d}${d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th'}`;
