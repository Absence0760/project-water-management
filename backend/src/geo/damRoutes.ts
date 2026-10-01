// Dam values proposed from the register of dams and the map (issue #326
// Part B, "B-dams"; 157_dam_register.sql; docs/api.md § Catchment map,
// docs/maps.md § Dams from the register and the map).
//
//   GET  /projects/:id/nodes/:nodeId/dam-proposals                 the proposals for a hydrological unit's dam (viewer)
//   POST /projects/:id/nodes/:nodeId/dam-capacity-from-register    accept a registered dam's capacity (editor)
//   POST /projects/:id/nodes/:nodeId/dam-area-from-map             accept the dam polygon's area as the full-supply area (editor)
//
// The map proposes, the modeller decides: nothing here changes the model but
// the two accepts, one value each, each recorded as a model revision whose
// reason names the source (the pattern of geo/routes.ts area-from-map). The
// server re-derives every accepted value; the client only names which.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser, type Db } from '../db/tx.js';
import { beginModelChange, recordModelRevision } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError, notFound } from '../http/errors.js';
import { requireRole, UUID } from '../projects/access.js';
import { damLabel, damOnMap, damRegisterDatasets, RADIUS_M, registerDamsNear } from './damProposals.js';

export const DamCapacityFromRegister = z.object({ registerNo: z.string().trim().min(1).max(20) }).strict();
export const DamAreaFromMap = z.object({ featureId: z.string().uuid() }).strict();

interface DamNode {
	name: string;
	dam_capacity_m3: number;
	dam_area_full_m2: number | null;
}

/** The project's node, a hydrological unit (the only kind with a dam): 404 when it isn't there, 400 when it's another kind. */
async function damNode(db: Db, projectId: string, nodeId: string): Promise<DamNode> {
	if (!UUID.test(nodeId)) throw notFound();
	const { rows } = await db.query<DamNode & { kind: string }>(
		'SELECT name, kind::text AS kind, dam_capacity_m3, dam_area_full_m2 FROM node WHERE id = $1 AND project_id = $2',
		[nodeId, projectId]
	);
	const n = rows[0];
	if (!n) throw notFound();
	if (n.kind !== 'farm') throw new ApiError(400, 'Only a hydrological unit (a farm node) has a dam to propose values for.');
	return n;
}

const m3 = (v: number) => `${Math.round(v)} m³`;
const m2 = (v: number) => `${Math.round(v)} m²`;

export const damRoutes = new Hono<AuthEnv>()
	.get('/:id/nodes/:nodeId/dam-proposals', async (c) => {
		const { id, nodeId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			const n = await damNode(db, id, nodeId);
			const dam = await damOnMap(db, id, nodeId);
			const register = dam ? await registerDamsNear(db, dam.point) : [];
			return c.json({
				nodeId,
				nodeName: n.name,
				current: { damCapacityM3: n.dam_capacity_m3, damAreaFullM2: n.dam_area_full_m2 },
				dam,
				radiusM: RADIUS_M,
				register,
				area:
					dam && dam.areaM2 !== null && dam.areaM2 > 0
						? { featureId: dam.id, featureName: dam.name, areaM2: dam.areaM2, method: 'the dam polygon’s area, computed on the server on the WGS84 ellipsoid' }
						: null,
				datasets: await damRegisterDatasets(db)
			});
		});
	})
	.post('/:id/nodes/:nodeId/dam-capacity-from-register', async (c) => {
		const body = DamCapacityFromRegister.parse(await readJson(c));
		const { id, nodeId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const n = await damNode(db, id, nodeId);
			const dam = await damOnMap(db, id, nodeId);
			if (!dam) throw new ApiError(400, `No dam on the map is linked to ${n.name}: link one on the Map first, so the register can be searched from it.`);
			// Re-derived here: only a dam the proposals would list (near this unit's dam) may be accepted.
			const hit = (await registerDamsNear(db, dam.point)).find((d) => d.registerNo === body.registerNo.toUpperCase());
			if (!hit) throw new ApiError(400, `Registered dam ${body.registerNo} is not within ${RADIUS_M / 1000} km of ${damLabel(dam)}, so it isn't proposed for ${n.name}.`);
			if (hit.capacityM3 === null) throw new ApiError(400, `The register gives no capacity for ${hit.name} (${hit.registerNo}).`);
			const change = await beginModelChange(db, id);
			await db.query('UPDATE node SET dam_capacity_m3 = $3 WHERE id = $1 AND project_id = $2', [nodeId, id, hit.capacityM3]);
			const revision = await recordModelRevision(db, id, {
				source: 'model_put',
				before: change.before,
				reason:
					`Dam capacity of ${n.name} from the register of dams: ${hit.name} (${hit.registerNo}, ${m3(hit.capacityM3)}, ${Math.round(hit.distanceM)} m from ${damLabel(dam)}; ${hit.source})`.slice(0, 500)
			});
			return c.json({ nodeId, damCapacityM3: hit.capacityM3, registerNo: hit.registerNo, revisionId: revision?.id ?? null });
		});
	})
	.post('/:id/nodes/:nodeId/dam-area-from-map', async (c) => {
		const body = DamAreaFromMap.parse(await readJson(c));
		const { id, nodeId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const n = await damNode(db, id, nodeId);
			const { rows } = await db.query<{ id: string; name: string; kind: string; node_id: string | null; area_m2: number | null }>(
				'SELECT id, name, kind, node_id, area_m2 FROM map_feature WHERE id = $1 AND project_id = $2',
				[body.featureId, id]
			);
			const f = rows[0];
			if (!f) throw notFound();
			if (f.kind !== 'dam') throw new ApiError(400, 'Only a dam’s polygon gives a dam’s full-supply area.');
			if (f.area_m2 === null || f.area_m2 <= 0) throw new ApiError(400, 'That dam is a point on the map, with no area; draw its water surface as a polygon.');
			if (f.node_id !== nodeId) throw new ApiError(400, `That dam on the map isn’t linked to ${n.name}; link it on the Map first.`);
			if (!(n.dam_capacity_m3 > 0)) throw new ApiError(400, `${n.name} has no dam capacity yet: set its capacity first, then its full-supply area.`);
			const change = await beginModelChange(db, id);
			await db.query('UPDATE node SET dam_area_full_m2 = $3 WHERE id = $1 AND project_id = $2', [nodeId, id, f.area_m2]);
			const revision = await recordModelRevision(db, id, {
				source: 'model_put',
				before: change.before,
				reason: `Dam full-supply area of ${n.name} from the map: ${damLabel(f)} (${m2(f.area_m2)}, computed from its polygon)`.slice(0, 500)
			});
			return c.json({ nodeId, damAreaFullM2: f.area_m2, areaFeatureId: f.id, revisionId: revision?.id ?? null });
		});
	});
