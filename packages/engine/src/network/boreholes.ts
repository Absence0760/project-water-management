// Boreholes on a farm or other water user (WP-1.34 and WP-3.9, docs/model.md
// §2.7d): the node's combined borehole fields and its individual boreholes
// (ProjectModel.boreholes) resolved into the plan's pumping units and the
// node's stream-depletion lag. runModel and the self-checks
// (../verify/checks.ts) both read a node's boreholes through this, so they
// agree on what a stored value means.
import { regroup } from '../format';
import { GA538_ALLUVIAL_DEPLETION_FRAC, GA538_GROUNDWATER_LIMIT_M3_YEAR, ga538VolumeM3, type Borehole, type GroundwaterAnnualUse, type NetworkNode, type ProjectModel } from '../project';
import { cmpStr } from '../order';
import { waterYearOf } from '../calendar';
import { surfaceSplit } from './supply';

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

/**
 * Does the dam serve any demand today (WP-3.9, engine ≥ 1.8.0)? `rem` is the
 * demand left after the off-take water used, the primary direct units and a
 * river-first pump, `D` the day's full demand, off-take water used included.
 * A primary or emergency unit that pumps into the dam pumps only then: on a
 * day with nothing to irrigate from the dam, groundwater pumped in would only
 * take the room that inflow later needs, and spill. The tolerance absorbs the
 * float noise of several primary units, or off-take water, adding up to D.
 * Before engine 1.57.0 an off-take day passed the rest after the off-take
 * water as D, so a rest of an ulp (980.5862268744551 of 980.5862268744552
 * m³ delivered) measured against itself switched the unit on (verify dense
 * seed 86: 1 590 m³ pumped).
 */
export const damDrawnFor = (rem: number, D: number): boolean => rem > D * 1e-12;

/** Is day t the first of a water year (1 October), or the run's first day? `month` is the calendar month of each day. */
export const startsWaterYear = (month: ArrayLike<number>, t: number): boolean => t === 0 || (month[t] === 10 && month[t - 1] !== 10);

/**
 * One day's groundwater at a node (WP-1.34, WP-3.9), in the supply order:
 * 1. primary units straight to the crop or user, up to demand D;
 * 2. units that pump into the dam: primary ones fill it, supplemental ones
 *    add what it lacks for today's remaining demand (above its dead storage,
 *    so a dam below it is first brought up to it), emergency ones fill it
 *    while it started the day below their trigger; primary and emergency ones
 *    only on a day the dam is drawn for demand (`damDrawnFor`, engine ≥
 *    1.8.0); never above capacity, so pumped water never spills;
 * 3. the dam and river (`surface`, with what was pumped into the dam);
 * 4. supplemental units, then emergency units while triggered, for what is left.
 * Each unit pumps at most `unitRoom`. Writes each unit's volume to `pumped`
 * and adds it to `used`. `avail` is what the dam holds and receives today
 * before irrigation, `dead` its dead storage, `cap` its capacity today (0 for a user).
 * On a day with no capacity (a dam not in service yet, or silted full) a
 * dam-target unit pumps straight to the crop in its mode's step, as on a node
 * without a dam.
 * `river` is what a farm's river pump can take today (WP-3.8, ./supply.ts
 * riverRoom; 0 = no river pump) and `rule` its supply rule: the river is part
 * of the surface in step 3, before the dam under river first and trigger
 * (rules 1, 2), after it on a run-of-river farm (rule 3); a supplemental
 * dam-target unit adds only what the dam lacks for the demand the river leaves.
 * `sRoom` and `gRoom` (engine ≥ 1.18.0, allocationMode 'cap'): the most the
 * surface (dam and river) and the pumping units together may still give
 * today under the node's registered volumes; Infinity = no cap. A capped
 * surface leaves the rest of the demand to the supplemental and emergency
 * units, within their own room.
 * `dayD` (engine ≥ 1.57.0) is the day's full demand, before off-take water
 * used took its share of D: the scale `damDrawnFor`'s noise is judged on.
 * Returns [from the dam Gs, groundwater to the crop, into the dam, Σ d × pumped, from the river].
 */
