// Starting an empty model from the map (issue #326 C3 and the B-delineate
// stretch; 178_start_proposal.sql, docs/design/start-from-map.md,
// docs/api.md § Start from the map).
//
//   GET  /projects/:id/map/start                    the DEM on or off, the model empty or not, the latest proposals (viewer)
//   POST /projects/:id/map/start                    propose units, areas and the order from the map's points (editor)
//   POST /projects/:id/map/start/:spid/apply        apply the ticked values: the nodes, parcels and links (editor)
//   POST /projects/:id/map/start/:spid/discard      discard an open proposal, a start or a division (editor)
//
// Dividing a model that already has nodes (182, the mode 'divide') shares the
// table, the GET, the cap and discard; its propose and apply are divide.ts.
//
// The map proposes, the editor decides, value by value: apply writes only
// what is ticked, and only into an empty model (409 once it has nodes), so
// nothing typed is ever overwritten. The DEM is read between two short
// transactions, never holding a connection while it routes flow.
import { oneLineName, newNetworkNode, type NetworkNode } from '@water-management/engine';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser, type Db } from '../db/tx.js';
import type { Geometry, Position } from '../geo/geojson.js';
import { beginModelChange, recordAudit, recordModelRevision } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError, notFound } from '../http/errors.js';
import { logEvent } from '../logging/logEvent.js';
import { beginDemAttempt, finishDemAttempt } from './attempt.js';
import { safeError } from '../logging/safeError.js';
import { loadModel, saveModel } from '../model/store.js';
import { ModelBody, modelProblems, nameText } from '../model/validate.js';
import { requireRole, UUID } from '../projects/access.js';
import { configuredDem } from './dem.js';
import { DelineationRefused } from './delineate.js';
import { PlacementChoice, placementOf, placementWarnings, pointReaches, PointsAtConfluence, ReachNotNearPoint, type PointPlacement, type PointReach } from './pointPlacement.js';
import { delineateUnits, START_METHOD_VERSION, type PlacementHints, type UnitRole } from './subcatchments.js';
import { pointInGeometry } from '../geo/geojson.js';

/** Proposals one project may ask for in an hour: each routes the DEM (seconds of CPU on the API). */
export const START_PROPOSALS_PER_HOUR = 30;
/** Superseded and discarded proposals kept per project (applied ones are all kept, as the model's provenance). */
export const START_PROPOSALS_KEPT = 50;
/** The most points one proposal takes. */
export const START_POINTS_MAX = 50;
/** Proposals the GET lists. */
const LISTED = 5;
/** Over this, the catchment above the outlet and the boundary on the map disagree enough to say so. */
export const BOUNDARY_MISMATCH = 0.1;
/** A unit's piece under this (m², one hectare) is worth a warning: two points nearly on top of each other. */
export const TINY_PIECE_M2 = 10_000;

export const ROLES = ['dam', 'abstraction', 'user', 'gauge'] as const satisfies readonly UnitRole[];
export const ProposeBody = z
	.object({
		/** A gauge on the map to take as the outlet; absent or null = the boundary's own outlet. */
		outletFeatureId: z.string().uuid().nullable().optional(),
		/** The outlet gauge's river at a confluence, and its larger channel chosen (pointPlacement.ts). */
		outletReach: PlacementChoice.reach,
		outletUseLarger: PlacementChoice.useLarger,
		points: z
			.array(z.object({ featureId: z.string().uuid(), role: z.enum(ROLES), ...PlacementChoice }).strict())
			.max(START_POINTS_MAX)
			.refine((ps) => new Set(ps.map((p) => p.featureId)).size === ps.length, 'a point is listed twice')
	})
	.strict();
// A node's name, as the model schema takes one (one line, issue #385).
const Name = nameText(1, 100);
export const ApplyBody = z
	.object({
		outletName: Name,
		units: z
			.array(
				z
					.object({
						key: z.string().uuid(),
						name: Name,
						/** Take the unit's proposed area (and save its outline as the unit's parcel). */
						area: z.boolean(),
						/** Take the proposed drains-into; unticked, the unit drains into the outflow gauge. */
						drainsInto: z.boolean(),
						/** A dam unit: all of its runoff reaches the dam (pctRunoffToDam = 1). */
						runoffToDam: z.boolean()
					})
					.strict()
			)
			.max(START_POINTS_MAX),
		rest: z.object({ include: z.boolean(), name: Name, area: z.boolean() }).strict()
	})
	.strict();

type Polygonal = Extract<Geometry, { type: 'Polygon' | 'MultiPolygon' }>;

