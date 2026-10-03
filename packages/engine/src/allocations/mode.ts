// allocationMode (engine ≥ 1.18.0, roadmap WP-3.10, issue #72, docs/model.md
// §2.12a): registered volumes as a physical limit on a run, not only as a
// comparison beside it.
//
//  - 'none' (the default): the allocations change nothing; a run that has
//    them only reports RunSummary.allocations (compareAllocations).
//  - 'cap': each farm's and water user's use per water year stays within
//    what is registered for it, per water source: surface use (supplied −
//    groundwater to the crop: the dam, the river pump, river off-take water
//    used) within the surface volume, groundwater use (pumped to the crop +
//    into the dam) within the groundwater volume. The budget is the whole
//    water year's registered volume (each allocation × its valid days in
//    the year ÷ the year's days), so a run that starts or ends inside a year
//    doesn't shrink it, and a farm may take its volume early. A source with
//    no allocation isn't capped (a run warning names them), nor (engine ≥
//    1.70.0, issue #393, #90 Q24) is a day on which none of the unit's
//    allocations of the source is in force, and that day's use doesn't count
//    against the year's budget (one run warning names the units and days).
//    Before 1.70.0 every day of the year was capped: a year with none in
//    force at 0, and a licence's first year from 1 October.
//    Every draw from the dam counts as surface use, groundwater pumped into
//    it included, so that water uses up both volumes; the comparison nets it
//    (docs/model.md §2.12). Pending the hydrologist (followups.md §
//    Allocations, issue #90).
//    The licence conditions bind too (engine ≥ 1.37.0, issue #72): on a day
//    outside every in-force allocation's months of use the source gives
//    nothing, and otherwise at most the in-force allocations' maximum rates
//    × 86 400 (dailyLimits). The cap's room on a day is the smaller of the
//    two.
//  - 'fullAllocation': "what if every registered or licensed volume were
//    taken in full" (a registration is not an entitlement; WP-3.11's
//    background run): each unit's abstraction demand (crops and
//    demand objects) is scaled, per water year, so it adds up to the
//    registered volume in force over the run's days of that year (both
//    sources together), keeping the unit's own seasonal pattern. A unit with
//    no demand in a year can't be scaled and takes nothing that year (a
//    warning names it). A year with no allocation in force on those days
//    keeps the unit's modelled demand, factor 1 (engine ≥ 1.70.0, #90 Q24;
//    before, 0), and one warning names the units and years.
//
// 'fullAllocation' doesn't apply the licence conditions: it scales demand to
// the volume, and its months and rate are what a cap run adds on top.
//
// Pure, like the rest of the engine.
import { monthOfEpochDay, toEpochDay, waterYearOf, isIsoDate as isRealDate } from '../calendar';
import { isStorageOnly, type AllocationEntry, type AllocationWaterSource } from './compare';
import { cmpStr } from '../order';

export const ALLOCATION_MODES = ['none', 'cap', 'fullAllocation'] as const;
export type AllocationMode = (typeof ALLOCATION_MODES)[number];

/** Each mode in plain words (the Settings form, run results). */
export const ALLOCATION_MODE_LABEL: Record<AllocationMode, string> = {
	none: 'Compare only',
	cap: 'Cap use at the registered volume',
	fullAllocation: 'Full allocation: every user takes their registered volume'
};

/** The mode a run uses: settings.allocationMode when it is one, else 'none'. */
export function resolveAllocationMode(v: unknown, warnings: string[]): AllocationMode {
	if (v === undefined || v === null) return 'none';
	if ((ALLOCATION_MODES as readonly unknown[]).includes(v)) return v as AllocationMode;
	warnings.push(`allocationMode "${String(v)}" is not one of ${ALLOCATION_MODES.join(', ')}; the allocations only compare`);
	return 'none';
}

const isIso = isRealDate;

/**
 * The allocations a run can use, each checked: a finite volume ≥ 0, a known
 * water source, and dates that are ISO days in order. Anything else is left
 * out with a warning (the API stores only valid rows; this guards a stored
 * input edited by hand).
 */
