// The observed wet days' data (report format evidence-21, issue #604 R5-C;
// engine evidence/damObservations.ts, docs/evidence-pack.md § Observed wet
// days): the project's traced dams on the given units, each with its WOfS
// rows (261 dam_observation, source 'wofs') in the period. Read under the
// reader's RLS (withUser): a reader who can't see a dam or its rows gets
// neither. The engine classifies each date (wet, dry, inconclusive) and freezes them.
import type { EvidenceDamObservationInput } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { UUID } from '../projects/access.js';

/** The dams on `nodeIds` (the applicant's own units) with their WOfS rows from `startDate` to `endDate` (ISO, inclusive). */
export async function loadDamObservations(db: Db, projectId: string, nodeIds: readonly string[], startDate: string, endDate: string): Promise<EvidenceDamObservationInput[]> {
	// A run's node ids are the node table's uuids; anything else names no map feature.
	const ids = nodeIds.filter((id) => UUID.test(id));
	if (!ids.length) return [];
	const { rows } = await db.query<{ featureId: string; name: string; nodeId: string | null; rows: [string, number, number][] }>(
		`SELECT f.id AS "featureId", f.name, f.node_id AS "nodeId",
			COALESCE(json_agg(json_build_array(o.obs_date, o.wet_area_m2, o.pct_observed) ORDER BY o.obs_date) FILTER (WHERE o.id IS NOT NULL), '[]'::json) AS rows
		 FROM map_feature f
		 LEFT JOIN dam_observation o
			ON o.feature_id = f.id AND o.project_id = f.project_id AND o.source = 'wofs' AND o.obs_date BETWEEN $3::date AND $4::date
		 WHERE f.project_id = $1 AND f.kind = 'dam' AND f.node_id = ANY($2::uuid[])
		 GROUP BY f.id
		 ORDER BY f.id`,
		[projectId, ids, startDate, endDate]
	);
	return rows.map((r) => ({
		featureId: r.featureId,
		name: r.name,
		nodeId: r.nodeId,
		rows: r.rows.map(([date, wetAreaM2, pctObserved]) => ({ date, wetAreaM2, pctObserved }))
	}));
}
