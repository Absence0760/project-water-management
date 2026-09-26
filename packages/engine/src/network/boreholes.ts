// Boreholes on a farm or other water user (WP-1.34 and WP-3.9, docs/model.md
// §2.7d): the node's combined borehole fields and its individual boreholes
// (ProjectModel.boreholes) resolved into the plan's pumping units and the
// node's stream-depletion lag. runModel and the self-checks
// (../verify/checks.ts) both read a node's boreholes through this, so they
// agree on what a stored value means.
import { GA538_GROUNDWATER_LIMIT_M3_YEAR, type Borehole, type GroundwaterAnnualUse, type NetworkNode, type ProjectModel } from '../project';
import { cmpStr } from '../order';
import { waterYearOf } from './stats';

/** One pumping unit of a node (WP-3.9): its combined capacity (WP-1.34) or one borehole. */
export interface PlanBoreholeUnit {
	/** The borehole's id; null = the node's combined borehole capacity (WP-1.34). */
	id: string | null;
	name: string;
	capacityM3Day: number;
	/** Most it may pump per water year (m³); Infinity = no cap. */
	annualCapM3: number;
	/** 0 = supplemental, 1 = primary, 2 = emergency (supplemental while the dam holds less than `triggerM3` at the start of the day). */
	mode: 0 | 1 | 2;
	triggerM3: number;
	/** Pumps into the farm dam instead of straight to the crop (WP-3.9). */
	toDam: boolean;
	/** Share d of what it pumps that the river eventually loses. */
	depletionFrac: number;
}

