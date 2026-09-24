// View model for CurtailmentTable: turns RunSummary.curtailment (engine,
// b023 [Shortfalls]) into display rows. Kept free of Svelte so it can be
// unit-tested. Sign convention throughout: negative = reduce, positive = gain.
import type { CurtailmentFarm, CurtailmentSummary, EwrSiteSummary } from '@water-management/engine';
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
	/** R: the farm's EWR charge (engine ≥ 0.17.0; AB before). */
	ewrShortfall: string;
	/** R_irr and R_store (engine ≥ 0.17.0); "–" on older runs. */
	ewrIrrigation: string;
	ewrStorage: string;
	/** −ΔG, the supply cut that meets R_irr (m³/day and l/s); "–" on older runs. */
	supplyCut: string;
	supplyCutLs: string;
	/** Name of the EWR site that set most of the charge; "" when not charged or on older runs. */
	bindingSite: string;
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
	const siteName = new Map((c.ewrSites ?? []).map((s) => [s.nodeId, names[s.nodeId] ?? s.name]));
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
			ewrIrrigation: fmtSigned(f.ewrChargeIrrigationM3Day, 0),
			ewrStorage: fmtSigned(f.ewrChargeStorageM3Day, 0),
			supplyCut: fmtSigned(f.ewrSupplyCutM3Day),
			supplyCutLs: fmtSigned(f.ewrSupplyCutLs),
			bindingSite: f.ewrBindingSiteId ? (siteName.get(f.ewrBindingSiteId) ?? names[f.ewrBindingSiteId] ?? f.ewrBindingSiteId) : '',
			totalChange: fmtSigned(f.totalChangeM3Day),
			totalChangeLs: fmtSigned(f.totalChangeLs),
			volumeLeft: fmtVol(f.volumeLeftM3Day),
			demandLeftPct: fmtPct(f.fractionOfDemandLeft),
			verdict: verdict(f, action)
		};
	});
}

export interface EwrSiteRow {
	nodeId: string;
	name: string;
	farmCount: number;
	daysNotMet: string;
	shortfall: string;
	charged: string;
	natural: string;
}

/**
 * The EWR sites (engine ≥ 0.17.0, audit Q17): outlet first, then gauges.
 * Empty for older runs, which assessed the EWR farm by farm (AB).
 */
export function ewrSiteRows(c: CurtailmentSummary, names: Record<string, string> = {}): EwrSiteRow[] {
	return (c.ewrSites ?? []).map((s: EwrSiteSummary) => ({
		nodeId: s.nodeId,
		name: `${names[s.nodeId] ?? s.name}${s.isOutlet ? ' (outlet)' : ''}`,
		farmCount: s.farmCount,
		daysNotMet: fmtNum(s.daysNotMet),
		shortfall: fmtSigned(s.shortfallM3Day, 0),
		charged: fmtSigned(s.chargedM3Day, 0),
		natural: fmtSigned(s.naturalM3Day, 0)
	}));
}

/** How many farms have to cut overall. */
export function cutCount(c: CurtailmentSummary): number {
	return c.farms.filter((f) => f.totalChangeM3Day < 0).length;
}