export function usableAllocations(list: readonly AllocationEntry[] | undefined, warnings: string[]): AllocationEntry[] {
	const out: AllocationEntry[] = [];
	for (const a of list ?? []) {
		const bad =
			!(typeof a.volumeM3PerYear === 'number' && Number.isFinite(a.volumeM3PerYear) && a.volumeM3PerYear >= 0)
				? 'its volume is not a number ≥ 0'
				: a.waterSource !== 'surface' && a.waterSource !== 'groundwater'
					? `its water source "${String(a.waterSource)}" is not surface or groundwater`
					: (a.validFrom != null && !isIso(a.validFrom)) || (a.validTo != null && !isIso(a.validTo))
						? 'a validity date is not an ISO date'
						: a.validFrom && a.validTo && a.validFrom > a.validTo
							? 'it is valid from after valid to'
							: null;
		const use = a.waterUse ?? null;
		const badUse = use !== null && use !== '21a' && use !== '21b' ? `its water use "${String(use)}" is not 21a or 21b` : null;
		if (bad || badUse) {
			warnings.push(`allocation ${String(a.id)} left out: ${bad ?? badUse}`);
			continue;
		}
		// A licence condition that doesn't read is dropped, not the volume (a stored input edited by hand).
		let c = a;
		// A storage-only (21b) row registers no take (engine ≥ 1.59.0): a volume on it isn't one either.
		if (use === '21b' && a.volumeM3PerYear > 0) {
			warnings.push(`allocation ${String(a.id)}: it is storage only (21b), so its volume of ${a.volumeM3PerYear} m³ a year is not a take and is ignored`);
			c = { ...c, volumeM3PerYear: 0 };
		}
		if (a.months != null && !(Array.isArray(a.months) && a.months.every((m) => Number.isInteger(m) && m >= 1 && m <= 12))) {
			warnings.push(`allocation ${String(a.id)}: its months of use aren't calendar months 1–12, so they're ignored`);
			c = { ...c, months: null };
		}
		if (a.maxRateM3s != null && !(typeof a.maxRateM3s === 'number' && Number.isFinite(a.maxRateM3s) && a.maxRateM3s >= 0)) {
			warnings.push(`allocation ${String(a.id)}: its maximum rate isn't a number ≥ 0, so it's ignored`);
			c = { ...c, maxRateM3s: null };
		}
		out.push(c);
	}
	return out;
}

/**
 * A cap run's warning for an allocation whose maximum rate can't deliver its
 * volume in its months of use (a year when none are stated), or null. The
 * rate is applied as stated either way; a 0 is often a blank field in an
 * export, so it is named.
 */
export function rateShortfall(a: AllocationEntry): string | null {
	if (a.maxRateM3s == null || !(a.volumeM3PerYear > 0)) return null;
	const days = a.months?.length ? a.months.reduce((s, m) => s + DAYS_IN_MONTH[m - 1]!, 0) : 365;
	const most = a.maxRateM3s * M3S_TO_M3_PER_DAY * days;
	if (most >= a.volumeM3PerYear) return null;
	return a.maxRateM3s === 0
		? `allocation cap: allocation ${String(a.id)}'s maximum rate is 0, so it may take none of its ${a.volumeM3PerYear} m³ a year (a blank rate states none)`
		: `allocation cap: at its maximum rate allocation ${String(a.id)} can take at most ${Math.round(most)} m³ in ${a.months?.length ? 'its months of use' : 'a year'}, less than its ${a.volumeM3PerYear} m³`;
}

/** Days in each calendar month of a common year (the rate warning's reach; a leap day doesn't change it). */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** A rate in m³/s as m³ a day. */
const M3S_TO_M3_PER_DAY = 86_400;

/** First epoch day of water year `wy` (1 October). */
const wyStart = (wy: number) => toEpochDay(`${wy}-10-01`);

/** Registered m³ of `allocs` over epoch days [from, to] of water year `wy`: each volume × its valid days there ÷ the year's days. */
export function registeredOver(allocs: readonly AllocationEntry[], wy: number, from: number, to: number): number {
	const yearDays = wyStart(wy + 1) - wyStart(wy);
	let sum = 0;
	for (const a of allocs) {
		const lo = Math.max(from, a.validFrom ? toEpochDay(a.validFrom) : -Infinity);
		const hi = Math.min(to, a.validTo ? toEpochDay(a.validTo) : Infinity);
		if (hi >= lo) sum += (a.volumeM3PerYear * (hi - lo + 1)) / yearDays;
	}
	return sum;
}

/** Each allocation's validity as epoch days [lo, hi] (no date = open). */
const spanOf = (a: AllocationEntry) => ({ lo: a.validFrom ? toEpochDay(a.validFrom) : -Infinity, hi: a.validTo ? toEpochDay(a.validTo) : Infinity });

