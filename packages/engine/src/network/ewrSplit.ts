// How the EWR is split between the units (engine ≥ 1.105.0, issue #615,
// docs/model.md §2.5b): one way only, by each unit's natural MAR share,
// under both flow generation methods.
//
// A unit's natural MAR is its own GR4J natural runoff from its own rain
// (before land cover and base flow), summed over the run's complete water
// years (Oct–Sep, historical days only), or the whole historical run when it
// holds none (engine-audit.md ES1, provisional). It is the unit's
// incremental runoff, not the flow accumulated from the units above it, so
// the shares add up to 1; the requirement at a site, Z = Σ Y over the unit
// and everything above it (§2.7), then follows the cumulative natural MAR
// there.
//
// - Per unit (settings.unitRain `perUnit`): the units' own GR4J runs, the
//   runoff they feed the network.
// - Fragmentation: the run also runs GR4J once per land unit on the Per unit
//   forcing (./../runoff/unitRain.ts, the same chain, stations and
//   parameters), for the shares only (engine-audit.md FM1). The catchment's
//   one GR4J run still makes the flow, split by the flow share (§2.5; issue
//   #616 moves that to these shares too). A unit with no rain of its own
//   runs on the catchment rain (rule 4), so its share is in proportion to
//   its area; the run names those units in one note.
//
// Fallbacks: no runoff over the period → the area shares (why 'noRunoff');
// no land unit at all → nothing to split by, the flow share (why
// 'noLandUnit', a transitional fallback that #616 removes with the flow
// share methods).
//
// Before 1.105.0 the split was a choice, settings.ewrSplit ('flowShare', the
// default, or 'naturalMar', engine 1.94.0): the key is retired, ignored when
// read (RETIRED_SETTINGS_KEYS), and an older run's summary still records the
// method it asked for (EwrSplitInfo.method). Pure: no I/O.
import { dayText, fromEpochDay, toEpochDay, waterYearOf } from '../calendar';
import { cmpStr } from '../order';

/** settings.ewrSplit's values, engines 1.94.0 to 1.104.x: what an older run's summary records it asked for. */
export const EWR_SPLIT_METHODS = ['flowShare', 'naturalMar'] as const;
export type EwrSplitMethod = (typeof EWR_SPLIT_METHODS)[number];

/** The words for each split, as the run's note, the report and the run comparison say them. */
export const EWR_SPLIT_LABEL: Record<EwrSplitMethod | 'area', string> = {
	flowShare: 'the flow share',
	naturalMar: 'each unit’s natural MAR',
	area: 'each unit’s area'
};

/** The engine version that retired settings.ewrSplit: the EWR is split by each unit's natural MAR from it on. */
export const EWR_SPLIT_RETIRED_IN = '1.105.0';

/** The days a natural MAR split is taken over (ISO dates, inclusive); `waterYears` 0 = the whole run, which holds no complete water year. */
export interface EwrSplitPeriod {
	start: string;
	end: string;
	waterYears: number;
}

/** A land unit that ran on the catchment rain for its share (rule 4: no station, gauge, MAP or CHIRPS of its own). */
export interface EwrSplitUnit {
	nodeId: string;
	name: string;
}

/**
 * What a run reports about its EWR split (RunSummary.ewrSplit).
 *
 * `applied`: what split the EWR. From 1.105.0 'naturalMar', else 'area' (why
 * 'noRunoff': no unit made runoff over the period) or 'flowShare' (why
 * 'noLandUnit': no unit has an area; 'noUnitRunoff': the natural flow was
 * supplied without the units' runoff, runModelWith's workbook regression and
 * hand networks; or 'resumed').
 *
 * `runoffFrom` (≥ 1.105.0): where the units' natural runoff came from,
 * 'unitRain' (Per unit's own runs) or 'shareRuns' (Fragmentation's per-unit
 * runs made for the shares only). `catchmentRain`: under Fragmentation, the
 * land units on rule 4, whose share is their area's.
 *
 * `method` (1.94.0 – 1.104.x only): the retired setting the run asked for;
 * `why` 'catchmentRain' was one of those runs' (the natural MAR asked for
 * under catchment rain fell back to the flow share).
 */
