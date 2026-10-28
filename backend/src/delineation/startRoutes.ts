// The routes of starting an empty model from the map (start.ts, which holds
// the plan code these share with the worker's delineate-plan job; the worker
// must never reach a routes module or jobs/wake.ts, lambda-worker.test.ts).
//
//   GET  /projects/:id/map/start                    the DEM on or off, the model empty or not, the latest proposals (viewer)
//   POST /projects/:id/map/start                    propose units, areas and the order from the map's points (editor)
//   POST /projects/:id/map/start/:spid/apply        apply the ticked values: the nodes, parcels and links (editor)
//   POST /projects/:id/map/start/:spid/discard      discard an open proposal, a start or a division (editor)
import { newNetworkNode, type NetworkNode } from '@water-management/engine';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { panReferenceLoader } from './panReference.js';
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
import { DelineationRefused, type WindowAim } from './delineate.js';
import { wakeWorker } from '../jobs/wake.js';
import { loadPlanRequest, queuePlan, waitingPlanRequest, type PlanRequest } from './planRequests.js';
import { delineationLimits, jobWindowsFrom, nextJobWindow } from './requests.js';
import { AreaBasis, areaBasisNote, takenAreaM2 } from './areaBasis.js';
import { delineateUnits, START_METHOD_VERSION, type Subcatchments } from './subcatchments.js';
import {
	ApplyBody,
	BEFORE_BOUNDARIES,
	linkMembers,
	LISTED,
	loadProposal,
	madeBeforeBoundaries,
	NO_CHOICES,
	NO_DEM_METHOD,
	nodeCount,
	NOT_EMPTY,
	type PlanMeta,
	planWithoutDem,
	type Polygonal,
	type ProposalRow,
	ProposeBody,
	readMapInputs,
	readPlacement,
	SELECT,
	START_PROPOSALS_PER_HOUR,
	type StartDecision,
	type StartPlan,
	startPlanFrom,
	startRouting,
	storeStartProposal,
	TOO_LARGE_METHOD,
	TOO_LARGE_WARNING,
	toProposal
} from './start.js';

