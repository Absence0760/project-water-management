// Start a model from the map (issue #326 C3, docs/design/start-from-map.md,
// docs/ui.md § Map): the pure parts of the Map's Start sheet. Which step the
// sheet is at (read from the server's state, never kept in the sheet), which
// features can be units and what each is by default, the ticks (every value
// unticked until the editor ticks it), and the body apply sends.
import type { DivideProposal, MapFeature, StartPlan, StartProposal, StartRole, StartState, StartTicks, StartUnit } from '$lib/api';
import { fmtNum } from '$lib/format/number';
import type { PlacementChoices } from './placement';

export type StartStep = 'boundary' | 'points' | 'review' | 'data' | 'closed';

/**
 * What the editor chose and ticked in the Start sheet, kept by the Map tab
 * (not the sheet) so closing the sheet, a reload of its data or a trip into
 * a tool (Place a point) loses nothing: each point's choice, the outlet
 * (null = the default), whether they went on to the points without a
 * boundary, and the ticks per proposal id.
 */
export interface StartDraft {
	picked: Record<string, PointChoice>;
	outlet: string | null;
	pointsAsked: boolean;
	ticks: Record<string, StartTicks>;
	/** The rivers picked at confluences and the larger channels taken, by point ('' the outlet gauge): sent with every proposal (placement.ts). */
	placement: PlacementChoices;
}

/** A point's choice in the points step: one of the roles, or not in the model. */
export type PointChoice = StartRole | 'none';

export const ROLE_LABEL: Record<PointChoice, string> = {
	dam: 'A unit with a dam',
	abstraction: 'A unit at an abstraction point',
	user: 'Another water user (no land)',
	gauge: 'A gauge in the network (no land)',
	none: 'Not in the model'
};

export const STEP_LABEL: Record<Exclude<StartStep, 'closed'>, string> = {
	boundary: 'The boundary',
	points: 'The points',
	review: 'The proposal',
	data: 'Data and the first run'
};

const isStart = (p: StartProposal | DivideProposal): p is StartProposal => p.mode === 'start';
const isDivide = (p: StartProposal | DivideProposal): p is DivideProposal => p.mode === 'divide';
/** The open start proposal, if any (the GET lists both modes, the newest first; at most one is open). */
export const openStart = (s: StartState | null): StartProposal | null => s?.proposals.filter(isStart).find((p) => p.status === 'proposed') ?? null;
/** The open division, if any. */
export const openDivide = (s: StartState | null): DivideProposal | null => s?.proposals.filter(isDivide).find((p) => p.status === 'proposed') ?? null;

/**
 * Where the sheet is. A model with nodes is past the flow: at its data step
 * when it was started from the map, else closed (the flow only starts an
 * empty model). An open proposal is reviewed. Otherwise the points, once
 * there is a boundary or a gauge to be the outlet (or the editor asked to go
 * on: `pointsAsked`), else the boundary.
 */
export function startStep(s: StartState | null, features: readonly MapFeature[], pointsAsked = false): StartStep {
	if (!s) return 'boundary';
	if (!s.modelEmpty) return s.startedFromMap ? 'data' : 'closed';
	if (openStart(s)) return 'review';
	const hasBoundary = features.some((f) => f.kind === 'catchment_boundary');
	return hasBoundary || pointsAsked ? 'points' : 'boundary';
}

/** Features that can be units: dams (a point or a polygon), and gauge and other points. */
export function candidatePoints(features: readonly MapFeature[]): MapFeature[] {
	return features.filter((f) => (f.kind === 'dam' && f.geometry.type !== 'LineString' && f.geometry.type !== 'MultiLineString') || ((f.kind === 'other' || f.kind === 'gauge') && f.geometry.type === 'Point'));
}

/**
 * A point's default: a dam is a dam unit, an other point an abstraction
 * point, a gauge a gauge node in the network (the outlet's is the outlet:
 * proposeBody leaves it out). A gauge that doesn't drain to the outlet is
 * dropped by the server, saying so.
 */
export const defaultChoice = (f: MapFeature): PointChoice => (f.kind === 'dam' ? 'dam' : f.kind === 'other' ? 'abstraction' : 'gauge');

/** The choices a point offers: a gauge node only for a gauge (a gauge node stands for a gauge on the map). */
export const choicesFor = (f: MapFeature): PointChoice[] => (f.kind === 'gauge' ? ['gauge', 'none'] : ['dam', 'abstraction', 'user', 'none']);

/** The gauges that may be the outlet (points only). */
export const outletGauges = (features: readonly MapFeature[]): MapFeature[] => features.filter((f) => f.kind === 'gauge' && f.geometry.type === 'Point');

/** The outlet by default: the boundary's own (''), or without a boundary the only gauge. */
export function defaultOutlet(features: readonly MapFeature[]): string {
	if (features.some((f) => f.kind === 'catchment_boundary')) return '';
	const g = outletGauges(features);
	return g.length === 1 ? g[0]!.id : '';
}

