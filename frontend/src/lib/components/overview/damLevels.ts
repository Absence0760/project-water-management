// Summary → Dam levels (issue #17, option A: the results first): each dam's
// storage at the end of the latest run, 30 days before it and at its lowest
// in the run's last year, from the run's daily dam_storage series, and all
// dams together (the Summary's "Dams today" card). A run from engine ≥ 1.2.0
// carries each dam's figures in its summary (FarmSummary.dam*, issue #55;
// damLevelsFromSummary); an older run's series are fetched (runs/cache.ts) and
// reduced here by damLevel(), the same rules as the engine's damFigures().
// On a forecast run the figures are the record's (issue #51): the summary's
// are, and damLevel() stops the series at `forecastFrom`, so "at the end" is
// the day before the forecast, never a forecast day.
// Every level is a share of the dam's capacity on that day (engine ≥ 1.30.0,
// issue #67): a dam losing capacity to sediment, or in service from a date,
// holds a different volume on each day (damCapacityOn), so a long record
// surveyed recently never reads above 100 %. A dam whose capacity doesn't
// change reads against its entered capacity, as before.
import { fmtNum } from '$lib/format/number';
import { beforeForecast, damCapacityOn, fromEpochDay, toEpochDay, type DailySeries, type FarmSummary, type NetworkNode } from '@water-management/engine';

const addDays = (iso: string, n: number) => fromEpochDay(toEpochDay(iso) + n);

/** A dam's fields that change its capacity over a run (engine ≥ 1.30.0, docs/model.md §2.7g). */
export type DamDev = Pick<NetworkNode, 'damSurveyDate' | 'damSedimentPctPerYear' | 'damInServiceFrom'>;

/** A dam as a run saw it: its entered capacity, minimum level (%) and, when set, what changes its capacity. */
export interface RunDam {
	nodeId: string;
	name: string;
	capacityM3: number;
	minPct: number;
	/** Present only when the dam's capacity changes over the run (a sediment rate, an in-service date). */
	dev?: DamDev;
}

/** The dam's capacity (m³) on epoch day `day`: the entered capacity unless its capacity changes (engine damCapacityOn). */
export function capacityOnDay(dam: { capacityM3: number; dev?: DamDev }, day: number): number {
	return dam.dev ? damCapacityOn({ kind: 'farm', damCapacityM3: dam.capacityM3, abstractionFrom: null, ...dam.dev }, day) : dam.capacityM3;
}

/** The dam's capacity (m³) on an ISO date. */
export function capacityOnDate(dam: { capacityM3: number; dev?: DamDev }, iso: string): number {
	return dam.dev ? capacityOnDay(dam, toEpochDay(iso)) : dam.capacityM3;
}

/** The capacity on each index of a series starting `startDate`, or undefined when it doesn't change (use capacityM3). */
export function capacityOver(dam: { capacityM3: number; dev?: DamDev }, startDate: string): ((i: number) => number) | undefined {
	if (!dam.dev) return undefined;
	const d0 = toEpochDay(startDate);
	return (i) => capacityOnDay(dam, d0 + i);
}

/** Storage as % of a day's capacity: 0 on a day the dam has none (before it is in service). */
export const pctOfCapacity = (m3: number, capacityM3: number) => (capacityM3 > 0 ? (m3 / capacityM3) * 100 : 0);

const hasDev = (n: { damSurveyDate?: unknown; damSedimentPctPerYear?: unknown; damInServiceFrom?: unknown }) =>
	(typeof n.damSedimentPctPerYear === 'number' && n.damSedimentPctPerYear > 0 && typeof n.damSurveyDate === 'string') || typeof n.damInServiceFrom === 'string';

/** The node's DamDev when its capacity changes over a run, else undefined (so an unchanged dam reads as before). */
export function damDevOf(n: { kind?: unknown; damSurveyDate?: unknown; damSedimentPctPerYear?: unknown; damInServiceFrom?: unknown }): DamDev | undefined {
	if ((n.kind !== undefined && n.kind !== 'farm') || !hasDev(n)) return undefined;
	return {
		damSurveyDate: typeof n.damSurveyDate === 'string' ? n.damSurveyDate : null,
		damSedimentPctPerYear: typeof n.damSedimentPctPerYear === 'number' ? n.damSedimentPctPerYear : null,
		damInServiceFrom: typeof n.damInServiceFrom === 'string' ? n.damInServiceFrom : null
	};
}