export const startRoutes = new Hono<AuthEnv>()
	.get('/:id/map/start', async (c) => {
		const id = c.req.param('id');
		const { proposals, empty, started, request } = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			const { rows } = await db.query<ProposalRow>(`${SELECT} ORDER BY p.created_at DESC, p.id LIMIT ${LISTED}`, [id]);
			const { rows: st } = await db.query<{ started: boolean }>(`SELECT EXISTS (SELECT 1 FROM start_proposal WHERE project_id = $1 AND mode = 'start' AND status = 'applied') AS started`, [id]);
			// A Start or Divide the worker is still routing (#646 item 3): the Map shows it waiting, and picks up its outcome.
			return { proposals: rows.map(toProposal), empty: (await nodeCount(db, id)) === 0, started: st[0]!.started, request: await waitingPlanRequest(db, id) };
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
		return c.json({ elevation: dataset !== null, dataset, modelEmpty: empty, startedFromMap: started, proposals, request });
	})
	.get('/:id/map/start/requests/:rid', async (c) => {
		const { id, rid } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			return c.json({ request: await loadPlanRequest(db, id, rid) });
		});
	})
	.post('/:id/map/start', async (c) => {
		const body = ProposeBody.parse(await readJson(c));
		const id = c.req.param('id');
		const userId = c.get('userId');
		const { inputs, placing, attempt } = await withUser(userId, async (db) => {
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
			const placing = configuredDem() ? await readPlacement(db, inputs.outlet, body) : NO_CHOICES;
			return { inputs, placing, attempt };
		});
		try {
			const dem = configuredDem();
			let plan: StartPlan;
			let meta: PlanMeta = { dataset: null, method: NO_DEM_METHOD, methodVersion: START_METHOD_VERSION };
			/** Too large for the request (F11): the worker goes on from this window, over where it cut the catchment. */
			let handOff: { fromWindow: number; aim: WindowAim | null } | null = null;
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
				if (!inputs.boundary && !inputs.points.length) throw new ApiError(400, 'Put the catchment boundary, or the units’ boundaries, on the map first.');
				plan = planWithoutDem(inputs);
			} else {
				let r: Subcatchments | null = null;
				try {
					r = await delineateUnits(dem, startRouting(inputs, placing), {
						windows: delineationLimits.requestWindows,
						panReference: panReferenceLoader((fn) => withUser(userId, fn, { readOnly: true }), id)
					});
				} catch (err) {
					if (!(err instanceof DelineationRefused)) {
						logEvent('error', { event: 'start_proposal_failed', ...safeError(err) });
						throw new ApiError(503, 'The elevation model could not be read just now. Try again; if it keeps failing, the operator should check DEM_URL.');
					}
					// Too large to route here (F11): since start-16 the areas are the boundaries', so the plan a server without a
					// DEM makes from the same map still holds; the worker routes the rest, if a larger window can (#646 item 3).
					if (err.code !== 'too_large') throw new ApiError(422, err.message, { reason: err.code });
					const next = nextJobWindow(err.windowCells);
					if (next !== null && jobWindowsFrom(next).length > 0) handOff = { fromWindow: next, aim: err.aim ?? null };
				}
				if (r) ({ plan, meta } = startPlanFrom(inputs, r));
				else {
					plan = planWithoutDem(inputs, TOO_LARGE_WARNING);
					meta = { dataset: null, method: TOO_LARGE_METHOD, methodVersion: START_METHOD_VERSION };
				}
			}
			const stored = await withUser(userId, async (db) => {
				await requireRole(db, id, 'editor');
				const proposal = await storeStartProposal(db, id, plan, meta);
				let queued: { request: PlanRequest; jobId: string } | null = null;
				if (handOff) {
					try {
						queued = await queuePlan(db, { projectId: id, userId, kind: 'start', body, fromWindow: handOff.fromWindow, aim: handOff.aim, fallbackId: proposal.id });
					} catch (err) {
						// Another large delineation of this account's is waiting or running: the proposal without the order stands.
						if (!(err instanceof ApiError && err.status === 429)) throw err;
						logEvent('info', { event: 'start_plan_not_queued', reason: err.message });
					}
				}
				return { proposal, queued };
			});
			if (stored.queued) await wakeWorker(stored.queued.jobId);
			return c.json({ proposal: stored.proposal, request: stored.queued?.request ?? null }, 201);
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
			if (madeBeforeBoundaries(plan.units)) throw new ApiError(409, BEFORE_BOUNDARIES);
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
				if (seen.has(k)) throw new ApiError(400, `Two hydrological units would be called “${n.trim()}”; give each a name of its own.`);
				seen.add(k);
			}
			for (const u of plan.units) {
				const t = ticks.get(u.key)!;
				if (t.area && (u.areaM2 === null || !u.geometry)) throw new ApiError(400, `${t.name} has no proposed area to take.`);
				if (t.areaBasis === 'effective' && !t.area) throw new ApiError(400, `Tick ${t.name}’s area to take its effective area.`);
				if (t.drainsInto && !u.drainsIntoProposed) throw new ApiError(400, `${t.name} has no proposed order to take.`);
				// The composite dam's share of the unit's runoff is the user's to enter, never proposed (start-16).
				if (t.runoffToDam || t.upstreamToDam) throw new ApiError(400, `${t.name}’s composite dam takes the shares of runoff and of the upstream inflow you enter on the unit: the map proposes neither.`);
			}
			if (body.rest.include && body.rest.area && plan.rest.areaM2 === null) throw new ApiError(400, 'The rest of the catchment has no proposed area to take.');
			// The rest's drains-into (start-17, F10): only one the routing proposed, and only with the rest in the model.
			const restDown = body.rest.drainsInto === true;
			if (restDown && !(body.rest.include && plan.rest.drainsIntoProposed && plan.rest.drainsInto)) throw new ApiError(400, 'The rest of the catchment has no proposed order to take.');
			// A unit's boundary is its area: it must still be the one proposed (start-16).
			const boundaries = plan.units.filter((u) => u.role === 'unit');
			if (boundaries.length) {
				const { rows: now } = await db.query<{ id: string; area_m2: number | null }>('SELECT id, area_m2 FROM map_feature WHERE project_id = $1 AND id = ANY($2::uuid[])', [
					id,
					boundaries.map((u) => u.key)
				]);
				const byId = new Map(now.map((r) => [r.id, r]));
				for (const u of boundaries) {
					const f = byId.get(u.key);
					const t = ticks.get(u.key)!;
					if (!f) throw new ApiError(409, `${t.name.trim()}’s boundary is no longer on the map; propose again.`);
					if (t.area && (f.area_m2 === null || u.areaM2 === null || Math.abs(f.area_m2 - u.areaM2) > 1)) throw new ApiError(409, `${t.name.trim()}’s boundary changed since the proposal; propose again.`);
				}
			}
			if (body.rest.areaBasis === 'effective' && !(body.rest.include && body.rest.area)) throw new ApiError(400, 'Tick the rest of the catchment’s area to take its effective area.');
			// Each taken area, gross unless the effective one is asked for (195); 400 when there's no pans figure for it.
			const taken = new Map<string, number>();
			for (const u of plan.units) {
				const t = ticks.get(u.key)!;
				if (t.area && u.areaM2 !== null) taken.set(u.key, takenAreaM2(t.name.trim(), u.areaM2, u.nonContributingM2, t.areaBasis ?? 'gross'));
			}
			const restTaken =
				body.rest.include && body.rest.area && plan.rest.areaM2 !== null ? takenAreaM2(body.rest.name.trim(), plan.rest.areaM2, plan.rest.nonContributingM2, body.rest.areaBasis ?? 'gross') : null;

			// The nodes: the outflow gauge, the units (upstream first, as the plan lists them), the rest.
			const outlet: NetworkNode = { ...newNetworkNode(crypto.randomUUID(), 0, null), name: body.outletName.trim() };
			const nodeOf = new Map(plan.units.map((u) => [u.key, crypto.randomUUID()]));
			const nodes: NetworkNode[] = [outlet];
			plan.units.forEach((u, i) => {
				const t = ticks.get(u.key)!;
				const down = t.drainsInto && u.drainsInto ? nodeOf.get(u.drainsInto)! : outlet.id;
				const n: NetworkNode = { ...newNetworkNode(nodeOf.get(u.key)!, i + 1, down), name: t.name.trim(), kind: u.role === 'user' ? 'user' : u.role === 'gauge' ? 'gauge' : 'farm' };
				if (taken.has(u.key)) n.areaKm2 = taken.get(u.key)! / 1e6;
				nodes.push(n);
			});
			const restId = body.rest.include ? crypto.randomUUID() : null;
			if (restId) {
				// Into the unit its flow path meets first when that is ticked (start-17, F10); else the outflow gauge, as before.
				const down = restDown && plan.rest.drainsInto ? (nodeOf.get(plan.rest.drainsInto) ?? outlet.id) : outlet.id;
				const n: NetworkNode = { ...newNetworkNode(restId, plan.units.length + 1, down), name: body.rest.name.trim() };
				if (restTaken !== null) n.areaKm2 = restTaken / 1e6;
				nodes.push(n);
			}
			const next = ModelBody.parse({ ...model, nodes });
			const problems = modelProblems(next);
			if (problems.length) throw new ApiError(400, 'The proposed model doesn’t pass the model’s checks.', problems);
			await saveModel(db, id, next);

			// The parcels: each ticked area's outline, linked to its unit, and the unit's area from it (as Use this area does).
			const provenance = p.dataset ? `Sub-catchment delineated from ${p.dataset} (${p.method_version}); check it against the map.` : `From the map (${p.method_version}).`;
			// The parcel keeps the gross area and what of it drains into pans (195); the unit has the area taken, and which.
			const parcel = async (nodeId: string, name: string, geometry: Polygonal, areaM2: number, ncM2: number | undefined, basis: AreaBasis): Promise<string> => {
				const { rows } = await db.query<{ id: string }>(
					`INSERT INTO map_feature (project_id, kind, name, node_id, geometry, properties, area_m2, non_contributing_m2, created_by)
					 VALUES ($1, 'farm_parcel', $2, $3, $4, $5, $6, $7, app_current_user_id()) RETURNING id`,
					[id, name, nodeId, JSON.stringify(geometry), JSON.stringify({ description: provenance.slice(0, 500) }), areaM2, ncM2 === undefined ? null : Math.min(ncM2, areaM2)]
				);
				await db.query(`UPDATE node SET area_source = 'map', area_basis = $4, area_feature_id = $3 WHERE id = $1 AND project_id = $2`, [nodeId, id, rows[0]!.id, basis]);
				return rows[0]!.id;
			};
			const decisionUnits: StartDecision['units'] = [];
			for (const u of plan.units) {
				const t = ticks.get(u.key)!;
				const nodeId = nodeOf.get(u.key)!;
				const basis = t.areaBasis ?? 'gross';
				const bounded = u.role === 'unit';
				// A unit's own boundary is its area (start-16): linked as Use this area does, never copied into a new parcel.
				const parcelId = !bounded && t.area && u.geometry && u.areaM2 !== null ? await parcel(nodeId, t.name.trim(), u.geometry, u.areaM2, u.nonContributingM2, basis) : null;
				if (bounded && t.area) await db.query(`UPDATE node SET area_source = 'map', area_basis = 'gross', area_feature_id = $3 WHERE id = $1 AND project_id = $2`, [nodeId, id, u.key]);
				// The feature the unit came from stands for it now (a link, not a model value): its boundary, or a point.
				// A gauge point stands for a gauge node; a dam or other point for a user; an area for a unit (map_feature's KIND_NODES).
				await db.query(`UPDATE map_feature SET node_id = $3 WHERE id = $1 AND project_id = $2 AND kind = ANY($4::text[]) AND node_id IS NULL`, [
					u.key,
					id,
					nodeId,
					u.role === 'gauge' ? ['gauge'] : bounded ? ['other', 'farm_parcel'] : ['dam', 'other']
				]);
				// Its dams (the composite dam) and abstraction points (the river pump) stand for it too; their sizes stay the user's to enter.
				if (u.members?.length) await linkMembers(db, id, nodeId, u.members);
				decisionUnits.push({ key: u.key, name: t.name.trim(), nodeId, area: t.area, ...(t.area ? { areaBasis: basis } : {}), drainsInto: t.drainsInto, runoffToDam: false, parcelId, ...(bounded ? { boundaryId: u.key } : {}) });
			}
			let restParcel: string | null = null;
			const restBasis = body.rest.areaBasis ?? 'gross';
			if (restId && body.rest.area && plan.rest.geometry && plan.rest.areaM2 !== null)
				restParcel = await parcel(restId, body.rest.name.trim(), plan.rest.geometry, plan.rest.areaM2, plan.rest.nonContributingM2, restBasis);
			if (restId && plan.rest.members?.length) await linkMembers(db, id, restId, plan.rest.members);
			if (plan.outlet.featureId) await db.query(`UPDATE map_feature SET node_id = $3 WHERE id = $1 AND project_id = $2 AND kind = 'gauge' AND node_id IS NULL`, [plan.outlet.featureId, id, outlet.id]);

			const restArea = restTaken !== null;
			const areas = decisionUnits.filter((u) => u.area).length + (restArea ? 1 : 0);
			const orders = decisionUnits.filter((u) => u.drainsInto).length + (restId && restDown ? 1 : 0);
			// Which areas were taken effective (without what drains into pans), so the run's inputs say so (195).
			const effective = [...decisionUnits.filter((u) => u.area && u.areaBasis === 'effective').map((u) => u.name), ...(restArea && restBasis === 'effective' ? [body.rest.name.trim()] : [])];
			const revision = await recordModelRevision(db, id, {
				source: 'model_put',
				before: change.before,
				reason: `Started from the map: ${nodes.length} hydrological units; ${areas} ${areas === 1 ? 'area' : 'areas'}${areaBasisNote(areas, effective)} and ${orders} drains-into from ${p.dataset ? `${p.dataset}, ${p.method_version}` : 'the points as placed'}`.slice(0, 500)
			});
			const decision: StartDecision = {
				outlet: { name: outlet.name, nodeId: outlet.id },
				units: decisionUnits,
				rest: { include: body.rest.include, name: body.rest.name.trim(), area: body.rest.area, ...(restArea ? { areaBasis: restBasis } : {}), ...(restId && restDown ? { drainsInto: true } : {}), nodeId: restId, parcelId: restParcel },
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
