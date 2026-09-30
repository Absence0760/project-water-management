// View model for CurtailmentTable: turns RunSummary.curtailment (engine,
// b023 [Shortfalls]) into display rows. Kept free of Svelte so it can be
// unit-tested. Sign convention for changes: negative = reduce, positive = below
// the equitable share. EWR charges and shortfalls are volumes, shown positive
// (fmtCharged), as the Farms table shows them (issue #45). The equitable share is a fairness benchmark, not an
// allocation (audit Q11), so no displayed text calls a positive value a gain.
import { DEMAND_PCT_FLOOR_M3_DAY, type CurtailmentFarm, type CurtailmentSummary, type EwrSiteSummary } from '@water-management/engine';
import { fmtNum, fmtPct } from '$lib/format/number';

/**
 * What a farm has to do overall: cut supply, sit below its equitable share
 * ('gain', an internal name only; total change = above/below the share
 * − EWR supply cut), or, with no change in supply, store less / pass inflow
 * for the storage part of its EWR charge (audit Q13, engine ≥ 0.17.0).
 */
export type Action = 'cut' | 'gain' | 'store' | 'none';

export function actionOf(totalChange: number): Action {
	if (totalChange < 0) return 'cut';
	if (totalChange > 0) return 'gain';
	return 'none';
}

/**
 * Signed volume: "+12.5", "-33.3", "0". The explicit "+" makes a positive
 * value (below the equitable share) read as positive. Values are shown to at most one decimal (the workbook's 1-dp
 * target) and the trailing ".0" is trimmed.
 */
export function fmtSigned(n: number | null | undefined, digits = 1): string {
	if (n == null || !Number.isFinite(n)) return '–';
	const s = fmtNum(n, digits, true);
	if (s === '0') return '0';
	return n > 0 ? `+${s}` : s;
}

/**
 * "Demand left %" (audit Q13): the share of demand left after the cuts, as a
 * whole %, never outside 0–100. No demand → "no demand"; demand under
 * DEMAND_PCT_FLOOR_M3_DAY → "—" (a % of almost nothing isn't meaningful);
 * (0, 0.5 %) → "<1%" and [99.5 %, 100 %) → ">99%" so neither rounds to a
 * misleading 0 or 100.
 */
export function fmtDemandLeft(demandM3Day: number, fraction: number | null | undefined): { text: string; title: string | null } {
	if (!(demandM3Day > 0) || fraction == null || !Number.isFinite(fraction)) return { text: 'no demand', title: null };
	if (demandM3Day < DEMAND_PCT_FLOOR_M3_DAY) return { text: '—', title: `demand under ${DEMAND_PCT_FLOOR_M3_DAY} m³/day; % not meaningful` };
	// Runs before engine 0.17.0 could store values outside 0–1 (the volume left could go negative).
	const p = Math.min(Math.max(fraction, 0), 1) * 100;
	if (p > 0 && p < 0.5) return { text: '<1%', title: null };
	if (p >= 99.5 && p < 100) return { text: '>99%', title: null };
	return { text: `${Math.round(p)}%`, title: null };
}

/**
 * An EWR charge or shortfall as the positive volume charged (m³/day, whole
 * numbers). The engine keeps the curtailment fields ≤ 0 (the workbook's
 * column R sign, so S = N + R holds); every table shows the volume, the same
 * way the Farms table shows FarmSummary.avgEwrShortfallM3Day (issue #45).
 */
export function fmtCharged(n: number | null | undefined): string {
	if (n == null || !Number.isFinite(n)) return '–';
	return fmtNum(0 - n, 0, true);
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
	/** Tooltip for demandLeftPct ("—" below the floor); null when none. */
	demandLeftTitle: string | null;
	/** How far the EWR supply cut exceeds the equitable share (m³/day); "" when it doesn't (audit Q13). */
	beyondShare: string;
	/**
	 * What the basic-needs floor held back of the cut (engine ≥ 1.38.0, issue
	 * #123), m³/day, and the floor itself; "" when it held nothing back (or
	 * the unit has no floor, or the run is older).
	 */
	basicNeedsHeld: string;
	basicNeeds: string;
	/** Short plain-language summary for the row (also used as the badge / screen-reader text). */
	verdict: string;
}

function verdict(f: CurtailmentFarm, action: Action): string {
	if (action === 'cut') return `cut ${fmtVol(-f.totalChangeM3Day)} m³/day`;
	if (action === 'gain') return `below its equitable share by ${fmtVol(f.totalChangeM3Day)} m³/day`;
	if (action === 'store') return `store less / pass inflow ${fmtVol(-(f.ewrChargeStorageM3Day ?? 0))} m³/day`;
	return 'no change';
}

/** The row's action: from the total change, or "store" when only a storage charge is left (Q13). */
function actionOfFarm(f: CurtailmentFarm): Action {
	const a = actionOf(f.totalChangeM3Day);
	// A charge that rounds to 0 m³/day at one decimal is not worth a badge.
	return a === 'none' && (f.ewrChargeStorageM3Day ?? 0) <= -0.05 ? 'store' : a;
}

/**
 * One display row per farm, in the engine's (network) order. `names` maps a
 * node id to its current name, for farms renamed since the run; unknown ids
 * keep the name stored with the run.
 */
export function curtailmentRows(c: CurtailmentSummary, names: Record<string, string> = {}): CurtailmentRow[] {
	const siteName = new Map((c.ewrSites ?? []).map((s) => [s.nodeId, names[s.nodeId] ?? s.name]));
	return c.farms.map((f) => {
		const action = actionOfFarm(f);
		const left = fmtDemandLeft(f.demandM3Day, f.fractionOfDemandLeft);
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
			ewrShortfall: fmtCharged(f.ewrShortfallM3Day),
			ewrIrrigation: fmtCharged(f.ewrChargeIrrigationM3Day),
			ewrStorage: fmtCharged(f.ewrChargeStorageM3Day),
			supplyCut: fmtSigned(f.ewrSupplyCutM3Day),
			supplyCutLs: fmtSigned(f.ewrSupplyCutLs),
			bindingSite: f.ewrBindingSiteId ? (siteName.get(f.ewrBindingSiteId) ?? names[f.ewrBindingSiteId] ?? f.ewrBindingSiteId) : '',
			totalChange: fmtSigned(f.totalChangeM3Day),
			totalChangeLs: fmtSigned(f.totalChangeLs),
			volumeLeft: fmtVol(f.volumeLeftM3Day),
			demandLeftPct: left.text,
			demandLeftTitle: left.title,
			beyondShare: (f.ewrCutBeyondShareM3Day ?? 0) >= 0.05 ? fmtVol(f.ewrCutBeyondShareM3Day) : '',
			basicNeedsHeld: (f.basicNeedsHeldM3Day ?? 0) >= 0.05 ? fmtVol(f.basicNeedsHeldM3Day) : '',
			basicNeeds: f.basicNeedsM3Day === undefined ? '' : fmtVol(f.basicNeedsM3Day),
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
		shortfall: fmtCharged(s.shortfallM3Day),
		charged: fmtCharged(s.chargedM3Day),
		natural: fmtCharged(s.naturalM3Day)
	}));
}

/** How many farms have to cut overall. */
export function cutCount(c: CurtailmentSummary): number {
	return c.farms.filter((f) => f.totalChangeM3Day < 0).length;
}