/** Whether any of `own` is in force (its validity dates) on some epoch day in [from, to]. */
export function inForceOver(own: readonly AllocationEntry[], from: number, to: number): boolean {
	return from <= to && own.some((a) => {
		const v = spanOf(a);
		return v.lo <= to && v.hi >= from;
	});
}

/**
 * The cap's budget on each run day (`cap` mode): the registered volume of
 * `source` over the whole water year the day falls in (each allocation × its
 * valid days in the year ÷ the year's days; not only the run's days of it),
 * the same number on every capped day of a year. null when the node has no
 * allocation of that source (no cap).
 * A day on which none of its allocations of the source is in force isn't
 * capped (engine ≥ 1.70.0, issue #393, #90 Q24): Infinity, as for a unit
 * with no allocation of the source, and the day's use doesn't count against
 * the year's budget (simulateNetwork counts use only on capped days). So a
 * licence from 1 September leaves October–August uncapped and caps September
 * at its 30/365 share. Before 1.70.0 every day of the year was capped, a year
 * with none in force at 0, and the use before a licence's start in its first
 * year counted against its share.
 */
export function yearBudgets(allocs: readonly AllocationEntry[], source: AllocationWaterSource, start: number, days: number): Float64Array | null {
	const own = allocs.filter((a) => a.waterSource === source);
	if (!own.length) return null;
	const spans = own.map(spanOf);
	const out = new Float64Array(days);
	for (let t = 0; t < days; ) {
		const wy = waterYearOf(start + t);
		const end = wyStart(wy + 1) - 1;
		const v = registeredOver(own, wy, wyStart(wy), end);
		const last = Math.min(days - 1, end - start);
		for (let k = t; k <= last; k++) {
			const d = start + k;
			out[k] = spans.some((x) => x.lo <= d && d <= x.hi) ? v : Infinity;
		}
		t = last + 1;
	}
	return out;
}

/**
 * The run days a capped source isn't capped on (engine ≥ 1.70.0,
 * yearBudgets), as spans [first, last] of run days: none of the unit's
 * allocations of `source` is in force on them. Empty when the unit has no
 * allocation of the source (that source isn't capped at all, and
 * planAllocations warns about it apart).
 */
export function uncappedSpans(allocs: readonly AllocationEntry[], source: AllocationWaterSource, start: number, days: number): [number, number][] {
	const b = yearBudgets(allocs, source, start, days);
	const out: [number, number][] = [];
	if (!b) return out;
	for (let t = 0; t < days; t++) {
		if (b[t]! < Infinity) continue;
		const last = out.at(-1);
		if (last && last[1] === t - 1) last[1] = t;
		else out.push([t, t]);
	}
	return out;
}

/** Water years as a short list: runs of consecutive years as a range ("2001–2003, 2007"). */
export function waterYearList(years: readonly number[]): string {
	const parts: string[] = [];
	for (let k = 0; k < years.length; ) {
		let j = k;
		while (j + 1 < years.length && years[j + 1] === years[j]! + 1) j++;
		parts.push(j === k ? String(years[k]) : `${years[k]}–${years[j]}`);
		k = j + 1;
	}
	return parts.join(', ');
}

/**
 * The licence conditions' limit on each run day (`cap` mode, engine ≥
 * 1.37.0, issue #72), m³/day, for one water source: of the allocations of
 * `source` in force that day (their validity dates), those whose months of
 * use include the day's month (none stated = every month) give their
 * maximum rate × 86 400 (none stated = no limit), summed. So a day in a
 * month none of them may use gives 0. A day no allocation of the source is
 * in force on has no limit here (the year's budget still binds), and nor
 * does any day when no allocation of the source states a condition: then
 * null.
 */
export function dailyLimits(allocs: readonly AllocationEntry[], source: AllocationWaterSource, start: number, days: number): Float64Array | null {
	const own = allocs.filter((a) => a.waterSource === source);
	if (!own.some((a) => (a.months != null && a.months.length > 0) || a.maxRateM3s != null)) return null;
	const span = own.map((a) => ({
		lo: a.validFrom ? toEpochDay(a.validFrom) : -Infinity,
		hi: a.validTo ? toEpochDay(a.validTo) : Infinity,
		months: a.months?.length ? new Set(a.months) : null,
		perDay: a.maxRateM3s == null ? Infinity : a.maxRateM3s * M3S_TO_M3_PER_DAY
	}));
	const out = new Float64Array(days);
	for (let t = 0; t < days; t++) {
		const d = start + t;
		const m = monthOfEpochDay(d);
		let inForce = false;
		let v = 0;
		for (const a of span) {
			if (d < a.lo || d > a.hi) continue;
			inForce = true;
			if (!a.months || a.months.has(m)) v += a.perDay;
		}
		out[t] = inForce ? v : Infinity;
	}
	return out;
}

