// The recent farm shortfall counts a publication stores for the portfolio
// dashboard (roadmap WP-2.14, docs/api.md § Portfolio): how many farms went
// short at least one day in the 7 and the 30 days to the run's dataUntil.
// Computed once at publish time from the run's stored deficit series, so the
// dashboard never reads daily arrays. Pure.
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import type { ProjectionRun, SeasonAnalysis } from '@water-management/engine';

/** A deficit below this (m³/day, under a millilitre) is float noise, not a short day: the farm projection's own rule. */
const NOISE_M3 = 1e-6;

/** Farms short in the last 7 and 30 days to `to` (both windows inclusive, clamped to the run). Counts only. */
export interface RecentShortfall {
	/** The last day both windows count to (the run's dataUntil). */
	to: string;
	from7: string;
	from30: string;
	farmsShort7: number;
	farmsShort30: number;
}

/**
 * Count the farms with a deficit on any day of each window. A farm without a
 * deficit series (it can't happen for a run the projection accepted) counts
 * as not short.
 */
export function recentShortfall(run: ProjectionRun, analysis: Pick<SeasonAnalysis, 'last30'>): RecentShortfall {
	const to = analysis.last30.to;
	const from30 = analysis.last30.from;
	const from7 = Math.max(0, to - 6);
	let farmsShort7 = 0;
	let farmsShort30 = 0;
	for (const n of run.nodes) {
		if (n.kind !== 'farm') continue;
		const deficit = run.series(n.id, 'deficit');
		if (!deficit) continue;
		let short30 = false;
		let short7 = false;
		for (let t = from30; t <= to && t < deficit.length; t++) {
			const v = deficit[t];
			if (typeof v === 'number' && v > NOISE_M3) {
				short30 = true;
				if (t >= from7) {
					short7 = true;
					break;
				}
			}
		}
		if (short30) farmsShort30++;
		if (short7) farmsShort7++;
	}
	const d0 = toEpochDay(run.startDate);
	return { to: fromEpochDay(d0 + to), from7: fromEpochDay(d0 + from7), from30: fromEpochDay(d0 + from30), farmsShort7, farmsShort30 };
}
