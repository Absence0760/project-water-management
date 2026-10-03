// Divide a model that has nodes from the map (#326 C3's follow-up,
// docs/design/start-from-map.md § Dividing a model that has nodes, docs/ui.md
// § Map): the pure parts of the Map's Divide sheet. What each point on the map
// can stand for (the model's nodes its kind may, or a new gauge), the ticks
// (every value unticked until the editor ticks it), the problems the server
// would refuse, and what apply will do.
import type { NetworkNode } from '@water-management/engine';
import type { DividePlan, DivideTicks, DivideUnit, MapFeature } from '$lib/api';
import { fmtNum } from '$lib/format/number';
import { KIND_NODES } from './mapData';
import { candidatePoints } from './startFlow';
import type { PlacementChoices } from './placement';

/** A point's choice: a node's id, a new gauge node, or not in the division. */
export type DivideChoice = string | 'new-gauge' | 'none';
export const NEW_GAUGE = 'new-gauge';
export const NONE = 'none';

/** What the editor chose and ticked, kept by the Map tab (as the Start sheet's draft): each point's node, the outlet, the ticks per proposal. */
export interface DivideDraft {
	picked: Record<string, DivideChoice>;
	outlet: string | null;
	ticks: Record<string, DivideTicks>;
	/** The rivers picked at confluences and the larger channels taken, by point ('' the outlet gauge): sent with every proposal (placement.ts). */
	placement: PlacementChoices;
}

/** The model's outflow: the node that drains nowhere (exactly one, or the model can't be divided). */
export function outflowOf(nodes: readonly Pick<NetworkNode, 'id' | 'downstreamNodeId'>[]): string | null {
	const roots = nodes.filter((n) => n.downstreamNodeId === null);
	return roots.length === 1 ? roots[0]!.id : null;
}

/** The nodes a point may stand for: those its kind may (map_feature's KIND_NODES), never the outflow. */
export function nodeOptions<N extends Pick<NetworkNode, 'id' | 'kind' | 'downstreamNodeId'>>(f: MapFeature, nodes: readonly N[]): N[] {
	const outflow = outflowOf(nodes);
	return nodes.filter((n) => n.id !== outflow && KIND_NODES[f.kind].includes(n.kind));
}

/** A point's default: the node it stands for on the map (if it may), else a new gauge for a gauge, else not in the division. */
export function defaultDivideChoice(f: MapFeature, nodes: readonly Pick<NetworkNode, 'id' | 'kind' | 'downstreamNodeId'>[]): DivideChoice {
	if (f.nodeId && nodeOptions(f, nodes).some((n) => n.id === f.nodeId)) return f.nodeId;
	return f.kind === 'gauge' && !f.nodeId && f.geometry.type === 'Point' ? NEW_GAUGE : NONE;
}

/** Points that can be in a division: the Start sheet's candidates. */
export const dividePoints = candidatePoints;

/** The propose body; the outlet gauge is never also a point. */
export function divideBody(choices: Record<string, DivideChoice>, outlet: string): { outletFeatureId: string | null; points: { featureId: string; nodeId: string | null }[] } {
	const points = Object.entries(choices)
		.filter(([id, c]) => c !== NONE && id !== outlet)
		.map(([featureId, c]) => ({ featureId, nodeId: c === NEW_GAUGE ? null : c }));
	return { outletFeatureId: outlet || null, points };
}

/** A node two points stand for (the server refuses it), by its id, or null. */
export function doubleNode(choices: Record<string, DivideChoice>, outlet: string): string | null {
	const seen = new Set<string>();
	for (const [id, c] of Object.entries(choices)) {
		if (c === NONE || c === NEW_GAUGE || id === outlet) continue;
		if (seen.has(c)) return c;
		seen.add(c);
	}
	return null;
}

/** Which values of a point were proposed, and so can be ticked. */
export const divideOffers = (u: DivideUnit) => ({
	add: u.nodeId === null,
	area: u.areaM2 !== null && !!u.geometry && u.role !== 'user' && u.role !== 'gauge',
	drainsInto: true,
	runoffToDam: u.role === 'dam',
	/** A dam marked on or off the river (194): its Upstream inflow to dam. */
	upstreamToDam: !!u.damShares
});

