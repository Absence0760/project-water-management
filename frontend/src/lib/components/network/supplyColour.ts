// Colouring the schematic's farms by how much of their irrigation demand the
// latest run supplied. Pure: the banding, the per-node lookup and the words
// that go with each colour (so the drawing is never colour-only).
import type { FarmSummary, NetworkNode, RunSummary } from '@water-management/engine';
import { fmtPct, localIsoDate } from '$lib/format/number';
import { daysSince } from '$lib/components/projects/freshness';
import { SUPPLY_TARGET } from '$lib/components/runs/results';

/** Below this share of demand supplied a farm is in the lowest band. */
export const LOW_SUPPLY = 0.7;

/**
 * - `met`: at or above SUPPLY_TARGET (the farm table's flag threshold)
 * - `short`: LOW_SUPPLY up to the target
 * - `low`: below LOW_SUPPLY
 * - `none`: the farm had no irrigation demand in the run (the engine then
 *   reports 100 % supplied, which would be misleading as a colour)
 * - `absent`: the farm is in the model but not in the run (added since, or
 *   was a gauge then)
 */
export type SupplyBand = 'met' | 'short' | 'low' | 'none' | 'absent';

export interface FarmSupply {
	band: SupplyBand;
	/** Share of demand supplied, 0–1; null for `none` and `absent`. */
	fraction: number | null;
	/** Short words for the node's label line, e.g. "82% supplied". */
	text: string;
}

export const BAND_LABEL: Record<SupplyBand, string> = {
	met: `${fmtPct(SUPPLY_TARGET, 0)} or more supplied`,
	short: `${fmtPct(LOW_SUPPLY, 0)} to ${fmtPct(SUPPLY_TARGET, 0)} supplied`,
	low: `Under ${fmtPct(LOW_SUPPLY, 0)} supplied`,
	none: 'No irrigation demand',
	absent: 'Not in this run'
};

/** The band for a farm's run summary (undefined = not in the run). */
export function supplyBand(f: FarmSummary | undefined): SupplyBand {
	if (!f) return 'absent';
	if (!(f.avgDemandM3Day > 0) || !Number.isFinite(f.fractionSupplied)) return 'none';
	if (f.fractionSupplied >= SUPPLY_TARGET) return 'met';
	if (f.fractionSupplied >= LOW_SUPPLY) return 'short';
	return 'low';
}

export function farmSupply(f: FarmSummary | undefined): FarmSupply {
	const band = supplyBand(f);
	if (band === 'absent') return { band, fraction: null, text: 'not in this run' };
	if (band === 'none') return { band, fraction: null, text: 'no demand' };
	return { band, fraction: f!.fractionSupplied, text: `${fmtPct(f!.fractionSupplied, 0)} supplied` };
}

/** Supply for every farm node in the model, by node id. Gauges and other users are left out. */
export function supplyByNode(nodes: readonly NetworkNode[], summary: Pick<RunSummary, 'farms'>): Map<string, FarmSupply> {
	const byId = new Map(summary.farms.map((f) => [f.nodeId, f]));
	const out = new Map<string, FarmSupply>();
	for (const n of nodes) if (n.kind === 'farm') out.set(n.id, farmSupply(byId.get(n.id)));
	return out;
}

/** Which bands occur, in legend order. */
export function bandsPresent(supply: ReadonlyMap<string, FarmSupply>): SupplyBand[] {
	const seen = new Set([...supply.values()].map((s) => s.band));
	return (['met', 'short', 'low', 'none', 'absent'] as const).filter((b) => seen.has(b));
}

/** "today", "yesterday", "3 days ago" for a run's createdAt, by the viewer's calendar. */
export function ranAgo(createdAt: string, now: Date = new Date()): string {
	const d = new Date(createdAt);
	if (Number.isNaN(d.getTime())) return '';
	const days = daysSince(localIsoDate(d), now);
	if (days <= 0) return 'today';
	if (days === 1) return 'yesterday';
	return `${days} days ago`;
}

