// Dividing a model that already has nodes into sub-catchments from the map
// (#326 C3's follow-up; 182_divide_proposal.sql, docs/design/start-from-map.md
// § Dividing a model that has nodes, docs/api.md § Start from the map).
//
//   POST /projects/:id/map/divide                   propose each linked unit's own area and drains-into, against its current values (editor)
//   POST /projects/:id/map/divide/:spid/apply       take the ticked values (editor)
//
// The GET and discard are start.ts's (one table, one open proposal a project).
//
// Each point on the map the editor names stands for a node of the model (a
// dam or abstraction point for its unit, a gauge for a gauge node), or, for a
// gauge point, a new gauge node. The same partition as starting from the map
// (subcatchments.ts) gives each point's own sub-catchment and the first point
// below it; the proposal shows each beside the node's current area, order and
// runoff to the dam. Apply takes only the ticked values, and refuses (409) a
// value whose current one changed since the proposal: what the editor saw
// replaced is exactly what is replaced, never anything typed since.
import { newNetworkNode, type NetworkNode, type ProjectModel } from '@water-management/engine';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser, type Db } from '../db/tx.js';
import type { Geometry, Position } from '../geo/geojson.js';
import { KIND_NODES } from '../geo/routes.js';
import { beginModelChange, recordAudit, recordModelRevision } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { logEvent } from '../logging/logEvent.js';
import { safeError } from '../logging/safeError.js';
import { loadModel, saveModel } from '../model/store.js';
import { ModelBody, modelProblems } from '../model/validate.js';
import { requireRole } from '../projects/access.js';
import { configuredDem } from './dem.js';
import { DelineationRefused } from './delineate.js';
import {
	BOUNDARY_MISMATCH,
	km2,
	loadProposal,
	nodeCount,
	START_POINTS_MAX,
	START_PROPOSALS_KEPT,
	START_PROPOSALS_PER_HOUR,
	TINY_PIECE_M2,
	toProposal,
	upstreamFirst
} from './start.js';
import { delineateUnits, ownsLand, type UnitRole } from './subcatchments.js';

export const DivideBody = z
	.object({
		/** A gauge on the map at the outflow; absent or null = the boundary's own outlet. */
		outletFeatureId: z.string().uuid().nullable().optional(),
		points: z
			.array(
				z
					.object({
						featureId: z.string().uuid(),
						/** The node the point stands for; null = a new gauge node (a gauge point only). */
						nodeId: z.string().uuid().nullable()
					})
					.strict()
			)
			.min(1)
			.max(START_POINTS_MAX)
			.refine((ps) => new Set(ps.map((p) => p.featureId)).size === ps.length, 'a point is listed twice')
			.refine((ps) => {
				const ids = ps.flatMap((p) => (p.nodeId ? [p.nodeId] : []));
				return new Set(ids).size === ids.length;
			}, 'two points stand for one node')
	})
	.strict();