/** The ticks a division opens with: every value unticked, a new gauge named as its point. */
export function initialDivideTicks(p: DividePlan): DivideTicks {
	return {
		units: p.units.map((u) => ({ key: u.key, area: false, drainsInto: false, runoffToDam: false, ...(u.damShares ? { upstreamToDam: false } : {}), add: false, ...(u.nodeId ? {} : { name: u.name }) })),
		rest: { to: 'none' }
	};
}

/** Tick every value proposed (names kept as typed); the rest isn't given anywhere by it, that's a choice. */
export function tickAllDivide(p: DividePlan, t: DivideTicks): DivideTicks {
	const by = new Map(p.units.map((u) => [u.key, u]));
	return {
		units: t.units.map((x) => {
			const o = divideOffers(by.get(x.key)!);
			return { ...x, add: o.add, area: o.area, drainsInto: true, runoffToDam: o.runoffToDam, ...(o.upstreamToDam ? { upstreamToDam: true } : {}) };
		}),
		rest: t.rest
	};
}

/** The name of what a point drains into (by the names as typed for a new gauge). */
export function divideDrainsIntoName(p: DividePlan, t: DivideTicks, u: DivideUnit): string {
	if (!u.drainsInto) return p.outlet.name;
	const target = p.units.find((x) => x.key === u.drainsInto);
	if (!target) return 'a point';
	return (target.nodeId ? null : t.units.find((x) => x.key === target.key)?.name?.trim()) || target.name;
}

/** Whether a proposed value is what the node has already (ticking it changes nothing). */
export function sameAsNow(p: DividePlan, u: DivideUnit, what: 'area' | 'drainsInto' | 'runoffToDam' | 'upstreamToDam'): boolean {
	const c = u.current;
	if (!c) return false;
	if (what === 'area') return u.areaM2 !== null && Math.abs(c.areaKm2 - u.areaM2 / 1e6) < 0.0005;
	if (what === 'runoffToDam') return c.pctRunoffToDam === (u.damShares?.pctRunoffToDam ?? 1);
	if (what === 'upstreamToDam') return !!u.damShares && c.pctUpstreamToDam === u.damShares.pctUpstreamToDam;
	const target = u.drainsInto ? p.units.find((x) => x.key === u.drainsInto)?.nodeId : p.outlet.nodeId;
	return !!target && c.downstreamNodeId === target;
}

/** What the server would refuse, as one sentence, or null. */
export function divideProblem(p: DividePlan, t: DivideTicks, nodeNames: readonly string[]): string | null {
	const tick = new Map(t.units.map((x) => [x.key, x]));
	const names = new Set(nodeNames.map((n) => n.trim().toLowerCase()));
	for (const u of p.units) {
		const x = tick.get(u.key)!;
		if (!u.nodeId && x.add) {
			const n = x.name?.trim() ?? '';
			if (!n) return `Name the new gauge at “${u.featureName || 'its point'}”.`;
			if (names.has(n.toLowerCase())) return `Two nodes would be called “${n}”: give the new gauge a name of its own.`;
			names.add(n.toLowerCase());
		}
		if (!u.nodeId && !x.add && (x.drainsInto || x.area || x.runoffToDam || x.upstreamToDam)) return `${u.name} is a new gauge: tick Add it before taking its order.`;
		if (x.drainsInto && u.drainsInto) {
			const target = p.units.find((y) => y.key === u.drainsInto);
			if (target && !target.nodeId && !tick.get(target.key)?.add) return `${u.name} would drain into the new gauge ${tick.get(target.key)?.name?.trim() || target.name}, which isn’t being added: tick Add it too.`;
		}
	}
	if (t.rest.to === 'new') {
		const n = t.rest.name.trim();
		if (!n) return 'Name the new unit for the rest of the catchment.';
		if (names.has(n.toLowerCase())) return `Two nodes would be called “${n}”: give the rest of the catchment a name of its own.`;
	}
	return null;
}