export interface DamLevel {
	nodeId: string;
	name: string;
	/** The entered capacity (the dam's size). */
	capacityM3: number;
	/** What changes its capacity over the run; the % figures below are shares of the day's capacity. */
	dev?: DamDev;
	/** The capacity on endDate, and AGO_DAYS before it, when it differs from capacityM3 (absent: capacityM3). */
	endCapacityM3?: number;
	agoCapacityM3?: number;
	/** The dam's minimum operating level, % of capacity (0 when none). */
	minPct: number;
	/** Storage on the run's last day with a value, % of capacity, and that day. */
	endPct: number;
	endDate: string;
	/** Lowest storage in the last 365 days of the run, % of capacity, and its first day. */
	lowPct: number;
	lowDate: string;
	/** Days in that year at or below the minimum level (0 when the dam has none). */
	daysAtMin: number;
	/** Storage AGO_DAYS before the end day, % of capacity; null when the series has no value there. */
	agoPct: number | null;
}

/** The window "the last year" covers: 365 days ending on the series' last day. */
export const YEAR_DAYS = 365;
/** "Dams today" compares the end of the run with this many days before it. */
export const AGO_DAYS = 30;

/**
 * One dam's levels, or null when the series has no finite value or the dam
 * no capacity. Values are m³; the result is % of capacity. A forecast run's
 * days from `forecastFrom` on are left out.
 */
export function damLevel(
	dam: RunDam,
	series: DailySeries,
	forecastFrom: string | null = null
): DamLevel | null {
	if (!(dam.capacityM3 >= 1)) return null;
	const v = beforeForecast(series.values, series.startDate, forecastFrom);
	let last = -1;
	for (let i = v.length - 1; i >= 0; i--) {
		const x = v[i];
		if (x != null && Number.isFinite(x)) {
			last = i;
			break;
		}
	}
	if (last < 0) return null;
	const capOn = capacityOver(dam, series.startDate);
	const pct = (x: number, i: number) => (capOn ? pctOfCapacity(x, capOn(i)) : (x / dam.capacityM3) * 100);
	const from = Math.max(0, last - YEAR_DAYS + 1);
	// The first day of the lowest level: scan forward, replace only on a lower value.
	let low = -1;
	let daysAtMin = 0;
	for (let i = from; i <= last; i++) {
		const x = v[i];
		if (x == null || !Number.isFinite(x)) continue;
		if (low < 0 || x < v[low]!) low = i;
		// A small tolerance: the engine holds a dam at its minimum as a float.
		if (dam.minPct > 0 && (!capOn || capOn(i) > 0) && pct(x, i) <= dam.minPct + 1e-6) daysAtMin++;
	}
	const ago = last - AGO_DAYS >= 0 ? v[last - AGO_DAYS] : null;
	return {
		nodeId: dam.nodeId,
		name: dam.name,
		capacityM3: dam.capacityM3,
		...(capOn ? { dev: dam.dev, endCapacityM3: capOn(last), agoCapacityM3: capOn(last - AGO_DAYS) } : {}),
		minPct: dam.minPct,
		endPct: pct(v[last]!, last),
		endDate: addDays(series.startDate, last),
		lowPct: pct(v[low]!, low),
		lowDate: addDays(series.startDate, low),
		daysAtMin,
		agoPct: ago != null && Number.isFinite(ago) ? pct(ago, last - AGO_DAYS) : null
	};
}

export interface DamsToday {
	/** All dams' storage at the end of the run as a share of their total capacity, %. */
	pct: number;
	/** Change in that share over the run's last AGO_DAYS days, percentage points; null when a dam has no value then. */
	change: number | null;
	dams: number;
	/** The end day (the latest of the dams' last days). */
	endDate: string;
}

/**
 * All dams together, weighted by capacity (a 90 000 m³ dam counts more than a
 * 5 000 m³ one): total storage over total capacity, and its change over the
 * last AGO_DAYS days. null without levels. Each dam's capacity is the day's
 * (endCapacityM3, agoCapacityM3), so the total is a share of what the dams
 * held on those days.
 */
