// Catchments delineated from a click on the Map (issue #326 B-delineate,
// #342 map item 4; 175_delineation.sql, docs/design/delineation.md,
// docs/api.md § Delineation).
//
//   GET  /projects/:id/map/delineation                  on or off, the dataset, the latest proposals (viewer)
//   POST /projects/:id/map/delineation                  delineate upstream of a point: a new proposal (editor)
//   POST /projects/:id/map/delineation/:pid/accept      save it as the catchment boundary or an "other" polygon (editor)
//   POST /projects/:id/map/delineation/:pid/reject      (editor)
//
// The DEM proposes, the editor decides: a proposal reaches the map only
// through accept, and accepting as the boundary when the project has one
// needs `replaceBoundary: true` (409 otherwise), the import review's rule.
// The computation runs between two short transactions, never holding a
// database connection while it reads tiles and routes flow.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser, type Db } from '../db/tx.js';
import { currentBoundary, loadFeature, removeBoundary, toFeature } from '../geo/routes.js';
import type { Geometry } from '../geo/geojson.js';
import { recordAudit } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError, notFound } from '../http/errors.js';
import { safeError } from '../logging/safeError.js';
import { logEvent } from '../logging/logEvent.js';
import { beginDemAttempt, finishDemAttempt } from './attempt.js';
import { requireRole, UUID } from '../projects/access.js';
import { configuredDem } from './dem.js';
import { delineate, DelineationRefused } from './delineate.js';
import { nearestReach } from './reach.js';

/** Delineations one project may ask for in an hour: each is seconds of CPU on the API (docs/design/delineation.md § Where it runs). */
export const DELINEATIONS_PER_HOUR = 30;
/** Superseded and rejected proposals kept per project (accepted ones are all kept, as their features' provenance). */
export const PROPOSALS_KEPT = 50;
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
		keepPoint: z.boolean().optional()
	})
	.strict();
export const AcceptBody = z
	.object({
		as: z.enum(['catchment_boundary', 'other']),
		/** With `as: 'catchment_boundary'`: replace the project's current boundary (refused without it when there is one). */
		replaceBoundary: z.boolean().optional(),
		name: z.string().trim().min(1).max(100).optional()
	})
	.strict();

interface ProposalRow {
	id: string;
	status: 'proposed' | 'accepted' | 'rejected' | 'superseded';
	click_kind: 'outlet' | 'dam_wall';
	click_lon: number;
	click_lat: number;
	outlet_lon: number;
	outlet_lat: number;
	snap_distance_m: number;
	geometry: Extract<Geometry, { type: 'Polygon' }>;
	area_m2: number;
	cells: number;
	cell_size_m: number;
	zoom: number;
	window_cells: number;
	dataset: string;
	dataset_fingerprint: string;
	method: string;
	method_version: string;
	feature_id: string | null;
	created_by_name: string | null;
	created_at: Date;
	decided_by_name: string | null;
	decided_at: Date | null;
}

const SELECT = `
	SELECT p.id, p.status, p.click_kind, p.click_lon, p.click_lat, p.outlet_lon, p.outlet_lat, p.snap_distance_m, p.geometry,
		p.area_m2, p.cells, p.cell_size_m, p.zoom, p.window_cells, p.dataset, p.dataset_fingerprint, p.method, p.method_version,
		p.feature_id, cu.display_name AS created_by_name, p.created_at, du.display_name AS decided_by_name, p.decided_at
	FROM delineation_proposal p
	LEFT JOIN app_user cu ON cu.id = p.created_by
	LEFT JOIN app_user du ON du.id = p.decided_by
	WHERE p.project_id = $1`;

const toProposal = (r: ProposalRow) => ({
	id: r.id,
	status: r.status,
	from: r.click_kind,
	click: [r.click_lon, r.click_lat] as [number, number],
	outlet: [r.outlet_lon, r.outlet_lat] as [number, number],
	snapDistanceM: r.snap_distance_m,
	geometry: r.geometry,
	areaM2: r.area_m2,
	cells: r.cells,
	cellSizeM: r.cell_size_m,
	zoom: r.zoom,
	windowCells: r.window_cells,
	dataset: r.dataset,
	datasetFingerprint: r.dataset_fingerprint,
	method: r.method,
	methodVersion: r.method_version,
	featureId: r.feature_id,
	createdBy: r.created_by_name,
	createdAt: r.created_at.toISOString(),
	decidedBy: r.decided_by_name,
	decidedAt: r.decided_at?.toISOString() ?? null
});
export type DelineationProposal = ReturnType<typeof toProposal>;

async function loadProposal(db: Db, projectId: string, pid: string): Promise<ProposalRow> {
	if (!UUID.test(pid)) throw notFound();
	const { rows } = await db.query<ProposalRow>(`${SELECT} AND p.id = $2`, [projectId, pid]);
	if (!rows[0]) throw notFound();
	return rows[0];
}

const DEFAULT_NAME = { outlet: 'Catchment above the outlet (delineated)', dam_wall: 'Catchment above the dam wall (delineated)' } as const;
const km2 = (m2: number) => `${(m2 / 1e6).toFixed(2)} km²`;

