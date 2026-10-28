// The seasonal outlook conditioned on C3S seasonal forecasts (issue #620
// step 6, docs/model.md §2.15d): the chance of each drought restriction level
// on each review date, from members built out of the forecast systems'
// members and the ESP's own analogue years, with a hindcast skill gate.
//
// Per forecast system (a centre's model, e.g. ecmwf-51) with a hindcast:
//  1. Quantile mapping (./qm.ts). Each lead month's totals (lead 0 = the init
//     month) are mapped onto the base run's monthly rain_final for the same
//     calendar month, fitted per system × lead month (so per calendar month)
//     on the hindcast years whose month the record holds wholly before the
//     decision date; the forecast sample pools every member of those years.
//     A cell with fewer than FORECAST_MIN_HINDCAST_YEARS years fails the
//     system, which is then left out with the reason.
//  2. A member: its mapped totals pick the nearest ESP analogue year, by the
//     root mean square of the differences from each analogue's totals over
//     the same months, each month standardised by the analogues' spread (as
//     ./climate.ts's distance); ties to the newer year. The analogue's daily
//     rain in each month is rescaled by mapped ÷ analogue total (the same
//     calendar month in the analogue's year), so a month with the analogue's
//     own total keeps its days to the bit, and each unit's rain under §2.4h
//     takes the same factor. A month whose analogue total is under
//     FORECAST_MIN_PATTERN_MM when the member asks for at least that much
//     borrows the daily pattern of the next-nearest analogue with rain that
//     month (no pattern to rescale); a season month the forecast doesn't
//     reach keeps the analogue's own days. The member then runs through
//     runOutlookMemberRun from the base run's snapshot, so it shares the
//     history with every ESP member.
//  3. The systems are weighted equally, and each system's members equally
//     within it, so a 51-member system doesn't outweigh a 7-member one.
//  4. Chances: per review date, the weighted share of members whose storage
//     (the rule's basis) at the start of the day is below each level's
//     belowPct, with "no restriction" for none; without a drought restriction
//     rule, the review triggers' storage bands (§2.15a) instead.
//  5. Skill: CRPSS of season-end storage against the ESP over the hindcast
//     years, from the season's own state (./skill.ts); the forecast leads
//     only above 0.
// With no forecast, no hindcast or no system that qualifies the result says
// so and runs nothing: the caller keeps the ESP, which is never touched here.
//
// Pure: no I/O. Deterministic.
import { fromEpochDay, toEpochDay } from '../calendar';
import { damCapacityOn } from '../network/development';
import { planRestriction, resolveDroughtRestriction, restrictionLevelFor } from '../network/restriction';
import { UNIT_RAIN_SERIES, type DroughtRestrictionRule, type ModelInput, type ModelOutput } from '../project';
import type { ScenarioOp } from '../scenario/ops';
import type { ModelStateSnapshot } from '../warmstart/snapshot';
import {
	OUTLOOK_MIN_YEARS,
	outlookAnalogues,
	outlookBaseAndSnapshot,
	outlookLevelProblems,
	outlookSeasonInput,
	runOutlookMemberRun,
	withoutDroughtRestriction,
	type OutlookBaseRun,
	type OutlookMember
} from './outlook';
import { applyQuantileMap, fitQuantileMap, type QuantileMap } from './qm';
import { resolveSeason, type OutlookAnalogue, type OutlookSeason, type ResolvedSeason } from './season';
import { crpsEnsemble, crpss } from './skill';
import { defaultReviewDate, reviewStorageHistory, storageBands, tercileEdges } from './triggers';

/** One system's forecast from one init month: each member's catchment-average monthly totals (mm). */
export interface SeasonalForecastSystem {
	/** e.g. 'ecmwf-51'. */
	system: string;
	/** 'YYYY-MM': the init month; its forecasts start on its 1st. */
	init: string;
	/** Index 0 = the init month (lead month 0), 1 = the next, …; only complete months. */
	members: { monthlyMm: number[] }[];
}

/** One system's hindcast for one init calendar month: for each hindcast year, each member's monthly totals (mm), same lead indexing. */
export interface SeasonalHindcastSystem {
	system: string;
	/** 1 … 12. */
	initMonth: number;
	years: { year: number; members: { monthlyMm: number[] }[] }[];
}

/** Fewest hindcast years a lead month's map is fitted on (the issue's open question 2); a leave-one-out fit for the skill score needs one fewer. */
export const FORECAST_MIN_HINDCAST_YEARS = 20;
/** A month total (mm) under which an analogue has no daily pattern to rescale (the zero-month rule). */
export const FORECAST_MIN_PATTERN_MM = 1;

// ─── Calendar months ────────────────────────────────────────────────────────

