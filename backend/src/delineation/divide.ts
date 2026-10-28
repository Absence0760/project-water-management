// Dividing a model that already has nodes into sub-catchments from the map
// (#326 C3's follow-up; 182_divide_proposal.sql, docs/design/start-from-map.md
// § Dividing a model that has nodes, docs/api.md § Start from the map).
//
//   POST /projects/:id/map/divide                   propose each linked unit's area (its boundary's) and drains-into (the DEM's), against its current values (editor)
//   POST /projects/:id/map/divide/:spid/apply       take the ticked values (editor)
//
// The GET and discard are start.ts's (one table, one open proposal a project).
//
// Each feature on the map the editor names stands for a node of the model: a
// unit's own boundary (an area on the map) for its unit (start-16, #523 C1),
// a point for an other water user, a gauge for a gauge node, or, for a gauge
// point, a new gauge node. A dam or an abstraction point never divides: the
// unlinked ones inside a unit's boundary become parts of its composite dam and
// its river pump, linked to it on apply (their sizes stay the user's). The
// same routing as starting from the map (subcatchments.ts) proposes the order
// and checks each boundary's area; the proposal shows each beside the node's
// current area and order. Apply takes only the ticked values, and refuses
// (409) a value whose current one changed since the proposal: what the editor
// saw replaced is exactly what is replaced, never anything typed since.
import { oneLineName, type NetworkNode, type ProjectModel } from '@water-management/engine';
import { z } from 'zod';
import type { Db } from '../db/tx.js';
import { KIND_NODES, NODE_KIND_WORD, type Geometry, type Position } from '../geo/geojson.js';
import { recordAudit } from '../history/record.js';
import { ApiError } from '../http/errors.js';
import { loadModel } from '../model/store.js';
import { nameText } from '../model/validate.js';
import { supersedePlanRequests } from './planRequests.js';
import { PlacementChoice, placementOf, placementWarnings, type PointPlacement } from './pointPlacement.js';
import {
	BOUNDARY_MISMATCH,
	assignMembers,
	boundaryCheck,
	km2,
	restBesideBoundaries,
	REST_SHARE_WARN,
	restDrainsMatters,
	loadProposal,
	outletHints,
	pointOf,
	type PointChoices,
	START_POINTS_MAX,
	START_PROPOSALS_KEPT,
	toProposal,
	upstreamFirst,
	type DamShares,
	type UnitMember
} from './start.js';
import { panWarning, type PanReport } from './pans.js';
import { AreaBasis } from './areaBasis.js';
import type { DamPosition, SubcatchmentRequest, Subcatchments, UnitRole } from './subcatchments.js';

export const DivideBody = z
	.object({
		/** A gauge on the map at the outflow; absent or null = the boundary's own outlet. */
		outletFeatureId: z.string().uuid().nullable().optional(),
		/** The outlet gauge's larger channel chosen (pointPlacement.ts). */
		outletUseLarger: PlacementChoice.useLarger,
		points: z
			.array(
				z
					.object({
						featureId: z.string().uuid(),
						/** The node the point stands for; null = a new gauge node (a gauge point only). */
						nodeId: z.string().uuid().nullable(),
						...PlacementChoice
					})
					.strict()
			)
			.min(1)
			.max(START_POINTS_MAX)
			.refine((ps) => new Set(ps.map((p) => p.featureId)).size === ps.length, 'a point is listed twice')
			.refine((ps) => {
				const ids = ps.flatMap((p) => (p.nodeId ? [p.nodeId] : []));
				return new Set(ids).size === ids.length;
			}, 'two points stand for one hydrological unit')
	})
	.strict();