/** What the confirm says will happen: counts of the ticked values. */
export function divideSummary(t: DivideTicks): string {
	const s = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
	const areas = t.units.filter((u) => u.area).length + (t.rest.to === 'none' ? 0 : 1);
	const orders = t.units.filter((u) => u.drainsInto).length;
	const runoff = t.units.filter((u) => u.runoffToDam).length;
	const upstream = t.units.filter((u) => u.upstreamToDam).length;
	const gauges = t.units.filter((u) => u.add).length;
	return `The model takes ${s(areas, 'area')} (each saved as its unit’s parcel), ${s(orders, 'drains-into', 'drains-into')} and ${s(runoff, 'runoff to the dam', 'runoffs to the dam')}${upstream ? `, ${s(upstream, 'upstream inflow to a dam', 'upstream inflows to dams')}` : ''}${gauges ? `, and ${s(gauges, 'new gauge')}` : ''}${t.rest.to === 'new' ? ', and a new unit for the rest of the catchment' : ''}. Every value not ticked stays as it is.`;
}

/** How far over the catchment the units may add up before the sheet says so: the pieces' own rounding stays under it. */
export const DIVIDE_OVERLAP_TOLERANCE = 0.01;

/**
 * The hydrological units' total area (km²) once the ticks are applied: each
 * point's own piece where its area is ticked (else its area now), every unit
 * no point stands for at its typed area (or the rest of the catchment when it
 * takes it), and a new unit for the rest. The pieces split the whole
 * catchment above the outlet, so a total past it is land counted twice
 * (persona-hydrologist, round 4).
 */
export function divideAreaAfterKm2(p: DividePlan, t: DivideTicks): number {
	const ticked = new Map(t.units.map((x) => [x.key, x]));
	let total = 0;
	for (const u of p.units) {
		if (u.areaM2 === null) continue;
		total += ticked.get(u.key)?.area ? u.areaM2 / 1e6 : (u.current?.areaKm2 ?? 0);
	}
	const rest = (p.rest.areaM2 ?? 0) / 1e6;
	for (const u of p.untouched) total += t.rest.to === 'node' && t.rest.nodeId === u.nodeId ? rest : u.areaKm2;
	if (t.rest.to === 'new') total += rest;
	return total;
}

/**
 * The sentence when the units would add up to more than the catchment above
 * the outlet, or null: what Apply would leave, or, with nothing taken yet,
 * what the model's typed areas already are. It names who keeps a typed area
 * bigger than the land the elevation model gives it: a point whose own area
 * isn't ticked, and a unit no point stands for (unless it takes the rest).
 */
export function divideOverlap(p: DividePlan, t: DivideTicks): string | null {
	const total = divideAreaAfterKm2(p, t);
	const catchment = p.catchment.areaM2 / 1e6;
	if (!(catchment > 0) || total <= catchment * (1 + DIVIDE_OVERLAP_TOLERANCE)) return null;
	const ticked = new Map(t.units.map((x) => [x.key, x]));
	const nothingTaken = t.rest.to === 'none' && !t.units.some((x) => x.area);
	const head = nothingTaken
		? `The model’s areas already add up to ${km2Now(total)}, more than the ${km2Now(catchment)} above the outlet, so some land counts twice and its runoff with it.`
		: `After Apply the units would add up to ${km2Now(total)}, more than the ${km2Now(catchment)} above the outlet, so some land would count twice and its runoff with it.`;
	const parts: string[] = [];
	const bigger = p.units.filter((u) => u.areaM2 !== null && !ticked.get(u.key)?.area && u.current && u.current.areaKm2 > (u.areaM2 / 1e6) * (1 + DIVIDE_OVERLAP_TOLERANCE));
	if (bigger.length) parts.push(`${bigger.map((u) => `${u.name} keeps its typed ${km2Now(u.current!.areaKm2)}`).join(', ')}: tick ${bigger.length === 1 ? 'its' : 'their'} area to take ${bigger.length === 1 ? 'its piece' : 'their pieces'}.`);
	const kept = p.untouched.filter((u) => u.areaKm2 > 0 && !(t.rest.to === 'node' && t.rest.nodeId === u.nodeId));
	if (kept.length) parts.push(`${kept.map((u) => u.name).join(', ')} ${kept.length === 1 ? 'keeps its' : 'keep their'} typed area: give ${kept.length === 1 ? 'it' : 'one'} the rest of the catchment or a point of its own, or check ${kept.length === 1 ? 'it' : 'them'}.`);
	return [head, ...parts].join(' ');
}

export const km2 = (m2: number | null): string => (m2 === null ? '–' : `${fmtNum(m2 / 1e6, 2)} km²`);
export const km2Now = (k: number): string => `${fmtNum(k, 2)} km²`;