export function groundwaterDay(
	b: PlanBorehole,
	used: Float64Array,
	pumped: Float64Array[],
	t: number,
	D: number,
	qPrev: number,
	avail: number,
	dead: number,
	cap: number,
	river = 0,
	rule: 1 | 2 | 3 = 1,
	sRoom = Infinity,
	gRoom = Infinity,
	dayD = D
): [number, number, number, number, number] {
	const { units } = b;
	// A unit with no dam today (capacity 0: not in service yet, or silted full) has none to pump into, so a
	// dam-target unit pumps straight to the crop or user that day, as on a node without a dam (§2.7d, §2.7g).
	const noDam = !(cap > 0);
	let dep = 0;
	let gLeft = gRoom;
	const take = (k: number, v: number) => {
		pumped[k]![t] = v;
		used[k]! += v;
		dep += units[k]!.depletionFrac * v;
		gLeft -= v;
	};
	let g = 0;
	for (let k = 0; k < units.length; k++) {
		const u = units[k]!;
		if ((u.toDam && !noDam) || u.mode !== 1) continue;
		const v = Math.max(0, Math.min(unitRoom(u, used[k]!), D - g, gLeft));
		take(k, v);
		g += v;
	}
	let gd = 0;
	// The demand a dam-target unit pumps for: what the primary units and the river pump (river first) leave, within the surface cap.
	const rem = river > 0 && rule !== 3 ? Math.min(D - g, sRoom) - Math.min(river, D - g, sRoom) : Math.min(D - g, sRoom);
	// Primary and emergency dam-target units top the dam up only on a day it is drawn for demand (engine ≥ 1.8.0).
	const drawn = damDrawnFor(rem, dayD);
	// A supplemental unit that pumped all it was asked for left the dam holding exactly `rem` above dead storage.
	let topped = false;
	for (let k = 0; k < units.length; k++) {
		const u = units[k]!;
		if (!u.toDam || noDam) continue;
		const head = cap - (avail + gd);
		const want = u.mode === 1 ? (drawn ? head : 0) : u.mode === 2 ? (drawn && qPrev < u.triggerM3 ? head : 0) : rem - (avail + gd - dead);
		const v = Math.max(0, Math.min(unitRoom(u, used[k]!), want, head, gLeft));
		take(k, v);
		gd += v;
		if (u.mode === 0 && v > 0 && v === want) topped = true;
	}
	// In floats (avail + gd) − dead gives `rem` back only to an ulp of the dam's volume, and a day it
	// fell that ulp short counted as a failed demand day (fuzz seed 11421: 1e-10 m³ of a 0.011 m³
	// demand beside a 1.4e6 m³ dam), so the dam supplies `rem` itself.
	const damAvail = topped ? Math.max(avail + gd - dead, rem, 0) : Math.max(avail + gd - dead, 0);
	let Gs: number;
	let Gr = 0;
	if (river > 0) [Gs, Gr] = surfaceSplit(rule, Math.min(D - g, sRoom), damAvail, river);
	else Gs = Math.min(damAvail, D - g, sRoom);
	for (const pass of [0, 2] as const) {
		for (let k = 0; k < units.length; k++) {
			const u = units[k]!;
			if ((u.toDam && !noDam) || u.mode !== pass || (pass === 2 && !(qPrev < u.triggerM3))) continue;
			const v = Math.max(0, Math.min(unitRoom(u, used[k]!), D - Gs - g - Gr, gLeft));
			take(k, v);
			g += v;
		}
	}
	return [Gs, g, gd, dep, Gr];
}

/**
 * The first day of the 12 consecutive calendar months that end on epoch day
 * `e`: the day after the same date a year earlier (29 February → the 28th, so
 * the window is still 12 months). GN 538's "year" is any such period.
 */
export function twelveMonthsStart(e: number): number {
	const d = new Date(e * 86_400_000);
	const y = d.getUTCFullYear() - 1;
	const m = d.getUTCMonth();
	const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
	return Math.round(Date.UTC(y, m, Math.min(d.getUTCDate(), last)) / 86_400_000) + 1;
}