// A node's name, as the model schema takes one (one line, issue #385).
const Name = nameText(1, 100);
export const DivideApplyBody = z
	.object({
		units: z
			.array(
				z
					.object({
						key: z.string().uuid(),
						/** Take the proposed area (its own piece, saved as the node's parcel). */
						area: z.boolean(),
						/** With `area`: its gross area (the default) or its effective one, without what drains into pans (195, areaBasis.ts). */
						areaBasis: AreaBasis.optional(),
						/** Take the proposed drains-into. */
						drainsInto: z.boolean(),
						/** Before start-16, a dam unit's runoff to its dam; never proposed now (the composite dam's shares are the user's): false. */
						runoffToDam: z.boolean(),
						/** A dam marked on or off the river (194): take its Upstream inflow to dam (damShares.pctUpstreamToDam). */
						upstreamToDam: z.boolean().optional(),
						/** A new gauge: add it to the model (its other values need it). */
						add: z.boolean(),
						/** A new gauge's name. */
						name: Name.optional()
					})
					.strict()
			)
			.max(START_POINTS_MAX),
		/** The rest of the catchment's area: not taken, given to a unit already in the model, or a new unit. */
		rest: z.discriminatedUnion('to', [
			z.object({ to: z.literal('none') }).strict(),
			z.object({ to: z.literal('node'), nodeId: z.string().uuid(), areaBasis: AreaBasis.optional() }).strict(),
			z
				.object({
					to: z.literal('new'),
					name: Name,
					areaBasis: AreaBasis.optional(),
					/** Take the proposed drains-into (start-17, F10); absent or unticked, the new unit drains into the outflow. */
					drainsInto: z.boolean().optional()
				})
				.strict()
		])
	})
	.strict();

type Poly = Extract<Geometry, { type: 'Polygon' }>;
export type Polygonal = Extract<Geometry, { type: 'Polygon' | 'MultiPolygon' }>;

/** A node's values the proposal would replace, as they stood when proposed. */
export interface DivideCurrent {
	areaKm2: number;
	areaSource: 'typed' | 'map';
	downstreamNodeId: string | null;
	downstreamName: string | null;
	pctRunoffToDam: number;
	/** Absent on proposals before 194. */
	pctUpstreamToDam?: number;
}

export interface DivideUnit {
	/** The map feature's id. */
	key: string;
	featureName: string;
	/** The node it stands for; null = a new gauge node. */
	nodeId: string | null;
	/** The node's name (a new gauge's proposed one). */
	name: string;
	role: UnitRole;
	point: Position;
	snapDistanceM: number | null;
	/** Its own area (m²) and outline: a unit's boundary's (start-16; before, its piece's); null for a water user or a gauge (they own no land). */
	areaM2: number | null;
	totalAreaM2: number | null;
	geometry: Poly | Polygonal | null;
	/** A unit (start-16): what drains to its boundary's outflow and to no unit above it (m²), the check on its area. */
	demAreaM2?: number | null;
	/** A unit (start-16): the unlinked dams (its composite dam) and abstraction points (its river pump) inside its boundary, linked to it on apply. */
	members?: UnitMember[];
	/** The point it drains into (its key), or null for the outflow. */
	drainsInto: string | null;
	/** The node's values now (null for a new gauge). */
	current: DivideCurrent | null;
	/** How its point was put on the channel (start-7). */
	placement: PointPlacement;
	/** Of its own area and of its whole catchment, what drains into pans (m²; pans.ts, start-11): reported, not taken out. Absent without a DEM or before start-11. */
	nonContributingM2?: number;
	totalNonContributingM2?: number;
	/** A dam marked on or off the river (194): the dam's shares it proposes (start.ts damSharesOf). */
	damShares?: DamShares;
}

export interface DividePlan {
	mode: 'divide';
	outlet: { featureId: string | null; nodeId: string; name: string; point: Position; snapDistanceM: number | null; foundIn: 'gauge' | 'delineation' | 'boundary'; placement: PointPlacement };
	catchment: { areaM2: number; boundaryAreaM2: number | null };
	units: DivideUnit[];
	/** What drains to the outflow through no point; beside units' boundaries (start-16), the catchment less them, with no outline. */
	rest: {
		areaM2: number;
		geometry: Polygonal | null;
		nonContributingM2?: number;
		/** Beside units' boundaries (start-17, F10): the point (its key) the rest drains into, the first its flow path meets, or null for the outflow. */
		drainsInto?: string | null;
		/** Whether drainsInto is proposed (a point's key), to tick for a new unit; absent, the outflow. */
		drainsIntoProposed?: boolean;
	};
	/** The catchment's pans (pans.ts, start-11): what of it drains into one, the largest, the method. Absent without a DEM or before start-11. */
	pans?: PanReport;
	/**
	 * Units of the model with no point in the division: they keep their values,
	 * and are the ones the rest of the catchment may go to (their area when
	 * proposed, which apply checks before replacing it).
	 */
	untouched: { nodeId: string; name: string; areaKm2: number }[];
	/** `placement`: how its point was put on the channel (start-7). */
	dropped: { featureId: string; name: string; reason: string; placement?: PointPlacement }[];
	warnings: string[];
	cellSizeM: number;
	zoom: number;
	windowCells: number;
}

