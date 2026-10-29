// The routes of dividing a model that already has nodes from the map
// (divide.ts, which holds the plan code these share with the worker's
// delineate-plan job; the worker must never reach a routes module or
// jobs/wake.ts, lambda-worker.test.ts).
//
//   POST /projects/:id/map/divide                   propose each linked unit's area (its boundary's) and drains-into (the DEM's), against its current values (editor)
//   POST /projects/:id/map/divide/:spid/apply       take the ticked values (editor)
import { newNetworkNode, type NetworkNode } from '@water-management/engine';
import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { panReferenceLoader } from './panReference.js';
import { featureNameOf } from '../geo/geojson.js';
import { beginModelChange, recordAudit, recordModelRevision } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { logEvent } from '../logging/logEvent.js';
import { safeError } from '../logging/safeError.js';
import { beginDemAttempt, finishDemAttempt } from './attempt.js';
import { loadModel, saveModel } from '../model/store.js';
import { ModelBody, modelProblems } from '../model/validate.js';
import { requireRole } from '../projects/access.js';
import { configuredDem } from './dem.js';
import { DelineationRefused } from './delineate.js';
import { wakeWorker } from '../jobs/wake.js';
import { queuePlan } from './planRequests.js';
import { delineationLimits, jobWindowsFrom, nextJobWindow } from './requests.js';
import {
	BEFORE_BOUNDARIES,
	linkMembers,
	madeBeforeBoundaries,
	loadProposal,
	nodeCount,
	NO_CHOICES,
	readPlacement,
	START_PROPOSALS_PER_HOUR,
	toProposal
} from './start.js';
import { AreaBasis, areaBasisNote, takenAreaM2 } from './areaBasis.js';
import { delineateUnits } from './subcatchments.js';
import {
	DivideApplyBody,
	DivideBody,
	type DivideDecision,
	type DividePlan,
	dividePlanFrom,
	divideRouting,
	EPS_KM2,
	loopIn,
	NO_DEM,
	NOT_EMPTY_NEEDED,
	type Polygonal,
	readDivideInputs,
	storeDivideProposal
} from './divide.js';

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