/** One proposed unit (the plan's row), keyed by the map feature it came from. */
export interface StartUnit {
	key: string;
	featureName: string;
	role: UnitRole;
	/** The proposed node name (the feature's, else a numbered one). */
	name: string;
	/** Where it sits on the river (snapped), or the feature's own place without a DEM. */
	point: Position;
	snapDistanceM: number | null;
	/** Its own piece's area (m²) and outline; null without a DEM (and the outline null for a water user). */
	areaM2: number | null;
	totalAreaM2: number | null;
	geometry: Extract<Geometry, { type: 'Polygon' }> | null;
	/** The unit it drains into (its key), or null for the outflow gauge. */
	drainsInto: string | null;
	/** Whether drainsInto is a proposal (from the DEM) or only the default (without one). */
	drainsIntoProposed: boolean;
	/** How its point was put on the channel (start-7); null without a DEM. */
	placement: PointPlacement | null;
}

export interface StartPlan {
	fromDem: boolean;
	outlet: { featureId: string | null; name: string; point: Position | null; snapDistanceM: number | null; foundIn: 'gauge' | 'delineation' | 'boundary' | null; placement: PointPlacement | null };
	/** The catchment above the outlet (from the DEM) and the boundary on the map, m². */
	catchment: { areaM2: number | null; boundaryAreaM2: number | null };
	units: StartUnit[];
	/** What drains to the outlet through no unit: proposed as one more (natural) unit. */
	rest: { name: string; areaM2: number | null; geometry: Polygonal | null };
	/** `placement`: how its point was put on the channel (start-7; absent without a DEM, or for a point never placed). */
	dropped: { featureId: string; name: string; reason: string; placement?: PointPlacement }[];
	warnings: string[];
	cellSizeM: number | null;
	zoom: number | null;
	windowCells: number | null;
}

export interface StartDecision {
	outlet: { name: string; nodeId: string };
	units: { key: string; name: string; nodeId: string; area: boolean; drainsInto: boolean; runoffToDam: boolean; parcelId: string | null }[];
	rest: { include: boolean; name: string; area: boolean; nodeId: string | null; parcelId: string | null };
	revisionId: string | null;
}

export interface ProposalRow<Plan = StartPlan, Decision = StartDecision> {
	id: string;
	mode: 'start' | 'divide';
	status: 'proposed' | 'applied' | 'discarded' | 'superseded';
	plan: Plan;
	from_dem: boolean;
	dataset: string | null;
	dataset_fingerprint: string | null;
	method: string;
	method_version: string;
	decision: Decision | null;
	created_by_name: string | null;
	created_at: Date;
	decided_by_name: string | null;
	decided_at: Date | null;
}

export const SELECT = `
	SELECT p.id, p.mode, p.status, p.plan, p.from_dem, p.dataset, p.dataset_fingerprint, p.method, p.method_version, p.decision,
		cu.display_name AS created_by_name, p.created_at, du.display_name AS decided_by_name, p.decided_at
	FROM start_proposal p
	LEFT JOIN app_user cu ON cu.id = p.created_by
	LEFT JOIN app_user du ON du.id = p.decided_by
	WHERE p.project_id = $1`;

export const toProposal = <P, D>(r: ProposalRow<P, D>) => ({
	id: r.id,
	mode: r.mode,
	status: r.status,
	plan: r.plan,
	fromDem: r.from_dem,
	dataset: r.dataset,
	datasetFingerprint: r.dataset_fingerprint,
	method: r.method,
	methodVersion: r.method_version,
	decision: r.decision,
	createdBy: r.created_by_name,
	createdAt: r.created_at.toISOString(),
	decidedBy: r.decided_by_name,
	decidedAt: r.decided_at?.toISOString() ?? null
});
export type StartProposal = ReturnType<typeof toProposal<StartPlan, StartDecision>>;

export async function loadProposal<P = StartPlan, D = StartDecision>(db: Db, projectId: string, spid: string): Promise<ProposalRow<P, D>> {
	if (!UUID.test(spid)) throw notFound();
	const { rows } = await db.query<ProposalRow<P, D>>(`${SELECT} AND p.id = $2`, [projectId, spid]);
	if (!rows[0]) throw notFound();
	return rows[0];
}

export async function nodeCount(db: Db, projectId: string): Promise<number> {
	const { rows } = await db.query<{ n: number }>('SELECT count(*)::integer AS n FROM node WHERE project_id = $1', [projectId]);
	return rows[0]!.n;
}