/**
 * RunSummary.groundwaterAnnualUse (WP-3.9): per node with boreholes, in node-id
 * order, and per water year the run touches, what was pumped (to the crop and
 * into the dam), the stream depletion taken, each unit's volume against its
 * annual cap, and the GN 538 volume for context: the property's own (area ×
 * Table 2 rate, capped at 40 000 m³/a) when the node carries both, else the
 * ceiling (engine ≥ 1.12.0). Also the most pumped in any 12 consecutive months
 * ending in the year, GN 538's "year". `start` is the run's first epoch day.
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
		const ga = ga538VolumeM3(n);
		// Running total of everything pumped, for the 12-month windows.
		const cum = new Float64Array(plan.days + 1);
		for (let t = 0; t < plan.days; t++) cum[t + 1] = cum[t]! + r.groundwater[t]! + r.groundwaterToDam[t]!;
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
					gaLimitM3: ga.limitM3,
					gaBasis: ga.basis,
					rolling12MaxM3: null,
					boreholes: b.units.map((u) => ({ id: u.id, name: u.name, abstractionM3: 0, annualCapM3: Number.isFinite(u.annualCapM3) ? u.annualCapM3 : null, capReached: false }))
				};
				out.push(row);
			}
			row.days++;
			row.abstractionM3 += r.groundwater[t]! + r.groundwaterToDam[t]!;
			row.toDamM3 += r.groundwaterToDam[t]!;
			row.streamDepletionM3 += r.depletion[t]!;
			const from = twelveMonthsStart(start + t) - start;
			if (from >= 0) {
				const v = cum[t + 1]! - cum[from]!;
				if (row.rolling12MaxM3 == null || v > row.rolling12MaxM3) row.rolling12MaxM3 = v;
			}
			for (let k = 0; k < b.units.length; k++) row.boreholes[k]!.abstractionM3 += r.boreholePumped![k]![t]!;
		}
	}
	// A cap counts as reached when the year's volume is within float noise of it.
	for (const row of out) for (const u of row.boreholes) if (u.annualCapM3 !== null) u.capReached = u.abstractionM3 >= u.annualCapM3 * (1 - 1e-9);
	return out;
}

/**
 * Run warnings about the GN 538 context (engine ≥ 1.12.0, docs/model.md §2.7d)
 * for the nodes that pump: those without a property area and Table 2 rate
 * (their tables show the 40 000 m³/a ceiling only), and pumping units whose
 * stream depletion share (≥ GA538_ALLUVIAL_DEPLETION_FRAC) suggests an
 * alluvial aquifer connected to the stream, which GN 538 counts as surface
 * water. The app has no borehole locations, so the GA's 100 m-from-a-
 * watercourse exclusion can't be checked; docs only.
 */
export function ga538Warnings(nodes: readonly NetworkNode[], plan: { nodes: readonly { borehole?: PlanBorehole }[] }): string[] {
	const out: string[] = [];
	const unknown: string[] = [];
	const alluvial: string[] = [];
	// In node-id order, so the text doesn't depend on the order the nodes are listed in.
	const idx = nodes.map((_, i) => i).sort((a, b) => cmpStr(nodes[a]!.id, nodes[b]!.id));
	for (const i of idx) {
		const b = plan.nodes[i]?.borehole;
		if (!b) continue;
		const n = nodes[i]!;
		if (ga538VolumeM3(n).basis === 'ceiling') unknown.push(n.name);
		for (const u of b.units) if (u.depletionFrac >= GA538_ALLUVIAL_DEPLETION_FRAC) alluvial.push(`${n.name}: ${u.name}`);
	}
	if (unknown.length)
		out.push(
			`GN 538 volume unknown for ${unknown.join('; ')}: no property area or Table 2 rate (or one not in the table), so the groundwater tables show the ${regroup(GA538_GROUNDWATER_LIMIT_M3_YEAR.toLocaleString('en-US'))} m³/a ceiling only, not the property's own volume (area × rate)`
		);
	if (alluvial.length)
		out.push(
			`boreholes with a stream depletion share of ${Math.round(GA538_ALLUVIAL_DEPLETION_FRAC * 100)} % or more (${alluvial.join('; ')}): if they draw on an alluvial aquifer connected to the stream, GN 538 counts that as surface water, and the groundwater general authorisation doesn't cover it`
		);
	return out;
}