const pad = (v: number, n: number) => String(v).padStart(n, '0');
/** A month as one integer: year × 12 + month − 1. */
const monthOfDay = (day: number) => {
	const s = fromEpochDay(day);
	return Number(s.slice(0, 4)) * 12 + Number(s.slice(5, 7)) - 1;
};
const monthText = (i: number) => `${pad(Math.floor(i / 12), 4)}-${pad((i % 12) + 1, 2)}`;
const monthFirstDay = (i: number) => toEpochDay(`${monthText(i)}-01`);
/** 'YYYY-MM' → its month integer, or null. */
function parseMonth(v: unknown): number | null {
	if (typeof v !== 'string' || !/^\d{4}-\d{2}$/.test(v)) return null;
	const m = Number(v.slice(5, 7));
	return m >= 1 && m <= 12 ? Number(v.slice(0, 4)) * 12 + m - 1 : null;
}

/** One calendar month of a season: its month and its first and last season day (0-based, inclusive). */
export interface SeasonMonth {
	month: string;
	index: number;
	firstDay: number;
	lastDay: number;
}

/** The calendar months a season's days fall in, in order. */
export function seasonMonths(season: OutlookSeason): SeasonMonth[] {
	const s = resolveSeason(season);
	const out: SeasonMonth[] = [];
	for (let i = 0; i < s.days; ) {
		const index = monthOfDay(s.from + i);
		const last = Math.min(s.days - 1, monthFirstDay(index + 1) - 1 - s.from);
		out.push({ month: monthText(index), index, firstDay: i, lastDay: last });
		i = last + 1;
	}
	return out;
}

const rainOf = (run: OutlookBaseRun) => {
	const r = run.series.find((x) => x.nodeId === null && x.key === 'rain_final')?.values;
	if (!r) throw new Error('the base run has no rain_final series (no rainfall): a forecast-conditioned outlook needs historical rain');
	return r;
};

/** Σ rain over calendar month `m`, or null when a day of it is outside the run, has no value, or is on or after epoch day `before`. */
function monthTotal(rain: readonly number[], r0: number, m: number, before = Number.POSITIVE_INFINITY): number | null {
	const a = monthFirstDay(m);
	const b = monthFirstDay(m + 1) - 1;
	if (a < r0 || b - r0 >= rain.length || b >= before) return null;
	let sum = 0;
	for (let d = a; d <= b; d++) {
		const v = rain[d - r0];
		if (typeof v !== 'number' || !Number.isFinite(v)) return null;
		sum += v;
	}
	return sum;
}

/** The analogue's month offset from the season: its month k is the season's month k shifted by this many months. */
const analogueShift = (s: ResolvedSeason, a: OutlookAnalogue) => monthOfDay(toEpochDay(a.from)) - monthOfDay(s.from);

/**
 * An analogue's rain total (the base run's rain_final, mm) in each season
 * month's calendar month of the analogue's own year (a whole month, also
 * where the season holds only part of it); null where the run doesn't hold
 * the whole month with a value every day.
 */
export function analogueMonthlyTotals(baseRun: OutlookBaseRun, season: OutlookSeason, analogue: OutlookAnalogue): (number | null)[] {
	const s = resolveSeason(season);
	const rain = rainOf(baseRun);
	const r0 = toEpochDay(baseRun.startDate);
	const shift = analogueShift(s, analogue);
	return seasonMonths(season).map((m) => monthTotal(rain, r0, m.index + shift));
}

// ─── Members ────────────────────────────────────────────────────────────────

/** An analogue year as a candidate: its month totals, and its distance from a member once ranked. */
export interface RankedAnalogue {
	analogue: OutlookAnalogue;
	totals: readonly (number | null)[];
	distance: number;
}

/** The sample standard deviation (n − 1); 0 below two values. */
function sd(v: readonly number[]): number {
	if (v.length < 2) return 0;
	const m = v.reduce((a, b) => a + b, 0) / v.length;
	return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}

/**
 * The candidates nearest a member's mapped totals first (`mapped` per season
 * month; null = a month the member doesn't give). Distance: the root mean
 * square over the member's months of (mapped − analogue total) ÷ the
 * analogues' standard deviation that month (a month alike in every analogue
 * adds 0). A candidate without a total in one of the member's months is left
 * out. Ties go to the newer year.
 */
export function rankAnalogues(mapped: readonly (number | null)[], candidates: readonly { analogue: OutlookAnalogue; totals: readonly (number | null)[] }[]): RankedAnalogue[] {
	const ks = mapped.flatMap((v, k) => (v === null ? [] : [k]));
	const ok = candidates.filter((c) => ks.every((k) => c.totals[k] !== null && c.totals[k] !== undefined));
	const scale = ks.map((k) => sd(ok.map((c) => c.totals[k]!)));
	return ok
		.map((c) => {
			let sum = 0;
			ks.forEach((k, j) => {
				const d = scale[j]! > 0 ? (mapped[k]! - c.totals[k]!) / scale[j]! : 0;
				sum += d * d;
			});
			return { analogue: c.analogue, totals: c.totals, distance: ks.length ? Math.sqrt(sum / ks.length) : 0 };
		})
		.sort((x, y) => x.distance - y.distance || y.analogue.waterYear - x.analogue.waterYear);
}