export function damsToday(levels: readonly DamLevel[]): DamsToday | null {
	if (!levels.length) return null;
	let cap = 0;
	let agoCap = 0;
	let end = 0;
	let ago = 0;
	let allAgo = true;
	let endDate = levels[0]!.endDate;
	for (const l of levels) {
		const endCap = l.endCapacityM3 ?? l.capacityM3;
		const agoCapL = l.agoCapacityM3 ?? l.capacityM3;
		cap += endCap;
		agoCap += agoCapL;
		end += (l.endPct / 100) * endCap;
		if (l.agoPct === null) allAgo = false;
		else ago += (l.agoPct / 100) * agoCapL;
		if (l.endDate > endDate) endDate = l.endDate;
	}
	const pct = pctOfCapacity(end, cap);
	return { pct, change: allAgo && agoCap > 0 ? pct - (ago / agoCap) * 100 : null, dams: levels.length, endDate };
}

type DamNode = {
	id: string;
	name?: string;
	kind?: unknown;
	damCapacityM3?: unknown;
	damMinPct?: unknown;
	damSurveyDate?: unknown;
	damSedimentPctPerYear?: unknown;
	damInServiceFrom?: unknown;
};

/**
 * The dams a run stored storage for: nodes with a capacity and a dam_storage
 * series. Capacity and the minimum level come from the run's own model
 * (`runNodes`), so a later edit doesn't skew them; `liveNodes` stand in for a
 * run saved before it kept its model. The model keeps the minimum level as a
 * fraction of capacity (`damMinPct` 0.1 = 10 %), and only a farm's dam has
 * one (the engine's dead storage; the node form offers it on farms only), so
 * it comes back as a percentage, 0 for any other node. A dam whose capacity
 * changes over the run carries `dev` (damDevOf), read by capacityOnDay.
 */
export function damsInRun(
	runNodes: readonly DamNode[] | undefined,
	liveNodes: readonly DamNode[],
	refs: readonly { key: string; nodeId: string | null }[]
): RunDam[] {
	const nodes = runNodes?.length ? runNodes : liveNodes;
	const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
	return nodes
		.map((n): RunDam => {
			const dev = damDevOf(n);
			return {
				nodeId: n.id,
				name: n.name || '(unnamed)',
				capacityM3: num(n.damCapacityM3),
				minPct: n.kind === undefined || n.kind === 'farm' ? num(n.damMinPct) * 100 : 0,
				...(dev ? { dev } : {})
			};
		})
		.filter((d) => d.capacityM3 >= 1 && refs.some((r) => r.key === 'dam_storage' && r.nodeId === d.nodeId));
}

/**
 * One dam as a run saw it (damsInRun): its capacity and minimum level from the
 * run's own model, or null when the run stored no storage for it. The
 * Network's node card reads its end-of-run level against this capacity, as the
 * map's colour by dam level does, so a capacity edited since the run doesn't
 * make the two disagree (issue #173).
 */
export function damInRun(
	runNodes: readonly DamNode[] | undefined,
	liveNodes: readonly DamNode[],
	refs: readonly { key: string; nodeId: string | null }[],
	nodeId: string
): RunDam | null {
	return damsInRun(runNodes, liveNodes, refs).find((d) => d.nodeId === nodeId) ?? null;
}

/**
 * A dam's storage at the end of the run, % of the run's capacity on `endDate`
 * (the summary's last day, latestRun.ts historyEnd), from the run
 * summary (engine ≥ 1.2.0, issue #55); undefined when the summary lacks the
 * figure (a run saved before it), so the caller reads the series (damLevel).
 */
export function damEndPctFromSummary(dam: { nodeId: string; capacityM3: number; dev?: DamDev }, farms: readonly FarmSummary[], endDate: string): number | undefined {
	const end = farms.find((f) => f.nodeId === dam.nodeId)?.damEndM3;
	if (end === undefined) return undefined;
	return dam.dev ? pctOfCapacity(end, capacityOnDate(dam, endDate)) : (end / dam.capacityM3) * 100;
}

/**
 * The Network card's "Dam at end of run" for one farm (issue #173): whether
 * the run modelled a dam there, and if so its capacity in the run and its
 * storage on the run's last day, % of that capacity (null while loading, or
 * when the series had no value).
 */
export interface DamEnd {
	nodeId: string;
	inRun: boolean;
	pct: number | null;
	capacityM3: number;
}

/**
 * The tile's value and its small line, reading a farm as the map's colour by
 * dam level does (network/farmColour.ts `damColouring`): a farm with no dam in
 * the model now is "No dam" (even if the run had one), one whose dam the run
 * didn't model (added since) reads "not in this run" under a dash, as the
 * Supplied tile writes it, and otherwise the % of the run's capacity. When the
 * capacity has been edited since the run, the line says what the % is a share
 * of. `liveCapacityM3` is the model's capacity now.
 */