/**
 * The run days outside a licence's months of use (`cap` mode, engine ≥
 * 1.40.0), for one water source: 1 on a day some allocation of `source` is in
 * force (its validity dates) and none of those in force may use the day's
 * month (dailyLimits gives 0 then, whatever the rates); else 0. null when no
 * allocation of the source states months of use.
 */
export function outsideMonths(allocs: readonly AllocationEntry[], source: AllocationWaterSource, start: number, days: number): Uint8Array | null {
	const own = allocs.filter((a) => a.waterSource === source);
	if (!own.some((a) => a.months != null && a.months.length > 0)) return null;
	const span = own.map((a) => ({ lo: a.validFrom ? toEpochDay(a.validFrom) : -Infinity, hi: a.validTo ? toEpochDay(a.validTo) : Infinity, months: a.months?.length ? new Set(a.months) : null }));
	const out = new Uint8Array(days);
	for (let t = 0; t < days; t++) {
		const d = start + t;
		const m = monthOfEpochDay(d);
		let inForce = false;
		let may = false;
		for (const a of span) {
			if (d < a.lo || d > a.hi) continue;
			inForce = true;
			if (!a.months || a.months.has(m)) may = true;
		}
		out[t] = inForce && !may ? 1 : 0;
	}
	return out;
}

/**
 * `fullAllocation`: the factor each run day's demand is scaled by, one per
 * water year: the registered volume (both sources) in force over the run's
 * days of the year ÷ the unit's abstraction demand over them (`demand`,
 * m³/day). A year with demand but nothing registered gets 0; a year with
 * registered volume but no demand can't be scaled, gets 0 and is listed in
 * `unscaled` (water years). The year a forecast tail starts in (engine ≥
 * 1.28.0) is scaled on its days before `historyDays` only, and its tail days
 * keep that factor, so the tail never changes a historical day's demand
 * (engine-audit.md K1); its registered volume is then factor × demand, as a
 * pinned year's. So a year with no demand on its historical days takes
 * nothing on its tail days either, as the run without the tail has it, and
 * (engine ≥ 1.57.0) lists the volume registered over its historical days, as
 * every other year with no demand lists the volume over its days.
 * A unit that abstracts only from run day `from` (NetworkNode.abstractionFrom,
 * engine ≥ 1.30.0) is scaled to the volume over its days from then: a year
 * it starts in asks for that part of the year's volume, a year wholly before
 * it for none (and isn't unscaled).
 * A year with no allocation in force on the days it is fitted on (engine ≥
 * 1.70.0, #90 Q24) keeps the modelled demand: factor 1, not listed in
 * `years`, listed in `unlicensed` (before 1.70.0 it was scaled to 0).
 * `asOf` (a run day, engine ≥ 1.69.0, a snapshot's day): `before` is the
 * factor of the water year that day falls in fitted on that year's days
 * before it only (as a forecast tail starting that day would have it), or
 * undefined when none of the year's days come before it, so an outlook in a
 * hindcast reads nothing on or after its decision date (docs/model.md §2.15).
 */
