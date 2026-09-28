// Demand objects (engine ≥ 1.7.0, issue #54 item 2b, docs/model.md §2.7f):
// demands on a unit that aren't crops (a town, households, livestock, a
// bulk supply piped out of the catchment). Each adds its daily abstraction
// demand to the unit's; the unit's dam, river pump and boreholes supply the
// total as they supply irrigation, and what the unit gets is split between
// its crops and its objects by priority class, pro rata within a class. Each
// object returns its share of what it got below the unit the same day
// (internal), or nothing (external). Pure; the simulation (./simulate.ts),
// the run summary (../run.ts) and the self-checks (../verify/checks.ts) all
// read an object through these functions, so a stored value means the same
// thing to each.
import { waterYearIndex } from '../calendar';
import { cmpStr } from '../order';
import type { DemandObject, DemandObjectPriority, ProjectModel } from '../project';
import { scheduleFactors } from './demandSchedule';

/** The priority classes in supply order: before the crops, with them, after them. */
export const PRIORITY_TIER: Record<DemandObjectPriority, 0 | 1 | 2> = { first: 0, shared: 1, last: 2 };

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
	/** Each object's priority class: 0 before the crops, 1 with them, 2 after them. */
	tier: Uint8Array;
	/** Σ of the objects' demand per day. */
	total: Float64Array;
}

/**
 * A unit's objects for the plan: each one's daily demand from its month's
 * value (`wy[t]` = the day's water-year month index), times the node's
 * demand factor from run day `factorFrom` on (the demand.scale scenario op,
 * as for the crop requirement), times its schedule's factor that day
 * (engine ≥ 1.17.0; `day0` = the run's first epoch day, needed only when an
 * object has a schedule). Warnings name what runs differently from what was
 * entered.
 */
export function planObjects(objects: readonly DemandObject[], days: number, wy: ArrayLike<number>, factor: Float64Array | null, factorFrom: number, warnings: string[], day0?: number): PlanObjects {
	const demand: Float64Array[] = [];
	const schedule: (Float64Array | null)[] = [];
	const returnShare = new Float64Array(objects.length);
	const tier = new Uint8Array(objects.length);
	const total = new Float64Array(days);
	objects.forEach((o, k) => {
		const monthly = objectMonthlyM3Day(o, warnings);
		const who = `demand object "${o.name}"`;
		if (Array.isArray(o.schedule) && o.schedule.length && day0 === undefined) throw new Error(`planObjects: ${who} has a schedule, which needs the run start`);
		const s = day0 === undefined ? null : scheduleFactors(o.schedule, day0, days, warnings, who);
		const d = new Float64Array(days);
		for (let t = 0; t < days; t++) {
			const m = wy[t]!;
			const v = factor && t >= factorFrom ? monthly[m]! * factor[m]! : monthly[m]!;
			d[t] = s ? v * s[t]! : v;
		}
		demand.push(d);
		schedule.push(s);
		returnShare[k] = objectReturnShare(o);
		if (o.destination !== 'external' && o.destination !== 'internal') warnings.push(`demand object "${o.name}": unknown destination "${String(o.destination)}"; runs as internal`);
		if (o.destination === 'external' && finite(o.returnPct) && o.returnPct > 0) warnings.push(`demand object "${o.name}" is piped out of the catchment, so none of it returns; its return share is ignored`);
		const r = o.returnPct;
		if (o.destination !== 'external' && finite(r) && (r < 0 || r > 1)) warnings.push(`demand object "${o.name}": return share ${r} is not in [0, 1]; using ${returnShare[k]}`);
		const p = PRIORITY_TIER[o.priority];
		if (p === undefined) warnings.push(`demand object "${o.name}": unknown priority "${String(o.priority)}"; supplied with the crops`);
		tier[k] = p ?? 1;
	});
	for (const d of demand) for (let t = 0; t < days; t++) total[t]! += d[t]!;
	return { ids: objects.map((o) => o.id), demand, schedule, returnShare, tier, total };
}

/** The daily water-year month index of each run day, from its calendar month. */
export function waterYearMonths(month: ArrayLike<number>, days: number): Uint8Array {
	const wy = new Uint8Array(days);
	for (let t = 0; t < days; t++) wy[t] = waterYearIndex(month[t]!);
	return wy;
}

/**
 * Split what a unit was supplied today, `G`, between its crops (irrigation
 * abstraction demand `crop`) and its objects: class 0 first, then the crops
 * with class 1, then class 2, each class pro rata to its members' demand.
 * A class that can be met in full gets exactly its demand; so does every
 * member when G covers the whole demand. Writes each object's supply into
 * `out[k][t]` and returns the crops' part. Σ parts = G up to float noise.
 */
export function splitSupply(G: number, crop: number, po: PlanObjects, t: number, out: Float64Array[]): number {
	const n = po.ids.length;
	if (G >= crop + po.total[t]!) {
		for (let k = 0; k < n; k++) out[k]![t] = po.demand[k]![t]!;
		return crop;
	}
	let rem = Math.max(G, 0);
	let cropGot = 0;
	for (let tier = 0; tier < 3; tier++) {
		let want = tier === 1 ? crop : 0;
		for (let k = 0; k < n; k++) if (po.tier[k] === tier) want += po.demand[k]![t]!;
		if (!(want > 0)) {
			for (let k = 0; k < n; k++) if (po.tier[k] === tier) out[k]![t] = 0;
			continue;
		}
		if (rem >= want) {
			for (let k = 0; k < n; k++) if (po.tier[k] === tier) out[k]![t] = po.demand[k]![t]!;
			if (tier === 1) cropGot = crop;
			rem -= want;
		} else {
			const f = rem / want;
			for (let k = 0; k < n; k++) if (po.tier[k] === tier) out[k]![t] = po.demand[k]![t]! * f;
			if (tier === 1) cropGot = crop * f;
			rem = 0;
		}
	}
	return cropGot;
}