export function damEndTile(end: DamEnd | null, liveCapacityM3: number): { value: string; sub: string | null } {
	if (!(liveCapacityM3 >= 1)) return { value: 'No dam', sub: null };
	if (!end) return { value: '–', sub: null };
	if (!end.inRun) return { value: '–', sub: 'not in this run' };
	const edited = Math.abs(end.capacityM3 - liveCapacityM3) >= 1;
	return {
		value: end.pct === null ? '–' : `${fmtNum(end.pct, 0)}%`,
		sub: edited ? `of ${fmtNum(end.capacityM3)} m³ in the run` : null
	};
}

/**
 * Each dam's levels from the run summary (engine ≥ 1.2.0, issue #55), with no
 * series to fetch; `endDate` is the last day the summary covers (the engine's
 * storage has a value every day): the run's last day, or on a forecast run
 * the day before the forecast (latestRun.ts historyEnd). null when any dam lacks the figures (a run saved before
 * them): the caller falls back to the series (loadDamLevels). Emptiest first.
 * Each figure is a share of the capacity on its own day (the end, 30 days
 * before it, the low's date; damDaysAtMin is the engine's, already so).
 */
export function damLevelsFromSummary(
	dams: readonly RunDam[],
	farms: readonly FarmSummary[],
	endDate: string
): DamLevel[] | null {
	const out: DamLevel[] = [];
	for (const d of dams) {
		const f = farms.find((x) => x.nodeId === d.nodeId);
		if (f?.damEndM3 === undefined || f.damLowM3 === undefined || f.damLowDate === undefined || f.damDaysAtMin === undefined) return null;
		const agoDate = addDays(endDate, -AGO_DAYS);
		const pct = (x: number, date: string) => (d.dev ? pctOfCapacity(x, capacityOnDate(d, date)) : (x / d.capacityM3) * 100);
		out.push({
			...d,
			...(d.dev ? { endCapacityM3: capacityOnDate(d, endDate), agoCapacityM3: capacityOnDate(d, agoDate) } : {}),
			endPct: pct(f.damEndM3, endDate),
			endDate,
			lowPct: pct(f.damLowM3, f.damLowDate),
			lowDate: f.damLowDate,
			daysAtMin: f.damDaysAtMin,
			agoPct: f.damAgoM3 == null ? null : pct(f.damAgoM3, agoDate)
		});
	}
	return sortDamLevels(out);
}

/** Emptiest first (end-of-run %), then by name. */
export function sortDamLevels(levels: readonly DamLevel[]): DamLevel[] {
	return [...levels].sort((a, b) => a.endPct - b.endPct || a.name.localeCompare(b.name));
}

/** How full, in words and a band for the bar (never colour alone: the % is always shown). */
export function levelBand(l: Pick<DamLevel, 'endPct' | 'minPct'>): 'at-min' | 'low' | 'ok' {
	if (l.minPct > 0 && l.endPct <= l.minPct + 1e-6) return 'at-min';
	return l.endPct < LOW_PCT ? 'low' : 'ok';
}

/** Below this share of capacity a dam counts as low on the Summary. */
export const LOW_PCT = 30;

/**
 * Each dam's levels from its daily series, `atOnce` fetches at a time (the
 * Summary's Dam levels panel and the Network's colour by dam level share it).
 * `get` fetches one dam's series (through the Runs cache); `onDone` reports
 * progress. Emptiest first; a dam whose series has no value is left out.
 */
export async function loadDamLevels(
	dams: readonly RunDam[],
	get: (nodeId: string) => Promise<DailySeries>,
	atOnce = 4,
	onDone?: (done: number) => void,
	forecastFrom: string | null = null
): Promise<DamLevel[]> {
	const out: DamLevel[] = [];
	let next = 0;
	let done = 0;
	const worker = async () => {
		while (next < dams.length) {
			const d = dams[next++]!;
			const l = damLevel(d, await get(d.nodeId), forecastFrom);
			if (l) out.push(l);
			onDone?.(++done);
		}
	};
	await Promise.all(Array.from({ length: Math.min(atOnce, dams.length) }, worker));
	return sortDamLevels(out);
}
