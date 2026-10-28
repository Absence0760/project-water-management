// The calibration site (settings.calibrationSiteNodeId, engine ≥ 1.41.0,
// docs/model.md §2.10k, docs/api.md § Projects): null = the outlet, else a
// gauge inside the network with an observed flow record attached to it
// (time_series.site_node_id, 084_gauge_records.sql). A change to a gauge is
// checked here against the stored network and series, as the outcome
// matrix's site is (outcomeSettings.ts checkOutcomeSite). A stored site that
// later loses its node or record doesn't block other saves: calibration
// refuses it then, saying why (engine calibrate/site.ts).
//
// The calibration zones (settings.calibrationZones, engine 1.106.0, issue
// #555, docs/model.md §2.10n) are checked the same way: each row new to the
// list must be such a gauge, and no ticked row may be the site or below it.
// A stored row whose gauge is later deleted blocks no save (the run warns).
import { CALIBRATION_FLOW_KINDS, calibrationZonesError } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';

export async function checkCalibrationSite(db: Db, projectId: string, siteNodeId: string, field = 'calibrationSiteNodeId'): Promise<void> {
	const { rows } = await db.query<{ kind: string; downstream_node_id: string | null; records: number }>(
		`SELECT n.kind, n.downstream_node_id,
			(SELECT count(*)::int FROM time_series t WHERE t.project_id = n.project_id AND t.site_node_id = n.id AND t.kind = ANY($3::text[])) AS records
		 FROM node n WHERE n.project_id = $1 AND n.id = $2`,
		[projectId, siteNodeId, [...CALIBRATION_FLOW_KINDS]]
	);
	const n = rows[0];
	if (!n) throw new ApiError(400, `${field}: no such hydrological unit in this project`);
	if (n.kind !== 'gauge' || n.downstream_node_id === null) throw new ApiError(400, `${field}: the site is the outlet (null) or a gauge above it`);
	if (n.records === 0) throw new ApiError(400, `${field}: that gauge has no observed flow record attached`);
}

/**
 * The calibration zones a save would store: each row whose gauge wasn't in
 * the stored list is checked as a site is, then the ticked rows against the
 * network and the calibration site (engine calibrationZonesError), skipping
 * rows whose gauge is gone (a stale row is the run's to warn about).
 */
export async function checkCalibrationZones(db: Db, projectId: string, zones: readonly { nodeId: string; enabled: boolean }[], stored: unknown, siteNodeId: string | null): Promise<void> {
	if (!zones.length) return;
	const before = new Set(Array.isArray(stored) ? stored.flatMap((z) => (z && typeof z === 'object' && typeof (z as { nodeId?: unknown }).nodeId === 'string' ? [(z as { nodeId: string }).nodeId] : [])) : []);
	for (const z of zones) if (!before.has(z.nodeId)) await checkCalibrationSite(db, projectId, z.nodeId, 'calibrationZones');
	const { rows } = await db.query<{ id: string; name: string; kind: 'farm' | 'gauge' | 'user'; downstream_node_id: string | null }>(
		'SELECT id, name, kind, downstream_node_id FROM node WHERE project_id = $1',
		[projectId]
	);
	const nodes = rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, downstreamNodeId: r.downstream_node_id }));
	const ids = new Set(nodes.map((n) => n.id));
	const err = calibrationZonesError(nodes, siteNodeId, zones.filter((z) => ids.has(z.nodeId)));
	if (err) throw new ApiError(400, `calibrationZones: ${err}`);
}