export function fullAllocationFactors(
	allocs: readonly AllocationEntry[],
	demand: ArrayLike<number>,
	start: number,
	days: number,
	/** A resumed run (../warmstart): the factor its first water year keeps from the run it was captured from. */
	pinnedFirst?: number,
	/** The run's historical days (before a forecast tail); default every day. */
	historyDays: number = days,
	/** The first run day the unit abstracts on (engine ≥ 1.30.0); 0 = every day. */
	from = 0,
	/** A snapshot's run day (0 … days): also fit its water year on the days before it (`before`). */
	asOf?: number
): { factor: Float64Array; years: { waterYear: number; demandM3: number; registeredM3: number }[]; unscaled: number[]; unlicensed: number[]; before?: number } {
	const factor = new Float64Array(days);
	const years: { waterYear: number; demandM3: number; registeredM3: number }[] = [];
	const unscaled: number[] = [];
	const unlicensed: number[] = [];
	for (let t = 0; t < days; ) {
		const wy = waterYearOf(start + t);
		const last = Math.min(days - 1, wyStart(wy + 1) - 1 - start);
		// A year the forecast tail starts inside is fitted on its historical days, and a unit with an
		// abstraction date (engine ≥ 1.30.0) on its days from then.
		const fit = t < historyDays && last >= historyDays ? historyDays - 1 : last;
		const a = Math.max(t, from);
		let d = 0;
		for (let k = a; k <= fit; k++) d += demand[k]!;
		const pinned = t === 0 && pinnedFirst !== undefined;
		// No allocation in force on any of the days it is fitted on (engine ≥ 1.70.0, #90 Q24): the unit keeps its
		// modelled demand there (factor 1), as a unit with no allocation does, and the year isn't listed as scaled.
		if (!pinned && a <= fit && !inForceOver(allocs, start + a, start + fit)) {
			unlicensed.push(wy);
			for (let k = t; k <= last; k++) factor[k] = 1;
			t = last + 1;
			continue;
		}
		const reg = a > fit ? 0 : registeredOver(allocs, wy, start + a, start + fit);
		const f = pinned ? pinnedFirst : d > 0 ? reg / d : 0;
		if (!pinned && !(d > 0) && reg > 0) unscaled.push(wy);
		for (let k = t; k <= last; k++) factor[k] = f;
		let all = d;
		for (let k = fit + 1; k <= last; k++) all += demand[k]!;
		// A pinned year was scaled to the capture run's volume for the whole of it, and a year cut by
		// the forecast tail to its historical days' volume: record what its days got. A year with no
		// demand to scale lists the volume registered over the days it would have been scaled on, the
		// year the tail starts in too (engine ≥ 1.57.0; before, that year listed k × demand = 0).
		years.push({ waterYear: wy, demandM3: all, registeredM3: pinned || (fit < last && d > 0) ? f * all : reg });
		t = last + 1;
	}
	const before = asOf === undefined ? undefined : factorBefore(allocs, demand, start, asOf, pinnedFirst, historyDays, from);
	return { factor, years, unscaled, unlicensed, ...(before !== undefined ? { before } : {}) };
}

/**
 * fullAllocationFactors' `before`: the factor of the water year run day `at`
 * falls in, fitted on that year's run days before `at` (and before the
 * historical days' end, as the year a forecast tail starts in is), as
 * fullAllocationFactors fits a year: the volume registered over them ÷ the
 * demand over them, 0 without demand. undefined when no day of the year
 * comes before `at` in the run.
 */
function factorBefore(allocs: readonly AllocationEntry[], demand: ArrayLike<number>, start: number, at: number, pinnedFirst: number | undefined, historyDays: number, from: number): number | undefined {
	const wy = waterYearOf(start + at);
	const t0 = Math.max(0, wyStart(wy) - start);
	if (t0 >= at) return undefined;
	if (t0 === 0 && pinnedFirst !== undefined) return pinnedFirst;
	const fit = (t0 < historyDays ? Math.min(at, historyDays) : at) - 1;
	const a = Math.max(t0, from);
	// No allocation in force on those days: the modelled demand, as fullAllocationFactors has it (engine ≥ 1.70.0).
	if (a <= fit && !inForceOver(allocs, start + a, start + fit)) return 1;
	let d = 0;
	for (let k = a; k <= fit; k++) d += demand[k]!;
	const reg = a > fit ? 0 : registeredOver(allocs, wy, start + a, start + fit);
	return d > 0 ? reg / d : 0;
}

/** What a plan node needs for the modes (../network/simulate.ts PlanNode). */
interface ModePlanNode {
	demand: Float64Array;
	irrigationEfficiency: number;
	objects?: { demand: Float64Array[]; total: Float64Array };
	borehole?: unknown;
	allocationCap?: AllocationCap;
}

/**
 * A full allocation's view of a unit's demand before its demand factors
 * (engine ≥ 1.70.0, docs/model.md §2.12a): the factor is fitted on that, and
 * the demand factors (a scenario's `demand.scale`, an outlook's level) apply
 * after it, so a level of 0.8 is 80 % of the registered use.
 */