/** How one season month of a member was made. */
export interface ForecastMemberMonth {
	month: string;
	/** The member's mapped total (mm); null where the forecast doesn't reach the month (the analogue's own days). */
	mappedMm: number | null;
	/** The analogue's own total that month (mm). */
	analogueMm: number | null;
	/** The factor on the month's days: mapped ÷ the pattern's total, 1 where nothing is rescaled. */
	factor: number;
	/** The analogue year whose days the month took under the zero-month rule; null = the member's own analogue. */
	patternYear: number | null;
}

/**
 * The base run as a member sees it: rain_final and each unit's rain_unit with
 * the analogue's season days rescaled month by month to `mapped` (module
 * header, step 2), every other day as recorded; only those series, which is
 * all outlookSeasonInput reads from a base run. `ranked[0]` is the member's
 * analogue, the rest the order the zero-month rule looks for a pattern in.
 * A month with mapped equal to the analogue's own total has factor 1, so its
 * values are the base run's to the bit.
 */
export function forecastMemberBaseRun(
	baseRun: OutlookBaseRun,
	season: OutlookSeason,
	ranked: readonly RankedAnalogue[],
	mapped: readonly (number | null)[]
): { baseRun: OutlookBaseRun; analogue: OutlookAnalogue; months: ForecastMemberMonth[]; warnings: string[] } {
	resolveSeason(season);
	const chosen = ranked[0];
	if (!chosen) throw new RangeError('no analogue year to build a forecast member on');
	const r0 = toEpochDay(baseRun.startDate);
	const from = (a: OutlookAnalogue) => toEpochDay(a.from) - r0;
	const sources = baseRun.series.filter((x) => (x.nodeId === null && x.key === 'rain_final') || (x.nodeId !== null && x.key === UNIT_RAIN_SERIES.rain.key));
	if (!sources.some((x) => x.nodeId === null)) rainOf(baseRun);
	const copies = sources.map((x) => x.values.slice());
	const warnings: string[] = [];
	const months: ForecastMemberMonth[] = seasonMonths(season).map((m, k) => {
		const M = mapped[k] ?? null;
		const T = chosen.totals[k] ?? null;
		if (M === null || T === null) return { month: m.month, mappedMm: M, analogueMm: T, factor: 1, patternYear: null };
		let pattern = chosen;
		if (T < FORECAST_MIN_PATTERN_MM && M >= FORECAST_MIN_PATTERN_MM) {
			const donor = ranked.slice(1).find((r) => (r.totals[k] ?? -1) >= FORECAST_MIN_PATTERN_MM);
			if (donor) pattern = donor;
			else if (!(T > 0)) {
				warnings.push(`${m.month}: no analogue year had rain that month, so the member's ${M.toFixed(1)} mm can't be laid on any day; the month stays dry`);
				return { month: m.month, mappedMm: M, analogueMm: T, factor: 1, patternYear: null };
			}
		}
		const PT = pattern.totals[k]!;
		// 0 ÷ 0: a dry month asked to stay dry has nothing to scale. Under the pattern minimum with M also under it: the
		// analogue's few millimetres scaled as they are (M − T is under 1 mm either way).
		const factor = PT > 0 ? M / PT : 1;
		const a = from(chosen.analogue);
		const p = from(pattern.analogue);
		for (let j = 0; j < sources.length; j++) {
			const src = sources[j]!.values;
			const dst = copies[j]!;
			for (let i = m.firstDay; i <= m.lastDay; i++) {
				const v = src[p + i];
				if (typeof v === 'number' && Number.isFinite(v)) dst[a + i] = v * factor;
			}
		}
		return { month: m.month, mappedMm: M, analogueMm: T, factor, patternYear: pattern === chosen ? null : pattern.analogue.waterYear };
	});
	return { baseRun: { startDate: baseRun.startDate, days: baseRun.days, series: sources.map((x, j) => ({ ...x, values: copies[j]! })) }, analogue: chosen.analogue, months, warnings };
}

// ─── Systems and their maps ─────────────────────────────────────────────────

/** A member's complete months: its values up to the first that isn't a finite number ≥ 0 (NaN padding, a gap). */
function completeMonths(v: unknown): number[] {
	if (!Array.isArray(v)) return [];
	const out: number[] = [];
	for (const x of v) {
		if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) break;
		out.push(x);
	}
	return out;
}

