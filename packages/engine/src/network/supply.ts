// A farm's supply rule and river pump (engine ≥ 0.42.0, roadmap WP-3.8,
// issue #54 item 2c, docs/model.md §2.7e): an experimental node-based workbook's
// pump scenarios, resolved from a node as runModel runs them. Pure; the
// simulation (./simulate.ts) and the self-checks (../verify/checks.ts) both
// read a node through these, so a stored value means the same thing to both.
import { waterYearIndex } from '../calendar';
import { DAM_AREA_EXPONENT, estimatedDamAreaM2, type NetworkNode } from '../project';
import { damPresence } from './development';

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
	/** Run of river only (engine ≥ 1.64.0): a pool at the pump's intake; absent = none. */
	pool?: PlanPool;
}

/**
 * A pool at a run-of-river farm's pump intake (engine ≥ 1.64.0, docs/model.md
 * §2.7j): in-channel storage the pump draws down once the flow it may take
 * is used, refilled from the flow above what must pass the farm.
 */
export interface PlanPool {
	/** Capacity, m³ (> 0). */
	capM3: number;
	/** Storage at the start of the run, m³. */
	initialM3: number;
	/** Surface area when full, m²: A = areaFullM2 × (storage / capacity)^DAM_AREA_EXPONENT. */
	areaFullM2: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Why a farm irrigates what is routed to its dam straight from the river, or
 * null when it doesn't: something is routed there (the upstream or runoff
 * share, River to dam), and there is no dam on some day of the run `span`
 * (epoch days; damPresence: none entered, not in service yet, silted empty,
 * engine ≥ 1.60.0). Without a span, the entered capacity alone decides.
 */
function noDamOf(n: NetworkNode, span: { start: number; end: number } | undefined): string | null {
	const routed = n.pctUpstreamToDam > 0 || n.pctRunoffToDam > 0 || (Array.isArray(n.divertMonthlyM3Day) ? n.divertMonthlyM3Day.some((v) => v > 0) : n.divertCapacityM3Day > 0);
	if (!routed) return null;
	const dam = damPresence(n, span);
	if (dam.always) return null;
	return dam.ever ? 'its dam isn’t there on some days of the run (not in service yet, or silted empty), so on those days' : 'it has no dam, so';
}

/**
 * The farm's supply rule for the plan; {} for 'damFirst' (and absent fields),
 * where the pump capacity is inert. Out-of-range values run clamped with a
 * warning. Without a dam, 'trigger' has nothing to trigger on and runs as
 * river first; 'runOfRiver' on a farm with a dam also runs as river first
 * (the dam is kept), each with a warning. The backend refuses both on save
 * (modelRuleIssues). A supply rule on a gauge or other water user is ignored
 * with a warning.
 */
export function supplyOf(n: NetworkNode, warnings: string[], span?: { start: number; end: number }): { supply?: PlanSupply } {
	const rule = n.supplyRule ?? 'damFirst';
	const pump = n.pumpCapacityM3Day;
	if (n.kind !== 'farm') {
		// An other water user's pump is its own (userPumpOf, engine ≥ 1.58.0); only the supply rule is a farm's.
		if (n.kind === 'user') {
			if (rule !== 'damFirst') warnings.push(`user "${n.name}": only a unit has a supply rule; ignored (a user always takes from the river, up to its pump capacity)`);
		} else if (rule !== 'damFirst' || (pump !== null && pump !== undefined)) warnings.push(`gauge "${n.name}": only a unit has a supply rule and river pump; ignored`);
		return {};
	}
	if (rule === 'damFirst') {
		if (n.poolCapacityM3) warnings.push(`unit "${n.name}": a pool is for a run-of-river unit; ignored under dam only`);
		// A farm with no dam irrigates from the river routed to it (K, M, O pass through the absent
		// dam), with no pump limit: b023's stand-in for a river pump, kept, but said (issue #54).
		const none = noDamOf(n, span);
		if (none)
			warnings.push(
				`unit "${n.name}": ${none} what is routed to its dam (upstream inflow, runoff, diversion) is irrigated straight from the river, with no pump limit; to cap it, set the supply rule to run of river with a pump capacity`
			);
		return {};
	}
	if (rule !== 'riverFirst' && rule !== 'trigger' && rule !== 'runOfRiver') {
		warnings.push(`unit "${n.name}": unknown supply rule "${String(rule)}"; the dam only`);
		return {};
	}
	let pumpM3Day = Infinity;
	if (pump === null || pump === undefined) warnings.push(`unit "${n.name}": no river pump capacity is set, so what it pumps from the river is limited only by the flow`);
	else if (finite(pump) && pump >= 0) pumpM3Day = pump;
	else warnings.push(`unit "${n.name}": pump capacity ${String(pump)} m³/day is not a size ≥ 0; no limit`);
	const cap = n.damCapacityM3 > 0 ? n.damCapacityM3 : 0;
	// River first or trigger with no dam (engine ≥ 1.60.0): the dam split and River to dam still route water
	// "into the dam", which is irrigated straight from the river past the pump and its capacity (simulate.ts
	// zeroes K, M and O only under run of river), as under dam only. Said, as there (issue #54), judged over
	// the run's days like the dam-only warning.
	const none = rule === 'runOfRiver' ? null : noDamOf(n, span);
	if (none)
		warnings.push(
			`unit "${n.name}": ${none} what is routed to its dam (upstream inflow, runoff, diversion) is irrigated straight from the river, past the river pump and its capacity; to send it all through the pump, set the supply rule to run of river`
		);
	const hasPool = n.poolCapacityM3 !== null && n.poolCapacityM3 !== undefined && n.poolCapacityM3 !== 0;
	if (rule === 'runOfRiver') {
		if (cap > 0) {
			warnings.push(`unit "${n.name}": run of river has no dam, but this unit has a ${Math.round(cap)} m³ dam; it runs as river first. Set the dam capacity to 0`);
			if (hasPool) warnings.push(`unit "${n.name}": its pool is ignored, as it runs as river first`);
			return { supply: { rule: 1, pumpM3Day, triggerM3: 0, stopM3: 0 } };
		}
		const pool = hasPool ? poolOf(n, warnings) : undefined;
		return { supply: { rule: 3, pumpM3Day, triggerM3: 0, stopM3: 0, ...(pool ? { pool } : {}) } };
	}
	if (hasPool) warnings.push(`unit "${n.name}": a pool is for a run-of-river unit; ignored under the ${rule === 'riverFirst' ? 'river first' : 'trigger'} supply rule (the dam is its store)`);
	if (rule === 'riverFirst') return { supply: { rule: 1, pumpM3Day, triggerM3: 0, stopM3: 0 } };
	if (!(cap > 0)) {
		warnings.push(`unit "${n.name}": the trigger supply rule needs a dam to trigger on; it runs as river first`);
		return { supply: { rule: 1, pumpM3Day, triggerM3: 0, stopM3: 0 } };
	}
	const clamp = (v: number | undefined, lo: number, fallback: number, name: string) => {
		const x = finite(v) ? Math.min(Math.max(v, lo), 1) : Math.max(fallback, lo);
		if (v !== undefined && x !== v) warnings.push(`unit "${n.name}": ${name} ${String(v)} is outside [${lo}, 1]; using ${x}`);
		return x;
	};
	const trigger = clamp(n.supplyTriggerPct, 0, 0.4, 'supply trigger');
	const stop = clamp(n.supplyStopPct, trigger, 0.6, 'supply stop level');
	return { supply: { rule: 2, pumpM3Day, triggerM3: trigger * cap, stopM3: stop * cap } };
}

