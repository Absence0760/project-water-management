// How the EWR is split between the units (engine ≥ 1.94.0, issue #553,
// docs/model.md §2.5b): settings.ewrSplit.
//
// - 'flowShare' (the default): each unit's EWR is the pragmatic (or daily)
//   EWR × its flow share (§2.5), the workbook's [Fragmented EWR], as every run
//   before 1.94.0 did.
// - 'naturalMar': each unit's EWR is the EWR × its natural MAR ÷ Σ the units'
//   natural MAR. A unit's natural MAR is its own GR4J natural runoff under
//   runoff from each unit's own rain (§2.4h), taken over the run's complete
//   water years (Oct–Sep, historical days only), or the whole historical run
//   when it holds none (engine-audit.md ES1, provisional). Under catchment
//   rain (Fragmentation) a unit's natural runoff is natural × its flow share,
//   so the shares are the flow shares and the run applies those.
//
// The split is the only thing that changes: every unit's EWR share Y, so the
// cumulative requirement Z, every EWR site's shortfall, the attribution and
// charge (§2.7b), the curtailment, the hands-off EWR flows and the drought
// restriction's EWR trigger follow it. Pure: no I/O.
import { dayText, fromEpochDay, toEpochDay, waterYearOf } from '../calendar';
import { cmpStr } from '../order';

export const EWR_SPLIT_METHODS = ['flowShare', 'naturalMar'] as const;
export type EwrSplitMethod = (typeof EWR_SPLIT_METHODS)[number];

/** The words for each method, as the Settings select, the run's note and the run comparison say them. */
export const EWR_SPLIT_LABEL: Record<EwrSplitMethod, string> = {
	flowShare: 'the flow share',
	naturalMar: 'each unit’s natural MAR'
};

/** The days a natural MAR split is taken over (ISO dates, inclusive); `waterYears` 0 = the whole run, which holds no complete water year. */
export interface EwrSplitPeriod {
	start: string;
	end: string;
	waterYears: number;
}

/**
 * What a run reports about its EWR split (RunSummary.ewrSplit). `method` is
 * the setting; `applied` what split the EWR. They differ when the method
 * asked for is the natural MAR and the run can't apply it: `why`
 * 'catchmentRain' (GR4J ran once on the catchment rain, so the natural MAR
 * shares are the flow shares) or 'noRunoff' (no unit made natural runoff
 * over the period, so there is nothing to split by) or 'resumed' (a run
 * resumed from a snapshot whose run pinned no shares keeps the flow share).
 * `pinned`: a resumed run's, taken from the capture run's snapshot.
 */
export interface EwrSplitInfo {
	method: EwrSplitMethod;
	applied: EwrSplitMethod;
	why?: 'catchmentRain' | 'noRunoff' | 'resumed';
	/** The days the natural MAR was taken over; with `applied` 'naturalMar' only. */
	period?: EwrSplitPeriod;
	pinned?: true;
}

/**
 * What a snapshot pins of a natural MAR split asked for under per-unit rain (warmstart PinnedStatistics.ewrSplit): the
 * period and each farm's share, by node id; no shares when the units made no runoff (the flow share split the EWR).
 */
export interface PinnedEwrSplit {
	period: EwrSplitPeriod;
	shares: { nodeId: string; share: number }[];
}

/** A stored or patched value as the run reads it: anything but 'naturalMar' is the default, 'flowShare'. */
export function resolveEwrSplit(v: unknown, warnings: string[]): EwrSplitMethod {
	if (v === undefined || v === null || v === 'flowShare') return 'flowShare';
	if (v === 'naturalMar') return 'naturalMar';
	warnings.push(`unknown EWR split "${String(v)}"; splitting the EWR by the flow share`);
	return 'flowShare';
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

/** Where a plan's natural MAR split reads its runoff from: the farms (plan index, node id) and their local runoff arrays, the plan's own, so a calibration's refill reaches them. */
export interface EwrSplitPlan {
	days: { from: number; to: number };
	farms: { index: number; nodeId: string; runoff: ArrayLike<number> | undefined }[];
}

/**
 * Set each farm's `ewrShare` from its runoff over the plan's period (the
 * run's, and each calibration candidate's), or clear it (the flow share
 * splits the EWR) when the units made no runoff. Returns the shares, or
 * null when cleared.
 */
export function fillPlanEwrShares(nodes: { ewrShare?: number }[], split: EwrSplitPlan): Map<string, number> | null {
	const shares = naturalMarShares(
		split.farms.flatMap((f) => (f.runoff ? [{ nodeId: f.nodeId, runoffM3Day: f.runoff }] : [])),
		split.days.from,
		split.days.to
	);
	for (const f of split.farms) {
		if (shares) nodes[f.index]!.ewrShare = shares.get(f.nodeId) ?? 0;
		else delete nodes[f.index]!.ewrShare;
	}
	return shares;
}

/** The run's note on a split other than the default (pushed with the warnings, as the daily outlet EWR's note is). */
export function ewrSplitNote(info: EwrSplitInfo): string | null {
	if (info.method === 'flowShare') return null;
	if (info.why === 'catchmentRain')
		return 'the EWR split by each unit’s natural MAR is the flow share here: GR4J runs once on the catchment rain, so a unit’s natural runoff is its flow share of it';
	if (info.why === 'noRunoff') return 'no unit made natural runoff over the run, so the EWR is split between the units by the flow share, not by their natural MAR';
	if (info.why === 'resumed') return 'this run resumes from a snapshot of a run that split the EWR by the flow share, so it keeps the flow share rather than work natural MAR shares out on its own days';
	const p = info.period!;
	const over = p.waterYears > 0 ? `${p.waterYears === 1 ? 'the 1 complete water year' : `the ${p.waterYears} complete water years`} ${dayText(p.start)} – ${dayText(p.end)}` : `the whole run, ${dayText(p.start)} – ${dayText(p.end)}, which holds no complete water year`;
	return `the EWR is split between the units by each unit’s natural MAR over ${over}${info.pinned ? ' (the capture run’s shares)' : ''}, not by the flow share; the period is provisional (engine-audit.md ES1)`;
}
