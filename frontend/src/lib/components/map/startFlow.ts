// Start a model from the map (issue #326 C3, docs/design/start-from-map.md,
// docs/ui.md § Map): the pure parts of the Map's Start sheet. Which step the
// sheet is at (read from the server's state, never kept in the sheet), which
// features can be in the model and what each is by default, the ticks (every
// value unticked until the editor ticks it), and the body apply sends. The
// units are the user's own boundaries (start-16, #523 C1): a dam or an
// abstraction point is part of the unit whose boundary holds it (its
// composite dam, its river pump), never a unit of its own.
import type { DivideProposal, MapFeature, StartPlan, StartProposal, StartRole, StartState, StartTicks, StartUnit } from '#lib/api/index.js';
import { fmtNum } from '#lib/format/number.js';
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
	/** The larger channels taken, by point ('' the outlet gauge): sent with every proposal (placement.ts). */
	placement: PlacementChoices;
}

/** A point's choice in the points step: one of the roles, or not in the model. */
export type PointChoice = StartRole | 'none';

export const ROLE_LABEL: Record<PointChoice, string> = {
	unit: 'A hydrological unit (this is its boundary)',
	dam: 'Part of its unit’s composite dam',
	abstraction: 'Its unit’s river pump',
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

const isArea = (f: MapFeature) => f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon';
/** An area on the map that can be a unit's boundary (start-16): an other area or a parcel. */
export const isUnitBoundary = (f: MapFeature): boolean => (f.kind === 'other' || f.kind === 'farm_parcel') && isArea(f);

/** Features that can be in the model: units' boundaries (other areas, parcels), dams (a point or a polygon), and gauge and other points. */
export function candidatePoints(features: readonly MapFeature[]): MapFeature[] {
	return features.filter((f) => isUnitBoundary(f) || (f.kind === 'dam' && f.geometry.type !== 'LineString' && f.geometry.type !== 'MultiLineString') || ((f.kind === 'other' || f.kind === 'gauge') && f.geometry.type === 'Point'));
}

/**
 * A feature's default: an area is a unit's boundary, a dam part of its
 * unit's composite dam, an other point its unit's river pump, a gauge a gauge
 * node in the network (the outlet's is the outlet: proposeBody leaves it
 * out). A gauge that doesn't drain to the outlet is dropped by the server,
 * saying so.
 */
export const defaultChoice = (f: MapFeature): PointChoice => (isUnitBoundary(f) ? 'unit' : f.kind === 'dam' ? 'dam' : f.kind === 'other' ? 'abstraction' : 'gauge');

/** The choices a feature offers: an area is a unit or nothing; a gauge node only for a gauge (a gauge node stands for a gauge on the map). */
export function choicesFor(f: MapFeature): PointChoice[] {
	if (isUnitBoundary(f)) return ['unit', 'none'];
	if (f.kind === 'gauge') return ['gauge', 'none'];
	return f.kind === 'dam' ? ['dam', 'user', 'none'] : ['abstraction', 'user', 'none'];
}

/** What the choices make: units (boundaries), gauges, other water users, and the dams and pumps that are parts of units. */
export function choiceCounts(choices: readonly PointChoice[]): { units: number; gauges: number; users: number; parts: number } {
	const n = (c: PointChoice) => choices.filter((x) => x === c).length;
	return { units: n('unit'), gauges: n('gauge'), users: n('user'), parts: n('dam') + n('abstraction') };
}

/** The points step's count line. */
export function countText(choices: readonly PointChoice[]): string {
	const { units, gauges, users, parts } = choiceCounts(choices);
	const s = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
	const head = units === 0 ? 'No units’ boundaries: the catchment becomes one unit' : s(units, 'unit');
	const order = [...(gauges ? [s(gauges, 'gauge')] : []), ...(users ? [s(users, 'other water user')] : [])];
	const tail = parts === 1 ? '; 1 dam or pump as part of the unit around it' : parts ? `; ${parts} dams and pumps as parts of the units around them` : '';
	return `${head}${order.length ? `, ${order.join(' and ')}` : ''}${units ? ', plus the rest of the catchment' : ''}${tail}.`;
}

/** A stored plan from before start-16, which made a unit at each dam and abstraction point: it can't be applied, only proposed again. */
export const planBeforeBoundaries = (p: { units: readonly { role: StartRole }[] }): boolean => p.units.some((u) => u.role === 'dam' || u.role === 'abstraction');

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

/**
 * Which values of a unit were proposed (only those can be ticked). The composite dam's shares of runoff and of the upstream
 * inflow are never proposed (start-16): they are the user's to enter on the unit.
 */
export const unitOffers = (u: StartUnit) => ({
	area: u.areaM2 !== null && !!u.geometry,
	drainsInto: u.drainsIntoProposed
});
/** The rest's area: with an outline (saved as its parcel) or, beside units' boundaries, the catchment less them (start-16). */
export const restOffersArea = (p: StartPlan) => p.rest.areaM2 !== null;
/** The rest's drains-into, to tick: proposed from the routing beside units' boundaries (start-17), never the outflow gauge's default. */
export const restOffersDrainsInto = (p: StartPlan) => !!p.rest.drainsIntoProposed && !!p.rest.drainsInto;
/** The name of the unit the rest drains into, by the names as typed. */
export const restDrainsIntoName = (p: StartPlan, t: StartTicks): string =>
	t.units.find((x) => x.key === p.rest.drainsInto)?.name || p.units.find((x) => x.key === p.rest.drainsInto)?.name || 'a unit';

/** The ticks a proposal opens with: the proposed names, every value unticked (each is accepted explicitly). */
export function initialTicks(p: StartPlan): StartTicks {
	return {
		outletName: p.outlet.name,
		units: p.units.map((u) => ({ key: u.key, name: u.name, area: false, drainsInto: false, runoffToDam: false })),
		rest: { include: false, name: p.rest.name, area: false, drainsInto: false }
	};
}

/** Tick every value the plan proposes (Tick every value), names kept as typed. */
export function tickAll(p: StartPlan, t: StartTicks): StartTicks {
	const by = new Map(p.units.map((u) => [u.key, u]));
	return {
		outletName: t.outletName,
		units: t.units.map((x) => {
			const o = unitOffers(by.get(x.key)!);
			return { ...x, area: o.area, drainsInto: o.drainsInto, runoffToDam: false };
		}),
		rest: { ...t.rest, include: true, area: restOffersArea(p), drainsInto: restOffersDrainsInto(p) }
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
	const orders = t.units.filter((u) => u.drainsInto).length + (t.rest.include && t.rest.drainsInto ? 1 : 0);
	const effective = [...t.units.filter((u) => u.area && u.areaBasis === 'effective').map((u) => u.name.trim()), ...(t.rest.include && t.rest.area && t.rest.areaBasis === 'effective' ? [t.rest.name.trim()] : [])];
	const s = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
	return `The empty model gets ${s(nodes, 'hydrological unit')}, with ${s(areas, 'area')} (a unit’s is its boundary on the map${effective.length ? `; ${effective.join(', ')} without what drains into pans` : ''}) and ${s(orders, 'drains-into', 'drains-into')} from the proposal. Each unit’s dams and pump are linked to it, their sizes yours to enter. Everything not ticked stays to be typed: an area of 0, draining into the outflow gauge.`;
}

/** The body apply sends: an area's basis only with its area ticked (the server refuses an effective area not taken), else gross. */
export function applyTicks(t: StartTicks): StartTicks {
	const basis = (area: boolean, b: StartTicks['rest']['areaBasis']) => (area && b ? { areaBasis: b } : {});
	return {
		outletName: t.outletName,
		units: t.units.map(({ areaBasis, ...u }) => ({ ...u, ...basis(u.area, areaBasis) })),
		rest: (({ areaBasis, drainsInto, ...r }) => ({ ...r, ...basis(r.include && r.area, areaBasis), ...(r.include && drainsInto ? { drainsInto } : {}) }))(t.rest)
	};
}