const NOT_EMPTY = 'The model has nodes already. Starting from the map only fills an empty model; change this one on the Network, or use the map’s per-feature tools.';
export const km2 = (m2: number) => `${(m2 / 1e6).toFixed(2)} km²`;
const DEFAULT_ROLE_NAME: Record<UnitRole, string> = { dam: 'Dam unit', abstraction: 'Abstraction unit', user: 'Water user', gauge: 'Gauge' };
const REST_NAME = 'Rest of the catchment';
const OUTLET_NAME = 'Outflow gauge';
const NO_DEM_METHOD =
	'No elevation model on the server: the units come from the points as placed; each drains into the outflow gauge and has no area until one is typed or drawn; the rest of the catchment is the boundary on the map.';

interface MapInputs {
	boundary: { id: string; geometry: Polygonal; areaM2: number } | null;
	outlet: { featureId: string | null; name: string; point: Position | null; foundIn: StartPlan['outlet']['foundIn'] };
	points: { featureId: string; name: string; role: UnitRole; geometry: Geometry }[];
}

/** The boundary, the outlet and the points the request names, read and checked (one transaction). */
async function readMapInputs(db: Db, projectId: string, body: z.infer<typeof ProposeBody>): Promise<MapInputs> {
	const { rows: b } = await db.query<{ id: string; geometry: Polygonal; area_m2: number }>(
		`SELECT id, geometry, area_m2 FROM map_feature WHERE project_id = $1 AND kind = 'catchment_boundary' ORDER BY created_at LIMIT 1`,
		[projectId]
	);
	const boundary = b[0] ? { id: b[0].id, geometry: b[0].geometry, areaM2: b[0].area_m2 } : null;
	const ids = [...body.points.map((p) => p.featureId), ...(body.outletFeatureId ? [body.outletFeatureId] : [])];
	const { rows: fs } = await db.query<{ id: string; kind: string; name: string; geometry: Geometry }>(
		'SELECT id, kind, name, geometry FROM map_feature WHERE project_id = $1 AND id = ANY($2::uuid[])',
		[projectId, ids]
	);
	const byId = new Map(fs.map((f) => [f.id, f]));
	let outlet: MapInputs['outlet'];
	if (body.outletFeatureId) {
		const f = byId.get(body.outletFeatureId);
		if (!f) throw new ApiError(400, 'The outlet gauge is not on this catchment’s map.');
		if (f.kind !== 'gauge' || f.geometry.type !== 'Point') throw new ApiError(400, 'The outlet must be a gauge point on the map.');
		if (body.points.some((p) => p.featureId === f.id)) throw new ApiError(400, 'The outlet gauge can’t also be a unit.');
		outlet = { featureId: f.id, name: oneLineName(f.name) || OUTLET_NAME, point: f.geometry.coordinates, foundIn: 'gauge' };
	} else {
		if (!boundary) throw new ApiError(400, 'Put the catchment boundary on the map first (draw, delineate or upload it), or pick the outlet gauge.');
		// A boundary that came from Delineate knows its outlet; any other finds it inside the boundary.
		const { rows: d } = await db.query<{ outlet_lon: number; outlet_lat: number }>(
			`SELECT outlet_lon, outlet_lat FROM delineation_proposal WHERE project_id = $1 AND feature_id = $2 AND status = 'accepted' ORDER BY decided_at DESC LIMIT 1`,
			[projectId, boundary.id]
		);
		outlet = d[0]
			? { featureId: null, name: OUTLET_NAME, point: [d[0].outlet_lon, d[0].outlet_lat], foundIn: 'delineation' }
			: { featureId: null, name: OUTLET_NAME, point: null, foundIn: 'boundary' };
	}
	const counter: Record<UnitRole, number> = { dam: 0, abstraction: 0, user: 0, gauge: 0 };
	const points = body.points.map((p) => {
		const f = byId.get(p.featureId);
		if (!f) throw new ApiError(400, 'A point is not on this catchment’s map (deleted since?). Reload the map and propose again.');
		const polygon = f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon';
		if (!(f.geometry.type === 'Point' || (polygon && f.kind === 'dam'))) {
			throw new ApiError(400, `“${f.name || 'A feature'}” is not a point or a dam: only points and dams can be units.`);
		}
		if (!['dam', 'gauge', 'other'].includes(f.kind)) throw new ApiError(400, `“${f.name || 'A feature'}” can’t be a unit.`);
		// A gauge node stands for a gauge on the map (map_feature's KIND_NODES), so only a gauge point is one.
		if (p.role === 'gauge' && !(f.kind === 'gauge' && f.geometry.type === 'Point')) throw new ApiError(400, `“${f.name || 'A feature'}” is not a gauge point, so it can’t be a gauge node.`);
		return { featureId: f.id, name: oneLineName(f.name) || `${DEFAULT_ROLE_NAME[p.role]} ${++counter[p.role]}`, role: p.role, geometry: f.geometry };
	});
	return { boundary, outlet, points };
}

