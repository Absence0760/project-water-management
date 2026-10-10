// The Demands grid (Network → Tables → Demands, `grid=demands`, docs/ui.md §
// Demands grid): every demand in the catchment in one table, one row each.
// A unit's crops (its irrigation demand, the Crops & demand preview's
// number), each of its demand objects in the unit's supply order, and each
// other water user. Monthly m³/day from the engine's own helpers
// (objectMonthlyM3Day, farmDemands), so a row reads what a run takes before
// rain, schedules, demand factors and restrictions.
import {
	daysPerMonth,
	DEMAND_OBJECT_CATEGORY_LABEL,
	objectMonthlyM3Day,
	supplyOrder,
	USER_PRIORITY_LABEL,
	type DemandObject,
	type NetworkNode,
	type ProjectModel
} from '@water-management/engine';
import { annualMm3, farmDemands } from '$lib/components/crops/demand';

export type DemandRowKind = 'crops' | 'object' | 'user';

export interface DemandRow {
	/** Stable across edits: `crops@<node>`, `object@<id>`, `user@<node>`. */
	key: string;
	kind: DemandRowKind;
	nodeId: string;
	/** The node's name, '(unnamed)' without one. */
	unit: string;
	/** The demand's own name: "Crops" for the crops, the object's name, the user's name. */
	name: string;
	/** What it is: "Irrigation (crops)", the object's category, "Other water user". */
	what: string;
	/** Where it takes its water, in words. */
	from: string;
	/** Its place in the unit's supply order ("1 of 3"), a user's priority (Priority / Non-priority); null when there is no order to tell. */
	order: string | null;
	/** false: an object kept on record but not modelled (out of the totals). */
	enabled: boolean;
	/** Piped out of the catchment (an external object): nothing returns. */
	external: boolean;
	/** Demand per water-year month (Oct–Sep), m³/day. */
	monthlyM3Day: number[];
	meanM3Day: number;
	annualMm3: number;
	/** The months are stored values the grid may edit (a monthly object, a user); else computed (crops, a per-unit object). */
	editable: boolean;
	/** How a computed row's months are made (a per-unit object's count × litres), for its note. */
	sizing: string | null;
	/** It has schedule windows, which change its demand on the days they cover (not shown here). */
	scheduled: boolean;
}

const name = (n: NetworkNode) => n.name || '(unnamed)';

function sums(monthly: number[], februaryDays: number): { meanM3Day: number; annualMm3: number } {
	const annual = annualMm3(monthly, februaryDays);
	const yearDays = daysPerMonth(februaryDays).reduce((a, b) => a + b, 0);
	return { meanM3Day: (annual * 1e6) / yearDays, annualMm3: annual };
}

const pct = (v: number) => `${Math.round(v * 100)} %`;

/** Where a unit's crops take their water: the crop supply table's shares (engine ≥ 1.73.0) or the one source. */
export function cropsFrom(n: NetworkNode, byId: ReadonlyMap<string, NetworkNode>): string {
	const dam = n.cropShareDam ?? null;
	const river = n.cropShareRiver ?? null;
	const remote = n.cropShareRemote ?? null;
	if (dam !== null || river !== null || remote !== null) {
		const parts: string[] = [];
		if (dam) parts.push(`dam side ${pct(dam)}`);
		if (river) parts.push(`river ${pct(river)}`);
		if (remote) {
			const other = n.cropRemoteNodeId ? byId.get(n.cropRemoteNodeId) : undefined;
			parts.push(`${other ? `${name(other)}’s dam` : 'another unit’s dam'} ${pct(remote)}`);
		}
		return parts.length ? parts.join(', ') : 'dam side';
	}
	return n.cropWaterSource === 'river' ? 'river abstraction' : 'dam side';
}

const objectFrom = (o: DemandObject) => (o.waterSource === 'river' ? 'river abstraction' : 'dam side');

function objectSizing(o: DemandObject): string | null {
	if (o.sizing !== 'perUnit') return null;
	const loss = o.lossPct > 0 ? `, losses ${pct(o.lossPct)}` : '';
	const profile = o.monthlyFactor?.some((f) => f !== null && f !== 1) ? ', monthly profile' : '';
	return `${o.count ?? 0} × ${o.litresPerUnitDay ?? 0} l a day${loss}${profile}`;
}

/**
 * Every demand in the catchment, in the network's node order; within a unit,
 * its supply order (the crops at their place among the objects).
 */
