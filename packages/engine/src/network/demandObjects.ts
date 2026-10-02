// Demand objects (engine ≥ 1.7.0, issue #54 item 2b, docs/model.md §2.7f):
// demands on a unit that aren't crops (a town, households, livestock, a
// bulk supply piped out of the catchment). Each adds its daily abstraction
// demand to the unit's; the unit's dam, river pump and boreholes supply the
// total as they supply irrigation, and what the unit gets is split between
// its crops and its objects in supply order: by priority class, then by rank
// within a class (engine ≥ 1.64.0), pro rata within one rank. Each
// object returns its share of what it got below the unit the same day
// (internal), or nothing (external). Pure; the simulation (./simulate.ts),
// the run summary (../run.ts) and the self-checks (../verify/checks.ts) all
// read an object through these functions, so a stored value means the same
// thing to each.
import { waterYearIndex } from '../calendar';
import { cmpStr } from '../order';
import { BASIC_NEEDS_CATEGORIES, DEMAND_NORMS, DEMAND_OBJECT_MAX_RANK, type DemandObject, type DemandObjectPriority, type ProjectModel } from '../project';
import { scheduleFactors } from './demandSchedule';

/** The priority classes in supply order: before the crops, with them, after them. */
export const PRIORITY_TIER: Record<DemandObjectPriority, 0 | 1 | 2> = { first: 0, shared: 1, last: 2 };

/**
 * A demand object's rank within its class as the run uses it (engine ≥
 * 1.64.0): a whole number in 1–DEMAND_OBJECT_MAX_RANK; null or absent is 1,
 * and so is anything else, with a warning when `warnings` is given. 0 for a
 * 'shared' object, which always shares with the crops.
 */
export function objectRank(o: Pick<DemandObject, 'name' | 'priority' | 'rank'>, warnings?: string[]): number {
	if (PRIORITY_TIER[o.priority] === 1 || PRIORITY_TIER[o.priority] === undefined) return 0;
	const r = o.rank;
	if (r === null || r === undefined) return 1;
	if (Number.isInteger(r) && r >= 1 && r <= DEMAND_OBJECT_MAX_RANK) return r;
	warnings?.push(`demand object "${o.name}": rank ${String(r)} is not a whole number from 1 to ${DEMAND_OBJECT_MAX_RANK}; runs as 1`);
	return 1;
}

/**
 * A unit's supply order (engine ≥ 1.64.0, issue #343, docs/model.md §2.7f):
 * each object's level and the crops' level, 0 supplied first, numbered
 * densely over the (class, rank) pairs present. Objects of one level, and
 * 'shared' objects with the crops, share pro rata. Without ranks the levels
 * are the classes present, so a unit saved before ranks runs as it did.
 * An unknown priority runs as 'shared' (planObjects warns).
 */
export function supplyLevels(objects: readonly Pick<DemandObject, 'name' | 'priority' | 'rank'>[], warnings?: string[]): { level: number[]; cropLevel: number; count: number } {
	const keyOf = (o: Pick<DemandObject, 'name' | 'priority' | 'rank'>) => {
		const tier = PRIORITY_TIER[o.priority] ?? 1;
		return tier * (DEMAND_OBJECT_MAX_RANK + 1) + objectRank(o, warnings);
	};
	const keys = objects.map(keyOf);
	const cropKey = DEMAND_OBJECT_MAX_RANK + 1;
	const distinct = [...new Set([...keys, cropKey])].sort((a, b) => a - b);
	const at = new Map(distinct.map((k, i) => [k, i]));
	return { level: keys.map((k) => at.get(k)!), cropLevel: at.get(cropKey)!, count: distinct.length };
}

/**
 * A unit's numbered supply order as the node form shows it (issue #343):
 * each object's position and the crops', from 1, equal positions sharing
 * (supplyLevels + 1).
 */
export function supplyOrder(objects: readonly Pick<DemandObject, 'name' | 'priority' | 'rank'>[]): { positions: number[]; crops: number } {
	const { level, cropLevel } = supplyLevels(objects);
	return { positions: level.map((l) => l + 1), crops: cropLevel + 1 };
}

/**
 * The priority class and rank of each object for a numbered supply order
 * (the inverse of supplyOrder): before the crops' position 'first', at it
 * 'shared', after it 'last', ranked densely within its class by position.
 * A class whose objects all hold one position gets rank null (1), the form
 * an object saved before ranks has.
 */