export interface DivideDecision {
	/** `areaBasis`: which area was taken (195), with `area`; absent on a decision before 195 (gross, the only choice then). */
	/** `boundaryId`: a unit's own boundary, linked to it as its area (start-16; never a parcel a later division may redraw). */
	units: { key: string; nodeId: string | null; area: boolean; areaBasis?: AreaBasis; drainsInto: boolean; runoffToDam: boolean; upstreamToDam?: boolean; add: boolean; parcelId: string | null; boundaryId?: string | null }[];
	rest: { to: 'none' | 'node' | 'new'; areaBasis?: AreaBasis; drainsInto?: boolean; nodeId: string | null; parcelId: string | null };
	revisionId: string | null;
}

export const NOT_EMPTY_NEEDED = 'The model has no hydrological units yet: start it from the map instead, which makes them.';
export const NO_DEM = 'Dividing the model needs an elevation model on the server (DEM_URL), and this one has none: set the areas and the order on the Network, or one unit at a time with Delineate and Use this area.';
export const EPS_KM2 = 1e-9;

/** A feature's role from the node it stands for (start-16): a unit (its boundary), a water user or a gauge. */
export function roleOf(node: Pick<NetworkNode, 'kind'> | null): UnitRole {
	if (!node) return 'gauge';
	if (node.kind === 'user') return 'user';
	if (node.kind === 'gauge') return 'gauge';
	return 'unit';
}

/** The node every other drains to in the end: the one that drains nowhere. */
function outflowOf(model: ProjectModel): NetworkNode {
	const roots = model.nodes.filter((n) => n.downstreamNodeId === null);
	if (roots.length !== 1) throw new ApiError(400, 'The model needs exactly one outflow gauge (a hydrological unit that drains nowhere) before it can be divided; fix it on the Network.');
	return roots[0]!;
}

/** A loop in the drains-into, by names, or null. */
export function loopIn(nodes: readonly Pick<NetworkNode, 'id' | 'name' | 'downstreamNodeId'>[]): string[] | null {
	const by = new Map(nodes.map((n) => [n.id, n]));
	for (const start of nodes) {
		const path: (typeof nodes)[number][] = [];
		for (let n: (typeof nodes)[number] | undefined = start; n; n = n.downstreamNodeId ? by.get(n.downstreamNodeId) : undefined) {
			const at = path.indexOf(n);
			if (at >= 0) return [...path.slice(at), n].map((x) => x.name);
			path.push(n);
		}
	}
	return null;
}

export interface DivideInputs {
	boundary: { id: string; geometry: Polygonal; areaM2: number } | null;
	outlet: { featureId: string | null; point: Position | null; foundIn: DividePlan['outlet']['foundIn'] };
	outflow: NetworkNode;
	model: ProjectModel;
	areaSource: Map<string, 'typed' | 'map'>;
	points: { featureId: string; featureKind: string; name: string; node: NetworkNode | null; geometry: Geometry; damPosition: DamPosition | null; areaM2: number | null }[];
	/** The dams and abstraction points (other points) linked to no node: parts of the unit whose boundary holds them (start-16). */
	members: { featureId: string; name: string; role: 'dam' | 'abstraction'; geometry: Geometry }[];
}

