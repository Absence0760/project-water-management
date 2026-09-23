// View model for CurtailmentTable: turns RunSummary.curtailment (engine,
// b023 [Shortfalls]) into display rows. Kept free of Svelte so it can be
// unit-tested. Sign convention throughout: negative = reduce, positive = gain.
import type { CurtailmentFarm, CurtailmentSummary } from '@water-management/engine';
import { fmtNum, fmtPct } from '$lib/format/number';

/** What a farm has to do overall (total change = reduce/gain + EWR shortfall). */
export type Action = 'cut' | 'gain' | 'none';

export function actionOf(totalChange: number): Action {
	if (totalChange < 0) return 'cut';
	if (totalChange > 0) return 'gain';
	return 'none';
}

/**
 * Signed volume: "+12.5", "-33.3", "0". The explicit "+" makes a gain read
 * as a gain. Values are shown to at most one decimal (the workbook's 1-dp
 * target) and the trailing ".0" is trimmed.
 */
export function fmtSigned(n: number | null | undefined, digits = 1): string {
	if (n == null || !Number.isFinite(n)) return '–';
	const s = fmtNum(n, digits, true);
	if (s === '0') return '0';
	return n > 0 ? `+${s}` : s;
}

/** Plain volume (m³/day), at most one decimal. */
export function fmtVol(n: number | null | undefined): string {
	return fmtNum(n, 1, true);
}

export interface CurtailmentRow {
	nodeId: string;
	name: string;
	action: Action;
	demand: string;
	supplied: string;
	suppliedPct: string;
	target: string;
	reduceGain: string;
	reduceGainLs: string;
	ewrShortfall: string;
	totalChange: string;
	totalChangeLs: string;
	volumeLeft: string;
	demandLeftPct: string;
	/** Short plain-language summary for the row (also used as the badge / screen-reader text). */
	verdict: string;
}

function verdict(f: CurtailmentFarm, action: Action): string {
	if (action === 'cut') return `cut ${fmtVol(-f.totalChangeM3Day)} m³/day`;
	if (action === 'gain') return `may gain ${fmtVol(f.totalChangeM3Day)} m³/day`;
	return 'no change';
}

/**
 * One display row per farm, in the engine's (network) order. `names` maps a
 * node id to its current name, for farms renamed since the run; unknown ids
 * keep the name stored with the run.
 */
export function curtailmentRows(c: CurtailmentSummary, names: Record<string, string> = {}): CurtailmentRow[] {
	return c.farms.map((f) => {
		const action = actionOf(f.totalChangeM3Day);
		return {
			nodeId: f.nodeId,
			name: names[f.nodeId] ?? f.name,
			action,
			demand: fmtVol(f.demandM3Day),
			supplied: fmtVol(f.suppliedM3Day),
			suppliedPct: fmtPct(f.fractionSupplied),
			target: fmtVol(f.targetM3Day),
			reduceGain: fmtSigned(f.reduceGainM3Day),
			reduceGainLs: fmtSigned(f.reduceGainLs),
			ewrShortfall: fmtSigned(f.ewrShortfallM3Day, 0),
			totalChange: fmtSigned(f.totalChangeM3Day),
			totalChangeLs: fmtSigned(f.totalChangeLs),
			volumeLeft: fmtVol(f.volumeLeftM3Day),
			demandLeftPct: fmtPct(f.fractionOfDemandLeft),
			verdict: verdict(f, action)
		};
	});
}

/** How many farms have to cut overall. */
export function cutCount(c: CurtailmentSummary): number {
	return c.farms.filter((f) => f.totalChangeM3Day < 0).length;
}
