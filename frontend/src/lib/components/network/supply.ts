// A farm's supply rule and river pump in the one-node form (WP-3.8, issue #54
// item 2c, docs/model.md §2.7e): the pumps × m³/h calculator and the hint the
// run gives a farm with no dam. The save rules are in $lib/model/validate.ts
// (supplyIssues). Pure: no Svelte.
import { SUPPLY_DEFAULTS, type NetworkNode, type SupplyRule } from '@water-management/engine';
import { describeMonths, WATER_YEAR_CALENDAR } from '$lib/format/months';
import { fmtNum } from '$lib/format/number';

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
	n: Pick<NetworkNode, 'kind' | 'damCapacityM3' | 'pctUpstreamToDam' | 'pctRunoffToDam' | 'divertCapacityM3Day' | 'divertMonthlyM3Day' | 'supplyRule'>
): string | null {
	if (n.kind !== 'farm' || (n.supplyRule ?? SUPPLY_DEFAULTS.supplyRule) !== 'damFirst' || n.damCapacityM3 > 0) return null;
	if (!(n.pctUpstreamToDam > 0 || n.pctRunoffToDam > 0 || diverts(n))) return null;
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
	n: Pick<NetworkNode, 'kind' | 'divertCapacityM3Day' | 'divertMonthlyM3Day' | 'supplyRule' | 'pumpCapacityM3Day'>
): string | null {
	const rule = n.supplyRule ?? SUPPLY_DEFAULTS.supplyRule;
	if (n.kind !== 'farm' || rule === 'damFirst' || rule === 'runOfRiver') return null;
	if (!diverts(n) || n.pumpCapacityM3Day === 0) return null;
	return 'This hydrological unit also takes water from the river into its dam (River to dam, under Routing). The run treats that and the river pump as two pumps: if one pump does both, split its capacity between the two fields.';
}

/**
 * Whether a node carries supply settings other than the defaults (a farm
 * turned into a gauge or user keeps them): the supply rule, the river pump,
 * the hands-off flow and River to dam by month (engine ≥ 1.31.0).
 */
export const hasSupplySettings = (n: Pick<NetworkNode, 'supplyRule' | 'pumpCapacityM3Day' | 'handsOffM3Day' | 'handsOffEwr' | 'divertMonthlyM3Day'>) =>
	(n.supplyRule ?? 'damFirst') !== 'damFirst' ||
	(n.pumpCapacityM3Day !== null && n.pumpCapacityM3Day !== undefined) ||
	(n.handsOffM3Day !== null && n.handsOffM3Day !== undefined) ||
	n.handsOffEwr === true ||
	(n.divertMonthlyM3Day !== null && n.divertMonthlyM3Day !== undefined);

/**
 * Whether River to dam takes anything, as the run reads it (engine
 * network/supply.ts): any month above 0 when it is set by month (engine ≥
 * 1.31.0), else the one capacity above 0.
 */
export function diverts(n: Pick<NetworkNode, 'divertCapacityM3Day' | 'divertMonthlyM3Day'>): boolean {
	return Array.isArray(n.divertMonthlyM3Day) ? n.divertMonthlyM3Day.some((v) => v > 0) : n.divertCapacityM3Day > 0;
}

/** "120 m³/day" when every month is the same, else "0–120 m³/day"; over the months above 0 when `positive`. */
function amountRange(row: readonly number[], positive: boolean): string {
	const vals = positive ? row.filter((v) => v > 0) : row;
	const lo = Math.min(...vals);
	const hi = Math.max(...vals);
	return lo === hi ? `${fmtNum(lo, 2, true)} m³/day` : `${fmtNum(lo, 2, true)}–${fmtNum(hi, 2, true)} m³/day`;
}

/** The water-year months (as "Oct–Mar", describeMonths) whose value is 0. */
function zeroMonths(row: readonly number[]): string {
	return describeMonths(WATER_YEAR_CALENDAR.filter((_, i) => !(row[i]! > 0)));
}

/**
 * The hands-off flow in plain words under its fields (engine ≥ 1.31.0, issue
 * #204, docs/model.md §2.7h): what the farm leaves in the river before its
 * river pump and River to dam take anything. Reads the node as the run does
 * (engine operatingOf): an amount of 0 in every month without the EWR is none.
 */
export function handsOffPreview(n: Pick<NetworkNode, 'handsOffM3Day' | 'handsOffEwr'>): string {
	const row = Array.isArray(n.handsOffM3Day) && n.handsOffM3Day.length === 12 ? n.handsOffM3Day : null;
	const some = row !== null && row.some((v) => v > 0);
	const ewr = n.handsOffEwr === true;
	if (!some && !ewr)
		return 'No hands-off flow: the river pump and River to dam leave in the river only what senior water users downstream need, not the EWR.';
	const what: string[] = [];
	if (some) {
		const off = row!.some((v) => !(v > 0));
		what.push(`${amountRange(row!, true)}${off ? ` (none in ${zeroMonths(row!)})` : ''}`);
	}
	if (ewr) what.push('the EWR required here (this unit’s share and upstream shares)');
	const keep = what.length === 2 ? `the larger of ${what[0]} and ${what[1]}` : what[0];
	return `Leaves ${keep} in the river before the river pump or River to dam takes anything. When less flows, neither takes anything.`;
}

/**
 * River to dam by month in plain words (engine ≥ 1.31.0): the months it
 * diverts in and the months it doesn't; null when it isn't set by month.
 */
export function divertMonthsPreview(n: Pick<NetworkNode, 'divertMonthlyM3Day'>): string | null {
	const row = Array.isArray(n.divertMonthlyM3Day) && n.divertMonthlyM3Day.length === 12 ? n.divertMonthlyM3Day : null;
	if (row === null) return null;
	if (!row.some((v) => v > 0)) return 'River to dam is 0 in every month: it diverts nothing.';
	const off = row.some((v) => !(v > 0));
	return `River to dam takes up to ${amountRange(row, true)}${off ? `; nothing in ${zeroMonths(row)}` : ' in every month'}. The one value above is not used.`;
}