export async function readDivideInputs(db: Db, projectId: string, body: z.infer<typeof DivideBody>): Promise<DivideInputs> {
	const model = await loadModel(db, projectId);
	if (!model.nodes.length) throw new ApiError(409, NOT_EMPTY_NEEDED);
	const outflow = outflowOf(model);
	const nodes = new Map(model.nodes.map((n) => [n.id, n]));
	const { rows: src } = await db.query<{ id: string; area_source: 'typed' | 'map' }>('SELECT id, area_source FROM node WHERE project_id = $1', [projectId]);
	const { rows: b } = await db.query<{ id: string; geometry: Polygonal; area_m2: number }>(
		`SELECT id, geometry, area_m2 FROM map_feature WHERE project_id = $1 AND kind = 'catchment_boundary' ORDER BY created_at LIMIT 1`,
		[projectId]
	);
	const boundary = b[0] ? { id: b[0].id, geometry: b[0].geometry, areaM2: b[0].area_m2 } : null;
	const ids = [...body.points.map((p) => p.featureId), ...(body.outletFeatureId ? [body.outletFeatureId] : [])];
	const { rows: fs } = await db.query<{ id: string; kind: string; name: string; geometry: Geometry; node_id: string | null; dam_position: DamPosition | null; area_m2: number | null }>(
		'SELECT id, kind, name, geometry, node_id, dam_position, area_m2 FROM map_feature WHERE project_id = $1 AND id = ANY($2::uuid[])',
		[projectId, ids]
	);
	const byId = new Map(fs.map((f) => [f.id, f]));
	let outlet: DivideInputs['outlet'];
	if (body.outletFeatureId) {
		const f = byId.get(body.outletFeatureId);
		if (!f) throw new ApiError(400, 'The outlet gauge is not on this catchment’s map.');
		if (f.kind !== 'gauge' || f.geometry.type !== 'Point') throw new ApiError(400, 'The outlet must be a gauge point on the map.');
		if (body.points.some((p) => p.featureId === f.id)) throw new ApiError(400, 'The outlet gauge can’t also be one of the points.');
		if (f.node_id && f.node_id !== outflow.id) throw new ApiError(400, `“${f.name || 'That gauge'}” stands for ${nodes.get(f.node_id)?.name ?? 'another hydrological unit'}, not the outflow (${outflow.name}).`);
		outlet = { featureId: f.id, point: f.geometry.coordinates, foundIn: 'gauge' };
	} else {
		if (!boundary) throw new ApiError(400, 'Put the catchment boundary on the map first (draw, delineate or upload it), or pick the outlet gauge.');
		const { rows: d } = await db.query<{ outlet_lon: number; outlet_lat: number }>(
			`SELECT outlet_lon, outlet_lat FROM delineation_proposal WHERE project_id = $1 AND feature_id = $2 AND status = 'accepted' ORDER BY decided_at DESC LIMIT 1`,
			[projectId, boundary.id]
		);
		outlet = d[0] ? { featureId: null, point: [d[0].outlet_lon, d[0].outlet_lat], foundIn: 'delineation' } : { featureId: null, point: null, foundIn: 'boundary' };
	}
	let gauges = 0;
	const points = body.points.map((p) => {
		const f = byId.get(p.featureId);
		if (!f) throw new ApiError(400, 'A point is not on this catchment’s map (deleted since?). Reload the map and propose again.');
		const label = `“${f.name || 'A feature'}”`;
		const polygon = f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon';
		if (p.nodeId === null) {
			if (f.kind !== 'gauge' || f.geometry.type !== 'Point') throw new ApiError(400, `${label} is not a gauge point, so it can’t be a new gauge.`);
			if (f.node_id) throw new ApiError(400, `${label} stands for ${nodes.get(f.node_id)?.name ?? 'a hydrological unit'} already.`);
			return { featureId: f.id, featureKind: f.kind, name: oneLineName(f.name) || `Gauge ${++gauges}`, node: null, geometry: f.geometry, damPosition: f.dam_position, areaM2: null };
		}
		const n = nodes.get(p.nodeId);
		if (!n) throw new ApiError(400, `${label} is matched to a hydrological unit that isn’t in the model (deleted since?). Reload and propose again.`);
		if (n.id === outflow.id) throw new ApiError(400, `${n.name} is the outflow: it is where the division ends, not one of its points.`);
		if (!(KIND_NODES[f.kind as keyof typeof KIND_NODES] ?? []).includes(n.kind)) throw new ApiError(400, `${label} can’t stand for ${n.name} (${NODE_KIND_WORD[n.kind] ?? `a ${n.kind}`}).`);
		if (n.kind === 'farm') {
			// A unit is its own boundary (start-16): its dams and abstraction points are parts of it, never where it ends.
			if (!polygon || !(f.kind === 'other' || f.kind === 'farm_parcel')) {
				throw new ApiError(400, `${label} is ${f.kind === 'dam' ? 'a dam' : 'a point'}: a dam or an abstraction point is part of its unit (its composite dam or its river pump), not where the unit ends. Pick ${n.name}’s boundary, an area on the map, instead.`);
			}
		} else if (!(f.geometry.type === 'Point' || (polygon && f.kind === 'dam'))) throw new ApiError(400, `${label} is not a point or a dam, so it can’t stand for ${n.name}.`);
		if (f.node_id && f.node_id !== n.id) throw new ApiError(400, `${label} stands for ${nodes.get(f.node_id)?.name ?? 'another hydrological unit'} on the map, not ${n.name}.`);
		return { featureId: f.id, featureKind: f.kind, name: f.name, node: n, geometry: f.geometry, damPosition: f.dam_position, areaM2: f.area_m2 };
	});
	// The dams and abstraction points no node has yet: each becomes part of the unit whose boundary holds it (start-16).
	const { rows: ms } = await db.query<{ id: string; kind: string; name: string; geometry: Geometry }>(
		`SELECT id, kind, name, geometry FROM map_feature WHERE project_id = $1 AND node_id IS NULL AND (kind = 'dam' OR (kind = 'other' AND geometry ->> 'type' = 'Point')) AND NOT (id = ANY($2::uuid[])) ORDER BY created_at, id`,
		[projectId, ids]
	);
	const members = ms
		.filter((m) => m.geometry.type !== 'LineString' && m.geometry.type !== 'MultiLineString')
		.map((m) => ({ featureId: m.id, name: oneLineName(m.name) || (m.kind === 'dam' ? 'A dam' : 'A point'), role: m.kind === 'dam' ? ('dam' as const) : ('abstraction' as const), geometry: m.geometry }));
	// The units first, so a gauge at a unit's outflow drains below it (subcatchments.ts).
	const ordered = [...points.filter((p) => p.node?.kind === 'farm'), ...points.filter((p) => p.node?.kind !== 'farm')];
	return { boundary, outlet, outflow, model, areaSource: new Map(src.map((r) => [r.id, r.area_source])), points: ordered, members };
}

