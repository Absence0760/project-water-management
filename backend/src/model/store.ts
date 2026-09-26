import type { ProjectModel } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';

export async function loadModel(db: Db, projectId: string): Promise<ProjectModel> {
	// Sequential on purpose: one pooled client can't run queries concurrently.
	const nodes = await db.query(
			`SELECT id, name, kind, downstream_node_id AS "downstreamNodeId", sort_order AS "sortOrder",
				area_km2 AS "areaKm2", area_hi_km2 AS "areaHiKm2", area_lo_km2 AS "areaLoKm2",
				flow_share_manual AS "flowShareManual", pct_upstream_to_dam AS "pctUpstreamToDam",
				pct_runoff_to_dam AS "pctRunoffToDam", dam_capacity_m3 AS "damCapacityM3",
				dam_initial_pct AS "damInitialPct", dam_min_pct AS "damMinPct",
				divert_capacity_m3_day AS "divertCapacityM3Day", irrigation_efficiency AS "irrigationEfficiency",
				loss_return_fraction AS "lossReturnFraction", dam_area_full_m2 AS "damAreaFullM2",
				dam_area_exponent AS "damAreaExponent", dam_seepage_per_day AS "damSeepagePerDay",
				user_demand_m3_day AS "userDemandM3Day", user_return_pct AS "userReturnPct", user_priority AS "userPriority",
				borehole_capacity_m3_day AS "boreholeCapacityM3Day", borehole_rule AS "boreholeRule",
				borehole_trigger_pct AS "boreholeTriggerPct", stream_depletion_frac AS "streamDepletionFrac",
				stream_depletion_lag_days AS "streamDepletionLagDays"
			 FROM node WHERE project_id = $1 ORDER BY sort_order, name`,
			[projectId]
		);
	const crops = await db.query(
		`SELECT id, name, sort_order AS "sortOrder", crop_factor AS "cropFactor" FROM crop WHERE project_id = $1 ORDER BY sort_order, name`,
		[projectId]
	);
	const cropAreas = await db.query(
			`SELECT node_id AS "nodeId", crop_id AS "cropId", area_m2 AS "areaM2" FROM crop_area WHERE project_id = $1`,
			[projectId]
		);
	const transfers = await db.query(
			`SELECT id, from_node_id AS "fromNodeId", to_node_id AS "toNodeId", months::int[] AS months,
				max_rate_m3s AS "maxRateM3s", daily_cap_m3 AS "dailyCapM3", min_storage_pct AS "minStoragePct", enabled, priority
			 FROM transfer WHERE project_id = $1 ORDER BY priority, id`,
			[projectId]
		);
	const landCover = await db.query(
		`SELECT id, node_id AS "nodeId", cover_class AS "coverClass", area_km2 AS "areaKm2", density_pct AS "densityPct", factors
		 FROM land_cover WHERE project_id = $1 ORDER BY node_id, cover_class, id`,
		[projectId]
	);
	// Individual boreholes (WP-3.9); in the document only when there are any, so older documents read back unchanged.
	const boreholes = await db.query(
		`SELECT id, node_id AS "nodeId", name, capacity_m3_day AS "capacityM3Day", annual_cap_m3 AS "annualCapM3", mode,
			emergency_below_pct AS "emergencyBelowPct", target, depletion_factor AS "depletionFactor"
		 FROM borehole WHERE project_id = $1 ORDER BY node_id, name, id`,
		[projectId]
	);
	return {
		nodes: nodes.rows,
		crops: crops.rows,
		cropAreas: cropAreas.rows,
		transfers: transfers.rows,
		landCover: landCover.rows,
		...(boreholes.rows.length ? { boreholes: boreholes.rows } : {})
	};
}

/**
 * Replace the project's model with `m` (already validated). Rows are upserted by
 * id so references from runs survive; rows missing from `m` are deleted.
 * Upserts only touch rows of *this* project — an id that exists in another
 * project is a conflict, never a hijack.
 */