export function fromSupplyOrder(positions: readonly number[], crops: number): { priority: DemandObjectPriority; rank: number | null }[] {
	const priorityOf = (p: number): DemandObjectPriority => (p < crops ? 'first' : p > crops ? 'last' : 'shared');
	const ranks = new Map<DemandObjectPriority, number[]>();
	positions.forEach((p) => {
		const c = priorityOf(p);
		if (c === 'shared') return;
		const list = ranks.get(c) ?? [];
		if (!list.includes(p)) list.push(p);
		ranks.set(c, list);
	});
	for (const list of ranks.values()) list.sort((a, b) => a - b);
	return positions.map((p) => {
		const priority = priorityOf(p);
		const list = ranks.get(priority);
		return { priority, rank: !list || list.length < 2 ? null : list.indexOf(p) + 1 };
	});
}

/**
 * Each enabled demand object's run series, on its unit: its daily demand and
 * what it was supplied (`object_demand@<id>`, `object_supplied@<id>`, the
 * `<kind>@<id>` shape of the transfer rules' series). Stored for every
 * enabled object on a farm, decided by the model alone, so a reader tells
 * whether a run has them without knowing its engine version.
 */
export const DEMAND_OBJECT_SERIES = {
	demandPrefix: 'object_demand@',
	suppliedPrefix: 'object_supplied@',
	demandLabel: (name: string) => `Demand object "${name}": demand`,
	suppliedLabel: (name: string) => `Demand object "${name}": supplied`,
	unit: 'm³/day'
} as const;

export const objectDemandKey = (id: string): string => `${DEMAND_OBJECT_SERIES.demandPrefix}${id}`;
export const objectSuppliedKey = (id: string): string => `${DEMAND_OBJECT_SERIES.suppliedPrefix}${id}`;