export function demandRows(model: ProjectModel, apanMm: readonly number[], februaryDays = 28.25): DemandRow[] {
	const byId = new Map(model.nodes.map((n) => [n.id, n]));
	const objectsOf = new Map<string, DemandObject[]>();
	for (const o of model.demandObjects ?? []) {
		const list = objectsOf.get(o.nodeId) ?? [];
		list.push(o);
		objectsOf.set(o.nodeId, list);
	}
	const farms = model.nodes.filter((n) => n.kind === 'farm').map((n) => n.id);
	const crops = new Map(farmDemands(model, apanMm, februaryDays, farms).map((d) => [d.nodeId, d]));
	const rows: DemandRow[] = [];
	for (const n of model.nodes) {
		if (n.kind === 'user') {
			const monthly = Array.from({ length: 12 }, (_, m) => {
				const v = n.userDemandM3Day?.[m];
				return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
			});
			rows.push({
				key: `user@${n.id}`,
				kind: 'user',
				nodeId: n.id,
				unit: name(n),
				name: name(n),
				what: 'Other water user',
				from: 'river',
				order: USER_PRIORITY_LABEL[n.userPriority === 'junior' ? 'junior' : 'senior'],
				enabled: true,
				external: false,
				monthlyM3Day: monthly,
				...sums(monthly, februaryDays),
				editable: true,
				sizing: null,
				scheduled: false
			});
			continue;
		}
		if (n.kind !== 'farm') continue;
		const objects = objectsOf.get(n.id) ?? [];
		const cropDemand = crops.get(n.id);
		const hasCrops = !!cropDemand && cropDemand.areaHa > 0;
		if (!hasCrops && !objects.length) continue;
		// The supply order counts every enabled object; one not modelled has no place in it.
		const live = objects.filter((o) => o.enabled !== false);
		const { positions, crops: cropPos } = supplyOrder(live);
		const levels = new Set([...positions, ...(hasCrops ? [cropPos] : [])]).size;
		const orderOf = (p: number) => (levels > 1 ? `${p} of ${levels}` : null);
		const unit: { pos: number; row: DemandRow }[] = [];
		if (hasCrops) {
			unit.push({
				pos: cropPos,
				row: {
					key: `crops@${n.id}`,
					kind: 'crops',
					nodeId: n.id,
					unit: name(n),
					name: 'Crops',
					what: 'Irrigation (crops)',
					from: cropsFrom(n, byId),
					order: orderOf(cropPos),
					enabled: true,
					external: false,
					monthlyM3Day: cropDemand.monthlyM3Day,
					meanM3Day: cropDemand.meanM3Day,
					annualMm3: cropDemand.annualMm3,
					editable: false,
					sizing: null,
					scheduled: false
				}
			});
		}
		for (const o of objects) {
			const i = live.indexOf(o);
			const monthly = Array.from(objectMonthlyM3Day(o, []));
			unit.push({
				// Off objects after the modelled ones, in their saved order.
				pos: i >= 0 ? positions[i]! : Number.MAX_SAFE_INTEGER,
				row: {
					key: `object@${o.id}`,
					kind: 'object',
					nodeId: n.id,
					unit: name(n),
					name: o.name || '(unnamed)',
					what: DEMAND_OBJECT_CATEGORY_LABEL[o.category] ?? o.category,
					from: objectFrom(o),
					order: i >= 0 ? orderOf(positions[i]!) : null,
					enabled: o.enabled !== false,
					external: o.destination === 'external',
					monthlyM3Day: monthly,
					...sums(monthly, februaryDays),
					editable: o.sizing === 'monthly',
					sizing: objectSizing(o),
					scheduled: !!o.schedule?.length
				}
			});
		}
		// A stable sort: equal places (sharing pro rata) keep the crops first, then the objects' saved order.
		unit.sort((a, b) => a.pos - b.pos);
		rows.push(...unit.map((u) => u.row));
	}
	return rows;
}

/** The catchment row: Σ the modelled rows (an object that is off counts nothing). */
export function demandTotal(rows: readonly DemandRow[], februaryDays = 28.25): { monthly: number[]; meanM3Day: number; annualMm3: number } {
	const monthly = Array.from({ length: 12 }, (_, m) => rows.reduce((s, r) => s + (r.enabled ? r.monthlyM3Day[m]! : 0), 0));
	return { monthly, ...sums(monthly, februaryDays) };
}

/** The share of the total each kind of demand takes, for the line above the table ("Irrigation 82 %, Municipal 12 %, …"), largest first. */
export function demandShares(rows: readonly DemandRow[]): { what: string; annualMm3: number; share: number }[] {
	const by = new Map<string, number>();
	let total = 0;
	for (const r of rows) {
		if (!r.enabled) continue;
		by.set(r.what, (by.get(r.what) ?? 0) + r.annualMm3);
		total += r.annualMm3;
	}
	if (total <= 0) return [];
	return [...by].map(([what, annualMm3]) => ({ what, annualMm3, share: annualMm3 / total })).sort((a, b) => b.annualMm3 - a.annualMm3);
}