export interface EwrSplitInfo {
	method?: EwrSplitMethod;
	applied: EwrSplitMethod | 'area';
	why?: 'catchmentRain' | 'noRunoff' | 'resumed' | 'noLandUnit' | 'noUnitRunoff';
	/** The days the natural MAR was taken over; with `applied` 'naturalMar' or 'area' (noRunoff). */
	period?: EwrSplitPeriod;
	runoffFrom?: 'unitRain' | 'shareRuns';
	catchmentRain?: EwrSplitUnit[];
	pinned?: true;
}

/**
 * What a snapshot pins of the split (warmstart PinnedStatistics.ewrSplit): the period and each farm's share, by
 * node id, and the run's record of it, so a resumed run (a seasonal outlook member) splits its EWR as the capture
 * run did. No shares with no land unit (the flow share split the EWR).
 */
export interface PinnedEwrSplit {
	period: EwrSplitPeriod;
	shares: { nodeId: string; share: number }[];
	info?: EwrSplitInfo;
}

const pad4 = (y: number) => String(y).padStart(4, '0');

/**
 * The run days [from, to) a natural MAR is taken over: the complete water
 * years (1 Oct … 30 Sep all inside the historical days), or every
 * historical day when there are none (waterYears 0). `start` is the run's
 * first epoch day; undefined (a plan without dates) takes the whole run.
 */
export function ewrSplitDays(start: number | undefined, historyDays: number): { from: number; to: number; waterYears: number } {
	const all = { from: 0, to: Math.max(0, historyDays), waterYears: 0 };
	if (start === undefined || historyDays <= 0) return all;
	const last = start + historyDays - 1;
	const wy0 = waterYearOf(start) + (fromEpochDay(start).slice(5) === '10-01' ? 0 : 1);
	const wy1 = waterYearOf(last) - (fromEpochDay(last).slice(5) === '09-30' ? 0 : 1);
	if (wy1 < wy0) return all;
	return { from: toEpochDay(`${pad4(wy0)}-10-01`) - start, to: toEpochDay(`${pad4(wy1 + 1)}-09-30`) - start + 1, waterYears: wy1 - wy0 + 1 };
}

/** The period as dates, for the run's record. */
export function ewrSplitPeriod(start: number | undefined, days: { from: number; to: number; waterYears: number }): EwrSplitPeriod {
	const d0 = start ?? 0;
	return { start: fromEpochDay(d0 + days.from), end: fromEpochDay(d0 + Math.max(days.from, days.to - 1)), waterYears: days.waterYears };
}

/**
 * Each unit's natural MAR share: Σ its runoff over [from, to) ÷ Σ every
 * unit's, summed in node-id order so the shares are the same to the bit
 * however the nodes are listed. A unit's negative or non-finite day counts
 * 0. null when the units made no runoff over the period (nothing to split
 * by).
 */
export function naturalMarShares(units: readonly { nodeId: string; runoffM3Day: ArrayLike<number> }[], from: number, to: number): Map<string, number> | null {
	const sorted = [...units].sort((a, b) => cmpStr(a.nodeId, b.nodeId));
	const vol = sorted.map((u) => {
		let s = 0;
		const end = Math.min(to, u.runoffM3Day.length);
		for (let t = Math.max(0, from); t < end; t++) {
			const v = u.runoffM3Day[t]!;
			if (v > 0 && Number.isFinite(v)) s += v;
		}
		return s;
	});
	let total = 0;
	for (const v of vol) total += v;
	if (!(total > 0) || !Number.isFinite(total)) return null;
	return new Map(sorted.map((u, k) => [u.nodeId, vol[k]! / total]));
}

/**
 * Each land unit's area share, areaKm2 ÷ Σ the land units' (node-id order): the split with no runoff over the
 * period. null without a land unit (no area anywhere).
 */