/**
 * The plan without an elevation model: the points become units in the order
 * given, all draining into the outflow gauge, with no area. With a boundary,
 * a point outside it is dropped (it isn't in the catchment), as the DEM
 * drops one that doesn't drain to the outlet.
 */
export function planWithoutDem(inputs: MapInputs): StartPlan {
	const boundary = inputs.boundary?.geometry ?? null;
	const outside = (p: MapInputs['points'][number]) => !!boundary && !pointInGeometry(pointOf(p.geometry), boundary);
	return {
		fromDem: false,
		outlet: { ...inputs.outlet, point: inputs.outlet.point, snapDistanceM: null, foundIn: inputs.outlet.foundIn === 'boundary' ? null : inputs.outlet.foundIn, placement: null },
		catchment: { areaM2: null, boundaryAreaM2: inputs.boundary?.areaM2 ?? null },
		units: inputs.points.filter((p) => !outside(p)).map((p) => ({
			key: p.featureId,
			featureName: p.name,
			role: p.role,
			name: p.name,
			point: pointOf(p.geometry),
			snapDistanceM: null,
			areaM2: null,
			totalAreaM2: null,
			geometry: null,
			drainsInto: null,
			drainsIntoProposed: false,
			placement: null
		})),
		rest: { name: REST_NAME, areaM2: inputs.boundary?.areaM2 ?? null, geometry: inputs.boundary?.geometry ?? null },
		dropped: inputs.points.filter(outside).map((p) => ({ featureId: p.featureId, name: p.name, reason: 'is outside the catchment boundary' })),
		warnings: ['The server has no elevation model, so nothing was delineated: type each unit’s area (or draw its parcel and Use it) and set the order on the Network.'],
		cellSizeM: null,
		zoom: null,
		windowCells: null
	};
}

export function pointOf(g: Geometry): Position {
	if (g.type === 'Point') return g.coordinates;
	const ring = g.type === 'Polygon' ? g.coordinates[0]! : g.type === 'MultiPolygon' ? g.coordinates[0]![0]! : [];
	const n = Math.max(1, ring.length - 1);
	let x = 0;
	let y = 0;
	for (let i = 0; i < n; i++) (x += ring[i]![0]), (y += ring[i]![1]);
	return [Math.round((x / n) * 1e7) / 1e7, Math.round((y / n) * 1e7) / 1e7];
}

/** Order units upstream first (a unit before the one it drains into), keeping the given order among equals. */
export function upstreamFirst<T extends { key: string; drainsInto: string | null }>(units: readonly T[]): T[] {
	const by = new Map(units.map((u) => [u.key, u]));
	const depth = (u: T) => {
		let d = 0;
		for (let k = u.drainsInto; k && d <= units.length; k = by.get(k)?.drainsInto ?? null) d++;
		return d;
	};
	return units.map((u, i) => ({ u, i, d: depth(u) })).sort((a, b) => b.d - a.d || a.i - b.i).map((x) => x.u);
}

/** The key the outlet's reach is kept under (no feature id is empty). */
export const OUTLET_KEY = '';

/**
 * Each map point's river reach (and the outlet gauge's), for placing it as Delineate does (pointPlacement.ts). Inside the
 * reading transaction; a point at a confluence without a pick is a 422 `confluence` naming every such point and its rivers.
 */
export async function readReaches(
	db: Db,
	outlet: { name: string; point: Position | null; foundIn: string | null },
	points: readonly { featureId: string; name: string; geometry: Geometry }[],
	choices: { outletReach?: { dataset: string; reachId: number }; outletUseLarger?: boolean; points: readonly { featureId: string; reach?: { dataset: string; reachId: number }; useLarger?: boolean }[] }
): Promise<Map<string, PointReach>> {
	const by = new Map(choices.points.map((p) => [p.featureId, p]));
	try {
		return await pointReaches(db, [
			...(outlet.foundIn === 'gauge' && outlet.point ? [{ key: OUTLET_KEY, name: outlet.name, at: outlet.point, reach: choices.outletReach ?? null, useLarger: choices.outletUseLarger }] : []),
			...points.flatMap((p) => (p.geometry.type === 'Point' ? [{ key: p.featureId, name: p.name || 'A point', at: p.geometry.coordinates, reach: by.get(p.featureId)?.reach ?? null, useLarger: by.get(p.featureId)?.useLarger }] : []))
		]);
	} catch (err) {
		if (err instanceof PointsAtConfluence) throw new ApiError(422, err.message, { reason: 'confluence', points: err.points });
		if (err instanceof ReachNotNearPoint) throw new ApiError(400, err.message);
		throw err;
	}
}