/**
 * The division from the routing (the route's, and the worker's plan job's, jobs/handlers/delineate-plan.ts): each unit's area its
 * boundary's beside its node's current values, the order and the checks from the DEM, the unlinked dams and abstraction points
 * to the units holding them, and the rest of the catchment, drained where its flow path meets a unit first (start-17, F10). Pure.
 */
export function dividePlanFrom(inputs: DivideInputs, r: Subcatchments): DividePlan {
	const named = new Map(inputs.points.map((p) => [p.featureId, p]));
	const nodes = new Map(inputs.model.nodes.map((n) => [n.id, n]));
	const warnings: string[] = [];
	const outletPlacement = placementOf(r.outlet);
	// The outlet's placement first: every point is placed against it.
	if (inputs.outlet.point) warnings.push(...placementWarnings(inputs.outflow.name, inputs.outlet.point, outletPlacement, true));
	if (inputs.boundary && Math.abs(r.catchment.areaM2 / inputs.boundary.areaM2 - 1) > BOUNDARY_MISMATCH) {
		warnings.push(
			`The catchment above the outlet is ${km2(r.catchment.areaM2)} on the elevation model, but the boundary on the map is ${km2(inputs.boundary.areaM2)}. Each unit’s area is its own boundary’s, and the elevation model orders and checks them: check the outlet and the boundary.`
		);
	}
	const units: DivideUnit[] = r.units.map((u) => {
		const p = named.get(u.id)!;
		const n = p.node;
		// A unit's area and outline are its boundary's (start-16); the DEM's piece only checks it.
		const bounded = u.role === 'unit' && (p.geometry.type === 'Polygon' || p.geometry.type === 'MultiPolygon');
		return {
			key: u.id,
			featureName: p.name,
			nodeId: n?.id ?? null,
			name: n?.name ?? p.name,
			role: u.role,
			point: u.point,
			snapDistanceM: u.snapDistanceM,
			areaM2: bounded ? p.areaM2 : null,
			totalAreaM2: u.role === 'user' ? null : u.totalAreaM2,
			geometry: bounded ? (p.geometry as Polygonal) : null,
			...(u.role === 'unit' ? { demAreaM2: u.areaM2 } : {}),
			drainsInto: u.drainsInto,
			current: n
				? {
						areaKm2: n.areaKm2,
						areaSource: inputs.areaSource.get(n.id) ?? 'typed',
						downstreamNodeId: n.downstreamNodeId,
						downstreamName: n.downstreamNodeId ? (nodes.get(n.downstreamNodeId)?.name ?? null) : null,
						pctRunoffToDam: n.pctRunoffToDam,
						pctUpstreamToDam: n.pctUpstreamToDam
					}
				: null,
			placement: placementOf(u),
			totalNonContributingM2: u.totalNonContributingM2
		};
	});
	// The unlinked dams and abstraction points to the units whose boundaries hold them (start-16); others stay as they are.
	const bounded = units.filter((u) => u.role === 'unit');
	const assigned = assignMembers(bounded, inputs.members, null);
	for (const u of bounded) u.members = assigned.byUnit.get(u.key)!;
	const dropped = r.dropped.map((d) => ({ featureId: d.id, name: named.get(d.id)!.name, reason: d.reason, ...(d.placedBy ? { placement: placementOf(d) } : {}) }));
	// A dropped point snapped beside its river: the larger channel is how to bring it in.
	for (const d of dropped) if (d.placement?.larger) warnings.push(...placementWarnings(d.name || 'A point', pointOf(named.get(d.featureId)!.geometry), d.placement));
	for (const u of units) {
		if (u.role !== 'unit') warnings.push(...placementWarnings(u.name, pointOf(named.get(u.key)!.geometry), u.placement));
		const check = u.role === 'unit' ? boundaryCheck(u.name, u.areaM2, u.demAreaM2) : null;
		if (check) warnings.push(check);
	}
	const restBeside = bounded.length ? restBesideBoundaries(inputs.boundary?.areaM2 ?? r.catchment.areaM2, bounded.map((u) => u.areaM2 ?? 0)) : null;
	if (restBeside?.warning) warnings.push(restBeside.warning);
	if (restBeside && r.restDrains && r.restDrains.share < REST_SHARE_WARN && restDrainsMatters(r.restDrains, r.catchment.areaM2)) {
		const to = r.restDrains.into ? (units.find((u) => u.key === r.restDrains!.into)?.name ?? 'a unit') : inputs.outflow.name;
		warnings.push(
			`Of the rest of the catchment (${km2(r.restDrains.areaM2)} on the elevation model), ${Math.round(r.restDrains.share * 100)} % drains into ${to}, as proposed; the rest of it reaches other units first. Check where it drains on the Network, or draw its parts as units’ boundaries.`
		);
	}
	const inDivision = new Set(units.flatMap((u) => (u.nodeId ? [u.nodeId] : [])));
	const untouched = inputs.model.nodes.filter((n) => n.kind === 'farm' && !inDivision.has(n.id)).map((n) => ({ nodeId: n.id, name: n.name, areaKm2: n.areaKm2 }));
	const panSentence = panWarning(r.pans, r.catchment.areaM2, [
		...r.units.map((u) => ({ name: named.get(u.id)!.node?.name ?? named.get(u.id)!.name, ncM2: u.nonContributingM2 ?? 0 })),
		{ name: 'the rest of the catchment', ncM2: r.rest.nonContributingM2 }
	], !bounded.length);
	if (panSentence) warnings.push(panSentence);
	const plan: DividePlan = {
		mode: 'divide',
		outlet: { featureId: inputs.outlet.featureId, nodeId: inputs.outflow.id, name: inputs.outflow.name, point: r.outlet.point, snapDistanceM: r.outlet.snapDistanceM, foundIn: inputs.outlet.foundIn, placement: outletPlacement },
		catchment: { areaM2: r.catchment.areaM2, boundaryAreaM2: inputs.boundary?.areaM2 ?? null },
		units: upstreamFirst(units),
		rest: restBeside ? { areaM2: restBeside.areaM2 ?? 0, geometry: null, drainsInto: r.restDrains?.into ?? null, drainsIntoProposed: !!r.restDrains?.into } : { areaM2: r.rest.areaM2, geometry: r.rest.geometry, nonContributingM2: r.rest.nonContributingM2 },
		pans: r.pans,
		untouched,
		dropped,
		warnings,
		cellSizeM: r.cellSizeM,
		zoom: r.zoom,
		windowCells: r.windowCells
	};
	return plan;
}

