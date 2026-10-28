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
import { oneLineName, newNetworkNode, type NetworkNode, type ProjectModel } from '@water-management/engine';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser, type Db } from '../db/tx.js';
import { panReferenceLoader } from './panReference.js';
import { featureNameOf, type Geometry, type Position } from '../geo/geojson.js';
import { KIND_NODES, NODE_KIND_WORD } from '../geo/routes.js';
import { beginModelChange, recordAudit, recordModelRevision } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { logEvent } from '../logging/logEvent.js';
import { beginDemAttempt, finishDemAttempt } from './attempt.js';
import { safeError } from '../logging/safeError.js';
import { loadModel, saveModel } from '../model/store.js';
import { ModelBody, modelProblems, nameText } from '../model/validate.js';
import { requireRole } from '../projects/access.js';
import { configuredDem } from './dem.js';
import { DelineationRefused } from './delineate.js';
import { wakeWorker } from '../jobs/wake.js';
import { queuePlan, supersedePlanRequests } from './planRequests.js';
import { delineationLimits, jobWindowsFrom, nextJobWindow } from './requests.js';
import { PlacementChoice, placementOf, placementWarnings, type PointPlacement } from './pointPlacement.js';
import {
	BEFORE_BOUNDARIES,
	BOUNDARY_MISMATCH,
	assignMembers,
	boundaryCheck,
	km2,
	linkMembers,
	madeBeforeBoundaries,
	restBesideBoundaries,
	REST_SHARE_WARN,
	restDrainsMatters,
	loadProposal,
	nodeCount,
	outletHints,
	pointOf,
	NO_CHOICES,
	readPlacement,
	type PointChoices,
	START_POINTS_MAX,
	START_PROPOSALS_KEPT,
	START_PROPOSALS_PER_HOUR,
	toProposal,
	upstreamFirst,
	type DamShares,
	type UnitMember
} from './start.js';
import { panWarning, type PanReport } from './pans.js';
import { AreaBasis, areaBasisNote, takenAreaM2 } from './areaBasis.js';
import { delineateUnits, type DamPosition, type SubcatchmentRequest, type Subcatchments, type UnitRole } from './subcatchments.js';

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
type Polygonal = Extract<Geometry, { type: 'Polygon' | 'MultiPolygon' }>;

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

const NOT_EMPTY_NEEDED = 'The model has no hydrological units yet: start it from the map instead, which makes them.';
const NO_DEM = 'Dividing the model needs an elevation model on the server (DEM_URL), and this one has none: set the areas and the order on the Network, or one unit at a time with Delineate and Use this area.';
const EPS_KM2 = 1e-9;

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