/** The outlet's placement hints: a gauge's reach, a delineated outlet's own cell (already on the channel), else none. */
export function outletHints(foundIn: string | null, reaches: ReadonlyMap<string, PointReach>): PlacementHints | undefined {
	return foundIn === 'delineation' ? { exact: true } : reaches.get(OUTLET_KEY)?.hints;
}

export const startRoutes = new Hono<AuthEnv>()
	.get('/:id/map/start', async (c) => {
		const id = c.req.param('id');
		const { proposals, empty, started } = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			const { rows } = await db.query<ProposalRow>(`${SELECT} ORDER BY p.created_at DESC, p.id LIMIT ${LISTED}`, [id]);
			const { rows: st } = await db.query<{ started: boolean }>(`SELECT EXISTS (SELECT 1 FROM start_proposal WHERE project_id = $1 AND mode = 'start' AND status = 'applied') AS started`, [id]);
			return { proposals: rows.map(toProposal), empty: (await nodeCount(db, id)) === 0, started: st[0]!.started };
		});
		const dem = configuredDem();
		let dataset = null;
		if (dem) {
			try {
				dataset = await dem.info();
			} catch (err) {
				logEvent('warn', { event: 'dem_unreadable', ...safeError(err) });
			}
		}
		return c.json({ elevation: dataset !== null, dataset, modelEmpty: empty, startedFromMap: started, proposals });
	})
	.post('/:id/map/start', async (c) => {
		const body = ProposeBody.parse(await readJson(c));
		const id = c.req.param('id');
		const userId = c.get('userId');
		const { inputs, reaches, attempt } = await withUser(userId, async (db) => {
			await requireRole(db, id, 'editor');
			if ((await nodeCount(db, id)) > 0) throw new ApiError(409, NOT_EMPTY);
			const { rows } = await db.query<{ n: number }>(`SELECT count(*)::integer AS n FROM start_proposal WHERE project_id = $1 AND created_at > now() - interval '1 hour'`, [id]);
			if (rows[0]!.n >= START_PROPOSALS_PER_HOUR) {
				throw new ApiError(429, `This catchment has asked for ${START_PROPOSALS_PER_HOUR} proposals in the last hour; try again later.`);
			}
			// Counted before any work, refused and failed attempts too (184_dem_attempt).
			const attempt = await beginDemAttempt(db, 'start');
			const inputs = await readMapInputs(db, id, body);
			// Each point's river reach, with a DEM to place it on (without one nothing is placed, so nothing is asked).
			const reaches = configuredDem() ? await readReaches(db, inputs.outlet, inputs.points, body) : new Map<string, PointReach>();
			return { inputs, reaches, attempt };
		});
		try {
			const dem = configuredDem();
			let plan: StartPlan;
			let dataset: { label: string; fingerprint: string } | null = null;
			let method = NO_DEM_METHOD;
			let methodVersion = START_METHOD_VERSION;
			let demReadable = false;
			if (dem) {
				try {
					await dem.info();
					demReadable = true;
				} catch (err) {
					logEvent('warn', { event: 'dem_unreadable', ...safeError(err) });
				}
			}
			if (!dem || !demReadable) {
				if (!inputs.boundary && !inputs.points.length) throw new ApiError(400, 'Put the catchment boundary or some points on the map first.');
				plan = planWithoutDem(inputs);
			} else {
				let r;
				try {
					r = await delineateUnits(dem, {
						outlet: inputs.outlet.point,
						outletHints: outletHints(inputs.outlet.foundIn, reaches),
						boundary: inputs.boundary?.geometry ?? null,
						points: inputs.points.map((p) => ({ id: p.featureId, role: p.role, geometry: p.geometry, ...reaches.get(p.featureId)?.hints }))
					});
				} catch (err) {
					if (err instanceof DelineationRefused) throw new ApiError(422, err.message, { reason: err.code });
					logEvent('error', { event: 'start_proposal_failed', ...safeError(err) });
					throw new ApiError(503, 'The elevation model could not be read just now. Try again; if it keeps failing, the operator should check DEM_URL.');
				}
				const named = new Map(inputs.points.map((p) => [p.featureId, p]));
				const warnings: string[] = [];
				const outletPlacement = placementOf(r.outlet, reaches.get(OUTLET_KEY));
				// The outlet's placement first: every unit is placed against it.
				if (inputs.outlet.point) warnings.push(...placementWarnings(inputs.outlet.name, inputs.outlet.point, outletPlacement, true));
				if (inputs.boundary && Math.abs(r.catchment.areaM2 / inputs.boundary.areaM2 - 1) > BOUNDARY_MISMATCH) {
					warnings.push(
						`The catchment above the outlet is ${km2(r.catchment.areaM2)} on the elevation model, but the boundary on the map is ${km2(inputs.boundary.areaM2)}. The units’ areas follow the elevation model; check the outlet and the boundary.`
					);
				}
				const units: StartUnit[] = r.units.map((u) => ({
					key: u.id,
					featureName: named.get(u.id)!.name,
					role: u.role,
					name: named.get(u.id)!.name,
					point: u.point,
					snapDistanceM: u.snapDistanceM,
					areaM2: u.role === 'user' || u.role === 'gauge' ? null : u.areaM2,
					// A gauge's whole area above it is worth showing (what it measures); a user's isn't.
					totalAreaM2: u.role === 'user' ? null : u.totalAreaM2,
					geometry: u.geometry,
					drainsInto: u.drainsInto,
					drainsIntoProposed: true,
					placement: placementOf(u, reaches.get(u.id))
				}));
				const dropped = r.dropped.map((d) => ({ featureId: d.id, name: named.get(d.id)!.name, reason: d.reason, ...(d.placedBy ? { placement: placementOf(d, reaches.get(d.id)) } : {}) }));
				// A dropped point snapped beside its river: the larger channel is how to bring it in.
				for (const d of dropped) if (d.placement?.larger) warnings.push(...placementWarnings(d.name || 'A point', pointOf(named.get(d.featureId)!.geometry), { ...d.placement, unmatched: false }));
				for (const u of units) {
					if (u.placement) warnings.push(...placementWarnings(u.name, pointOf(named.get(u.key)!.geometry), u.placement));
					if (u.role !== 'user' && u.role !== 'gauge' && u.areaM2 !== null && u.areaM2 < TINY_PIECE_M2) warnings.push(`${u.name}’s own area is under a hectare: is its point right on top of another unit’s?`);
					if (u.role !== 'user' && u.role !== 'gauge' && u.areaM2 !== null && !u.geometry) warnings.push(`${u.name}’s outline couldn’t be made a valid polygon, so its area has no parcel to save; type it in instead.`);
				}
				plan = {
					fromDem: true,
					outlet: { featureId: inputs.outlet.featureId, name: inputs.outlet.name, point: r.outlet.point, snapDistanceM: r.outlet.snapDistanceM, foundIn: inputs.outlet.foundIn, placement: outletPlacement },
					catchment: { areaM2: r.catchment.areaM2, boundaryAreaM2: inputs.boundary?.areaM2 ?? null },
					units: upstreamFirst(units),
					rest: { name: REST_NAME, areaM2: r.rest.areaM2, geometry: r.rest.geometry },
					dropped,
					warnings,
					cellSizeM: r.cellSizeM,
					zoom: r.zoom,
					windowCells: r.windowCells
				};
				dataset = { label: r.dataset.label, fingerprint: r.dataset.fingerprint };
				method = r.method;
				methodVersion = r.methodVersion;
			}
			return await withUser(userId, async (db) => {
				await requireRole(db, id, 'editor');
				if ((await nodeCount(db, id)) > 0) throw new ApiError(409, NOT_EMPTY);
				await db.query(`UPDATE start_proposal SET status = 'superseded' WHERE project_id = $1 AND status = 'proposed'`, [id]);
				const { rows } = await db
					.query<{ id: string }>(
						`INSERT INTO start_proposal (project_id, plan, from_dem, dataset, dataset_fingerprint, method, method_version, created_by)
						 VALUES ($1, $2, $3, $4, $5, $6, $7, app_current_user_id()) RETURNING id`,
						[id, JSON.stringify(plan), plan.fromDem, dataset?.label ?? null, dataset?.fingerprint ?? null, method, methodVersion]
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
				const proposal = toProposal(await loadProposal(db, id, rows[0]!.id));
				await recordAudit(db, id, 'map.start_proposed', {
					proposalId: proposal.id,
					units: plan.units.length,
					dropped: plan.dropped.length,
					fromDem: plan.fromDem,
					dataset: dataset?.label ?? null,
					methodVersion
				});
				return c.json({ proposal }, 201);
			});
		} finally {
			await finishDemAttempt(userId, attempt);
		}
	})
	.post('/:id/map/start/:spid/apply', async (c) => {
		const body = ApplyBody.parse(await readJson(c));
		const { id, spid } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const p = await loadProposal(db, id, spid);
			// Locked, then re-read: two applies of one proposal can't both make a model.
			const { rows: st } = await db.query<{ status: string }>('SELECT status FROM start_proposal WHERE id = $1 AND project_id = $2 FOR UPDATE', [spid, id]);
			if (st[0]?.status !== 'proposed') throw new ApiError(409, `That proposal is ${st[0]?.status ?? p.status}, so it can no longer be applied; propose again.`);
			if (p.mode !== 'start') throw new ApiError(409, 'That proposal divides the model; apply it from Divide the model.');
			const plan = p.plan;
			// The model is locked by beginModelChange; an empty one is the only one this fills.
			const change = await beginModelChange(db, id);
			const model = await loadModel(db, id);
			if (model.nodes.length) throw new ApiError(409, NOT_EMPTY);
			const ticks = new Map(body.units.map((u) => [u.key, u]));
			if (ticks.size !== body.units.length || ticks.size !== plan.units.length || plan.units.some((u) => !ticks.has(u.key))) {
				throw new ApiError(400, 'The ticks must name every proposed unit once, and only those.');
			}
			const names = [body.outletName, ...body.units.map((u) => u.name), ...(body.rest.include ? [body.rest.name] : [])];
			const seen = new Set<string>();
			for (const n of names) {
				const k = n.trim().toLowerCase();
				if (seen.has(k)) throw new ApiError(400, `Two nodes would be called “${n.trim()}”; give each a name of its own.`);
				seen.add(k);
			}
			for (const u of plan.units) {
				const t = ticks.get(u.key)!;
				if (t.area && (u.areaM2 === null || !u.geometry)) throw new ApiError(400, `${t.name} has no proposed area to take.`);
				if (t.drainsInto && !u.drainsIntoProposed) throw new ApiError(400, `${t.name} has no proposed order to take.`);
				if (t.runoffToDam && u.role !== 'dam') throw new ApiError(400, `${t.name} is not a dam unit.`);
			}
			if (body.rest.include && body.rest.area && (plan.rest.areaM2 === null || !plan.rest.geometry)) throw new ApiError(400, 'The rest of the catchment has no proposed area to take.');

			// The nodes: the outflow gauge, the units (upstream first, as the plan lists them), the rest.
			const outlet: NetworkNode = { ...newNetworkNode(crypto.randomUUID(), 0, null), name: body.outletName.trim() };
			const nodeOf = new Map(plan.units.map((u) => [u.key, crypto.randomUUID()]));
			const nodes: NetworkNode[] = [outlet];
			plan.units.forEach((u, i) => {
				const t = ticks.get(u.key)!;
				const down = t.drainsInto && u.drainsInto ? nodeOf.get(u.drainsInto)! : outlet.id;
				const n: NetworkNode = { ...newNetworkNode(nodeOf.get(u.key)!, i + 1, down), name: t.name.trim(), kind: u.role === 'user' ? 'user' : u.role === 'gauge' ? 'gauge' : 'farm' };
				if (t.area && u.areaM2 !== null) n.areaKm2 = u.areaM2 / 1e6;
				if (t.runoffToDam) n.pctRunoffToDam = 1;
				nodes.push(n);
			});
			const restId = body.rest.include ? crypto.randomUUID() : null;
			if (restId) {
				const n: NetworkNode = { ...newNetworkNode(restId, plan.units.length + 1, outlet.id), name: body.rest.name.trim() };
				if (body.rest.area && plan.rest.areaM2 !== null) n.areaKm2 = plan.rest.areaM2 / 1e6;
				nodes.push(n);
			}
			const next = ModelBody.parse({ ...model, nodes });
			const problems = modelProblems(next);
			if (problems.length) throw new ApiError(400, 'The proposed model doesn’t pass the model’s checks.', problems);
			await saveModel(db, id, next);

			// The parcels: each ticked area's outline, linked to its unit, and the unit's area from it (as Use this area does).
			const provenance = p.dataset ? `Sub-catchment delineated from ${p.dataset} (${p.method_version}); check it against the map.` : `From the map (${p.method_version}).`;
			const parcel = async (nodeId: string, name: string, geometry: Polygonal, areaM2: number): Promise<string> => {
				const { rows } = await db.query<{ id: string }>(
					`INSERT INTO map_feature (project_id, kind, name, node_id, geometry, properties, area_m2, created_by)
					 VALUES ($1, 'farm_parcel', $2, $3, $4, $5, $6, app_current_user_id()) RETURNING id`,
					[id, name, nodeId, JSON.stringify(geometry), JSON.stringify({ description: provenance.slice(0, 500) }), areaM2]
				);
				await db.query(`UPDATE node SET area_source = 'map', area_feature_id = $3 WHERE id = $1 AND project_id = $2`, [nodeId, id, rows[0]!.id]);
				return rows[0]!.id;
			};
			const decisionUnits: StartDecision['units'] = [];
			for (const u of plan.units) {
				const t = ticks.get(u.key)!;
				const nodeId = nodeOf.get(u.key)!;
				const parcelId = t.area && u.geometry && u.areaM2 !== null ? await parcel(nodeId, t.name.trim(), u.geometry, u.areaM2) : null;
				// The point the unit came from stands for it now (a link, not a model value).
				// A gauge point stands for a gauge node; a dam or other point for a unit or user (map_feature's KIND_NODES).
				await db.query(`UPDATE map_feature SET node_id = $3 WHERE id = $1 AND project_id = $2 AND kind = ANY($4::text[]) AND node_id IS NULL`, [u.key, id, nodeId, u.role === 'gauge' ? ['gauge'] : ['dam', 'other']]);
				decisionUnits.push({ key: u.key, name: t.name.trim(), nodeId, area: t.area, drainsInto: t.drainsInto, runoffToDam: t.runoffToDam, parcelId });
			}
			let restParcel: string | null = null;
			if (restId && body.rest.area && plan.rest.geometry && plan.rest.areaM2 !== null) restParcel = await parcel(restId, body.rest.name.trim(), plan.rest.geometry, plan.rest.areaM2);
			if (plan.outlet.featureId) await db.query(`UPDATE map_feature SET node_id = $3 WHERE id = $1 AND project_id = $2 AND kind = 'gauge' AND node_id IS NULL`, [plan.outlet.featureId, id, outlet.id]);

			const areas = decisionUnits.filter((u) => u.area).length + (restParcel ? 1 : 0);
			const orders = decisionUnits.filter((u) => u.drainsInto).length;
			const revision = await recordModelRevision(db, id, {
				source: 'model_put',
				before: change.before,
				reason: `Started from the map: ${nodes.length} nodes; ${areas} ${areas === 1 ? 'area' : 'areas'} and ${orders} drains-into from ${p.dataset ? `${p.dataset}, ${p.method_version}` : 'the points as placed'}`.slice(0, 500)
			});
			const decision: StartDecision = {
				outlet: { name: outlet.name, nodeId: outlet.id },
				units: decisionUnits,
				rest: { include: body.rest.include, name: body.rest.name.trim(), area: body.rest.area, nodeId: restId, parcelId: restParcel },
				revisionId: revision?.id ?? null
			};
			await db.query(`UPDATE start_proposal SET status = 'applied', decision = $3, decided_by = app_current_user_id(), decided_at = now() WHERE id = $1 AND project_id = $2`, [
				spid,
				id,
				JSON.stringify(decision)
			]);
			await recordAudit(db, id, 'map.start_applied', { proposalId: spid, nodes: nodes.length, areas, orders, revisionId: decision.revisionId });
			return c.json({ proposal: toProposal(await loadProposal(db, id, spid)), model: await loadModel(db, id) });
		});
	})
	.post('/:id/map/start/:spid/discard', async (c) => {
		// An empty body only: nothing a caller sends may ride along.
		z.object({}).strict().parse((await readJson(c, { optional: true })) ?? {});
		const { id, spid } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const p = await loadProposal(db, id, spid);
			const { rowCount } = await db.query(
				`UPDATE start_proposal SET status = 'discarded', decided_by = app_current_user_id(), decided_at = now() WHERE id = $1 AND project_id = $2 AND status = 'proposed'`,
				[spid, id]
			);
			if (!rowCount) throw new ApiError(409, 'That proposal is no longer open.');
			await recordAudit(db, id, p.mode === 'divide' ? 'map.divide_discarded' : 'map.start_discarded', { proposalId: spid });
			return c.json({ proposal: toProposal(await loadProposal(db, id, spid)) });
		});
	});
