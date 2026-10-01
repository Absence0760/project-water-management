// A farm's supply rule and river pump (engine ≥ 0.42.0, roadmap WP-3.8,
// issue #54 item 2c, docs/model.md §2.7e): an experimental node-based workbook's
// pump scenarios, resolved from a node as runModel runs them. Pure; the
// simulation (./simulate.ts) and the self-checks (../verify/checks.ts) both
// read a node through these, so a stored value means the same thing to both.
import { waterYearIndex } from '../calendar';
import type { NetworkNode } from '../project';

/**
 * A farm's supply rule as the simulation runs it; a node without one
 * (`damFirst`, the default, and every node that isn't a farm) has none and
 * runs exactly as engines before 0.42.0 did.
 */
export interface PlanSupply {
	/** 1 = river first, 2 = trigger (river first only while switched to the river), 3 = run of river (no dam; the river after any transfer in). */
	rule: 1 | 2 | 3;
	/** The river pump's capacity, m³/day; Infinity = no limit. */
	pumpM3Day: number;
	/** 'trigger': switch to the river when the start-of-day storage is below this (m³). */
	triggerM3: number;
	/** 'trigger': switch back to the dam once the start-of-day storage is at least this (m³, ≥ triggerM3). */
	stopM3: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The farm's supply rule for the plan; {} for 'damFirst' (and absent fields),
 * where the pump capacity is inert. Out-of-range values run clamped with a
 * warning. Without a dam, 'trigger' has nothing to trigger on and runs as
 * river first; 'runOfRiver' on a farm with a dam also runs as river first
 * (the dam is kept), each with a warning. The backend refuses both on save
 * (modelRuleIssues). A supply rule on a gauge or other water user is ignored
 * with a warning.
 */
export function supplyOf(n: NetworkNode, warnings: string[]): { supply?: PlanSupply } {
	const rule = n.supplyRule ?? 'damFirst';
	const pump = n.pumpCapacityM3Day;
	if (n.kind !== 'farm') {
		// An other water user's pump is its own (userPumpOf, engine ≥ 1.58.0); only the supply rule is a farm's.
		if (n.kind === 'user') {
			if (rule !== 'damFirst') warnings.push(`user "${n.name}": only a farm has a supply rule; ignored (a user always takes from the river, up to its pump capacity)`);
		} else if (rule !== 'damFirst' || (pump !== null && pump !== undefined)) warnings.push(`gauge "${n.name}": only a farm has a supply rule and river pump; ignored`);
		return {};
	}
	if (rule === 'damFirst') {
		// A farm with no dam irrigates from the river routed to it (K, M, O pass through the absent
		// dam), with no pump limit: b023's stand-in for a river pump, kept, but said (issue #54).
		if (!(n.damCapacityM3 > 0) && (n.pctUpstreamToDam > 0 || n.pctRunoffToDam > 0 || (Array.isArray(n.divertMonthlyM3Day) ? n.divertMonthlyM3Day.some((v) => v > 0) : n.divertCapacityM3Day > 0)))
			warnings.push(
				`farm "${n.name}": it has no dam, so what is routed to its dam (upstream inflow, runoff, diversion) is irrigated straight from the river, with no pump limit; to cap it, set the supply rule to run of river with a pump capacity`
			);
		return {};
	}
	if (rule !== 'riverFirst' && rule !== 'trigger' && rule !== 'runOfRiver') {
		warnings.push(`farm "${n.name}": unknown supply rule "${String(rule)}"; the dam only`);
		return {};
	}
	let pumpM3Day = Infinity;
	if (pump === null || pump === undefined) warnings.push(`farm "${n.name}": no river pump capacity is set, so what it pumps from the river is limited only by the flow`);
	else if (finite(pump) && pump >= 0) pumpM3Day = pump;
	else warnings.push(`farm "${n.name}": pump capacity ${String(pump)} m³/day is not a size ≥ 0; no limit`);
	const cap = n.damCapacityM3 > 0 ? n.damCapacityM3 : 0;
	if (rule === 'runOfRiver') {
		if (cap > 0) {
			warnings.push(`farm "${n.name}": run of river has no dam, but this farm has a ${Math.round(cap)} m³ dam; it runs as river first. Set the dam capacity to 0`);
			return { supply: { rule: 1, pumpM3Day, triggerM3: 0, stopM3: 0 } };
		}
		return { supply: { rule: 3, pumpM3Day, triggerM3: 0, stopM3: 0 } };
	}
	if (rule === 'riverFirst') return { supply: { rule: 1, pumpM3Day, triggerM3: 0, stopM3: 0 } };
	if (!(cap > 0)) {
		warnings.push(`farm "${n.name}": the trigger supply rule needs a dam to trigger on; it runs as river first`);
		return { supply: { rule: 1, pumpM3Day, triggerM3: 0, stopM3: 0 } };
	}
	const clamp = (v: number | undefined, lo: number, fallback: number, name: string) => {
		const x = finite(v) ? Math.min(Math.max(v, lo), 1) : Math.max(fallback, lo);
		if (v !== undefined && x !== v) warnings.push(`farm "${n.name}": ${name} ${String(v)} is outside [${lo}, 1]; using ${x}`);
		return x;
	};
	const trigger = clamp(n.supplyTriggerPct, 0, 0.4, 'supply trigger');
	const stop = clamp(n.supplyStopPct, trigger, 0.6, 'supply stop level');
	return { supply: { rule: 2, pumpM3Day, triggerM3: trigger * cap, stopM3: stop * cap } };
}

/**
 * An other water user's river pump (engine ≥ 1.58.0, WP-3.8, issue #54 item
 * 2b, docs/model.md §2.7c): its `pumpCapacityM3Day`, the most it takes from
 * the river in a day (m³). {} for null / absent (no limit: every user before
 * 1.58.0, which took MIN(demand, what reaches it)) and on any node that isn't
 * a user. A user has no supply rule, so, unlike a farm's, a null capacity is
 * the default and doesn't warn. A value that isn't a size ≥ 0 runs as no
 * limit with a warning (the API refuses it on save).
 */
export function userPumpOf(n: NetworkNode, warnings: string[]): { userPumpM3Day?: number } {
	if (n.kind !== 'user') return {};
	const pump = n.pumpCapacityM3Day;
	if (pump === null || pump === undefined) return {};
	if (finite(pump) && pump >= 0) return { userPumpM3Day: pump };
	warnings.push(`user "${n.name}": pump capacity ${String(pump)} m³/day is not a size ≥ 0; no limit`);
	return {};
}

/**
 * Is the farm pumping from the river today? Always under river first and run
 * of river. Under 'trigger' it switches to the river when the storage at the
 * start of the day (`qPrev`) is below the trigger and back to the dam once it
 * is at least the stop level; `wasRiver` is yesterday's answer (false before
 * the first day, so a run starts on the dam unless the dam starts low).
 */
export function pumpsRiverToday(s: PlanSupply, wasRiver: boolean, qPrev: number): boolean {
	if (s.rule !== 2) return true;
	return wasRiver ? qPrev < s.stopM3 : qPrev < s.triggerM3;
}

/**
 * What the river pump can take today (m³): the flow below the dam `below` (S)
 * above what the farm must let pass, `keep` (the senior users' requirement,
 * and a pass-inflow release's target), up to the pump's capacity.
 */
export function riverRoom(s: PlanSupply, below: number, keep: number): number {
	return Math.max(0, Math.min(s.pumpM3Day, below - keep));
}

/**
 * Split today's surface supply between the river and the dam, up to demand
 * `want`: river first (then the dam) under rules 1 and 2, the dam (which, on
 * a run-of-river farm, holds only a transfer in) first under rule 3.
 * `damAvail` = what the dam can give (above dead storage), `room` = riverRoom.
 * Returns [from the dam, from the river].
 */
export function surfaceSplit(rule: PlanSupply['rule'], want: number, damAvail: number, room: number): [number, number] {
	if (rule === 3) {
		const fromDam = Math.min(damAvail, want);
		return [fromDam, Math.max(0, Math.min(room, want - fromDam))];
	}
	const fromRiver = Math.max(0, Math.min(room, want));
	return [Math.min(damAvail, want - fromRiver), fromRiver];
}

/**
 * A farm's hands-off flow (engine ≥ 1.32.0, WP-3.8, issue #204, docs/model.md
 * §2.7h) as the simulation runs it: the flow left in the river at the farm
 * before the river pump or River to dam (the diversion O) takes anything.
 */
export interface PlanHandsOff {
	/** m³/day by calendar month (index 1–12); null = no fixed amount. */
	m3DayByMonth: Float64Array | null;
	/** Also keep the EWR required at the farm (its cumulative requirement Z). */
	ewr: boolean;
}

/**
 * A 12-value water-year row (Oct–Sep) indexed by calendar month (1–12), each
 * month a size ≥ 0; a missing month or one that isn't a number ≥ 0 is 0,
 * with a warning. null for a row that isn't a list.
 */
function monthlyRow(raw: unknown, who: string, what: string, warnings: string[]): Float64Array | null {
	if (!Array.isArray(raw)) {
		warnings.push(`${who}: ${what} is not a list of 12 monthly values; ignored`);
		return null;
	}
	if (raw.length !== 12) warnings.push(`${who}: ${what} should have 12 monthly values, has ${raw.length}; missing months are 0`);
	const out = new Float64Array(13);
	let bad = false;
	for (let m = 1; m <= 12; m++) {
		const x: unknown = raw[waterYearIndex(m)];
		if (finite(x) && x >= 0) out[m] = x;
		else if (x !== undefined) bad = true;
	}
	if (bad) warnings.push(`${who}: ${what} has a month that is not a size ≥ 0 m³/day; that month is 0`);
	return out;
}

/**
 * A farm's operating rules beyond the supply rule (engine ≥ 1.32.0, issue
 * #204): the hands-off flow and River to dam by month. {} when neither is
 * set (and on a node that isn't a farm, with a warning if one is), so a node
 * without them runs exactly as engines before 1.32.0 did. A hands-off flow of
 * 0 in every month without the EWR is none. Invalid months run as 0 with a
 * warning; the backend refuses them on save.
 */
export function operatingOf(n: NetworkNode, warnings: string[]): { handsOff?: PlanHandsOff; divertM3DayByMonth?: Float64Array } {
	const hasHandsOff = n.handsOffM3Day !== null && n.handsOffM3Day !== undefined;
	const hasDivert = n.divertMonthlyM3Day !== null && n.divertMonthlyM3Day !== undefined;
	if (n.kind !== 'farm') {
		if (hasHandsOff || n.handsOffEwr === true || hasDivert)
			warnings.push(`${n.kind === 'user' ? 'user' : 'gauge'} "${n.name}": only a farm has a hands-off flow and River to dam by month; ignored`);
		return {};
	}
	const who = `farm "${n.name}"`;
	const out: { handsOff?: PlanHandsOff; divertM3DayByMonth?: Float64Array } = {};
	let byMonth = hasHandsOff ? monthlyRow(n.handsOffM3Day, who, 'hands-off flow', warnings) : null;
	if (byMonth && !byMonth.some((v) => v > 0)) byMonth = null;
	const ewr = n.handsOffEwr === true;
	if (byMonth || ewr) out.handsOff = { m3DayByMonth: byMonth, ewr };
	const divert = hasDivert ? monthlyRow(n.divertMonthlyM3Day, who, 'River to dam by month', warnings) : null;
	if (divert) out.divertM3DayByMonth = divert;
	return out;
}

/** The flow the hands-off rule keeps in the river today (m³): MAX(the month's amount, the EWR Z when kept). */
export function handsOffToday(h: PlanHandsOff, calendarMonth: number, ewrRequired: number): number {
	const fixed = h.m3DayByMonth ? h.m3DayByMonth[calendarMonth]! : 0;
	return h.ewr ? Math.max(fixed, ewrRequired) : fixed;
}

/** River to dam's capacity today (m³/day): the month's, when set by month, else the one value. */
export function divertCapacityToday(n: { divertCapacityM3Day: number; divertM3DayByMonth?: Float64Array }, calendarMonth: number): number {
	return n.divertM3DayByMonth ? n.divertM3DayByMonth[calendarMonth]! : n.divertCapacityM3Day;
}