export const divideRoutes = new Hono<AuthEnv>()
	.post('/:id/map/divide', async (c) => {
		const body = DivideBody.parse(await readJson(c));
		const id = c.req.param('id');
		const userId = c.get('userId');
		const { inputs, placing, attempt } = await withUser(userId, async (db) => {
			await requireRole(db, id, 'editor');
			if ((await nodeCount(db, id)) === 0) throw new ApiError(409, NOT_EMPTY_NEEDED);
			const { rows } = await db.query<{ n: number }>(`SELECT count(*)::integer AS n FROM start_proposal WHERE project_id = $1 AND created_at > now() - interval '1 hour'`, [id]);
			if (rows[0]!.n >= START_PROPOSALS_PER_HOUR) throw new ApiError(429, `This catchment has asked for ${START_PROPOSALS_PER_HOUR} proposals in the last hour; try again later.`);
			// Counted before any work, refused and failed attempts too (184_dem_attempt).
			const attempt = await beginDemAttempt(db, 'divide');
			const inputs = await readDivideInputs(db, id, body);
			// Each point's river reach, with a DEM to place it on (without one the division is refused below).
			const placing = configuredDem() ? await readPlacement(db, { point: inputs.outlet.point, foundIn: inputs.outlet.foundIn }, body) : NO_CHOICES;
			return { inputs, placing, attempt };
		});
		try {
			const dem = configuredDem();
			if (!dem) throw new ApiError(422, NO_DEM, { reason: 'no_dem' });
			let r;
			try {
				r = await delineateUnits(dem, divideRouting(inputs, placing), {
					windows: delineationLimits.requestWindows,
					panReference: panReferenceLoader((fn) => withUser(userId, fn, { readOnly: true }), id)
				});
			} catch (err) {
				if (err instanceof DelineationRefused) {
					// Still at the edge of the request's last window (or out of its time): the worker goes on from the next (#646 item 3).
					const next = err.code === 'too_large' ? nextJobWindow(err.windowCells) : null;
					if (next !== null && jobWindowsFrom(next).length > 0) {
						const queued = await withUser(userId, async (db) => {
							await requireRole(db, id, 'editor');
							return queuePlan(db, { projectId: id, userId, kind: 'divide', body, fromWindow: next, aim: err.aim ?? null, fallbackId: null });
						});
						await wakeWorker(queued.jobId);
						return c.json({ request: queued.request }, 202);
					}
					throw new ApiError(422, err.message, { reason: err.code });
				}
				logEvent('error', { event: 'divide_proposal_failed', ...safeError(err) });
				throw new ApiError(503, 'The elevation model could not be read just now. Try again; if it keeps failing, the operator should check DEM_URL.');
			}
			const plan = dividePlanFrom(inputs, r);
			const done = r;
			return await withUser(userId, async (db) => {
				await requireRole(db, id, 'editor');
				return c.json({ proposal: await storeDivideProposal(db, id, plan, done) }, 201);
			});
		} finally {
			await finishDemAttempt(userId, attempt);
		}
	})
	.post('/:id/map/divide/:spid/apply', async (c) => {
		const body = DivideApplyBody.parse(await readJson(c));
		const { id, spid } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const p = await loadProposal<DividePlan, DivideDecision>(db, id, spid);
			const { rows: st } = await db.query<{ status: string }>('SELECT status FROM start_proposal WHERE id = $1 AND project_id = $2 FOR UPDATE', [spid, id]);
			if (st[0]?.status !== 'proposed') throw new ApiError(409, `That proposal is ${st[0]?.status ?? p.status}, so it can no longer be applied; propose again.`);
			if (p.mode !== 'divide') throw new ApiError(409, 'That proposal starts an empty model; apply it from Start the model from the map.');
			const plan = p.plan;
			if (madeBeforeBoundaries(plan.units)) throw new ApiError(409, BEFORE_BOUNDARIES);
			const change = await beginModelChange(db, id);
			const model = await loadModel(db, id);
			const nodes = new Map(model.nodes.map((n) => [n.id, { ...n }]));
			const ticks = new Map(body.units.map((u) => [u.key, u]));
			if (ticks.size !== body.units.length || ticks.size !== plan.units.length || plan.units.some((u) => !ticks.has(u.key))) {
				throw new ApiError(400, 'The ticks must name every proposed point once, and only those.');
			}
			const outflow = nodes.get(plan.outlet.nodeId);
			if (!outflow || outflow.downstreamNodeId !== null) throw new ApiError(409, `${plan.outlet.name} is no longer the model’s outflow, so the proposal no longer fits it; propose again.`);
			const changed = (what: string) => new ApiError(409, `${what} changed since the proposal, so taking the proposed value would overwrite it unseen; propose again.`);
			const names = new Set(model.nodes.map((n) => n.name.trim().toLowerCase()));
			const fresh = (name: string) => {
				const k = name.trim().toLowerCase();
				if (names.has(k)) throw new ApiError(400, `Two hydrological units would be called “${name.trim()}”; give the new one a name of its own.`);
				names.add(k);
				return name.trim();
			};
			// Each point's node: an existing one (still there), or a new gauge when ticked to be added.
			let sort = Math.max(0, ...model.nodes.map((n) => n.sortOrder));
			const nodeOf = new Map<string, string | null>();
			const added: NetworkNode[] = [];
			for (const u of plan.units) {
				const t = ticks.get(u.key)!;
				if (u.nodeId) {
					if (t.add || t.name !== undefined) throw new ApiError(400, `${u.name} is in the model already; only a new gauge is added or named.`);
					if (!nodes.has(u.nodeId)) throw new ApiError(409, `${u.name} is no longer in the model; propose again.`);
					nodeOf.set(u.key, u.nodeId);
				} else if (t.add) {
					const n: NetworkNode = { ...newNetworkNode(crypto.randomUUID(), ++sort, outflow.id), name: fresh(t.name ?? u.name), kind: 'gauge' };
					added.push(n);
					nodes.set(n.id, n);
					nodeOf.set(u.key, n.id);
				} else {
					if (t.area || t.drainsInto || t.runoffToDam || t.upstreamToDam) throw new ApiError(400, `${u.name} is a new gauge: tick Add it before taking its order.`);
					nodeOf.set(u.key, null);
				}
			}
			// A unit's boundary is its area: it must still be the one proposed (start-16).
			const boundaryKeys = plan.units.filter((u) => u.role === 'unit').map((u) => u.key);
			const { rows: fNow } = await db.query<{ id: string; area_m2: number | null }>('SELECT id, area_m2 FROM map_feature WHERE project_id = $1 AND id = ANY($2::uuid[])', [id, boundaryKeys]);
			const boundaryArea = new Map(fNow.map((r) => [r.id, r.area_m2]));
			// The ticked values, each against the value it replaces.
			for (const u of plan.units) {
				const t = ticks.get(u.key)!;
				const nid = nodeOf.get(u.key);
				if (!nid) continue;
				const n = nodes.get(nid)!;
				const cur = u.current;
				if (t.areaBasis === 'effective' && !t.area) throw new ApiError(400, `Tick ${u.name}’s area to take its effective area.`);
				if (t.area) {
					if (u.areaM2 === null || !u.geometry) throw new ApiError(400, `${u.name} has no proposed area to take.`);
					if (n.kind !== 'farm') throw new ApiError(400, `${u.name} is not a unit, so it has no catchment area.`);
					if (cur && Math.abs(n.areaKm2 - cur.areaKm2) > EPS_KM2) throw changed(`${u.name}’s area`);
					if (u.role === 'unit') {
						const now = boundaryArea.get(u.key);
						if (now === undefined) throw new ApiError(409, `${u.name}’s boundary is no longer on the map; propose again.`);
						if (now === null || Math.abs(now - u.areaM2) > 1) throw changed(`${u.name}’s boundary`);
					}
					// Gross unless the effective area (without what drains into pans) is asked for (195).
					n.areaKm2 = takenAreaM2(u.name, u.areaM2, u.nonContributingM2, t.areaBasis ?? 'gross') / 1e6;
				}
				if (t.drainsInto) {
					if (cur && n.downstreamNodeId !== cur.downstreamNodeId) throw changed(`What ${u.name} drains into`);
					const target = u.drainsInto ? nodeOf.get(u.drainsInto) : outflow.id;
					if (u.drainsInto && !target) {
						const g = plan.units.find((x) => x.key === u.drainsInto);
						throw new ApiError(400, `${u.name} would drain into the new gauge ${g?.name ?? ''}, which isn’t being added: tick Add it too.`);
					}
					n.downstreamNodeId = target!;
				}
				// The composite dam's shares are the user's to enter, never proposed (start-16).
				if (t.runoffToDam || t.upstreamToDam) throw new ApiError(400, `${u.name}’s composite dam takes the shares of runoff and of the upstream inflow you enter on the unit: the map proposes neither.`);
			}
			// The rest of the catchment.
			let restNode: NetworkNode | null = null;
			if (body.rest.to !== 'none') {
				if (body.rest.to === 'node') {
					const n = nodes.get(body.rest.nodeId);
					if (!n) throw new ApiError(400, 'The unit for the rest of the catchment isn’t in the model.');
					const was = plan.untouched.find((u) => u.nodeId === n.id);
					if (!was || n.kind !== 'farm' || n.id === outflow.id || [...nodeOf.values()].includes(n.id)) {
						throw new ApiError(400, `${n.name} can’t take the rest of the catchment: pick a unit that isn’t one of the points.`);
					}
					if (Math.abs(n.areaKm2 - was.areaKm2) > EPS_KM2) throw changed(`${n.name}’s area`);
					restNode = n;
				} else {
					// Into the point its flow path meets first when that is ticked (start-17, F10); else the outflow, as before.
					let down = outflow.id;
					if (body.rest.drainsInto) {
						const key = plan.rest.drainsIntoProposed ? plan.rest.drainsInto : null;
						if (!key) throw new ApiError(400, 'The rest of the catchment has no proposed order to take.');
						const target = nodeOf.get(key);
						if (!target) throw new ApiError(400, `The rest of the catchment would drain into the new gauge ${plan.units.find((x) => x.key === key)?.name ?? ''}, which isn’t being added: tick Add it too.`);
						down = target;
					}
					restNode = { ...newNetworkNode(crypto.randomUUID(), ++sort, down), name: fresh(body.rest.name) };
					added.push(restNode);
					nodes.set(restNode.id, restNode);
				}
				restNode.areaKm2 = takenAreaM2('The rest of the catchment', plan.rest.areaM2, plan.rest.nonContributingM2, body.rest.areaBasis ?? 'gross') / 1e6;
			}
			const next = ModelBody.parse({ ...model, nodes: [...model.nodes.map((n) => nodes.get(n.id)!), ...added] });
			const loop = loopIn(next.nodes);
			if (loop) throw new ApiError(400, `The ticked drains-into would make a loop (${loop.join(' → ')}); tick the order of the units along it too, or change it on the Network.`);
			const problems = modelProblems(next);
			if (problems.length) throw new ApiError(400, 'The divided model doesn’t pass the model’s checks.', problems);
			// Each node's parcel as it stood before the save: saveModel forgets the link of an area that changes (typed over),
			// and a taken area that changes (a new outline, or gross after effective) must still redraw its own parcel.
			const { rows: linked } = await db.query<{ id: string; area_feature_id: string | null }>('SELECT id, area_feature_id FROM node WHERE project_id = $1', [id]);
			const parcelBefore = new Map(linked.map((r) => [r.id, r.area_feature_id]));
			await saveModel(db, id, next);

			// Parcels: each taken area's outline, linked to its node, and the area marked as from the map (as Use this area does).
			const provenance = `Sub-catchment delineated from ${p.dataset} (${p.method_version}); check it against the map.`;
			// The parcels an earlier start or division made (their ids are in the applied decisions): a unit's
			// own sub-catchment from one of those is redrawn in place, so dividing again doesn't pile outlines up.
			const { rows: madeRows } = await db.query<{ id: string }>(
				`SELECT DISTINCT x.id FROM start_proposal p,
					LATERAL (SELECT u ->> 'parcelId' AS id FROM jsonb_array_elements(p.decision -> 'units') u UNION ALL SELECT p.decision -> 'rest' ->> 'parcelId') x
				 WHERE p.project_id = $1 AND p.status = 'applied' AND x.id IS NOT NULL`,
				[id]
			);
			const made = new Set(madeRows.map((r) => r.id));
			// The parcel keeps the gross area and what of it drains into pans (195); the node has the area taken, and which.
			const parcel = async (nodeId: string, name: string, geometry: Polygonal, areaM2: number, ncM2: number | undefined, basis: AreaBasis): Promise<string> => {
				const nc = ncM2 === undefined ? null : Math.min(ncM2, areaM2);
				const old = parcelBefore.get(nodeId);
				if (old && made.has(old)) {
					const { rowCount } = await db.query(
						`UPDATE map_feature SET geometry = $4, area_m2 = $5, properties = $6, non_contributing_m2 = $7 WHERE id = $1 AND project_id = $2 AND node_id = $3 AND kind = 'farm_parcel'`,
						[old, id, nodeId, JSON.stringify(geometry), areaM2, JSON.stringify({ description: provenance.slice(0, 500) }), nc]
					);
					if (rowCount) {
						await db.query(`UPDATE node SET area_source = 'map', area_basis = $4, area_feature_id = $3 WHERE id = $1 AND project_id = $2`, [nodeId, id, old, basis]);
						return old;
					}
				}
				const { rows } = await db.query<{ id: string }>(
					`INSERT INTO map_feature (project_id, kind, name, node_id, geometry, properties, area_m2, non_contributing_m2, created_by)
					 VALUES ($1, 'farm_parcel', $2, $3, $4, $5, $6, $7, app_current_user_id()) RETURNING id`,
					[id, featureNameOf(`${name}: own sub-catchment`), nodeId, JSON.stringify(geometry), JSON.stringify({ description: provenance.slice(0, 500) }), areaM2, nc]
				);
				await db.query(`UPDATE node SET area_source = 'map', area_basis = $4, area_feature_id = $3 WHERE id = $1 AND project_id = $2`, [nodeId, id, rows[0]!.id, basis]);
				return rows[0]!.id;
			};
			const decisionUnits: DivideDecision['units'] = [];
			for (const u of plan.units) {
				const t = ticks.get(u.key)!;
				const nid = nodeOf.get(u.key) ?? null;
				const basis = t.areaBasis ?? 'gross';
				const bounded = u.role === 'unit';
				// A unit's own boundary is its area (start-16): linked as Use this area does, never copied into a new parcel.
				const parcelId = !bounded && nid && t.area && u.geometry && u.areaM2 !== null ? await parcel(nid, nodes.get(nid)!.name, u.geometry as Polygonal, u.areaM2, u.nonContributingM2, basis) : null;
				if (bounded && nid && t.area) await db.query(`UPDATE node SET area_source = 'map', area_basis = 'gross', area_feature_id = $3 WHERE id = $1 AND project_id = $2`, [nid, id, u.key]);
				// The feature stands for its node now, if it stood for nothing (a link, not a model value).
				if (nid) await db.query(`UPDATE map_feature SET node_id = $3 WHERE id = $1 AND project_id = $2 AND node_id IS NULL`, [u.key, id, nid]);
				// Its unlinked dams (the composite dam) and abstraction points (the river pump) stand for it too.
				if (nid && u.members?.length) await linkMembers(db, id, nid, u.members);
				decisionUnits.push({ key: u.key, nodeId: nid, area: t.area, ...(t.area ? { areaBasis: basis } : {}), drainsInto: t.drainsInto, runoffToDam: false, add: t.add, parcelId, ...(bounded ? { boundaryId: u.key } : {}) });
			}
			const restBasis = body.rest.to === 'none' ? 'gross' : (body.rest.areaBasis ?? 'gross');
			const restParcel = restNode && plan.rest.geometry ? await parcel(restNode.id, restNode.name, plan.rest.geometry, plan.rest.areaM2, plan.rest.nonContributingM2, restBasis) : null;
			if (plan.outlet.featureId) await db.query(`UPDATE map_feature SET node_id = $3 WHERE id = $1 AND project_id = $2 AND kind = 'gauge' AND node_id IS NULL`, [plan.outlet.featureId, id, outflow.id]);

			const areas = decisionUnits.filter((u) => u.area && u.nodeId).length + (restNode ? 1 : 0);
			const orders = decisionUnits.filter((u) => u.drainsInto).length;
			const gauges = decisionUnits.filter((u) => u.add).length;
			// Which areas were taken effective (without what drains into pans), so the run's inputs say so (195).
			const effective = [
				...decisionUnits.filter((u) => u.parcelId && u.areaBasis === 'effective').map((u) => nodes.get(u.nodeId!)!.name),
				...(restNode && restBasis === 'effective' ? [restNode.name] : [])
			];
			const s = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
			const revision = await recordModelRevision(db, id, {
				source: 'model_put',
				before: change.before,
				reason: `Divided from the map: ${s(areas, 'area')}${areaBasisNote(areas, effective)}, ${s(orders, 'drains-into', 'drains-into')}${gauges ? `, ${s(gauges, 'gauge')} added` : ''}${body.rest.to === 'new' ? ', the rest of the catchment added' : ''} from ${p.dataset}, ${p.method_version}`.slice(0, 500)
			});
			const decision: DivideDecision = {
				units: decisionUnits,
				rest: { to: body.rest.to, ...(restNode ? { areaBasis: restBasis } : {}), ...(body.rest.to === 'new' && body.rest.drainsInto ? { drainsInto: true } : {}), nodeId: restNode?.id ?? null, parcelId: restParcel },
				revisionId: revision?.id ?? null
			};
			await db.query(`UPDATE start_proposal SET status = 'applied', decision = $3, decided_by = app_current_user_id(), decided_at = now() WHERE id = $1 AND project_id = $2`, [
				spid,
				id,
				JSON.stringify(decision)
			]);
			await recordAudit(db, id, 'map.divide_applied', { proposalId: spid, areas, orders, gauges, revisionId: decision.revisionId });
			return c.json({ proposal: toProposal(await loadProposal<DividePlan, DivideDecision>(db, id, spid)), model: await loadModel(db, id) });
		});
	});