/**
 * A run-of-river farm's pool as the simulation runs it (engine ≥ 1.64.0), or
 * undefined when its capacity isn't a size > 0 (with a warning; the API
 * refuses it on save). The start share is clamped to 0–1 (default full); an
 * unknown surface area is estimated from the capacity, as a dam's is, with a
 * warning.
 */
function poolOf(n: NetworkNode, warnings: string[]): PlanPool | undefined {
	const cap = n.poolCapacityM3;
	if (!finite(cap) || cap <= 0) {
		warnings.push(`unit "${n.name}": pool capacity ${String(cap)} m³ is not a size > 0; no pool`);
		return undefined;
	}
	const raw = n.poolInitialPct;
	const pct = finite(raw) ? Math.min(Math.max(raw, 0), 1) : 1;
	if (raw !== undefined && pct !== raw) warnings.push(`unit "${n.name}": pool start ${String(raw)} is outside [0, 1]; using ${pct}`);
	let area = n.poolAreaM2;
	if (area === null || area === undefined) {
		area = estimatedDamAreaM2(cap);
		warnings.push(`unit "${n.name}": the pool's surface area is not set; estimated from its capacity as ${Math.round(area)} m² for its evaporation`);
	} else if (!finite(area) || area < 0) {
		warnings.push(`unit "${n.name}": pool area ${String(area)} m² is not a size ≥ 0; no evaporation from it`);
		area = 0;
	}
	return { capM3: cap, initialM3: pct * cap, areaFullM2: area };
}

/**
 * The pool's day (engine ≥ 1.64.0, docs/model.md §2.7j) before the pump runs:
 * its evaporation, from the surface its start-of-day storage `prev` covers
 * (A = A_full × (prev / capacity)^b, the dams' small-reservoir exponent),
 * at most what it holds. Returns [area, evaporation].
 */
export function poolLosses(pool: PlanPool, prev: number, evapMmDay: number): [number, number] {
	if (!(prev > 0)) return [0, 0];
	const A = pool.areaFullM2 * Math.pow(Math.min(prev / pool.capM3, 1), DAM_AREA_EXPONENT);
	return [A, Math.min((evapMmDay * A) / 1000, prev)];
}

/**
 * Split what the river pump took today, `Gr`, between the flow and the pool,
 * and refill the pool (engine ≥ 1.64.0): the flow it may take, `free` (the
 * flow below the farm above what must pass it), is used first, then the pool
 * (holding `held` after evaporation); the pool refills from what is left of
 * `free`, up to its capacity. Returns [from the flow, from the pool, refill,
 * storage at the end of the day].
 */
export function poolDay(pool: PlanPool, Gr: number, free: number, held: number): [number, number, number, number] {
	const fromFlow = Math.min(Gr, free);
	const fromPool = Math.min(Math.max(Gr - fromFlow, 0), held);
	const after = held - fromPool;
	const refill = Math.max(0, Math.min(pool.capM3 - after, free - fromFlow));
	return [fromFlow, fromPool, refill, after + refill];
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
			warnings.push(`${n.kind === 'user' ? 'user' : 'gauge'} "${n.name}": only a unit has a hands-off flow and River to dam by month; ignored`);
		return {};
	}
	const who = `unit "${n.name}"`;
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

/** A run-of-river pool's result series (engine ≥ 1.64.0, docs/model.md §2.7j): keys, labels and units, for run.ts and the checks. */
export const POOL_SERIES = {
	storage: { key: 'pool_storage', label: 'Pool storage at the river pump (end of the day)', unit: 'm³' },
	drawn: { key: 'pool_drawn', label: 'Pumped from the pool (part of the river abstraction)', unit: 'm³/day' },
	evaporation: { key: 'pool_evaporation', label: 'Evaporation from the pool', unit: 'm³/day' },
	area: { key: 'pool_area', label: 'Pool surface area (start of day)', unit: 'm²' }
} as const;