/** The propose body from the choices; the outlet gauge is never also a unit. */
export function proposeBody(choices: Record<string, PointChoice>, outlet: string): { outletFeatureId: string | null; points: { featureId: string; role: StartRole }[] } {
	const points = Object.entries(choices)
		.filter((e): e is [string, StartRole] => e[1] !== 'none' && e[0] !== outlet)
		.map(([featureId, role]) => ({ featureId, role }));
	return { outletFeatureId: outlet || null, points };
}

/** Which values of a unit were proposed (only those can be ticked). */
export const unitOffers = (u: StartUnit) => ({
	area: u.areaM2 !== null && !!u.geometry,
	drainsInto: u.drainsIntoProposed,
	runoffToDam: u.role === 'dam' && u.drainsIntoProposed,
	/** A dam marked on or off the river (194): its Upstream inflow to dam. */
	upstreamToDam: !!u.damShares
});
export const restOffersArea = (p: StartPlan) => p.rest.areaM2 !== null && !!p.rest.geometry;

/** The ticks a proposal opens with: the proposed names, every value unticked (each is accepted explicitly). */
export function initialTicks(p: StartPlan): StartTicks {
	return {
		outletName: p.outlet.name,
		units: p.units.map((u) => ({ key: u.key, name: u.name, area: false, drainsInto: false, runoffToDam: false, ...(u.damShares ? { upstreamToDam: false } : {}) })),
		rest: { include: false, name: p.rest.name, area: false }
	};
}

/** Tick every value the plan proposes (Tick every value), names kept as typed. */
export function tickAll(p: StartPlan, t: StartTicks): StartTicks {
	const by = new Map(p.units.map((u) => [u.key, u]));
	return {
		outletName: t.outletName,
		units: t.units.map((x) => {
			const o = unitOffers(by.get(x.key)!);
			return { ...x, area: o.area, drainsInto: o.drainsInto, runoffToDam: o.runoffToDam, ...(o.upstreamToDam ? { upstreamToDam: true } : {}) };
		}),
		rest: { ...t.rest, include: true, area: restOffersArea(p) }
	};
}

/** The name of what a unit drains into, by the names as typed. */
export function drainsIntoName(p: StartPlan, t: StartTicks, u: StartUnit): string {
	if (!u.drainsInto) return t.outletName || p.outlet.name;
	return t.units.find((x) => x.key === u.drainsInto)?.name || p.units.find((x) => x.key === u.drainsInto)?.name || 'a unit';
}

/** A name used twice (the server refuses it), or null. */
export function duplicateName(t: StartTicks): string | null {
	const seen = new Set<string>();
	for (const n of [t.outletName, ...t.units.map((u) => u.name), ...(t.rest.include ? [t.rest.name] : [])]) {
		const k = n.trim().toLowerCase();
		if (!k) continue;
		if (seen.has(k)) return n.trim();
		seen.add(k);
	}
	return null;
}

/** A name left empty, or null. */
export const emptyName = (t: StartTicks): boolean => [t.outletName, ...t.units.map((u) => u.name), ...(t.rest.include ? [t.rest.name] : [])].some((n) => !n.trim());

export const km2Text = (m2: number | null): string => (m2 === null ? '–' : `${fmtNum(m2 / 1e6, 2)} km²`);

/** What the confirm says will happen: counts of the ticked values, and which areas are effective (195). */
export function applySummary(t: StartTicks): string {
	const nodes = 1 + t.units.length + (t.rest.include ? 1 : 0);
	const areas = t.units.filter((u) => u.area).length + (t.rest.include && t.rest.area ? 1 : 0);
	const orders = t.units.filter((u) => u.drainsInto).length;
	const effective = [...t.units.filter((u) => u.area && u.areaBasis === 'effective').map((u) => u.name.trim()), ...(t.rest.include && t.rest.area && t.rest.areaBasis === 'effective' ? [t.rest.name.trim()] : [])];
	const s = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
	return `The empty model gets ${s(nodes, 'node')}, with ${s(areas, 'area')} (each saved as its unit’s parcel${effective.length ? `; ${effective.join(', ')} without what drains into pans` : ''}) and ${s(orders, 'drains-into', 'drains-into')} from the proposal. Everything not ticked stays to be typed: an area of 0, draining into the outflow gauge.`;
}

/** The body apply sends: an area's basis only with its area ticked (the server refuses an effective area not taken), else gross. */
export function applyTicks(t: StartTicks): StartTicks {
	const basis = (area: boolean, b: StartTicks['rest']['areaBasis']) => (area && b ? { areaBasis: b } : {});
	return {
		outletName: t.outletName,
		units: t.units.map(({ areaBasis, ...u }) => ({ ...u, ...basis(u.area, areaBasis) })),
		rest: (({ areaBasis, ...r }) => ({ ...r, ...basis(r.include && r.area, areaBasis) }))(t.rest)
	};
}
