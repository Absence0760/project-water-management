// A delineation proposal's row, its API shape, and storing a new one
// (175_delineation.sql). Shared by the request (routes.ts) and the background
// worker's `delineate` job (jobs/handlers/delineate.ts), which store a
// proposal the same way: it supersedes the project's open one, old decided
// ones are pruned, and map.delineation_proposed is audited.
import type { Db } from '../db/tx.js';
import type { Geometry } from '../geo/geojson.js';
import { recordAudit } from '../history/record.js';
import { ApiError, notFound } from '../http/errors.js';
import { UUID } from '../projects/access.js';
import type { Delineation } from './delineate.js';

/** Superseded and rejected proposals kept per project (accepted ones are all kept, as their features' provenance). */
export const PROPOSALS_KEPT = 50;

export interface ProposalRow {
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

export const SELECT = `
	SELECT p.id, p.status, p.click_kind, p.click_lon, p.click_lat, p.outlet_lon, p.outlet_lat, p.snap_distance_m, p.geometry,
		p.area_m2, p.cells, p.cell_size_m, p.zoom, p.window_cells, p.dataset, p.dataset_fingerprint, p.method, p.method_version,
		p.feature_id, cu.display_name AS created_by_name, p.created_at, du.display_name AS decided_by_name, p.decided_at
	FROM delineation_proposal p
	LEFT JOIN app_user cu ON cu.id = p.created_by
	LEFT JOIN app_user du ON du.id = p.decided_by
	WHERE p.project_id = $1`;

export const toProposal = (r: ProposalRow) => ({
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

export async function loadProposal(db: Db, projectId: string, pid: string): Promise<ProposalRow> {
	if (!UUID.test(pid)) throw notFound();
	const { rows } = await db.query<ProposalRow>(`${SELECT} AND p.id = $2`, [projectId, pid]);
	if (!rows[0]) throw notFound();
	return rows[0];
}

/**
 * The river-network check (issue #374): a reach nearby whose area no channel matched; or (issue #390) an outlet a confluence's junction
 * moved far from the click. With the answer only.
 */
export function checkNote(r: Delineation): string | null {
	if (r.unmatched)
		return `The river network has ${r.unmatched.reach} near this point, draining about ${Math.round(r.unmatched.reachKm2).toLocaleString('en-ZA')} km², but no channel within 1 km drains within half of that: this catchment (${(r.areaM2 / 1e6).toFixed(2)} km²) may be on another stream. Check it against the map.`;
	if (r.farJunction)
		return `The outlet was moved ${(r.farJunction.movedM / 1000).toFixed(1)} km from the point to keep it on ${r.farJunction.reach}'s side of a confluence: the elevation model's rivers meet away from where the river network joins them. A gauge or weir that far from its site records another catchment, so check the outlet against the map.`;
	return null;
}

/**
 * Store a delineation as the project's open proposal, as the transaction's
 * user (an editor; the caller has checked): it supersedes the open one, the
 * decided ones beyond PROPOSALS_KEPT go, and it is audited. 409 when another
 * finished at the same moment (the unique open index keeps one).
 */
export async function storeProposal(db: Db, projectId: string, from: 'outlet' | 'dam_wall', r: Delineation, audit: Record<string, unknown> = {}): Promise<DelineationProposal> {
	// One open proposal per project: this one supersedes the last.
	await db.query(`UPDATE delineation_proposal SET status = 'superseded' WHERE project_id = $1 AND status = 'proposed'`, [projectId]);
	const { rows } = await db
		.query<{ id: string }>(
			`INSERT INTO delineation_proposal (project_id, click_kind, click_lon, click_lat, outlet_lon, outlet_lat, snap_distance_m, geometry,
				area_m2, cells, cell_size_m, zoom, window_cells, dataset, dataset_fingerprint, method, method_version, created_by)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, app_current_user_id()) RETURNING id`,
			[
				projectId,
				from,
				r.click[0],
				r.click[1],
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
		[projectId, PROPOSALS_KEPT]
	);
	const proposal = toProposal(await loadProposal(db, projectId, rows[0]!.id));
	await recordAudit(db, projectId, 'map.delineation_proposed', {
		proposalId: proposal.id,
		from,
		areaKm2: Math.round(r.areaM2 / 1e4) / 100,
		dataset: r.dataset.label,
		methodVersion: r.methodVersion,
		...audit
	});
	return proposal;
}
