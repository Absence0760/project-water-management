// Catchments delineated from a click on the Map (issue #326 B-delineate,
// #342 map item 4; 175_delineation.sql, docs/design/delineation.md,
// docs/api.md § Delineation).
//
//   GET  /projects/:id/map/delineation                  on or off, the dataset, the latest proposals (viewer)
//   POST /projects/:id/map/delineation                  delineate upstream of a point: a new proposal (editor), or, for a
//                                                        catchment too large for the request, a request the worker answers (202)
//   GET  /projects/:id/map/delineation/requests/:rid    that request: waiting, running, or what came of it (viewer)
//   POST /projects/:id/map/delineation/:pid/accept      save it as the catchment boundary or an "other" polygon (editor)
//   POST /projects/:id/map/delineation/:pid/reject      (editor)
//
// The DEM proposes, the editor decides: a proposal reaches the map only
// through accept, and accepting as the boundary when the project has one
// needs `replaceBoundary: true` (409 otherwise), the import review's rule.
// The computation runs between two short transactions, never holding a
// database connection while it reads tiles and routes flow. A catchment still
// at the edge of the request's largest window (or one the editor says is
// large: `background`) goes to the worker's `delineate` job instead
// (requests.ts, 191_delineation_request), the same code with larger windows.
import { hasNameControlChars, NAME_CONTROL_MESSAGE } from '@water-management/engine';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser, type Db } from '../db/tx.js';
import { currentBoundary, loadFeature, removeBoundary, toFeature } from '../geo/routes.js';
import { recordAudit } from '../history/record.js';
import { wakeWorker } from '../jobs/wake.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { safeError } from '../logging/safeError.js';
import { logEvent } from '../logging/logEvent.js';
import { beginDemAttempt, finishDemAttempt } from './attempt.js';
import { requireRole } from '../projects/access.js';
import { configuredDem } from './dem.js';
import { delineate, DelineationRefused, type WindowAim } from './delineate.js';
import { checkNote, loadProposal, SELECT, storeProposal, toProposal, type ProposalRow } from './proposals.js';
import { delineationLimits, jobWindowsFrom, loadRequest, nextJobWindow, queueDelineation, waitingRequest } from './requests.js';
import { ConfluenceAmbiguity, ReachChoiceBody, reachFor, ReachNotNear } from './reach.js';

/** Delineations one project may ask for in an hour: each is seconds of CPU on the API (docs/design/delineation.md § Where it runs). */
export const DELINEATIONS_PER_HOUR = 30;
/** Proposals the GET lists. */
const LISTED = 10;

const Lon = z.number().finite().min(-180).max(180);
const Lat = z.number().finite().min(-90).max(90);
export const DelineateBody = z
	.object({
		lon: Lon,
		lat: Lat,
		from: z.enum(['outlet', 'dam_wall']),
		/** Keep the point even beside a much larger channel (otherwise 422 `larger_channel`, naming it; place.ts). */
		keepPoint: z.boolean().optional(),
		/** At a confluence, the river reach the editor means (one of the 422 `confluence` choices; its area is read from the database). */
		reach: ReachChoiceBody.optional(),
		/** A catchment the editor knows is large: straight to the worker (202 with the request), skipping the request's own attempt. */
		background: z.boolean().optional()
	})
	.strict();
export const AcceptBody = z
	.object({
		as: z.enum(['catchment_boundary', 'other']),
		/** With `as: 'catchment_boundary'`: replace the project's current boundary (refused without it when there is one). */
		replaceBoundary: z.boolean().optional(),
		name: z.string().trim().min(1).max(100).refine((s) => !hasNameControlChars(s), NAME_CONTROL_MESSAGE).optional()
	})
	.strict();

const DEFAULT_NAME = { outlet: 'Catchment above the outlet (delineated)', dam_wall: 'Catchment above the dam wall (delineated)' } as const;
const km2 = (m2: number) => `${(m2 / 1e6).toFixed(2)} km²`;