/** How a system was used: its members, the hindcast years each lead month was fitted on, and why it was left out. */
export interface ForecastSystemReport {
	system: string;
	init: string;
	/** Members with at least one complete month, and those left out without one. */
	members: number;
	membersDropped: number;
	/** The season months it gives, each with its lead and the hindcast years its map was fitted on. */
	months: { month: string; lead: number; years: number[] }[];
	used: boolean;
	/** Its share of the ensemble (1 ÷ systems used); 0 when not used. */
	weight: number;
	reason: string | null;
}

interface Cell {
	k: number;
	lead: number;
	years: number[];
	map: QuantileMap | null;
}

interface PreparedSystem {
	report: ForecastSystemReport;
	members: number[][];
	hindcast: Map<number, number[][]>;
	leads: { k: number; lead: number }[];
	cells: Cell[];
}

/** The map of each lead, fitted on the hindcast years whose calendar month the record holds wholly before `before`, leaving out `exclude`. */
function fitCells(hindcast: Map<number, number[][]>, initMonth: number, leads: readonly { k: number; lead: number }[], rain: readonly number[], r0: number, before: number, exclude?: number): Cell[] {
	return leads.map(({ k, lead }) => {
		const years: number[] = [];
		const fc: number[] = [];
		const obs: number[] = [];
		for (const [year, members] of hindcast) {
			if (year === exclude) continue;
			const o = monthTotal(rain, r0, year * 12 + initMonth - 1 + lead, before);
			if (o === null) continue;
			const vals = members.flatMap((m) => (lead < m.length ? [m[lead]!] : []));
			if (!vals.length) continue;
			years.push(year);
			obs.push(o);
			fc.push(...vals);
		}
		return { k, lead, years, map: years.length ? fitQuantileMap(fc, obs) : null };
	});
}

/** Each forecast paired with its hindcast, its months and its maps; one init for every system (the first forecast's). */
function prepareSystems(forecasts: readonly SeasonalForecastSystem[], hindcasts: readonly SeasonalHindcastSystem[], season: ResolvedSeason, baseRun: OutlookBaseRun): PreparedSystem[] {
	const rain = rainOf(baseRun);
	const r0 = toEpochDay(baseRun.startDate);
	const months = seasonMonths(season);
	const init0 = forecasts.map((f) => parseMonth(f.init)).find((x) => x !== null) ?? null;
	const seen = new Set<string>();
	const out: PreparedSystem[] = [];
	for (const f of forecasts) {
		const members = (f.members ?? []).map((m) => completeMonths(m?.monthlyMm));
		const kept = members.filter((m) => m.length > 0);
		const report: ForecastSystemReport = { system: String(f.system), init: String(f.init), members: kept.length, membersDropped: members.length - kept.length, months: [], used: false, weight: 0, reason: null };
		const prepared: PreparedSystem = { report, members: kept, hindcast: new Map(), leads: [], cells: [] };
		out.push(prepared);
		const init = parseMonth(f.init);
		const fail = (why: string) => {
			report.reason = why;
		};
		if (init === null) {
			fail(`its init "${String(f.init)}" isn't a month (YYYY-MM)`);
			continue;
		}
		if (seen.has(report.system)) {
			fail('listed twice; the first is used');
			continue;
		}
		seen.add(report.system);
		if (init !== init0) {
			fail(`its init ${f.init} differs from the other systems' ${monthText(init0!)}: one outlook takes one init`);
			continue;
		}
		if (!kept.length) {
			fail('no member has a complete month');
			continue;
		}
		const initMonth = (init % 12) + 1;
		const h = hindcasts.find((x) => x.system === f.system && x.initMonth === initMonth);
		if (!h) {
			fail(`no hindcast for its ${monthText(init).slice(5)} init`);
			continue;
		}
		for (const y of h.years ?? []) {
			if (!Number.isInteger(y?.year) || prepared.hindcast.has(y.year)) continue;
			const ms = (y.members ?? []).map((m) => completeMonths(m?.monthlyMm)).filter((m) => m.length > 0);
			if (ms.length) prepared.hindcast.set(y.year, ms);
		}
		const reach = Math.min(...kept.map((m) => m.length));
		prepared.leads = months.flatMap((m, k) => {
			const lead = m.index - init;
			return lead >= 0 && lead < reach ? [{ k, lead }] : [];
		});
		if (!prepared.leads.length) {
			fail('its months reach no month of the season');
			continue;
		}
		prepared.cells = fitCells(prepared.hindcast, initMonth, prepared.leads, rain, r0, season.from);
		report.months = prepared.cells.map((c) => ({ month: months[c.k]!.month, lead: c.lead, years: c.years }));
		const short = prepared.cells.find((c) => c.years.length < FORECAST_MIN_HINDCAST_YEARS);
		if (short) {
			fail(`lead month ${short.lead} (${months[short.k]!.month.slice(5)}) has ${short.years.length} hindcast year${short.years.length === 1 ? '' : 's'} the record holds before the decision date; at least ${FORECAST_MIN_HINDCAST_YEARS} are needed`);
			continue;
		}
		report.used = true;
	}
	const used = out.filter((p) => p.report.used);
	for (const p of used) p.report.weight = 1 / used.length;
	return out;
}