export const delineationRoutes = new Hono<AuthEnv>()
	.get('/:id/map/delineation', async (c) => {
		const id = c.req.param('id');
		const proposals = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			const { rows } = await db.query<ProposalRow>(`${SELECT} ORDER BY p.created_at DESC, p.id LIMIT ${LISTED}`, [id]);
			return rows.map(toProposal);
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
		return c.json({ available: dataset !== null, dataset, proposals });
	})
	.post('/:id/map/delineation', async (c) => {
		const body = DelineateBody.parse(await readJson(c));
		const id = c.req.param('id');
		const userId = c.get('userId');
		const attempt = await withUser(userId, async (db) => {
			await requireRole(db, id, 'editor');
			const { rows } = await db.query<{ n: number }>(
				`SELECT count(*)::integer AS n FROM delineation_proposal WHERE project_id = $1 AND created_at > now() - interval '1 hour'`,
				[id]
			);
			if (rows[0]!.n >= DELINEATIONS_PER_HOUR) {
				throw new ApiError(429, `This catchment has asked for ${DELINEATIONS_PER_HOUR} delineations in the last hour; try again later.`);
			}
			// The nearest river reach's upstream area, for matching the outlet to it (issue #374).
			const reach = await nearestReach(db, [body.lon, body.lat]);
			// Counted before the DEM work, refused and failed attempts too (184_dem_attempt).
			return { id: await beginDemAttempt(db, 'delineation'), reach };
		});
		try {
			const dem = configuredDem();
			if (!dem) throw new ApiError(409, 'Delineation is off: the server has no elevation model (DEM_URL is empty).');
			let result;
			try {
				result = await delineate(dem, [body.lon, body.lat], {
					expected: attempt.reach ? { km2: attempt.reach.upstreamKm2, reach: `reach ${attempt.reach.reachId} of ${attempt.reach.dataset}` } : null,
					keepPoint: body.keepPoint
				});
			} catch (err) {
				if (err instanceof DelineationRefused) throw new ApiError(422, err.message, { reason: err.code, ...(err.larger ? { larger: err.larger } : {}) });
				logEvent('error', { event: 'delineation_failed', ...safeError(err) });
				throw new ApiError(503, 'The elevation model could not be read just now. Try again; if it keeps failing, the operator should check DEM_URL.');
			}
			const r = result;
			return await withUser(userId, async (db) => {
				await requireRole(db, id, 'editor');
				// One open proposal per project: this one supersedes the last.
				await db.query(`UPDATE delineation_proposal SET status = 'superseded' WHERE project_id = $1 AND status = 'proposed'`, [id]);
				const { rows } = await db
					.query<{ id: string }>(
						`INSERT INTO delineation_proposal (project_id, click_kind, click_lon, click_lat, outlet_lon, outlet_lat, snap_distance_m, geometry,
							area_m2, cells, cell_size_m, zoom, window_cells, dataset, dataset_fingerprint, method, method_version, created_by)
						 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, app_current_user_id()) RETURNING id`,
						[
							id,
							body.from,
							body.lon,
							body.lat,
							r.outlet[0],
							r.outlet[1],
							r.snapDistanceM,
							JSON.stringify(r.geometry),
							r.areaM2,
							r.cells,
							r.cellSizeM,
							r.zoom,
							r.windowCells,
							r.dataset.label,
							r.dataset.fingerprint,
							r.method,
							r.methodVersion
						]
					)
					.catch((err: unknown) => {
						// Two delineations finishing at once: the unique open index keeps one; the other is told.
						if ((err as { code?: string; constraint?: string }).constraint === 'delineation_proposal_one_open_idx') {
							throw new ApiError(409, 'Another delineation for this catchment finished at the same moment; look at it, or click again.');
						}
						throw err;
					});
				// Keep the table bounded: superseded and rejected proposals beyond the newest PROPOSALS_KEPT go.
				await db.query(
					`DELETE FROM delineation_proposal WHERE project_id = $1 AND status IN ('superseded', 'rejected') AND id NOT IN (
						SELECT id FROM delineation_proposal WHERE project_id = $1 AND status IN ('superseded', 'rejected') ORDER BY created_at DESC, id LIMIT $2)`,
					[id, PROPOSALS_KEPT]
				);
				const proposal = toProposal(await loadProposal(db, id, rows[0]!.id));
				await recordAudit(db, id, 'map.delineation_proposed', {
					proposalId: proposal.id,
					from: body.from,
					areaKm2: Math.round(r.areaM2 / 1e4) / 100,
					dataset: r.dataset.label,
					methodVersion: r.methodVersion
				});
				// The river-network check (issue #374): a reach nearby whose area no channel matched. With this answer only, not stored.
				const check = r.unmatched
					? `The river network has ${r.unmatched.reach} near this point, draining about ${Math.round(r.unmatched.reachKm2).toLocaleString('en-ZA')} km², but no channel within 1 km drains within half of that: this catchment (${(r.areaM2 / 1e6).toFixed(2)} km²) may be on another stream. Check it against the map.`
					: null;
				return c.json({ proposal, check }, 201);
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