/** The object id of an object_demand@ / object_supplied@ key, and which it is; null for any other key. */
export function parseDemandObjectKey(key: string): { id: string; what: 'demand' | 'supplied' } | null {
	for (const [prefix, what] of [
		[DEMAND_OBJECT_SERIES.demandPrefix, 'demand'],
		[DEMAND_OBJECT_SERIES.suppliedPrefix, 'supplied']
	] as const) {
		if (key.startsWith(prefix) && key.length > prefix.length) return { id: key.slice(prefix.length), what };
	}
	return null;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * A demand object's abstraction demand per water-year month, m³/day:
 * 'monthly' — its twelve values; 'perUnit' — count × litres per unit per
 * day ÷ 1000 × the month's factor ÷ (1 − losses). A value that isn't a
 * number ≥ 0 runs as 0, a loss outside [0, 1) as 0, a missing factor as 1,
 * each with a warning.
 */
export function objectMonthlyM3Day(o: DemandObject, warnings: string[]): Float64Array {
	const out = new Float64Array(12);
	const who = `demand object "${o.name}"`;
	if (o.sizing === 'perUnit') {
		const count = o.count;
		const lpd = o.litresPerUnitDay;
		if (!(finite(count) && count >= 0) || !(finite(lpd) && lpd >= 0)) {
			warnings.push(`${who}: sized per unit, but its count (${String(count)}) or litres per unit per day (${String(lpd)}) is not a number ≥ 0; its demand is 0`);
			return out;
		}
		let loss = o.lossPct;
		if (!(finite(loss) && loss >= 0 && loss < 1)) {
			warnings.push(`${who}: losses ${String(loss)} are not in [0, 1); using 0`);
			loss = 0;
		}
		const f = o.monthlyFactor;
		if (f !== null && f !== undefined && (!Array.isArray(f) || f.length !== 12)) warnings.push(`${who}: the monthly profile should have 12 values; missing months are 1`);
		let badFactor = false;
		const base = (count * lpd) / 1000 / (1 - loss);
		for (let m = 0; m < 12; m++) {
			const x = Array.isArray(f) ? f[m] : undefined;
			let k = 1;
			if (x !== undefined && x !== null) {
				if (finite(x) && x >= 0) k = x;
				else badFactor = true;
			}
			out[m] = base * k;
		}
		if (badFactor) warnings.push(`${who}: a monthly profile value that isn't a number ≥ 0 runs as 1`);
		return out;
	}
	if (o.sizing !== 'monthly') {
		warnings.push(`${who}: unknown sizing "${String(o.sizing)}"; its demand is 0`);
		return out;
	}
	const v = o.monthlyM3Day;
	if (!Array.isArray(v) || v.length !== 12) warnings.push(`${who}: its monthly demand should have 12 values, has ${Array.isArray(v) ? v.length : 0}; missing months are 0`);
	let bad = false;
	for (let m = 0; m < 12; m++) {
		const x = Array.isArray(v) ? v[m] : undefined;
		if (x === undefined || x === null) continue;
		if (finite(x) && x >= 0) out[m] = x;
		else bad = true;
	}
	if (bad) warnings.push(`${who}: a monthly demand that isn't a number ≥ 0 runs as 0`);
	return out;
}

/**
 * The unit-level series of the basic-needs floor (engine ≥ 1.44.0, issue
 * #123, docs/model.md §2.7f): Σ its floored objects' floor each day, stored
 * only on a unit with one, so the curtailment report over any window of a
 * saved run (views/farmProjection.ts) holds the same floor runModel did.
 */
export const BASIC_NEEDS_SERIES = {
	key: 'basic_needs',
	label: 'Basic-needs floor of its domestic and municipal demand objects (25 l per person a day)',
	unit: 'm³/day'
} as const;

/**
 * The people a demand object's basic-needs floor counts (engine ≥ 1.44.0,
 * issue #123): null unless it is domestic or municipal; else its
 * `population` when entered, or a `perUnit` object's count. Null too for a
 * population that isn't a number > 0 (a `monthly` object without one has
 * no floor).
 */
export function basicNeedsPopulation(o: Pick<DemandObject, 'category' | 'sizing' | 'count' | 'population'>): number | null {
	if (!BASIC_NEEDS_CATEGORIES.includes(o.category)) return null;
	const p = o.population !== null && o.population !== undefined ? o.population : o.sizing === 'perUnit' ? o.count : null;
	return finite(p) && p > 0 ? p : null;
}

/**
 * A demand object's basic-needs floor, m³/day abstracted (engine ≥ 1.44.0,
 * issue #123, docs/model.md §2.7f): population × 25 l ÷ 1000, grossed up
 * for distribution losses (÷ (1 − losses)) when it is sized per unit, as its
 * demand is, so the floor reaches the tap. Null without a floor.
 */
export function basicNeedsM3Day(o: Pick<DemandObject, 'category' | 'sizing' | 'count' | 'population' | 'lossPct'>): number | null {
	const p = basicNeedsPopulation(o);
	if (p === null) return null;
	const loss = o.sizing === 'perUnit' && finite(o.lossPct) && o.lossPct >= 0 && o.lossPct < 1 ? o.lossPct : 0;
	return (p * DEMAND_NORMS.basicLitresPerPersonDay) / 1000 / (1 - loss);
}

/** The day's floor of an object with floor `floor` and demand `demand` that day: MIN(floor, demand). */
export const dayFloor = (floor: number, demand: number): number => Math.min(floor, demand);

/** An object's return share as the run uses it: 0 for an external object, else its returnPct clamped to [0, 1]. */
export function objectReturnShare(o: DemandObject): number {
	if (o.destination === 'external') return 0;
	const r = o.returnPct;
	return finite(r) ? Math.min(Math.max(r, 0), 1) : 0;
}

/**
 * The enabled demand objects runModel runs, per unit (farm node id), each
 * unit's in id order so sums never depend on list order. An object on a
 * node that doesn't exist or isn't a farm is skipped with a warning (the
 * backend refuses both on save, modelRuleIssues); so is an unknown priority
 * or destination, which runs as 'shared' / 'internal'.
 */
export function demandObjectsByNode(model: Pick<ProjectModel, 'nodes' | 'demandObjects'>, warnings: string[]): Map<string, DemandObject[]> {
	const out = new Map<string, DemandObject[]>();
	const kind = new Map(model.nodes.map((n) => [n.id, n.kind]));
	for (const o of [...(model.demandObjects ?? [])].sort((a, b) => cmpStr(String(a.id), String(b.id)))) {
		if (o.enabled === false) continue;
		const k = kind.get(o.nodeId);
		if (k !== 'farm') {
			warnings.push(`demand object "${o.name}" is ${k === undefined ? 'on a node that does not exist' : `on a ${k === 'user' ? 'user' : 'gauge'}`}: only a unit has demand objects; skipped`);
			continue;
		}
		const list = out.get(o.nodeId) ?? [];
		list.push(o);
		out.set(o.nodeId, list);
	}
	return out;
}

/** A unit's demand objects as the simulation runs them. */
export interface PlanObjects {
	ids: string[];
	/** Each object's daily abstraction demand (m³/day), after any demand factor and its schedule. */
	demand: Float64Array[];
	/** Each object's schedule factor per day (engine ≥ 1.17.0); null without a schedule that runs. */
	schedule: (Float64Array | null)[];
	/** Each object's return share of what it gets (0 when external). */
	returnShare: Float64Array;
	/**
	 * Each object's supply level (engine ≥ 1.64.0, supplyLevels): 0 is
	 * supplied first; the crops are at `cropLevel`; `levels` levels in all.
	 */
	tier: Uint8Array;
	cropLevel: number;
	levels: number;
	/** Σ of the objects' demand per day. */
	total: Float64Array;
	/**
	 * Each object's basic-needs floor, m³/day (engine ≥ 1.44.0, basicNeedsM3Day);
	 * null for one without. The day's floor is MIN(floor, its demand that day).
	 */
	floor: (number | null)[];
	/**
	 * The days a restriction (the demand factor below 1) applies on the unit
	 * (engine ≥ 1.44.0): a full allocation's rescaling holds the floor on
	 * these days too (allocations/mode.ts). Null when no day is restricted or
	 * no object has a floor.
	 */
	restricted: Uint8Array | null;
	/** Each object's category (engine ≥ 1.54.0): the part of demand a drought restriction level cuts it as (./restriction.ts). */
	category: DemandObject['category'][];
}

/**
 * A unit's objects for the plan: each one's daily demand from its month's
 * value (`wy[t]` = the day's water-year month index), times the node's
 * demand factor from run day `factorFrom` on (the demand.scale scenario op,
 * as for the crop requirement), times its schedule's factor that day
 * (engine ≥ 1.17.0; `day0` = the run's first epoch day, needed only when an
 * object has a schedule). A demand factor below 1 never takes a domestic or
 * municipal object below MIN(its basic-needs floor, its unrestricted
 * demand) (engine ≥ 1.44.0). Warnings name what runs differently from what was
 * entered.
 */
export function planObjects(
	objects: readonly DemandObject[],
	days: number,
	wy: ArrayLike<number>,
	unitFactor: Float64Array | null | ((o: DemandObject) => Float64Array | null),
	factorFrom: number,
	warnings: string[],
	day0?: number
): PlanObjects {
	const demand: Float64Array[] = [];
	const schedule: (Float64Array | null)[] = [];
	const returnShare = new Float64Array(objects.length);
	const tier = new Uint8Array(objects.length);
	const total = new Float64Array(days);
	const floors: (number | null)[] = [];
	let restricted: Uint8Array | null = null;
	objects.forEach((o, k) => {
		const monthly = objectMonthlyM3Day(o, warnings);
		const who = `demand object "${o.name}"`;
		const floor = basicNeedsM3Day(o);
		floors.push(floor);
		const pop = o.population;
		if (pop !== null && pop !== undefined && !(finite(pop) && pop >= 0)) warnings.push(`${who}: population ${String(pop)} is not a number ≥ 0; it has no basic-needs floor`);
		if (Array.isArray(o.schedule) && o.schedule.length && day0 === undefined) throw new Error(`planObjects: ${who} has a schedule, which needs the run start`);
		const s = day0 === undefined ? null : scheduleFactors(o.schedule, day0, days, warnings, who);
		// The object's own demand factor (engine ≥ 1.45.0): the unit's × its category's (demand.scale with a part), one path for the floor below.
		const factor = typeof unitFactor === 'function' ? unitFactor(o) : unitFactor;
		const d = new Float64Array(days);
		for (let t = 0; t < days; t++) {
			const m = wy[t]!;
			const v = factor && t >= factorFrom ? monthly[m]! * factor[m]! : monthly[m]!;
			d[t] = s ? v * s[t]! : v;
			// A restriction never below the floor (engine ≥ 1.44.0); the schedule applies first, so a day off stays off.
			if (floor !== null && factor && t >= factorFrom && factor[m]! < 1) {
				d[t] = Math.max(d[t]!, dayFloor(floor, s ? monthly[m]! * s[t]! : monthly[m]!));
				(restricted ??= new Uint8Array(days))[t] = 1;
			}
		}
		demand.push(d);
		schedule.push(s);
		returnShare[k] = objectReturnShare(o);
		if (o.destination !== 'external' && o.destination !== 'internal') warnings.push(`demand object "${o.name}": unknown destination "${String(o.destination)}"; runs as internal`);
		if (o.destination === 'external' && finite(o.returnPct) && o.returnPct > 0) warnings.push(`demand object "${o.name}" is piped out of the catchment, so none of it returns; its return share is ignored`);
		const r = o.returnPct;
		if (o.destination !== 'external' && finite(r) && (r < 0 || r > 1)) warnings.push(`demand object "${o.name}": return share ${r} is not in [0, 1]; using ${returnShare[k]}`);
		if (PRIORITY_TIER[o.priority] === undefined) warnings.push(`demand object "${o.name}": unknown priority "${String(o.priority)}"; supplied with the crops`);
	});
	const order = supplyLevels(objects, warnings);
	order.level.forEach((l, k) => (tier[k] = l));
	for (const d of demand) for (let t = 0; t < days; t++) total[t]! += d[t]!;
	return { ids: objects.map((o) => o.id), demand, schedule, returnShare, tier, cropLevel: order.cropLevel, levels: order.count, total, floor: floors, restricted, category: objects.map((o) => o.category) };
}

/**
 * A unit's basic-needs floor per day (engine ≥ 1.44.0, BASIC_NEEDS_SERIES):
 * Σ over its objects with a floor of MIN(floor, the object's demand that
 * day); null when none of its objects has one.
 */
export function unitBasicNeeds(po: PlanObjects): Float64Array | null {
	if (!po.floor.some((f) => f !== null)) return null;
	const days = po.total.length;
	const out = new Float64Array(days);
	po.floor.forEach((f, k) => {
		if (f === null) return;
		const d = po.demand[k]!;
		for (let t = 0; t < days; t++) out[t]! += dayFloor(f, d[t]!);
	});
	return out;
}

/** The daily water-year month index of each run day, from its calendar month. */
export function waterYearMonths(month: ArrayLike<number>, days: number): Uint8Array {
	const wy = new Uint8Array(days);
	for (let t = 0; t < days; t++) wy[t] = waterYearIndex(month[t]!);
	return wy;
}

/**
 * Split what a unit was supplied today, `G`, between its crops (irrigation
 * abstraction demand `crop`) and its objects in supply order: level 0
 * first, and so on, the crops with the objects at `po.cropLevel` (the
 * 'shared' class), each level pro rata to its members' demand. Without
 * ranks the levels are the classes: 'first', then the crops with 'shared',
 * then 'last'. A level that can be met in full gets exactly its demand; so
 * does every member when G covers the whole demand. Writes each object's
 * supply into `out[k][t]` and returns the crops' part. Σ parts = G up to
 * float noise.
 */
export function splitSupply(G: number, crop: number, po: PlanObjects, t: number, out: Float64Array[]): number {
	const n = po.ids.length;
	if (G >= crop + po.total[t]!) {
		for (let k = 0; k < n; k++) out[k]![t] = po.demand[k]![t]!;
		return crop;
	}
	let rem = Math.max(G, 0);
	let cropGot = 0;
	const cl = po.cropLevel;
	for (let tier = 0; tier < po.levels; tier++) {
		let want = tier === cl ? crop : 0;
		for (let k = 0; k < n; k++) if (po.tier[k] === tier) want += po.demand[k]![t]!;
		if (!(want > 0)) {
			for (let k = 0; k < n; k++) if (po.tier[k] === tier) out[k]![t] = 0;
			continue;
		}
		if (rem >= want) {
			for (let k = 0; k < n; k++) if (po.tier[k] === tier) out[k]![t] = po.demand[k]![t]!;
			if (tier === cl) cropGot = crop;
			rem -= want;
		} else {
			const f = rem / want;
			for (let k = 0; k < n; k++) if (po.tier[k] === tier) out[k]![t] = po.demand[k]![t]! * f;
			if (tier === cl) cropGot = crop * f;
			rem = 0;
		}
	}
	return cropGot;
}