export function areaShares(units: readonly { nodeId: string; areaKm2: number }[]): Map<string, number> | null {
	const land = [...units].filter((u) => u.areaKm2 > 0 && Number.isFinite(u.areaKm2)).sort((a, b) => cmpStr(a.nodeId, b.nodeId));
	let total = 0;
	for (const u of land) total += u.areaKm2;
	if (!(total > 0)) return null;
	return new Map(land.map((u) => [u.nodeId, u.areaKm2 / total]));
}

/**
 * Where a plan's split reads its runoff from: the farms (plan index, node id, area) and their natural runoff
 * arrays (the plan's local runoff under Per unit, the share runs' under Fragmentation), which a calibration
 * refills for each candidate.
 */
export interface EwrSplitPlan {
	days: { from: number; to: number };
	farms: { index: number; nodeId: string; areaKm2: number; runoff: ArrayLike<number> | undefined }[];
}

/**
 * Set each farm's `ewrShare` from its runoff over the plan's period (the run's, and each calibration
 * candidate's), or from the units' areas when they made no runoff. Returns the shares and which split applied.
 */
export function fillPlanEwrShares(nodes: { ewrShare?: number }[], split: EwrSplitPlan): { shares: Map<string, number>; applied: 'naturalMar' | 'area' } | null {
	const natural = naturalMarShares(
		split.farms.flatMap((f) => (f.runoff ? [{ nodeId: f.nodeId, runoffM3Day: f.runoff }] : [])),
		split.days.from,
		split.days.to
	);
	const shares = natural ?? areaShares(split.farms);
	if (!shares) return null;
	for (const f of split.farms) nodes[f.index]!.ewrShare = shares.get(f.nodeId) ?? 0;
	return { shares, applied: natural ? 'naturalMar' : 'area' };
}

const names = (units: readonly EwrSplitUnit[]): string => {
	const q = units.map((u) => `"${u.name}"`);
	return q.length <= 1 ? (q[0] ?? '') : `${q.slice(0, -1).join(', ')} and ${q.at(-1)}`;
};

/**
 * The run's note on its EWR split (pushed with the warnings): how the units' shares were made, from 1.105.0 on
 * every run with a land unit. One note, naming the land units a Fragmentation run's shares put on the catchment rain.
 */
export function ewrSplitNote(info: EwrSplitInfo): string | null {
	// Only runModelWith supplies natural flow without the units' runoff (a test harness, not a project's run): no note.
	if (info.why === 'noUnitRunoff') return null;
	if (info.why === 'noLandUnit') return 'no unit has an area, so there is no natural MAR to split the EWR by: it is split between the units by the flow share';
	if (info.why === 'resumed') return 'this run resumes from a snapshot that pinned no EWR shares, so it splits the EWR by the flow share';
	const p = info.period;
	if (!p) return null;
	const over = p.waterYears > 0 ? `${p.waterYears === 1 ? 'the 1 complete water year' : `the ${p.waterYears} complete water years`} ${dayText(p.start)} – ${dayText(p.end)}` : `the whole run, ${dayText(p.start)} – ${dayText(p.end)}, which holds no complete water year`;
	if (info.applied === 'area') return `no unit made natural runoff over ${over}, so the EWR is split between the units by their area`;
	const pinned = info.pinned ? ' (the capture run’s shares)' : '';
	const how =
		info.runoffFrom === 'shareRuns'
			? ': under Fragmentation GR4J also runs once on each unit’s own rain (the Per unit setup) for these shares only, and the catchment’s one run still makes the flow'
			: '';
	const fell = info.catchmentRain?.length
		? `. ${names(info.catchmentRain)} ${info.catchmentRain.length === 1 ? 'has' : 'have'} no rain of ${info.catchmentRain.length === 1 ? 'its' : 'their'} own (no station, gauge, MAP or CHIRPS), so ${info.catchmentRain.length === 1 ? 'it runs' : 'they run'} on the catchment rain and ${info.catchmentRain.length === 1 ? 'its share follows its' : 'their shares follow their'} area: set up Per unit for ${info.catchmentRain.length === 1 ? 'it' : 'them'} (Model settings → Model selection for flow generation)`
		: '';
	return `the EWR is split between the units by each unit’s natural MAR over ${over}${pinned}${how}; the period is provisional (engine-audit.md ES1)${fell}`;
}