export async function saveModel(db: Db, projectId: string, m: ProjectModel): Promise<void> {
	const nodeIds = m.nodes.map((n) => n.id);
	const cropIds = m.crops.map((c) => c.id);
	const transferIds = m.transfers.map((t) => t.id);

	await db.query('DELETE FROM transfer WHERE project_id = $1 AND NOT (id = ANY($2::uuid[]))', [projectId, transferIds]);
	// Land cover (WP-1.35) is rewritten whole, like crop areas; nothing references its rows.
	await db.query('DELETE FROM land_cover WHERE project_id = $1', [projectId]);
	// So are individual boreholes (WP-3.9).
	await db.query('DELETE FROM borehole WHERE project_id = $1', [projectId]);
	await db.query('DELETE FROM crop_area WHERE project_id = $1', [projectId]);
	await db.query('DELETE FROM crop WHERE project_id = $1 AND NOT (id = ANY($2::uuid[]))', [projectId, cropIds]);
	// Clear topology first so node renames/reorders can't trip uniqueness or
	// same-project checks mid-way; it's restored below.
	await db.query('UPDATE node SET downstream_node_id = NULL WHERE project_id = $1', [projectId]);
	await db.query('DELETE FROM node WHERE project_id = $1 AND NOT (id = ANY($2::uuid[]))', [projectId, nodeIds]);
	// Temporarily rename survivors so swapping two names in one save works.
	await db.query(`UPDATE node SET name = '~' || id::text WHERE project_id = $1`, [projectId]);
	await db.query(`UPDATE crop SET name = '~' || id::text WHERE project_id = $1`, [projectId]);

	const upserted = async (sql: string, params: unknown[], what: string) => {
		const { rowCount } = await db.query(sql, params);
		if (rowCount !== 1) throw new ApiError(409, `${what} id already used by another project`);
	};

	for (const n of m.nodes) {
		await upserted(
			`INSERT INTO node (id, project_id, name, kind, sort_order, area_km2, area_hi_km2, area_lo_km2,
				flow_share_manual, pct_upstream_to_dam, pct_runoff_to_dam, dam_capacity_m3, dam_initial_pct,
				dam_min_pct, divert_capacity_m3_day, irrigation_efficiency, loss_return_fraction,
				dam_area_full_m2, dam_area_exponent, dam_seepage_per_day, user_demand_m3_day, user_return_pct, user_priority,
				borehole_capacity_m3_day, borehole_rule, borehole_trigger_pct, stream_depletion_frac, stream_depletion_lag_days)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
			 ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, sort_order = EXCLUDED.sort_order,
				area_km2 = EXCLUDED.area_km2, area_hi_km2 = EXCLUDED.area_hi_km2, area_lo_km2 = EXCLUDED.area_lo_km2,
				flow_share_manual = EXCLUDED.flow_share_manual, pct_upstream_to_dam = EXCLUDED.pct_upstream_to_dam,
				pct_runoff_to_dam = EXCLUDED.pct_runoff_to_dam, dam_capacity_m3 = EXCLUDED.dam_capacity_m3,
				dam_initial_pct = EXCLUDED.dam_initial_pct, dam_min_pct = EXCLUDED.dam_min_pct,
				divert_capacity_m3_day = EXCLUDED.divert_capacity_m3_day, irrigation_efficiency = EXCLUDED.irrigation_efficiency,
				loss_return_fraction = EXCLUDED.loss_return_fraction, dam_area_full_m2 = EXCLUDED.dam_area_full_m2,
				dam_area_exponent = EXCLUDED.dam_area_exponent, dam_seepage_per_day = EXCLUDED.dam_seepage_per_day,
				user_demand_m3_day = EXCLUDED.user_demand_m3_day, user_return_pct = EXCLUDED.user_return_pct,
				user_priority = EXCLUDED.user_priority, borehole_capacity_m3_day = EXCLUDED.borehole_capacity_m3_day,
				borehole_rule = EXCLUDED.borehole_rule, borehole_trigger_pct = EXCLUDED.borehole_trigger_pct,
				stream_depletion_frac = EXCLUDED.stream_depletion_frac, stream_depletion_lag_days = EXCLUDED.stream_depletion_lag_days
			 WHERE node.project_id = EXCLUDED.project_id`,
			[
				n.id, projectId, n.name, n.kind, n.sortOrder, n.areaKm2, n.areaHiKm2, n.areaLoKm2, n.flowShareManual,
				n.pctUpstreamToDam, n.pctRunoffToDam, n.damCapacityM3, n.damInitialPct, n.damMinPct,
				n.divertCapacityM3Day, n.irrigationEfficiency, n.lossReturnFraction, n.damAreaFullM2, n.damAreaExponent,
				n.damSeepagePerDay, n.userDemandM3Day ?? null, n.userReturnPct ?? 0, n.userPriority ?? 'senior',
				n.boreholeCapacityM3Day ?? null, n.boreholeRule ?? 'supplemental', n.boreholeTriggerPct ?? 0.3,
				n.streamDepletionFrac ?? 0, n.streamDepletionLagDays ?? 0
			],
			'node'
		);
	}
	for (const n of m.nodes) {
		if (n.downstreamNodeId) {
			await db.query('UPDATE node SET downstream_node_id = $2 WHERE id = $1', [n.id, n.downstreamNodeId]);
		}
	}
	for (const [i, c] of m.crops.entries()) {
		await upserted(
			`INSERT INTO crop (id, project_id, name, sort_order, crop_factor) VALUES ($1, $2, $3, $4, $5)
			 ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order,
				crop_factor = EXCLUDED.crop_factor
			 WHERE crop.project_id = EXCLUDED.project_id`,
			// Without an explicit order, the document's order is the display order.
			[c.id, projectId, c.name, c.sortOrder ?? i, c.cropFactor],
			'crop'
		);
	}
	const areas = m.cropAreas.filter((a) => a.areaM2 > 0);
	if (areas.length) {
		await db.query(
			`INSERT INTO crop_area (project_id, node_id, crop_id, area_m2)
			 SELECT $1, * FROM unnest($2::uuid[], $3::uuid[], $4::float8[])`,
			[projectId, areas.map((a) => a.nodeId), areas.map((a) => a.cropId), areas.map((a) => a.areaM2)]
		);
	}
	for (const t of m.transfers) {
		await upserted(
			`INSERT INTO transfer (id, project_id, from_node_id, to_node_id, months, max_rate_m3s, daily_cap_m3,
				min_storage_pct, enabled, priority)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			 ON CONFLICT (id) DO UPDATE SET from_node_id = EXCLUDED.from_node_id, to_node_id = EXCLUDED.to_node_id,
				months = EXCLUDED.months, max_rate_m3s = EXCLUDED.max_rate_m3s, daily_cap_m3 = EXCLUDED.daily_cap_m3,
				min_storage_pct = EXCLUDED.min_storage_pct, enabled = EXCLUDED.enabled, priority = EXCLUDED.priority
			 WHERE transfer.project_id = EXCLUDED.project_id`,
			[t.id, projectId, t.fromNodeId, t.toNodeId, t.months, t.maxRateM3s, t.dailyCapM3, t.minStoragePct, t.enabled, t.priority],
			'transfer'
		);
	}
	for (const p of m.landCover ?? []) {
		await upserted(
			`INSERT INTO land_cover (id, project_id, node_id, cover_class, area_km2, density_pct, factors)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)
			 ON CONFLICT (id) DO NOTHING`,
			[p.id, projectId, p.nodeId, p.coverClass, p.areaKm2, p.densityPct, p.factors === null ? null : JSON.stringify(p.factors)],
			'land cover'
		);
	}
	for (const b of m.boreholes ?? []) {
		await upserted(
			`INSERT INTO borehole (id, project_id, node_id, name, capacity_m3_day, annual_cap_m3, mode, emergency_below_pct, target, depletion_factor)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			 ON CONFLICT (id) DO NOTHING`,
			[b.id, projectId, b.nodeId, b.name, b.capacityM3Day, b.annualCapM3, b.mode, b.emergencyBelowPct, b.target, b.depletionFactor],
			'borehole'
		);
	}
	await db.query('UPDATE project SET updated_at = now() WHERE id = $1', [projectId]);
}