/** The routing request for a division (the route's and the plan job's). */
export function divideRouting(inputs: DivideInputs, placing: PointChoices): SubcatchmentRequest {
	return {
		outlet: inputs.outlet.point,
		outletHints: outletHints(inputs.outlet.foundIn, placing),
		outletMappedKm2: placing.outletMappedKm2,
		boundary: inputs.boundary?.geometry ?? null,
		points: inputs.points.map((p) => ({ id: p.featureId, role: roleOf(p.node), geometry: p.geometry, damPosition: p.damPosition, ...placing.hints.get(p.featureId) }))
	};
}

/**
 * Store a division (the open proposal superseded), prune the old ones and audit it, as the transaction's user (an editor).
 * `background`: the worker's plan job made it.
 */
export async function storeDivideProposal(db: Db, projectId: string, plan: DividePlan, r: Pick<Subcatchments, 'dataset' | 'method' | 'methodVersion'>, background = false, requestId: string | null = null) {
	// A plan still with the worker gives way to this one (but the job's own request, `requestId`).
	await supersedePlanRequests(db, projectId, requestId);
	await db.query(`UPDATE start_proposal SET status = 'superseded' WHERE project_id = $1 AND status = 'proposed'`, [projectId]);
	const { rows } = await db
		.query<{ id: string }>(
			`INSERT INTO start_proposal (project_id, mode, plan, from_dem, dataset, dataset_fingerprint, method, method_version, created_by)
			 VALUES ($1, 'divide', $2, true, $3, $4, $5, $6, app_current_user_id()) RETURNING id`,
			[projectId, JSON.stringify(plan), r.dataset.label, r.dataset.fingerprint, r.method, r.methodVersion]
		)
		.catch((err: unknown) => {
			if ((err as { constraint?: string }).constraint === 'start_proposal_one_open_idx') {
				throw new ApiError(409, 'Another proposal for this catchment finished at the same moment; look at it, or propose again.');
			}
			throw err;
		});
	await db.query(
		`DELETE FROM start_proposal WHERE project_id = $1 AND status IN ('superseded', 'discarded') AND id NOT IN (
			SELECT id FROM start_proposal WHERE project_id = $1 AND status IN ('superseded', 'discarded') ORDER BY created_at DESC, id LIMIT $2)`,
		[projectId, START_PROPOSALS_KEPT]
	);
	const proposal = toProposal(await loadProposal<DividePlan, DivideDecision>(db, projectId, rows[0]!.id));
	await recordAudit(db, projectId, 'map.divide_proposed', {
		proposalId: proposal.id,
		units: plan.units.length,
		dropped: plan.dropped.length,
		dataset: r.dataset.label,
		methodVersion: r.methodVersion,
		...(background ? { background: true } : {})
	});
	return proposal;
}