const Name = z.string().trim().min(1).max(100);
export const DivideApplyBody = z
	.object({
		units: z
			.array(
				z
					.object({
						key: z.string().uuid(),
						/** Take the proposed area (its own piece, saved as the node's parcel). */
						area: z.boolean(),
						/** Take the proposed drains-into. */
						drainsInto: z.boolean(),
						/** A dam unit: all of its own runoff reaches its dam. */
						runoffToDam: z.boolean(),
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
			z.object({ to: z.literal('node'), nodeId: z.string().uuid() }).strict(),
			z.object({ to: z.literal('new'), name: Name }).strict()
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
	/** Its own piece (m²) and outline; null for a water user or a gauge (they own no land). */
	areaM2: number | null;
	totalAreaM2: number | null;
	geometry: Poly | null;
	/** The point it drains into (its key), or null for the outflow. */
	drainsInto: string | null;
	/** The node's values now (null for a new gauge). */
	current: DivideCurrent | null;
}

export interface DividePlan {
	mode: 'divide';
	outlet: { featureId: string | null; nodeId: string; name: string; point: Position; snapDistanceM: number | null; foundIn: 'gauge' | 'delineation' | 'boundary' };
	catchment: { areaM2: number; boundaryAreaM2: number | null };
	units: DivideUnit[];
	/** What drains to the outflow through no point. */
	rest: { areaM2: number; geometry: Polygonal | null };
	/** Units of the model with no point in the division: they keep their values. */
	untouched: { nodeId: string; name: string }[];
	dropped: { featureId: string; name: string; reason: string }[];
	warnings: string[];
	cellSizeM: number;
	zoom: number;
	windowCells: number;
}

export interface DivideDecision {
	units: { key: string; nodeId: string | null; area: boolean; drainsInto: boolean; runoffToDam: boolean; add: boolean; parcelId: string | null }[];
	rest: { to: 'none' | 'node' | 'new'; nodeId: string | null; parcelId: string | null };
	revisionId: string | null;
}

const NOT_EMPTY_NEEDED = 'The model has no nodes yet: start it from the map instead, which makes them.';
const NO_DEM = 'Dividing the model needs an elevation model on the server (DEM_URL), and this one has none: set the areas and the order on the Network, or one unit at a time with Delineate and Use this area.';
const EPS_KM2 = 1e-9;

/** A unit's role from its node and the point's kind: a dam point or a node with a dam is a dam unit. */
export function roleOf(node: Pick<NetworkNode, 'kind' | 'damCapacityM3'> | null, featureKind: string): UnitRole {
	if (!node) return 'gauge';
	if (node.kind === 'user') return 'user';
	if (node.kind === 'gauge') return 'gauge';
	return featureKind === 'dam' || node.damCapacityM3 > 0 ? 'dam' : 'abstraction';
}

/** The node every other drains to in the end: the one that drains nowhere. */
function outflowOf(model: ProjectModel): NetworkNode {
	const roots = model.nodes.filter((n) => n.downstreamNodeId === null);
	if (roots.length !== 1) throw new ApiError(400, 'The model needs exactly one outflow gauge (a node that drains nowhere) before it can be divided; fix it on the Network.');
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

interface DivideInputs {
	boundary: { id: string; geometry: Polygonal; areaM2: number } | null;
	outlet: { featureId: string | null; point: Position | null; foundIn: DividePlan['outlet']['foundIn'] };
	outflow: NetworkNode;
	model: ProjectModel;
	areaSource: Map<string, 'typed' | 'map'>;
	points: { featureId: string; featureKind: string; name: string; node: NetworkNode | null; geometry: Geometry }[];
}

async function readInputs(db: Db, projectId: string, body: z.infer<typeof DivideBody>): Promise<DivideInputs> {
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
	const { rows: fs } = await db.query<{ id: string; kind: string; name: string; geometry: Geometry; node_id: string | null }>(
		'SELECT id, kind, name, geometry, node_id FROM map_feature WHERE project_id = $1 AND id = ANY($2::uuid[])',
		[projectId, ids]
	);
	const byId = new Map(fs.map((f) => [f.id, f]));
	let outlet: DivideInputs['outlet'];
	if (body.outletFeatureId) {
		const f = byId.get(body.outletFeatureId);
		if (!f) throw new ApiError(400, 'The outlet gauge is not on this catchment’s map.');
		if (f.kind !== 'gauge' || f.geometry.type !== 'Point') throw new ApiError(400, 'The outlet must be a gauge point on the map.');
		if (body.points.some((p) => p.featureId === f.id)) throw new ApiError(400, 'The outlet gauge can’t also be one of the points.');
		if (f.node_id && f.node_id !== outflow.id) throw new ApiError(400, `“${f.name || 'That gauge'}” stands for ${nodes.get(f.node_id)?.name ?? 'another node'}, not the outflow (${outflow.name}).`);
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
		if (!(f.geometry.type === 'Point' || (polygon && f.kind === 'dam'))) throw new ApiError(400, `${label} is not a point or a dam: only points and dams stand for units.`);
		if (p.nodeId === null) {
			if (f.kind !== 'gauge' || f.geometry.type !== 'Point') throw new ApiError(400, `${label} is not a gauge point, so it can’t be a new gauge node.`);
			if (f.node_id) throw new ApiError(400, `${label} stands for ${nodes.get(f.node_id)?.name ?? 'a node'} already.`);
			return { featureId: f.id, featureKind: f.kind, name: f.name || `Gauge ${++gauges}`, node: null, geometry: f.geometry };
		}
		const n = nodes.get(p.nodeId);
		if (!n) throw new ApiError(400, `${label} is matched to a node that isn’t in the model (deleted since?). Reload and propose again.`);
		if (n.id === outflow.id) throw new ApiError(400, `${n.name} is the outflow: it is where the division ends, not one of its points.`);
		if (!(KIND_NODES[f.kind as keyof typeof KIND_NODES] ?? []).includes(n.kind)) throw new ApiError(400, `${label} can’t stand for ${n.name} (a ${n.kind} node).`);
		if (f.node_id && f.node_id !== n.id) throw new ApiError(400, `${label} stands for ${nodes.get(f.node_id)?.name ?? 'another node'} on the map, not ${n.name}.`);
		return { featureId: f.id, featureKind: f.kind, name: f.name, node: n, geometry: f.geometry };
	});
	return { boundary, outlet, outflow, model, areaSource: new Map(src.map((r) => [r.id, r.area_source])), points };
}

export const divideRoutes = new Hono<AuthEnv>()
	.post('/:id/map/divide', async (c) => {
		const body = DivideBody.parse(await readJson(c));
		const id = c.req.param('id');
		const userId = c.get('userId');
		const inputs = await withUser(userId, async (db) => {
			await requireRole(db, id, 'editor');
			if ((await nodeCount(db, id)) === 0) throw new ApiError(409, NOT_EMPTY_NEEDED);
			const { rows } = await db.query<{ n: number }>(`SELECT count(*)::integer AS n FROM start_proposal WHERE project_id = $1 AND created_at > now() - interval '1 hour'`, [id]);
			if (rows[0]!.n >= START_PROPOSALS_PER_HOUR) throw new ApiError(429, `This catchment has asked for ${START_PROPOSALS_PER_HOUR} proposals in the last hour; try again later.`);
			return readInputs(db, id, body);
		});
		const dem = configuredDem();
		if (!dem) throw new ApiError(422, NO_DEM, { reason: 'no_dem' });
		let r;
		try {
			r = await delineateUnits(dem, {
				outlet: inputs.outlet.point,
				boundary: inputs.boundary?.geometry ?? null,
				points: inputs.points.map((p) => ({ id: p.featureId, role: roleOf(p.node, p.featureKind), geometry: p.geometry }))
			});
		} catch (err) {
			if (err instanceof DelineationRefused) throw new ApiError(422, err.message, { reason: err.code });
			logEvent('error', { event: 'divide_proposal_failed', ...safeError(err) });
			throw new ApiError(503, 'The elevation model could not be read just now. Try again; if it keeps failing, the operator should check DEM_URL.');
		}
		const named = new Map(inputs.points.map((p) => [p.featureId, p]));
		const nodes = new Map(inputs.model.nodes.map((n) => [n.id, n]));
		const warnings: string[] = [];
		if (inputs.boundary && Math.abs(r.catchment.areaM2 / inputs.boundary.areaM2 - 1) > BOUNDARY_MISMATCH) {
			warnings.push(
				`The catchment above the outlet is ${km2(r.catchment.areaM2)} on the elevation model, but the boundary on the map is ${km2(inputs.boundary.areaM2)}. The areas follow the elevation model; check the outlet and the boundary.`
			);
		}
		const units: DivideUnit[] = r.units.map((u) => {
			const p = named.get(u.id)!;
			const n = p.node;
			const land = ownsLand(u.role);
			return {
				key: u.id,
				featureName: p.name,
				nodeId: n?.id ?? null,
				name: n?.name ?? p.name,
				role: u.role,
				point: u.point,
				snapDistanceM: u.snapDistanceM,
				areaM2: land ? u.areaM2 : null,
				totalAreaM2: u.role === 'user' ? null : u.totalAreaM2,
				geometry: land ? u.geometry : null,
				drainsInto: u.drainsInto,
				current: n
					? {
							areaKm2: n.areaKm2,
							areaSource: inputs.areaSource.get(n.id) ?? 'typed',
							downstreamNodeId: n.downstreamNodeId,
							downstreamName: n.downstreamNodeId ? (nodes.get(n.downstreamNodeId)?.name ?? null) : null,
							pctRunoffToDam: n.pctRunoffToDam
						}
					: null
			};
		});
		for (const u of units) {
			if (u.areaM2 !== null && u.areaM2 < TINY_PIECE_M2) warnings.push(`${u.name}’s own area is under a hectare: is its point right on top of another one’s?`);
			if (u.areaM2 !== null && !u.geometry) warnings.push(`${u.name}’s outline couldn’t be made a valid polygon, so its area has no parcel to save; type it in instead.`);
		}
		const inDivision = new Set(units.flatMap((u) => (u.nodeId ? [u.nodeId] : [])));
		const untouched = inputs.model.nodes.filter((n) => n.kind === 'farm' && !inDivision.has(n.id)).map((n) => ({ nodeId: n.id, name: n.name }));
		const plan: DividePlan = {
			mode: 'divide',
			outlet: { featureId: inputs.outlet.featureId, nodeId: inputs.outflow.id, name: inputs.outflow.name, point: r.outlet.point, snapDistanceM: r.outlet.snapDistanceM, foundIn: inputs.outlet.foundIn },
			catchment: { areaM2: r.catchment.areaM2, boundaryAreaM2: inputs.boundary?.areaM2 ?? null },
			units: upstreamFirst(units),
			rest: { areaM2: r.rest.areaM2, geometry: r.rest.geometry },
			untouched,
			dropped: r.dropped.map((d) => ({ featureId: d.id, name: named.get(d.id)!.name, reason: d.reason })),
			warnings,
			cellSizeM: r.cellSizeM,
			zoom: r.zoom,
			windowCells: r.windowCells
		};
		return withUser(userId, async (db) => {
			await requireRole(db, id, 'editor');
			await db.query(`UPDATE start_proposal SET status = 'superseded' WHERE project_id = $1 AND status = 'proposed'`, [id]);
			const { rows } = await db
				.query<{ id: string }>(
					`INSERT INTO start_proposal (project_id, mode, plan, from_dem, dataset, dataset_fingerprint, method, method_version, created_by)
					 VALUES ($1, 'divide', $2, true, $3, $4, $5, $6, app_current_user_id()) RETURNING id`,
					[id, JSON.stringify(plan), r.dataset.label, r.dataset.fingerprint, r.method, r.methodVersion]
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
				[id, START_PROPOSALS_KEPT]
			);
			const proposal = toProposal(await loadProposal<DividePlan, DivideDecision>(db, id, rows[0]!.id));
			await recordAudit(db, id, 'map.divide_proposed', { proposalId: proposal.id, units: plan.units.length, dropped: plan.dropped.length, dataset: r.dataset.label, methodVersion: r.methodVersion });
			return c.json({ proposal }, 201);
		});
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
				if (names.has(k)) throw new ApiError(400, `Two nodes would be called “${name.trim()}”; give the new one a name of its own.`);
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
					if (t.area || t.drainsInto || t.runoffToDam) throw new ApiError(400, `${u.name} is a new gauge: tick Add it before taking its order.`);
					nodeOf.set(u.key, null);
				}
			}
			// The ticked values, each against the value it replaces.
			for (const u of plan.units) {
				const t = ticks.get(u.key)!;
				const nid = nodeOf.get(u.key);
				if (!nid) continue;
				const n = nodes.get(nid)!;
				const cur = u.current;
				if (t.area) {
					if (u.areaM2 === null || !u.geometry) throw new ApiError(400, `${u.name} has no proposed area to take.`);
					if (n.kind !== 'farm') throw new ApiError(400, `${u.name} is not a unit, so it has no catchment area.`);
					if (cur && Math.abs(n.areaKm2 - cur.areaKm2) > EPS_KM2) throw changed(`${u.name}’s area`);
					n.areaKm2 = u.areaM2 / 1e6;
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
				if (t.runoffToDam) {
					if (u.role !== 'dam') throw new ApiError(400, `${u.name} is not a dam unit.`);
					if (cur && n.pctRunoffToDam !== cur.pctRunoffToDam) throw changed(`${u.name}’s runoff to the dam`);
					n.pctRunoffToDam = 1;
				}
			}
			// The rest of the catchment.
			let restNode: NetworkNode | null = null;
			if (body.rest.to !== 'none') {
				if (!plan.rest.geometry) throw new ApiError(400, 'The rest of the catchment has no outline to save as a parcel; type its area instead.');
				if (body.rest.to === 'node') {
					const n = nodes.get(body.rest.nodeId);
					if (!n) throw new ApiError(400, 'The unit for the rest of the catchment isn’t in the model.');
					if (n.kind !== 'farm' || n.id === outflow.id || [...nodeOf.values()].includes(n.id)) {
						throw new ApiError(400, `${n.name} can’t take the rest of the catchment: pick a unit that isn’t one of the points.`);
					}
					restNode = n;
				} else {
					restNode = { ...newNetworkNode(crypto.randomUUID(), ++sort, outflow.id), name: fresh(body.rest.name) };
					added.push(restNode);
					nodes.set(restNode.id, restNode);
				}
				restNode.areaKm2 = plan.rest.areaM2 / 1e6;
			}
			const next = ModelBody.parse({ ...model, nodes: [...model.nodes.map((n) => nodes.get(n.id)!), ...added] });
			const loop = loopIn(next.nodes);
			if (loop) throw new ApiError(400, `The ticked drains-into would make a loop (${loop.join(' → ')}); tick the order of the units along it too, or change it on the Network.`);
			const problems = modelProblems(next);
			if (problems.length) throw new ApiError(400, 'The divided model doesn’t pass the model’s checks.', problems);
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
			const parcel = async (nodeId: string, name: string, geometry: Polygonal, areaM2: number): Promise<string> => {
				const { rows: cur } = await db.query<{ area_feature_id: string | null }>('SELECT area_feature_id FROM node WHERE id = $1 AND project_id = $2', [nodeId, id]);
				const old = cur[0]?.area_feature_id;
				if (old && made.has(old)) {
					const { rowCount } = await db.query(
						`UPDATE map_feature SET geometry = $4, area_m2 = $5, properties = $6 WHERE id = $1 AND project_id = $2 AND node_id = $3 AND kind = 'farm_parcel'`,
						[old, id, nodeId, JSON.stringify(geometry), areaM2, JSON.stringify({ description: provenance.slice(0, 500) })]
					);
					if (rowCount) {
						await db.query(`UPDATE node SET area_source = 'map', area_feature_id = $3 WHERE id = $1 AND project_id = $2`, [nodeId, id, old]);
						return old;
					}
				}
				const { rows } = await db.query<{ id: string }>(
					`INSERT INTO map_feature (project_id, kind, name, node_id, geometry, properties, area_m2, created_by)
					 VALUES ($1, 'farm_parcel', $2, $3, $4, $5, $6, app_current_user_id()) RETURNING id`,
					[id, `${name}: own sub-catchment`.slice(0, 200), nodeId, JSON.stringify(geometry), JSON.stringify({ description: provenance.slice(0, 500) }), areaM2]
				);
				await db.query(`UPDATE node SET area_source = 'map', area_feature_id = $3 WHERE id = $1 AND project_id = $2`, [nodeId, id, rows[0]!.id]);
				return rows[0]!.id;
			};
			const decisionUnits: DivideDecision['units'] = [];
			for (const u of plan.units) {
				const t = ticks.get(u.key)!;
				const nid = nodeOf.get(u.key) ?? null;
				const parcelId = nid && t.area && u.geometry && u.areaM2 !== null ? await parcel(nid, nodes.get(nid)!.name, u.geometry, u.areaM2) : null;
				// The point stands for its node now, if it stood for nothing (a link, not a model value).
				if (nid) await db.query(`UPDATE map_feature SET node_id = $3 WHERE id = $1 AND project_id = $2 AND node_id IS NULL`, [u.key, id, nid]);
				decisionUnits.push({ key: u.key, nodeId: nid, area: t.area, drainsInto: t.drainsInto, runoffToDam: t.runoffToDam, add: t.add, parcelId });
			}
			const restParcel = restNode && plan.rest.geometry ? await parcel(restNode.id, restNode.name, plan.rest.geometry, plan.rest.areaM2) : null;
			if (plan.outlet.featureId) await db.query(`UPDATE map_feature SET node_id = $3 WHERE id = $1 AND project_id = $2 AND kind = 'gauge' AND node_id IS NULL`, [plan.outlet.featureId, id, outflow.id]);

			const areas = decisionUnits.filter((u) => u.area).length + (restParcel ? 1 : 0);
			const orders = decisionUnits.filter((u) => u.drainsInto).length;
			const runoff = decisionUnits.filter((u) => u.runoffToDam).length;
			const gauges = decisionUnits.filter((u) => u.add).length;
			const s = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
			const revision = await recordModelRevision(db, id, {
				source: 'model_put',
				before: change.before,
				reason: `Divided from the map: ${s(areas, 'area')}, ${s(orders, 'drains-into', 'drains-into')}, ${s(runoff, 'runoff to the dam', 'runoffs to the dam')}${gauges ? `, ${s(gauges, 'gauge')} added` : ''}${body.rest.to === 'new' ? ', the rest of the catchment added' : ''} from ${p.dataset}, ${p.method_version}`.slice(0, 500)
			});
			const decision: DivideDecision = {
				units: decisionUnits,
				rest: { to: body.rest.to, nodeId: restNode?.id ?? null, parcelId: restParcel },
				revisionId: revision?.id ?? null
			};
			await db.query(`UPDATE start_proposal SET status = 'applied', decision = $3, decided_by = app_current_user_id(), decided_at = now() WHERE id = $1 AND project_id = $2`, [
				spid,
				id,
				JSON.stringify(decision)
			]);
			await recordAudit(db, id, 'map.divide_applied', { proposalId: spid, areas, orders, runoff, gauges, revisionId: decision.revisionId });
			return c.json({ proposal: toProposal(await loadProposal<DividePlan, DivideDecision>(db, id, spid)), model: await loadModel(db, id) });
		});
	});

