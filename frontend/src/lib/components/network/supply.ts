// A farm's supply rule and river pump in the one-node form (WP-3.8, issue #54
// item 2c, docs/model.md §2.7e): the pumps × m³/h calculator and the hint the
// run gives a farm with no dam. The save rules are in $lib/model/validate.ts
// (supplyIssues). Pure: no Svelte.
import { SUPPLY_DEFAULTS, type NetworkNode, type SupplyRule } from '@water-management/engine';

/** What each rule does, under the form's select. */
export const SUPPLY_RULE_HELP: Record<SupplyRule, string> = {
	damFirst: 'Irrigation comes from the hydrological unit’s dam only, with no river pump.',
	riverFirst: 'Pumps from the river below the dam up to the pump capacity; the dam covers the rest.',
	trigger: 'The dam only until it falls below the switch-to-river level, then river first until it is back at the switch-back level.',
	runOfRiver: 'No dam: pumps from the river up to the pump capacity; the rest is a shortfall.'
};

/**
 * The river pump's capacity in m³/day from the form's calculator: pumps ×
 * m³/h per pump × 24 h. Null (no value yet) until both are entered; a
 * negative or non-finite entry is not a size.
 */
export function pumpM3Day(pumps: number | null, m3PerHour: number | null): number | null {
	if (pumps === null || m3PerHour === null) return null;
	if (!Number.isFinite(pumps) || !Number.isFinite(m3PerHour) || pumps < 0 || m3PerHour < 0) return null;
	return Math.round(pumps * m3PerHour * 24 * 1e6) / 1e6;
}

/**
 * The run's warning for a farm with no dam on the default rule that has
 * anything routed to its dam (engine network/supply.ts, issue #54): it
 * irrigates straight from the river with no limit. Null otherwise.
 */
export function noDamSupplyHint(
	n: Pick<NetworkNode, 'kind' | 'damCapacityM3' | 'pctUpstreamToDam' | 'pctRunoffToDam' | 'divertCapacityM3Day' | 'supplyRule'>
): string | null {
	if (n.kind !== 'farm' || (n.supplyRule ?? SUPPLY_DEFAULTS.supplyRule) !== 'damFirst' || n.damCapacityM3 > 0) return null;
	if (!(n.pctUpstreamToDam > 0 || n.pctRunoffToDam > 0 || n.divertCapacityM3Day > 0)) return null;
	return 'This hydrological unit has no dam, so what is routed to its dam (upstream inflow, runoff, diversion) is irrigated straight from the river, with no pump limit. To cap it, pick run of river and enter the pump capacity.';
}

/**
 * A note for a farm that fills its dam from the river (River to dam,
 * `divertCapacityM3Day`) and also irrigates with a river pump: the run
 * treats the two as separate pumps, each with its own capacity, so one pump
 * doing both jobs is counted twice unless its capacity is split. Run of river
 * ignores the diversion (no dam), and a pump of 0 is no pump. Null otherwise.
 */
export function sharedPumpHint(
	n: Pick<NetworkNode, 'kind' | 'divertCapacityM3Day' | 'supplyRule' | 'pumpCapacityM3Day'>
): string | null {
	const rule = n.supplyRule ?? SUPPLY_DEFAULTS.supplyRule;
	if (n.kind !== 'farm' || rule === 'damFirst' || rule === 'runOfRiver') return null;
	if (!(n.divertCapacityM3Day > 0) || n.pumpCapacityM3Day === 0) return null;
	return 'This hydrological unit also takes water from the river into its dam (River to dam, under Routing). The run treats that and the river pump as two pumps: if one pump does both, split its capacity between the two fields.';
}

/** Whether a node carries supply settings other than the defaults (a farm turned into a gauge or user keeps them). */
export const hasSupplySettings = (n: Pick<NetworkNode, 'supplyRule' | 'pumpCapacityM3Day'>) =>
	(n.supplyRule ?? 'damFirst') !== 'damFirst' || (n.pumpCapacityM3Day !== null && n.pumpCapacityM3Day !== undefined);