/** A member's mapped totals per season month (null where the system doesn't reach it). */
function mapMember(monthly: readonly number[], cells: readonly Cell[], nMonths: number): (number | null)[] | null {
	const out = new Array<number | null>(nMonths).fill(null);
	for (const c of cells) {
		if (c.lead >= monthly.length || !c.map) return null;
		out[c.k] = applyQuantileMap(c.map, monthly[c.lead]!);
	}
	return out;
}

// ─── Restriction levels on a review date ────────────────────────────────────

/** One outcome on a review date: a restriction level (rule) or a storage band (no rule), best first. */
export interface RestrictionCategory {
	id: string;
	label: string;
	/** Rule: the level's threshold (null for "no restriction"). */
	belowPct: number | null;
	/** Bands: the band's total storage range, m³. */
	fromM3: number | null;
	toM3: number | null;
	chance: number;
}

export interface RestrictionChances {
	reviewDate: string;
	basis: 'rule' | 'bands';
	categories: RestrictionCategory[];
}

interface CategoryPlan {
	reviewDate: string;
	day: number;
	basis: 'rule' | 'bands';
	categories: Omit<RestrictionCategory, 'chance'>[];
	classify: (storage: Readonly<Record<string, number>>) => number;
}

const farmDams = (input: ModelInput) => input.model.nodes.filter((n) => n.kind === 'farm' && n.damCapacityM3 > 0);

/** The review dates: given ones, else the rule's in the season, else the review triggers' default. */
function reviewDays(rule: DroughtRestrictionRule | null, s: ResolvedSeason, given: readonly string[] | undefined): number[] {
	if (given) {
		return [...new Set(given.map((d) => {
			const day = toEpochDay(resolveSeason({ decisionDate: d, seasonEnd: d }).decisionDate);
			if (day < s.from || day > s.to) throw new RangeError(`review date ${d} is outside the season ${s.decisionDate} – ${s.seasonEnd}`);
			return day;
		}))].sort((a, b) => a - b);
	}
	if (rule) {
		const md = new Set(rule.reviewDates);
		const out: number[] = [];
		for (let d = s.from; d <= s.to; d++) if (md.has(fromEpochDay(d).slice(5))) out.push(d);
		return out;
	}
	return s.days >= 2 ? [toEpochDay(defaultReviewDate(s))] : [];
}

/** How each review date's storage falls into categories (module header, step 4). */
function planCategories(rule: DroughtRestrictionRule | null, input: ModelInput, baseRun: OutlookBaseRun, s: ResolvedSeason, days: readonly number[], warnings: string[]): CategoryPlan[] {
	const nodes = input.model.nodes;
	return days.map((day) => {
		const reviewDate = fromEpochDay(day);
		const plan = rule ? planRestriction(rule, nodes, day, 1, warnings) : null;
		if (rule && plan) {
			const level = (ids: readonly number[], st: Readonly<Record<string, number>>) => {
				let q = 0;
				let c = 0;
				for (const i of ids) {
					const cap = damCapacityOn(nodes[i]!, day);
					if (!(cap > 0)) continue;
					q += st[nodes[i]!.id] ?? 0;
					c += cap;
				}
				return c > 0 ? restrictionLevelFor(q / c, plan.thresholds) : 0;
			};
			return {
				reviewDate,
				day,
				basis: 'rule' as const,
				categories: [
					{ id: 'level-0', label: 'No restriction', belowPct: null, fromM3: null, toM3: null },
					...rule.levels.map((l, i) => ({ id: `level-${i + 1}`, label: l.label?.trim() || `Level ${i + 1}`, belowPct: l.belowPct, fromM3: null, toM3: null }))
				],
				classify: (st) => {
					if (plan.shared) return level(Array.from(plan.dams), st);
					let deepest = 0;
					for (let i = 0; i < nodes.length; i++) if (plan.inScope[i] && plan.ownDam[i]! >= 0) deepest = Math.max(deepest, level([plan.ownDam[i]!], st));
					return deepest;
				}
			};
		}
		// No rule: the review triggers' bands (§2.15a), from the years known before the decision date, fullest first.
		const samples = reviewStorageHistory(input, baseRun, reviewDate).filter((x) => toEpochDay(x.date) <= s.from);
		const cap = farmDams(input).reduce((a, n) => a + damCapacityOn(n, day), 0);
		const { bands, warnings: w } = storageBands(tercileEdges(samples), cap);
		warnings.push(...w.map((x) => `${reviewDate}: ${x}`));
		const top = bands.length - 1;
		return {
			reviewDate,
			day,
			basis: 'bands' as const,
			categories: bands.map((_, j) => {
				const b = bands[top - j]!;
				return { id: `band-${top - j}`, label: `${Math.round(b.fromM3)} – ${Math.round(b.toM3)} m³`, belowPct: null, fromM3: b.fromM3, toM3: b.toM3 };
			}),
			classify: (st) => {
				let total = 0;
				for (const v of Object.values(st)) total += v;
				let i = 0;
				while (i < top && total >= bands[i + 1]!.fromM3) i++;
				return top - i;
			}
		};
	});
}

