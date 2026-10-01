// A farm's supply rule and river pump in the one-node form (WP-3.8, issue #54
// item 2c, docs/model.md §2.7e): the pumps × m³/h calculator and the hint the
// run gives a farm with no dam. The save rules are in $lib/model/validate.ts
// (supplyIssues). Pure: no Svelte.
import { estimatedDamAreaM2, SUPPLY_DEFAULTS, type NetworkNode, type SupplyRule } from '@water-management/engine';
import { describeMonths, WATER_YEAR_CALENDAR } from '$lib/format/months';
import { groupedText } from '$lib/components/common/numberText';
import { monthsOf } from './monthFields';

/** What each rule does, under the form's select. */
export const SUPPLY_RULE_HELP: Record<SupplyRule, string> = {
	damFirst: 'Irrigation comes from the hydrological unit’s dam only, with no river pump.',
	riverFirst: 'Pumps from the river below the dam up to the pump capacity; the dam covers the rest.',
	trigger: 'The dam only until it falls below the switch-to-river level, then river first until it is back at the switch-back level.',
	runOfRiver: 'No dam: pumps from the river (and a pool at the pump, if there is one) up to the pump capacity; the rest is a shortfall.'
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
 * the hands-off flow and River to dam by month (engine ≥ 1.32.0).
 */
export const hasSupplySettings = (n: Pick<NetworkNode, 'supplyRule' | 'pumpCapacityM3Day' | 'handsOffM3Day' | 'handsOffEwr' | 'divertMonthlyM3Day'> & Partial<Pick<NetworkNode, 'kind'>>) =>
	(n.supplyRule ?? 'damFirst') !== 'damFirst' ||
	// An other water user's pump capacity is its own (engine ≥ 1.58.0), edited with its user fields.
	(n.kind !== 'user' && n.pumpCapacityM3Day !== null && n.pumpCapacityM3Day !== undefined) ||
	(n.handsOffM3Day !== null && n.handsOffM3Day !== undefined) ||
	n.handsOffEwr === true ||
	(n.divertMonthlyM3Day !== null && n.divertMonthlyM3Day !== undefined);

/**
 * Whether River to dam takes anything, as the run reads it (engine
 * network/supply.ts): any month above 0 when it is set by month (engine ≥
 * 1.32.0), else the one capacity above 0.
 */
export function diverts(n: Pick<NetworkNode, 'divertCapacityM3Day' | 'divertMonthlyM3Day'>): boolean {
	return Array.isArray(n.divertMonthlyM3Day) ? n.divertMonthlyM3Day.some((v) => v > 0) : n.divertCapacityM3Day > 0;
}

/** A value as its field shows it (12 345.5, 0.0129): every figure entered, thousands grouped. */
const asEntered = (v: number) => groupedText(v);

/**
 * "120 m³/day" when every month counted is the same, else "between 80 and
 * 12 345.5 m³/day by month"; over the months above 0 when `positive`. With
 * `upTo`, the one amount reads "up to 120 m³/day" (a capacity).
 */
function amountRange(row: readonly number[], positive: boolean, upTo = false): string {
	const vals = positive ? row.filter((v) => v > 0) : row;
	const lo = Math.min(...vals);
	const hi = Math.max(...vals);
	return lo === hi ? `${upTo ? 'up to ' : ''}${asEntered(lo)} m³/day` : `between ${asEntered(lo)} and ${asEntered(hi)} m³/day by month`;
}

/** The water-year months (as "Oct–Mar", describeMonths) whose value is 0. */
function zeroMonths(row: readonly number[]): string {
	return describeMonths(WATER_YEAR_CALENDAR.filter((_, i) => !(row[i]! > 0)));
}

/** A monthly row the run reads (12 values), or null. */
const monthRow = (v: readonly number[] | null | undefined): readonly number[] | null => (Array.isArray(v) && v.length === 12 ? v : null);

type HandsOffNode = Pick<
	NetworkNode,
	| 'handsOffM3Day'
	| 'handsOffEwr'
	| 'supplyRule'
	| 'pumpCapacityM3Day'
	| 'damCapacityM3'
	| 'pctUpstreamToDam'
	| 'pctRunoffToDam'
	| 'divertCapacityM3Day'
	| 'divertMonthlyM3Day'
>;

/**
 * What the hands-off flow holds back on this farm, as the run reads it
 * (engine network/simulate.ts, docs/model.md §2.7h): the river pump (any rule
 * but the dam only, unless its capacity is 0), and River to dam (O) on a farm
 * with a dam. A farm with no dam irrigates what is routed to its dam (K, M
 * and O) straight from the river, so there the hands-off flow limits that
 * (engine ≥ 1.32.0). Run of river routes nothing to the dam. The dam's own
 * split (K, M) into a real dam is not a pump, so it isn't held back. Reads
 * the entered capacity: a dam not yet in service, or silted to nothing, runs
 * as no dam on those days (§2.7g), which a one-line preview doesn't split.
 */
export function handsOffTakers(n: Partial<HandsOffNode>): { pump: boolean; riverToDam: boolean; noDamRouting: boolean } {
	const rule = n.supplyRule ?? SUPPLY_DEFAULTS.supplyRule;
	const pump = rule !== 'damFirst' && n.pumpCapacityM3Day !== 0;
	const routes = rule !== 'runOfRiver';
	const dam = (n.damCapacityM3 ?? 0) > 0;
	const div = diverts({ divertCapacityM3Day: n.divertCapacityM3Day ?? 0, divertMonthlyM3Day: n.divertMonthlyM3Day });
	const noDamRouting = routes && !dam && ((n.pctUpstreamToDam ?? 0) > 0 || (n.pctRunoffToDam ?? 0) > 0 || div);
	return { pump, riverToDam: routes && dam && div, noDamRouting };
}

/**
 * The hands-off flow in plain words under its fields (engine ≥ 1.32.0, issue
 * #204, docs/model.md §2.7h): what the farm leaves in the river, and before
 * which of its takes (handsOffTakers), named only where they apply; where
 * none does, it says the flow changes nothing. Reads the node as the run does
 * (engine operatingOf): an amount of 0 in every month without the EWR is none.
 */
export function handsOffPreview(n: Partial<HandsOffNode>): string {
	const row = monthRow(n.handsOffM3Day);
	const some = row !== null && row.some((v) => v > 0);
	const ewr = n.handsOffEwr === true;
	if (!some && !ewr)
		return 'No hands-off flow: the river pump and River to dam leave in the river only what senior water users downstream need, not the EWR.';
	const flow = some ? `${amountRange(row!, true)}${row!.some((v) => !(v > 0)) ? `; none in ${zeroMonths(row!)}` : ''}` : '';
	const EWR = 'the EWR required here (this unit’s share and upstream shares)';
	const keep = some && ewr ? `the larger of the set flow (${flow}) and ${EWR}` : some ? (flow.includes(';') ? `the set flow (${flow})` : flow) : EWR;
	const t = handsOffTakers(n);
	const names = [t.pump ? 'the river pump' : null, t.riverToDam ? 'River to dam' : null, t.noDamRouting ? 'its irrigation straight from the river' : null].filter((x): x is string => x !== null);
	if (names.length === 0)
		return `Would leave ${keep} in the river, but it changes nothing here: this hydrological unit takes nothing from the river past its dam (no river pump, no River to dam).`;
	const noDam = t.noDamRouting ? ' It has no dam, so what is routed to its dam (upstream inflow, runoff, River to dam) is irrigated straight from the river.' : '';
	return `Leaves ${keep} in the river before ${names.join(' or ')} takes anything.${noDam} When less flows, ${names.length === 2 ? 'neither takes anything' : 'nothing is taken'}.`;
}

/**
 * River to dam by month in plain words (engine ≥ 1.32.0): the months it
 * diverts in and the months it doesn't; null when it isn't set by month.
 */
export function divertMonthsPreview(n: Pick<NetworkNode, 'divertMonthlyM3Day'>): string | null {
	const row = monthRow(n.divertMonthlyM3Day);
	if (row === null) return null;
	if (!row.some((v) => v > 0)) return 'River to dam is 0 in every month: it diverts nothing.';
	const off = row.some((v) => !(v > 0));
	return `River to dam takes ${amountRange(row, true, true)}${off ? `; nothing in ${zeroMonths(row)}` : ''}. The one value above is not used.`;
}

/**
 * The node table's River to dam cell on a farm set by month (engine ≥
 * 1.32.0): the run ignores the one value there, so the table shows the
 * months' range, read-only, instead of an input, and points to the one-node
 * form where the months are edited. `text` is the cell ("by month: 0–800",
 * "by month: 500"), `aria` its accessible name. Null when it isn't set by
 * month: the table edits the one value. The caller adds where to edit it.
 */
export function divertMonthsCell(n: Pick<NetworkNode, 'divertMonthlyM3Day'>, name: string): { text: string; aria: string } | null {
	const row = n.divertMonthlyM3Day;
	if (!Array.isArray(row)) return null;
	const vals = row.filter((v) => Number.isFinite(v));
	if (!vals.length) return { text: 'by month', aria: `River to dam at ${name} is set by month` };
	const lo = Math.min(...vals);
	const hi = Math.max(...vals);
	const range = lo === hi ? asEntered(lo) : `${asEntered(lo)}–${asEntered(hi)}`;
	const words = lo === hi ? `${asEntered(lo)} m³/day every month` : `between ${asEntered(lo)} and ${asEntered(hi)} m³/day`;
	return { text: `by month: ${range}`, aria: `River to dam at ${name} is set by month, ${words}` };
}

/** The hands-off flow's row when its box is ticked (0 in every month, to fill in) or null when unticked. */
export const handsOffTicked = (checked: boolean): number[] | null => (checked ? monthsOf(0) : null);

/** River to dam by month when its box is ticked: the one value in every month, so the run is unchanged until a month is edited; null when unticked. */
export const divertMonthsTicked = (checked: boolean, divertCapacityM3Day: number): number[] | null => (checked ? monthsOf(divertCapacityM3Day) : null);

/**
 * The hint under a run-of-river unit's pool field (engine ≥ 1.64.0,
 * docs/model.md §2.7j): what a blank means, what a pool does, and the area
 * the run estimates when none is entered.
 */
export function poolHint(n: Pick<NetworkNode, 'poolCapacityM3' | 'poolAreaM2'>): string {
	const cap = n.poolCapacityM3 ?? null;
	if (cap === null || !(cap > 0)) return 'Blank is no pool: the pump takes only what flows.';
	const base = 'The pump draws it down once the flow it may take is used; it refills from the flow above what must pass.';
	return n.poolAreaM2 == null ? `${base} With no surface area entered, the run estimates ${groupedText(Math.round(estimatedDamAreaM2(cap)))} m² for its evaporation.` : base;
}