export const delineationRoutes = new Hono<AuthEnv>()
	.get('/:id/map/delineation', async (c) => {
		const id = c.req.param('id');
		const { proposals, request } = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			const { rows } = await db.query<ProposalRow>(`${SELECT} ORDER BY p.created_at DESC, p.id LIMIT ${LISTED}`, [id]);
			// A delineation the worker still has: the Map shows it waiting, and picks up its outcome.
			return { proposals: rows.map(toProposal), request: await waitingRequest(db, id) };
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
		// On only when the DEM is configured *and* readable, so the Map never offers a tool that can only fail.
		return c.json({ available: dataset !== null, dataset, proposals, request });
	})
	.get('/:id/map/delineation/requests/:rid', async (c) => {
		const { id, rid } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			return c.json({ request: await loadRequest(db, id, rid) });
		});
	})
	.post('/:id/map/delineation', async (c) => {
		const body = DelineateBody.parse(await readJson(c));
		const id = c.req.param('id');
		const userId = c.get('userId');
		const queue = (db: Db, fromWindow: number, aim: WindowAim | null = null) =>
			queueDelineation(db, { projectId: id, userId, from: body.from, lon: body.lon, lat: body.lat, keepPoint: body.keepPoint, reach: body.reach ?? null, fromWindow, aim });
		const attempt = await withUser(userId, async (db) => {
			await requireRole(db, id, 'editor');
			const { rows } = await db.query<{ n: number }>(
				`SELECT count(*)::integer AS n FROM delineation_proposal WHERE project_id = $1 AND created_at > now() - interval '1 hour'`,
				[id]
			);
			if (rows[0]!.n >= DELINEATIONS_PER_HOUR) {
				throw new ApiError(429, `This catchment has asked for ${DELINEATIONS_PER_HOUR} delineations in the last hour; try again later.`);
			}
			// The river reach the click means, for matching the outlet to its area (issue #374): the one chosen at a
			// confluence, else the nearest; at a confluence with none chosen, the editor is asked (422 `confluence`).
			let reach;
			let junction = null;
			try {
				({ reach, junction } = await reachFor(db, [body.lon, body.lat], body.reach ?? null));
			} catch (err) {
				if (err instanceof ConfluenceAmbiguity) throw new ApiError(422, err.message, { reason: 'confluence', choices: err.choices });
				if (err instanceof ReachNotNear) throw new ApiError(400, err.message);
				throw err;
			}
			// Counted before the DEM work, refused and failed attempts too (184_dem_attempt); a request for the background as well.
			const attemptId = await beginDemAttempt(db, 'delineation');
			if (!body.background) return { id: attemptId, reach, junction, queued: null };
			if (!configuredDem()) throw new ApiError(409, 'Delineation is off: the server has no elevation model (DEM_URL is empty).');
			return { id: attemptId, reach, junction, queued: await queue(db, delineationLimits.jobWindows[0]!) };
		});
		try {
			if (attempt.queued) {
				await wakeWorker(attempt.queued.jobId);
				return c.json({ request: attempt.queued.request }, 202);
			}
			const dem = configuredDem();
			if (!dem) throw new ApiError(409, 'Delineation is off: the server has no elevation model (DEM_URL is empty).');
			let result;
			try {
				result = await delineate(dem, [body.lon, body.lat], {
					windows: delineationLimits.requestWindows,
					// A river cut at the request's last window goes on to the worker's windows.
					capCells: delineationLimits.jobWindows[delineationLimits.jobWindows.length - 1],
					expected: attempt.reach ? { km2: attempt.reach.upstreamKm2, reach: `reach ${attempt.reach.reachId} of ${attempt.reach.dataset}`, chosen: !!body.reach, distanceM: attempt.reach.distanceM, head: attempt.reach.head } : null,
					junction: attempt.junction,
					keepPoint: body.keepPoint
				});
			} catch (err) {
				if (err instanceof DelineationRefused) {
					// Still at the edge of the request's window (or out of its time): the worker goes on from the next window.
					const next = err.code === 'too_large' ? nextJobWindow(err.windowCells) : null;
					if (next !== null && jobWindowsFrom(next).length > 0) {
						const queued = await withUser(userId, async (db) => {
							await requireRole(db, id, 'editor');
							// Where the request's window cut it: the job's first window goes over it, not centred on the click again.
							return queue(db, next, err.aim ?? null);
						});
						await wakeWorker(queued.jobId);
						return c.json({ request: queued.request }, 202);
					}
					throw new ApiError(422, err.message, { reason: err.code, ...(err.larger ? { larger: err.larger } : {}) });
				}
				logEvent('error', { event: 'delineation_failed', ...safeError(err) });
				throw new ApiError(503, 'The elevation model could not be read just now. Try again; if it keeps failing, the operator should check DEM_URL.');
			}
			const r = result;
			return await withUser(userId, async (db) => {
				await requireRole(db, id, 'editor');
				const proposal = await storeProposal(db, id, body.from, r);
				// The river-network check (issue #374): with this answer only, not stored.
				return c.json({ proposal, check: checkNote(r) }, 201);
			});
		} finally {
			await finishDemAttempt(userId, attempt.id);
		}
	})
	.post('/:id/map/delineation/:pid/accept', async (c) => {
		const body = AcceptBody.parse(await readJson(c));
		const { id, pid } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const p = await loadProposal(db, id, pid);
			// Locked, then re-read: two accepts of one proposal can't both make a feature.
			const { rows: st } = await db.query<{ status: string }>('SELECT status FROM delineation_proposal WHERE id = $1 AND project_id = $2 FOR UPDATE', [pid, id]);
			if (st[0]?.status !== 'proposed') throw new ApiError(409, `That proposal is ${st[0]?.status ?? p.status}, so it can no longer be accepted; delineate again.`);
			if (body.as === 'catchment_boundary') {
				const boundary = await currentBoundary(db, id);
				if (boundary && body.replaceBoundary !== true) {
					throw new ApiError(
						409,
						`The catchment already has a boundary${boundary.name ? ` “${boundary.name}”` : ''}. Tick “Replace the current boundary” to replace it with this one, or accept it as an area instead.`
					);
				}
				await removeBoundary(db, id);
			}
			const name = body.name ?? DEFAULT_NAME[p.click_kind];
			const { rows } = await db.query<{ id: string }>(
				`INSERT INTO map_feature (project_id, kind, name, geometry, properties, area_m2, created_by)
				 VALUES ($1, $2, $3, $4, $5, $6, app_current_user_id()) RETURNING id`,
				[id, body.as, name, JSON.stringify(p.geometry), JSON.stringify({ description: `Delineated from ${p.dataset} (${p.method_version}); check it against the map.`.slice(0, 500) }), p.area_m2]
			);
			const featureId = rows[0]!.id;
			await db.query(`UPDATE delineation_proposal SET status = 'accepted', feature_id = $3, decided_by = app_current_user_id(), decided_at = now() WHERE id = $1 AND project_id = $2`, [
				pid,
				id,
				featureId
			]);
			await recordAudit(db, id, 'map.delineation_accepted', { proposalId: pid, featureId, as: body.as, name, areaKm2: Math.round(p.area_m2 / 1e4) / 100 });
			const feature = toFeature(await loadFeature(db, id, featureId));
			return c.json({ proposal: toProposal(await loadProposal(db, id, pid)), feature, summary: `${name}, ${km2(p.area_m2)}` });
		});
	})
	.post('/:id/map/delineation/:pid/reject', async (c) => {
		// An empty body only: nothing a caller sends may ride along.
		z.object({}).strict().parse((await readJson(c, { optional: true })) ?? {});
		const { id, pid } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			await loadProposal(db, id, pid);
			const { rowCount } = await db.query(
				`UPDATE delineation_proposal SET status = 'rejected', decided_by = app_current_user_id(), decided_at = now() WHERE id = $1 AND project_id = $2 AND status = 'proposed'`,
				[pid, id]
			);
			if (!rowCount) throw new ApiError(409, 'That proposal is no longer open.');
			await recordAudit(db, id, 'map.delineation_rejected', { proposalId: pid });
			return c.json({ proposal: toProposal(await loadProposal(db, id, pid)) });
		});
	});