/** Each dam's storage at the start of `day` (the end of the day before): the member run's, or the base run's before the season. */
function storageAtStart(output: Pick<ModelOutput, 'startDate' | 'series'>, baseRun: OutlookBaseRun, input: ModelInput, day: number): Record<string, number> {
	const out: Record<string, number> = {};
	const t = day - 1 - toEpochDay(output.startDate);
	const tb = day - 1 - toEpochDay(baseRun.startDate);
	for (const n of farmDams(input)) {
		const v = t >= 0 ? output.series.find((x) => x.nodeId === n.id && x.key === 'dam_storage')?.values[t] : baseRun.series.find((x) => x.nodeId === n.id && x.key === 'dam_storage')?.values[tb];
		out[n.id] = typeof v === 'number' && Number.isFinite(v) ? v : 0;
	}
	return out;
}

function chancesOf(plans: readonly CategoryPlan[], members: readonly { weight: number; categories: readonly number[] }[]): RestrictionChances[] {
	const total = members.reduce((a, m) => a + m.weight, 0);
	return plans.map((p, r) => {
		const w = new Array<number>(p.categories.length).fill(0);
		for (const m of members) w[m.categories[r]!]! += m.weight;
		return { reviewDate: p.reviewDate, basis: p.basis, categories: p.categories.map((c, i) => ({ ...c, chance: total > 0 ? w[i]! / total : 0 })) };
	});
}

// ─── The outlook ────────────────────────────────────────────────────────────

/** One forecast member's season. */
export interface ForecastMemberResult {
	system: string;
	/** Its index among the system's members that have a complete month. */
	member: number;
	/** Its share of the ensemble: the system's weight ÷ its members. */
	weight: number;
	analogueYear: number;
	analogueLabel: string;
	/** The analogue's distance from the member's mapped totals (standard deviations, RMS). */
	distance: number;
	months: ForecastMemberMonth[];
	seasonEndStorageM3: number | null;
	/** Total farm dam storage at the start of each review date. */
	reviewStorageM3: number[];
	/** Its category on each review date (an index into RestrictionChances.categories). */
	categories: number[];
	outcome: OutlookMember;
}

/** One hindcast year of the skill score. */
export interface ForecastSkillYear {
	year: number;
	waterYear: number;
	/** The season-end storage driven by that year's own recorded rain from this season's state: the outcome scored. */
	observedM3: number;
	crpsForecast: number;
	crpsEsp: number;
	/** Systems that had the year. */
	systems: string[];
}

export interface ForecastSkill {
	metric: 'crpssSeasonEndStorage';
	/** 1 − mean CRPS of the forecast members ÷ the ESP's; null when it can't be scored (reason). */
	crpss: number | null;
	nYears: number;
	years: ForecastSkillYear[];
	reason: string | null;
}

export type ForecastOffReason = 'noForecast' | 'noHindcast' | 'noQualifyingSystem' | 'noDams' | 'noAnalogues' | 'levelProblems';

export interface ForecastOutlook {
	method: 'c3s';
	/** 'off': nothing was run and the outlook is the ESP's alone (reason, message). */
	status: 'ready' | 'off';
	reason: ForecastOffReason | null;
	message: string | null;
	decisionDate: string;
	seasonEnd: string;
	init: string | null;
	systems: ForecastSystemReport[];
	members: ForecastMemberResult[];
	/** The forecast members' chance of each category per review date. */
	chances: RestrictionChances[];
	/** The same over the ESP's analogue years, each weighted alike: what the forecast is set beside. */
	espChances: RestrictionChances[];
	skill: ForecastSkill | null;
	/** 'forecast' only with a skill score above 0; else the ESP leads ("no better than past weather"). */
	leads: 'forecast' | 'esp';
	warnings: string[];
}