export interface FullAllocationHooks {
	/**
	 * Unit i's abstraction demand before its demand factors (m³/day: F ÷ e +
	 * its objects', after its abstraction date), or undefined when no demand
	 * factor applies to it (its plan demand is then that, to the bit).
	 */
	baseDemand?: (i: number) => Float64Array | undefined;
	/** Unit i's demand objects re-planned with the factor `k` per day applied before the demand factor and the basic-needs floor. */
	scaledObjects?: (i: number, k: Float64Array) => { demand: Float64Array[]; total: Float64Array } | undefined;
}

/**
 * A unit's cap (PlanNode.allocationCap): per source, the water year's
 * registered volume on each day (null = that source isn't capped), and the
 * licence conditions' limit on each day (m³/day, engine ≥ 1.37.0; absent or
 * null = none stated).
 */
export interface AllocationCap {
	surface: Float64Array | null;
	groundwater: Float64Array | null;
	surfaceLimit?: Float64Array | null;
	groundwaterLimit?: Float64Array | null;
}

/** The allocations as a run plans them (buildNetworkPlan). */
export interface AllocationPlan {
	mode: AllocationMode;
	/** The usable allocations, in id order. */
	list: AllocationEntry[];
	/** Node index → its allocations (farms and water users only). */
	byNode: Map<number, AllocationEntry[]>;
	/** 'fullAllocation': node index → its demand's factor per day, and per water year the demand before and the volume after. */
	scaled: Map<number, { factor: Float64Array; years: { waterYear: number; demandM3: number; registeredM3: number }[]; before?: number }>;
	/** The run's historical days, when a forecast tail follows them (engine ≥ 1.28.0): full allocation fits its factors on these. */
	historyDays?: number;
	/** Node index → the first run day it abstracts on, for units with an abstraction date (engine ≥ 1.30.0). */
	abstractFrom?: Map<number, number>;
	/**
	 * 'fullAllocation' in a run resumed from a snapshot (../warmstart): node
	 * index → the factor of the water year in progress in the run it was
	 * captured from, kept for the resumed days of that year so they are the
	 * uninterrupted run's (the year's demand before the snapshot isn't in the
	 * resumed run).
	 */
	pinned?: Map<number, number>;
	/** A capture run (../warmstart, engine ≥ 1.69.0): the snapshot's run day, so each scaled unit also records `before` there. */
	asOf?: number;
	/**
	 * 'fullAllocation' (engine ≥ 1.70.0): node index → the water years it keeps its modelled demand in, no
	 * allocation being in force on the days its factor is fitted on; planAllocations names them in one warning.
	 */
	unlicensed?: Map<number, number[]>;
}

/** The usable allocations matched to the run's farms and water users (node index → its allocations). */
export function matchAllocations(
	allocations: readonly AllocationEntry[] | undefined,
	mode: AllocationMode,
	nodes: readonly { id: string; kind: string }[],
	warnings: string[]
): AllocationPlan {
	// In id order, so a unit's registered volume sums the same to the last bit however the list came.
	// A storage-only (s21b) allocation is not a take (engine ≥ 1.59.0): it neither caps nor scales a
	// unit, and RunSummary.allocations doesn't count it; the storage comparison reads it (compare.ts).
	const list = usableAllocations(allocations, warnings)
		.filter((a) => !isStorageOnly(a))
		.sort((a, b) => cmpStr(String(a.id), String(b.id)));
	const index = new Map(nodes.map((n, i) => [n.id, i]));
	const byNode = new Map<number, AllocationEntry[]>();
	for (const a of list) {
		const i = a.nodeId === null || a.nodeId === undefined ? undefined : index.get(a.nodeId);
		if (i === undefined || (nodes[i]!.kind !== 'farm' && nodes[i]!.kind !== 'user')) continue;
		const own = byNode.get(i) ?? [];
		own.push(a);
		byNode.set(i, own);
	}
	return { mode, list, byNode, scaled: new Map() };
}

/**
 * 'fullAllocation': scale node `i`'s abstraction demand `D` (m³/day) in
 * place to its registered volume, year by year, and record it in
 * `plan.scaled`. A water user's demand is scaled this way before its senior
 * claim is passed down (buildNetworkPlan), so the farms upstream pass the
 * scaled demand.
 */
