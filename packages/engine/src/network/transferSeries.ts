// Each transfer rule's daily volume as a run series (engine ≥ 1.6.0,
// followups "The per-run attribution self-check is exact only where no
// transfer crosses a site's catchment boundary"). A farm's own `transfer`
// series is its net (in + / out −), which can't be split back into rules when
// a rule crosses an EWR site's catchment boundary or the rules form a loop.
// The EWR attribution (./attribution.ts) counts only the transfers with both
// ends upstream of a site, so without the per-rule volumes neither the per-run
// self-check (verify/checks.ts checkEwrAttribution) nor the farm projection's
// recompute (views/farmProjection.ts) can redo it exactly at such a site.
//
// Stored on the rule's source farm under `transfer_rule@<rule id>`, the same
// `<kind>@<id>` shape as a gauge's own input record (project.ts
// gaugeSeriesKey). Only for a rule that can move water (canMove): enabled,
// between two farms, running in some month, with a daily limit above 0. That
// is decided by the rule alone, never by what the run moved, so a run resumed
// part-way (../warmstart) stores the same series as the whole run's tail, and
// a reader tells a run from 1.6.0 on (it stores every such rule's series) from
// an older one (none) without knowing its engine version.
import type { NetworkNode, Transfer } from '../project';
import { isRiverOfftake, planOfftakes } from './offtake';
import { transferDailyLimit } from './transferRates';

export const TRANSFER_RULE_SERIES = {
	prefix: 'transfer_rule@',
	/** The series' label, naming the farm the rule moves water to. */
	label: (toName: string) => `Transferred to ${toName} by one transfer rule`,
	unit: 'm³/day'
} as const;

/** The run series key of one transfer rule's daily volume. */
export const transferRuleKey = (ruleId: string): string => `${TRANSFER_RULE_SERIES.prefix}${ruleId}`;

/** The rule id of a transfer_rule@ key; null for any other key. */
export function parseTransferRuleKey(key: string): string | null {
	return key.startsWith(TRANSFER_RULE_SERIES.prefix) && key.length > TRANSFER_RULE_SERIES.prefix.length ? key.slice(TRANSFER_RULE_SERIES.prefix.length) : null;
}

/**
 * Whether an enabled rule can move water at all: its daily limit (the month's
 * rate × 86 400, capped by the daily cap, as run.ts buildPlan sets it,
 * ./transferRates.ts) is above 0 in some month it runs in. A rule that can't
 * moves 0 every day, in any engine version, and has no series.
 */
export function canMove(tr: Pick<Transfer, 'months' | 'maxRateM3s' | 'dailyCapM3' | 'monthlyRateM3s'>): boolean {
	return transferDailyLimit(tr).some((v) => v > 0);
}

/**
 * The rules runModel runs between two farms (run.ts buildPlan), in the
 * model's list order: enabled, both ends farms, and for a river off-take
 * (engine ≥ 1.14.0) one the run doesn't skip (./offtake.ts planOfftakes: its
 * destination doesn't drain into its source).
 */
export function farmRules(transfers: readonly Transfer[], nodes: readonly Pick<NetworkNode, 'id' | 'name' | 'kind' | 'downstreamNodeId'>[]): Transfer[] {
	const kind = new Map(nodes.map((n) => [n.id, n.kind]));
	const river = transfers.some((tr) => tr.enabled && isRiverOfftake(tr)) ? new Set(planOfftakes(transfers, nodes, [], () => undefined).map((o) => o.id)) : null;
	return transfers.filter((tr) => tr.enabled && kind.get(tr.fromNodeId) === 'farm' && kind.get(tr.toNodeId) === 'farm' && (!isRiverOfftake(tr) || !!river?.has(tr.id)));
}

/**
 * Each farm-to-farm rule's daily volume from the run's stored series, or null
 * for a run saved before engine 1.6.0 (no series for a rule that can move
 * water). A rule that can't move water is all zeros, in any run. A missing
 * (null / non-finite) day reads as 0. `series(nodeId, key)` is the run's
 * stored series, undefined when absent.
 */
export function readRuleVolumes(
	rules: readonly Transfer[],
	days: number,
	series: (nodeId: string, key: string) => ArrayLike<number | null> | undefined
): Float64Array[] | null {
	const stored = rules.map((r) => (canMove(r) ? series(r.fromNodeId, transferRuleKey(r.id)) : undefined));
	if (rules.some((r, k) => canMove(r) && stored[k] === undefined)) return null;
	return stored.map((v) => {
		const out = new Float64Array(days);
		if (v) for (let t = 0; t < days && t < v.length; t++) out[t] = typeof v[t] === 'number' && Number.isFinite(v[t]) ? (v[t] as number) : 0;
		return out;
	});
}