export interface ForecastOutlookOptions extends OutlookSeason {
	forecasts: readonly SeasonalForecastSystem[];
	hindcasts: readonly SeasonalHindcastSystem[];
	/** The demand level's ops (demand.scale only); default none, the full demand. */
	ops?: readonly ScenarioOp[];
	/** Review dates (ISO, inside the season); default the rule's in the season, else the review triggers' default. */
	reviewDates?: readonly string[];
	analogueYears?: readonly number[];
	baseRun?: OutlookBaseRun;
	snapshot?: ModelStateSnapshot;
	siteNodeId?: string | null;
	/** Score the hindcast (default true): years × members more runs of the season. */
	skill?: boolean;
}

/**
 * The forecast-conditioned outlook (module header). Off, with nothing run,
 * without a forecast, a hindcast or a qualifying system; then the caller's
 * ESP stands alone, as it always does here: no ESP figure is changed.
 */
export function runForecastOutlook(raw: ModelInput, options: ForecastOutlookOptions): ForecastOutlook {
	const s = resolveSeason(options);
	const warnings: string[] = [];
	const result = (x: Partial<ForecastOutlook>): ForecastOutlook => ({
		method: 'c3s',
		status: 'off',
		reason: null,
		message: null,
		decisionDate: s.decisionDate,
		seasonEnd: s.seasonEnd,
		init: null,
		systems: [],
		members: [],
		chances: [],
		espChances: [],
		skill: null,
		leads: 'esp',
		warnings,
		...x
	});
	const off = (reason: ForecastOffReason, message: string, x: Partial<ForecastOutlook> = {}) => result({ reason, message, ...x });
	if (!options.forecasts?.length) return off('noForecast', 'No seasonal forecast is held for this season: the outlook is the ESP alone.');
	if (!options.hindcasts?.length) return off('noHindcast', 'The copy holds no hindcast to calibrate the forecasts on: the outlook is the ESP alone.');
	const ops = options.ops ?? [];
	const opProblems = outlookLevelProblems({ id: 'forecast', label: 'forecast', ops });
	if (opProblems.length) return off('levelProblems', opProblems.join('; '));

	const input = withoutDroughtRestriction(raw);
	const rule = resolveDroughtRestriction(raw.settings.droughtRestriction, warnings);
	const season: OutlookSeason = { decisionDate: s.decisionDate, seasonEnd: s.seasonEnd };
	const { baseRun, snapshot } = outlookBaseAndSnapshot(input, s.decisionDate, options);
	if (!snapshot) throw new RangeError(`the base run doesn't hold the day before ${s.decisionDate}: there is no state to start the season from`);
	const systems = prepareSystems(options.forecasts, options.hindcasts, s, baseRun);
	const used = systems.filter((p) => p.report.used);
	const init = used[0]?.report.init ?? null;
	const reports = systems.map((p) => p.report);
	if (!used.length) return off('noQualifyingSystem', `No forecast system has a hindcast of at least ${FORECAST_MIN_HINDCAST_YEARS} years the record covers: the outlook is the ESP alone.`, { systems: reports });
	if (!farmDams(input).length) return off('noDams', 'The project has no farm dam: there is no storage to give a restriction level by.', { systems: reports, init });
	const { analogues } = outlookAnalogues(baseRun, season, options.analogueYears);
	if (!analogues.length) return off('noAnalogues', 'The record holds no analogue year for this season.', { systems: reports, init });
	const first = outlookSeasonInput(input, baseRun, season, analogues[0]!, ops);
	if (first.problems.length) return off('levelProblems', first.problems.join('; '), { systems: reports, init });

	const site = options.siteNodeId ?? null;
	const plans = planCategories(rule, input, baseRun, s, reviewDays(rule, s, options.reviewDates), warnings);
	if (!plans.length) warnings.push('The season holds no review date: no chance of a restriction level is given.');
	const candidates = analogues.map((a) => ({ analogue: a, totals: analogueMonthlyTotals(baseRun, season, a) }));
	const run = (view: OutlookBaseRun, a: OutlookAnalogue) => {
		const r = runOutlookMemberRun(snapshot, input, view, season, a, ops, site);
		if (!r.member || !r.output) throw new Error(`a forecast member didn't run: ${r.problems.join('; ')}`);
		const at = plans.map((p) => storageAtStart(r.output!, baseRun, input, p.day));
		return { outcome: r.member, categories: plans.map((p, i) => p.classify(at[i]!)), review: at.map((st) => Object.values(st).reduce((x, y) => x + y, 0)) };
	};

	// The ESP members, from the same snapshot: the reference the forecast is set beside and scored against.
	const esp = analogues.map((a) => run(baseRun, a));
	const espChances = chancesOf(plans, esp.map((m) => ({ weight: 1, categories: m.categories })));

	const nMonths = seasonMonths(season).length;
	/** One system's members mapped, matched to an analogue, rescaled and run. */
	const runSystem = (p: PreparedSystem, members: readonly number[][], cells: readonly Cell[], pool: typeof candidates) =>
		members.flatMap((monthly, j) => {
			const mapped = mapMember(monthly, cells, nMonths);
			const ranked = mapped ? rankAnalogues(mapped, pool) : [];
			if (!mapped || !ranked.length) return [];
			const view = forecastMemberBaseRun(baseRun, season, ranked, mapped);
			return [{ j, ranked, view, ...run(view.baseRun, view.analogue) }];
		});

	const members: ForecastMemberResult[] = [];
	for (const p of used) {
		const got = runSystem(p, p.members, p.cells, candidates);
		if (got.length < p.members.length) warnings.push(`${p.report.system}: ${p.members.length - got.length} member(s) not run (no analogue year has every month they give)`);
		for (const m of got) {
			warnings.push(...m.view.warnings.map((w) => `${p.report.system} member ${m.j + 1}: ${w}`));
			members.push({
				system: p.report.system,
				member: m.j,
				weight: p.report.weight / got.length,
				analogueYear: m.view.analogue.waterYear,
				analogueLabel: m.view.analogue.label,
				distance: m.ranked[0]!.distance,
				months: m.view.months,
				seasonEndStorageM3: m.outcome.seasonEndStorageM3,
				reviewStorageM3: m.review,
				categories: m.categories,
				outcome: m.outcome
			});
		}
	}
	const chances = chancesOf(plans, members);

	let skill: ForecastSkill | null = null;
	if (options.skill !== false) {
		const rain = rainOf(baseRun);
		const r0 = toEpochDay(baseRun.startDate);
		const initIdx = parseMonth(init)!;
		const shiftToInit = initIdx - monthOfDay(s.from);
		// Hindcast year y ↔ the analogue whose init month (its first month shifted as the season's is to the init) is in y.
		const yearOf = (a: OutlookAnalogue) => Math.floor((monthOfDay(toEpochDay(a.from)) + shiftToInit) / 12);
		const years: ForecastSkillYear[] = [];
		const allYears = [...new Set(used.flatMap((p) => [...p.hindcast.keys()]))].sort((a, b) => a - b);
		for (const y of allYears) {
			const k = analogues.findIndex((a) => yearOf(a) === y);
			if (k < 0) continue;
			const observed = esp[k]!.outcome.seasonEndStorageM3;
			if (observed === null) continue;
			const pool = candidates.filter((_, i) => i !== k);
			const fc: { v: number; w: number }[] = [];
			const names: string[] = [];
			const present = used.filter((p) => p.hindcast.has(y));
			const rows: { name: string; values: number[] }[] = [];
			for (const p of present) {
				// Leave-one-out: the map without year y, and the analogue pool without its own year.
				const cells = fitCells(p.hindcast, (initIdx % 12) + 1, p.leads, rain, r0, s.from, y);
				if (cells.some((c) => c.years.length < FORECAST_MIN_HINDCAST_YEARS - 1)) continue;
				const got = runSystem(p, p.hindcast.get(y)!, cells, pool).flatMap((m) => (m.outcome.seasonEndStorageM3 === null ? [] : [m.outcome.seasonEndStorageM3]));
				if (got.length) rows.push({ name: p.report.system, values: got });
			}
			for (const r of rows) {
				names.push(r.name);
				for (const v of r.values) fc.push({ v, w: 1 / rows.length / r.values.length });
			}
			if (!fc.length) continue;
			const espVals = esp.flatMap((m, i) => (i === k || m.outcome.seasonEndStorageM3 === null ? [] : [m.outcome.seasonEndStorageM3]));
			if (!espVals.length) continue;
			years.push({
				year: y,
				waterYear: analogues[k]!.waterYear,
				observedM3: observed,
				crpsForecast: crpsEnsemble(fc.map((x) => x.v), fc.map((x) => x.w), observed),
				crpsEsp: crpsEnsemble(espVals, null, observed),
				systems: names
			});
		}
		const enough = years.length >= OUTLOOK_MIN_YEARS;
		const score = enough ? crpss(years.map((x) => x.crpsForecast), years.map((x) => x.crpsEsp)) : null;
		skill = {
			metric: 'crpssSeasonEndStorage',
			crpss: score,
			nYears: years.length,
			years,
			reason: !enough
				? `Only ${years.length} hindcast year${years.length === 1 ? '' : 's'} can be scored (an analogue year in the record, a hindcast of it): at least ${OUTLOOK_MIN_YEARS} are needed.`
				: score === null
					? 'The ESP was exact in every hindcast year, so there is nothing to score against.'
					: null
		};
	}
	const leads = skill?.crpss != null && skill.crpss > 0 ? 'forecast' : 'esp';
	if (leads === 'esp' && skill?.crpss != null) warnings.push('The forecasts scored no better than past weather over the hindcast years (CRPSS ≤ 0): the ESP leads.');
	return result({ status: 'ready', init, systems: reports, members, chances, espChances, skill, leads });
}