export function scaleDemandToAllocation(plan: AllocationPlan, i: number, D: Float64Array, start: number, days: number, name: string, warnings: string[]): Float64Array | null {
	const allocs = plan.byNode.get(i);
	if (plan.mode !== 'fullAllocation' || !allocs || days <= 0) return null;
	const f = fullAllocationFactors(allocs, D, start, days, plan.pinned?.get(i), plan.historyDays ?? days, plan.abstractFrom?.get(i) ?? 0, plan.asOf);
	for (let t = 0; t < days; t++) D[t]! *= f.factor[t]!;
	plan.scaled.set(i, { factor: f.factor, years: f.years, ...(f.before !== undefined ? { before: f.before } : {}) });
	if (f.unlicensed.length) (plan.unlicensed ??= new Map()).set(i, f.unlicensed);
	if (f.unscaled.length) warnings.push(`full allocation: "${name}" has no demand in water year${f.unscaled.length === 1 ? '' : 's'} ${f.unscaled.join(', ')}, so it takes none of its registered volume there`);
	return f.factor;
}

/**
 * Put the allocation mode into a built plan (engine ≥ 1.18.0): for 'cap'
 * each unit's per-source budgets (PlanNode.allocationCap); for
 * 'fullAllocation' each farm's demand scaled (the crop requirement and the
 * demand objects alike, so D = F / e + objects scales with them; water users
 * were scaled before their claims, scaleDemandToAllocation). Warns about
 * units the mode leaves alone.
 *
 * From engine 1.70.0 (issue #90 Q29) a full allocation's factor is fitted on
 * the demand before the demand factors (`hooks.baseDemand`), and the factors
 * then cut the scaled demand: F = factor × k × F₀, and each object
 * MAX(raw × k × factor, MIN(floor, raw × k)) on a day its factor is below 1
 * (`hooks.scaledObjects`). Before, the factor was fitted on the demand after
 * them, so a uniform level cancelled out.
 */
export function planAllocations(
	ap: AllocationPlan,
	nodes: readonly { id: string; name: string; kind: string }[],
	plan: ModePlanNode[],
	start: number,
	days: number,
	warnings: string[],
	hooks: FullAllocationHooks = {}
): void {
	const { mode, byNode } = ap;
	if (mode === 'none' || days <= 0) return;
	const without = nodes.flatMap((n, i) => ((n.kind === 'farm' || n.kind === 'user') && !byNode.has(i) ? [n.name] : []));
	if (without.length)
		warnings.push(
			`allocation mode ${mode}: ${without.length} unit${without.length === 1 ? ' has' : 's have'} no registered volume, so ${mode === 'cap' ? 'nothing caps their use' : 'their demand is left as modelled'} (${without.join('; ')})`
		);
	// No licence in force (engine ≥ 1.70.0, #90 Q24): under a cap the days a source isn't capped on, under a full
	// allocation the water years a unit keeps its modelled demand in, named in one warning after the loop, by node id
	// (whatever order the nodes came in).
	const notInForce: [number, string][] = [];
	for (const [i, allocs] of byNode) {
		const p = plan[i]!;
		if (mode === 'cap') {
			for (const source of ['surface', 'groundwater'] as const) {
				const spans = uncappedSpans(allocs, source, start, days);
				if (spans.length)
					notInForce.push([i, `"${nodes[i]!.name}" ${source === 'surface' ? 'surface water' : 'groundwater'} ${spans.map(([a, b]) => (a === b ? fromEpochDay(start + a) : `${fromEpochDay(start + a)} to ${fromEpochDay(start + b)}`)).join(', ')}`]);
			}
			const surface = yearBudgets(allocs, 'surface', start, days);
			const groundwater = yearBudgets(allocs, 'groundwater', start, days);
			const surfaceLimit = dailyLimits(allocs, 'surface', start, days);
			const groundwaterLimit = dailyLimits(allocs, 'groundwater', start, days);
			p.allocationCap = { surface, groundwater, ...(surfaceLimit ? { surfaceLimit } : {}), ...(groundwaterLimit ? { groundwaterLimit } : {}) };
			if (!surface) warnings.push(`allocation cap: "${nodes[i]!.name}" has no surface-water volume registered, so its surface use isn't capped`);
			if (!groundwater && p.borehole) warnings.push(`allocation cap: "${nodes[i]!.name}" has no groundwater volume registered, so its boreholes aren't capped`);
			for (const a of allocs) {
				const w = rateShortfall(a);
				if (w) warnings.push(w);
			}
			continue;
		}
		if (nodes[i]!.kind !== 'farm') continue;
		// The demand the factor is fitted on: before the demand factors (engine ≥ 1.70.0); without one, the plan's.
		const base = hooks.baseDemand?.(i);
		let D: Float64Array;
		if (base) D = Float64Array.from(base);
		else {
			const e = p.irrigationEfficiency;
			D = new Float64Array(days);
			for (let t = 0; t < days; t++) D[t] = p.demand[t]! / e + (p.objects ? p.objects.total[t]! : 0);
		}
		const factor = scaleDemandToAllocation(ap, i, D, start, days, nodes[i]!.name, warnings)!;
		// The crop requirement already carries its demand factor: × k is factor × k × F₀.
		p.demand = Float64Array.from(p.demand, (v, t) => v * factor[t]!);
		if (p.objects) {
			// The objects are re-planned with k before their factor, so the floor is MIN(floor, k × demand) (engine ≥ 1.70.0).
			const again = hooks.scaledObjects?.(i, factor);
			if (again) p.objects = { ...p.objects, demand: again.demand, total: again.total };
			else {
				const demand = p.objects.demand.map((d) => Float64Array.from(d, (v, t) => v * factor[t]!));
				const total = new Float64Array(days);
				for (const d of demand) for (let t = 0; t < days; t++) total[t]! += d[t]!;
				p.objects = { ...p.objects, demand, total };
			}
		}
	}
	if (mode === 'fullAllocation') for (const [i, years] of ap.unlicensed ?? []) notInForce.push([i, `"${nodes[i]!.name}" in water year${years.length === 1 ? '' : 's'} ${waterYearList(years)}`]);
	if (notInForce.length)
		warnings.push(
			`${mode === 'cap' ? 'allocation cap' : 'full allocation'}: no licence in force, so modelled demand is used, uncapped (as for a unit with no licence; check the licence dates)${mode === 'cap' ? ", and that use doesn't count against the water year's volume" : ''}: ${notInForce.sort((a, b) => cmpStr(nodes[a[0]]!.id, nodes[b[0]]!.id)).map((x) => x[1]).join('; ')}`
		);
}

