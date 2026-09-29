// The seasonal outlook as one farmer sees it (issue #53 R5, farmer-view ask
// E3; docs/design/planning-outputs.md §3.5, docs/ui.md § Farm view): the
// level the WUA published for the season and what that level gave this farm
// across the analogue years, its own figures only. The WUA decides the level
// and publishes it (the client confirmed farmers see the outlook, O5, issue
// #90); the app never picks one for a farmer.
//
// Pure: no I/O. Built by the backend when an outlook is published (one per
// linked farm, outlook_publication_farm) and read back unchanged.
import type { OutlookStat, SeasonalOutlook } from '../outlook/outlook';

/** One farm's view of a published outlook. Shares are fractions 0–1. */
export interface FarmOutlookProjection {
	/** The season: its first day (the decision date) and last. */
	decisionDate: string;
	seasonEnd: string;
	/** When the WUA reviews the level (the review triggers' date); null when it set none. */
	reviewDate: string | null;
	/** The level the WUA published, by its label as the WUA typed it ("85 %"). */
	level: { id: string; label: string };
	/** Analogue years the outlook ran. */
	nYears: number;
	/** Years this farm had irrigation demand in, at this level. */
	demandYears: number;
	/** This farm's share of its own demand met: median and 10th–90th percentile; null with too few years or no demand. */
	demandMet: OutlookStat | null;
	/** This farm's dam at the season end, as a share of its capacity; null without a dam. */
	dam: { capacityM3: number; seasonEndShare: OutlookStat | null } | null;
}

/** Why a published outlook can't be shown per farm. */
export type FarmOutlookProblem = 'noSuchLevel' | 'levelNotRun' | 'noFarmFigures';

/**
 * One farm's projection of an outlook result at the published level, or why
 * there is none: the level isn't in the outlook, it didn't run, or the
 * outlook predates per-farm figures (engine < 1.19.0, so re-run it). A farm
 * without demand in any year gets a projection with `demandMet` null and
 * `demandYears` 0; a farm without a dam gets `dam` null.
 */
export function farmOutlookProjection(
	outlook: Pick<SeasonalOutlook, 'decisionDate' | 'seasonEnd' | 'nYears' | 'levels'>,
	levelId: string,
	nodeId: string,
	reviewDate: string | null
): { projection: FarmOutlookProjection; problem: null } | { projection: null; problem: FarmOutlookProblem } {
	const level = outlook.levels.find((l) => l.id === levelId);
	if (!level) return { projection: null, problem: 'noSuchLevel' };
	if (level.problems.length) return { projection: null, problem: 'levelNotRun' };
	if (!Array.isArray((level as { demandMetByFarm?: unknown }).demandMetByFarm)) return { projection: null, problem: 'noFarmFigures' };
	const own = level.demandMetByFarm.find((f) => f.nodeId === nodeId);
	const dam = level.storageByDam.find((d) => d.nodeId === nodeId);
	const share = (s: OutlookStat | null, cap: number): OutlookStat | null => (s && cap > 0 ? { p10: s.p10 / cap, p50: s.p50 / cap, p90: s.p90 / cap } : null);
	return {
		problem: null,
		projection: {
			decisionDate: outlook.decisionDate,
			seasonEnd: outlook.seasonEnd,
			reviewDate,
			level: { id: level.id, label: level.label },
			nYears: outlook.nYears,
			demandYears: own?.nYears ?? 0,
			demandMet: own?.stat ?? null,
			dam: dam ? { capacityM3: dam.capacityM3, seasonEndShare: share(dam.stat, dam.capacityM3) } : null
		}
	};
}