export interface PlanBorehole {
	/** In order: the combined capacity first, then the boreholes by id (../order.ts). */
	units: PlanBoreholeUnit[];
	/** Release rate of the node's depletion lag store, 1 − e^(−1/k); 1 for k = 0. */
	depletionAlpha: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Each node's individual boreholes (WP-3.9), by node id, in id order. A
 * borehole naming no known node is dropped with a warning.
 */
export function boreholesByNode(model: Pick<ProjectModel, 'nodes' | 'boreholes'>, warnings: string[]): Map<string, Borehole[]> {
	const out = new Map<string, Borehole[]>();
	const list = model.boreholes ?? [];
	if (!list.length) return out;
	const ids = new Set(model.nodes.map((n) => n.id));
	for (const b of [...list].sort((a, c) => cmpStr(String(a.id), String(c.id)))) {
		if (!ids.has(b.nodeId)) {
			warnings.push(`borehole "${b.name}" refers to a node that does not exist; skipped`);
			continue;
		}
		const a = out.get(b.nodeId) ?? [];
		a.push(b);
		out.set(b.nodeId, a);
	}
	return out;
}

/**
 * A farm's or other user's boreholes (WP-1.34, WP-3.9, docs/model.md §2.7d),
 * for the plan; {} when it can pump nothing (no combined capacity, and no
 * borehole with a capacity and a mode other than 'none'). Out-of-range values
 * run clamped, with a warning. On a node without a dam, 'drought' and
 * 'emergency' never trigger, so they run as supplemental, and a borehole
 * that pumps into the dam pumps straight to the crop or user; each with a
 * warning. Boreholes on a gauge are skipped with a warning.
 */
export function boreholeOf(n: NetworkNode, own: readonly Borehole[], warnings: string[]): { borehole?: PlanBorehole } {
	const cap = n.boreholeCapacityM3Day;
	const combined = n.kind !== 'gauge' && finite(cap) && cap > 0;
	const pumping = own.filter((b) => b.mode !== 'none' && finite(b.capacityM3Day) && b.capacityM3Day > 0);
	if (n.kind === 'gauge') {
		if (own.length) warnings.push(`gauge "${n.name}": a gauge only measures; its ${own.length} borehole${own.length === 1 ? ' is' : 's are'} skipped`);
		return {};
	}
	if (!combined && !pumping.length) return {};
	const what = n.kind === 'user' ? 'user' : 'farm';
	const clamp = (v: number | undefined, lo: number, hi: number, fallback: number, name: string) => {
		const x = finite(v) ? Math.min(Math.max(v, lo), hi) : fallback;
		if (v !== undefined && x !== v) warnings.push(`${what} "${n.name}": ${name} ${String(v)} is outside [${lo}, ${hi}]; using ${x}`);
		return x;
	};
	const damCap = n.kind === 'farm' ? n.damCapacityM3 : 0;
	const hasDam = damCap > 0;
	const units: PlanBoreholeUnit[] = [];
	if (combined) {
		let mode: 0 | 1 | 2 = n.boreholeRule === 'primary' ? 1 : n.boreholeRule === 'drought' ? 2 : 0;
		if (mode === 2 && !hasDam) {
			warnings.push(`${what} "${n.name}": the drought borehole rule needs a dam to trigger on; its boreholes run as supplemental`);
			mode = 0;
		}
		const trigger = clamp(n.boreholeTriggerPct, 0, 1, 0.3, 'borehole trigger');
		const d = clamp(n.streamDepletionFrac, 0, 1, 0, 'stream depletion fraction');
		units.push({ id: null, name: 'Combined boreholes', capacityM3Day: cap, annualCapM3: Infinity, mode, triggerM3: trigger * damCap, toDam: false, depletionFrac: d });
	}
	for (const b of pumping) {
		const label = `borehole "${b.name}"`;
		let mode: 0 | 1 | 2 = b.mode === 'primary' ? 1 : b.mode === 'emergency' ? 2 : 0;
		if (mode === 2 && !hasDam) {
			warnings.push(`${what} "${n.name}": ${label} runs in emergency mode but there is no dam to trigger on; it runs as supplemental`);
			mode = 0;
		}
		let toDam = b.target === 'dam';
		if (toDam && !hasDam) {
			warnings.push(`${what} "${n.name}": ${label} pumps into a dam but there is none; it pumps straight to the ${n.kind === 'user' ? 'user' : 'crop'}`);
			toDam = false;
		}
		const annual = b.annualCapM3 === null || b.annualCapM3 === undefined ? Infinity : clamp(b.annualCapM3, 0, Number.MAX_VALUE, Infinity, `${label} annual cap`);
		units.push({
			id: b.id,
			name: b.name,
			capacityM3Day: b.capacityM3Day,
			annualCapM3: annual,
			mode,
			triggerM3: clamp(b.emergencyBelowPct, 0, 1, 0.3, `${label} emergency level`) * damCap,
			toDam,
			depletionFrac: clamp(b.depletionFactor, 0, 1, 0, `${label} depletion factor`)
		});
	}
	const k = clamp(n.streamDepletionLagDays, 0, 36_500, 0, 'stream depletion lag (days)');
	return { borehole: { units, depletionAlpha: k > 0 ? 1 - Math.exp(-1 / k) : 1 } };
}

/** What a unit may still pump today: its daily capacity, less once this water year's cap is nearly reached. */
export const unitRoom = (u: PlanBoreholeUnit, usedThisYear: number): number => Math.max(0, Math.min(u.capacityM3Day, u.annualCapM3 - usedThisYear));

/** Is day t the first of a water year (1 October), or the run's first day? `month` is the calendar month of each day. */
export const startsWaterYear = (month: ArrayLike<number>, t: number): boolean => t === 0 || (month[t] === 10 && month[t - 1] !== 10);

/**
 * One day's groundwater at a node (WP-1.34, WP-3.9), in the supply order:
 * 1. primary units straight to the crop or user, up to demand D;
 * 2. units that pump into the dam: primary ones fill it, supplemental ones
 *    add what it lacks for today's remaining demand (above its dead storage,
 *    so a dam below it is first brought up to it), emergency ones fill it
 *    while it started the day below their trigger; never above capacity, so
 *    pumped water never spills;
 * 3. the dam and river (`surface`, with what was pumped into the dam);
 * 4. supplemental units, then emergency units while triggered, for what is left.
 * Each unit pumps at most `unitRoom`. Writes each unit's volume to `pumped`
 * and adds it to `used`. `avail` is what the dam holds and receives today
 * before irrigation, `dead` its dead storage, `cap` its capacity (0 for a user).
 * Returns [surface supply Gs, groundwater to the crop, into the dam, Σ d × pumped].
 */
export function groundwaterDay(b: PlanBorehole, used: Float64Array, pumped: Float64Array[], t: number, D: number, qPrev: number, avail: number, dead: number, cap: number): [number, number, number, number] {
	const { units } = b;
	let dep = 0;
	const take = (k: number, v: number) => {
		pumped[k]![t] = v;
		used[k]! += v;
		dep += units[k]!.depletionFrac * v;
	};
	let g = 0;
	for (let k = 0; k < units.length; k++) {
		const u = units[k]!;
		if (u.toDam || u.mode !== 1) continue;
		const v = Math.max(0, Math.min(unitRoom(u, used[k]!), D - g));
		take(k, v);
		g += v;
	}
	let gd = 0;
	for (let k = 0; k < units.length; k++) {
		const u = units[k]!;
		if (!u.toDam) continue;
		const head = cap - (avail + gd);
		const want = u.mode === 1 ? head : u.mode === 2 ? (qPrev < u.triggerM3 ? head : 0) : D - g - (avail + gd - dead);
		const v = Math.max(0, Math.min(unitRoom(u, used[k]!), want, head));
		take(k, v);
		gd += v;
	}
	const Gs = Math.min(Math.max(avail + gd - dead, 0), D - g);
	for (const pass of [0, 2] as const) {
		for (let k = 0; k < units.length; k++) {
			const u = units[k]!;
			if (u.toDam || u.mode !== pass || (pass === 2 && !(qPrev < u.triggerM3))) continue;
			const v = Math.max(0, Math.min(unitRoom(u, used[k]!), D - Gs - g));
			take(k, v);
			g += v;
		}
	}
	return [Gs, g, gd, dep];
}

/**
 * RunSummary.groundwaterAnnualUse (WP-3.9): per node with boreholes, in node-id
 * order, and per water year the run touches, what was pumped (to the crop and
 * into the dam), the stream depletion taken, each unit's volume against its
 * annual cap, and the GN 538 ceiling for context. `start` is the run's first
 * epoch day.
 */
export function groundwaterAnnualUse(
	nodes: readonly NetworkNode[],
	plan: { days: number; nodes: readonly { borehole?: PlanBorehole }[] },
	sim: { nodes: readonly { groundwater: Float64Array; groundwaterToDam: Float64Array; depletion: Float64Array; boreholePumped?: Float64Array[] }[] },
	start: number
): GroundwaterAnnualUse[] {
	const out: GroundwaterAnnualUse[] = [];
	const idx = nodes.map((_, i) => i).sort((a, b) => cmpStr(nodes[a]!.id, nodes[b]!.id));
	for (const i of idx) {
		const b = plan.nodes[i]!.borehole;
		const n = nodes[i]!;
		if (!b || n.kind === 'gauge') continue;
		const r = sim.nodes[i]!;
		const capped = b.units.every((u) => Number.isFinite(u.annualCapM3));
		let row: GroundwaterAnnualUse | null = null;
		for (let t = 0; t < plan.days; t++) {
			const wy = waterYearOf(start + t);
			if (!row || row.waterYear !== wy) {
				row = {
					nodeId: n.id,
					name: n.name,
					kind: n.kind,
					waterYear: wy,
					label: `${wy}/${String((wy + 1) % 100).padStart(2, '0')}`,
					days: 0,
					abstractionM3: 0,
					toDamM3: 0,
					streamDepletionM3: 0,
					annualCapM3: capped ? b.units.reduce((s, u) => s + u.annualCapM3, 0) : null,
					gaLimitM3: GA538_GROUNDWATER_LIMIT_M3_YEAR,
					boreholes: b.units.map((u) => ({ id: u.id, name: u.name, abstractionM3: 0, annualCapM3: Number.isFinite(u.annualCapM3) ? u.annualCapM3 : null, capReached: false }))
				};
				out.push(row);
			}
			row.days++;
			row.abstractionM3 += r.groundwater[t]! + r.groundwaterToDam[t]!;
			row.toDamM3 += r.groundwaterToDam[t]!;
			row.streamDepletionM3 += r.depletion[t]!;
			for (let k = 0; k < b.units.length; k++) row.boreholes[k]!.abstractionM3 += r.boreholePumped![k]![t]!;
		}
	}
	// A cap counts as reached when the year's volume is within float noise of it.
	for (const row of out) for (const u of row.boreholes) if (u.annualCapM3 !== null) u.capReached = u.abstractionM3 >= u.annualCapM3 * (1 - 1e-9);
	return out;
}
