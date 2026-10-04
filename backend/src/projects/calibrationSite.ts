// The calibration site (settings.calibrationSiteNodeId, engine ≥ 1.41.0,
// docs/model.md §2.10k, docs/api.md § Projects): null = the outlet, else a
// gauge inside the network with an observed flow record attached to it
// (time_series.site_node_id, 084_gauge_records.sql). A change to a gauge is
// checked here against the stored network and series, as the outcome
// matrix's site is (outcomeSettings.ts checkOutcomeSite). A stored site that
// later loses its node or record doesn't block other saves: calibration
// refuses it then, saying why (engine calibrate/site.ts).
import { CALIBRATION_FLOW_KINDS } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';

export async function checkCalibrationSite(db: Db, projectId: string, siteNodeId: string): Promise<void> {
	const { rows } = await db.query<{ kind: string; downstream_node_id: string | null; records: number }>(
		`SELECT n.kind, n.downstream_node_id,
			(SELECT count(*)::int FROM time_series t WHERE t.project_id = n.project_id AND t.site_node_id = n.id AND t.kind = ANY($3::text[])) AS records
		 FROM node n WHERE n.project_id = $1 AND n.id = $2`,
		[projectId, siteNodeId, [...CALIBRATION_FLOW_KINDS]]
	);
	const n = rows[0];
	if (!n) throw new ApiError(400, 'calibrationSiteNodeId: no such hydrological unit in this project');
	if (n.kind !== 'gauge' || n.downstream_node_id === null) throw new ApiError(400, 'calibrationSiteNodeId: the site is the outlet (null) or a gauge above it');
	if (n.records === 0) throw new ApiError(400, 'calibrationSiteNodeId: that gauge has no observed flow record attached');
}