/**
 * Whether the licence limit bound a capped source on a day, and which limit
 * (engine ≥ 1.40.0, ../run.ts capYears): the source took all its room, MIN(`left` of the year's
 * volume, the day's `limit`), within float noise, and the unit still went
 * short (`deficit` > 0 beyond noise on its `demand`). The room is what was
 * left when that is no more than the limit, within 10⁻⁹ of the year's
 * `budget` ('volumeDays'), else the limit:
 * on a day `outside` the months of use (outsideMonths) 'monthsDays', else
 * the maximum rate ('rateDays', a rate of 0 included). null when it didn't bind.
 * It says which limit set the room on a short day, not that the limit alone
 * caused the shortfall: a day the river or dam had exactly the room left
 * counts too, and outside the months every short day does. Also ../verify/checks.ts
 * checkAllocations, which redoes it from the stored columns.
 */
export function limitBoundKind(left: number, limit: number, outside: boolean, use: number, demand: number, deficit: number, budget: number): 'volumeDays' | 'rateDays' | 'monthsDays' | null {
	if (!(deficit > 1e-9 * Math.max(demand, 1))) return null;
	const room = Math.min(left, limit);
	// No room limit at all (a day the source isn't capped, engine ≥ 1.70.0) never binds.
	if (room === Infinity || use < room - 1e-9 * Math.max(room, 1)) return null;
	// What is left carries the year's summing noise: a volume used up to within 10⁻⁹ of the budget is used up.
	return left <= limit + 1e-9 * Math.max(budget, 1) ? 'volumeDays' : outside ? 'monthsDays' : 'rateDays';
}

/** The run series the modes add (engine ≥ 1.18.0), per farm or water user they touch. */
export const ALLOCATION_SERIES = {
	surfaceRoom: { key: 'allocation_room_surface', label: 'Allocation cap: surface water it may take today (what is left of the water year’s volume, within the licence’s months and rate)' },
	groundwaterRoom: { key: 'allocation_room_groundwater', label: 'Allocation cap: groundwater it may take today (what is left of the water year’s volume, within the licence’s months and rate)' },
	surfaceLeft: { key: 'allocation_left_surface', label: 'Allocation cap: what is left of the water year’s surface-water volume (start of the day, before the licence’s months and rate)' },
	groundwaterLeft: { key: 'allocation_left_groundwater', label: 'Allocation cap: what is left of the water year’s groundwater volume (start of the day, before the licence’s months and rate)' },
	demandFactor: { key: 'allocation_demand_factor', label: 'Full allocation: demand × this factor (the water year’s registered volume ÷ its demand)' }
} as const;
