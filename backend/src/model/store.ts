import type { ProjectModel } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';

// The model as one JSON document, built in one statement: each table as a
// json_agg, in the order the per-table queries used. One round trip, not
// five: the history snapshots load the model twice more on every save, and a
// round trip is what queues when the API is busy (issue #41). Every column is
// float8, float8[], smallint[], jsonb, text or uuid, all of which JSON carries
// exactly (float8 prints its shortest round-trip form, which pg's own parser
// would read as the same number).
const MODEL_JSON = `json_build_object(
	'nodes', coalesce((SELECT json_agg(r ORDER BY r."sortOrder", r.name) FROM (
		SELECT id, name, kind, downstream_node_id AS "downstreamNodeId", sort_order AS "sortOrder",
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
			stream_depletion_lag_days AS "streamDepletionLagDays",
			dam_curve AS "damCurve", dam_release_rule AS "damReleaseRule", dam_release_m3_day AS "damReleaseM3Day",
			dam_outlet_capacity_m3_day AS "damOutletCapacityM3Day", dam_seepage_return_pct AS "damSeepageReturnPct"
		FROM node WHERE project_id = $1) r), '[]'),
	'crops', coalesce((SELECT json_agg(r ORDER BY r."sortOrder", r.name) FROM (
		SELECT id, name, sort_order AS "sortOrder", crop_factor AS "cropFactor" FROM crop WHERE project_id = $1) r), '[]'),
	'cropAreas', coalesce((SELECT json_agg(r) FROM (
		SELECT node_id AS "nodeId", crop_id AS "cropId", area_m2 AS "areaM2" FROM crop_area WHERE project_id = $1) r), '[]'),
	'transfers', coalesce((SELECT json_agg(r ORDER BY r.priority, r.id) FROM (
		SELECT id, from_node_id AS "fromNodeId", to_node_id AS "toNodeId", months::int[] AS months,
			max_rate_m3s AS "maxRateM3s", daily_cap_m3 AS "dailyCapM3", min_storage_pct AS "minStoragePct", enabled, priority
		FROM transfer WHERE project_id = $1) r), '[]'),
	'landCover', coalesce((SELECT json_agg(r ORDER BY r."nodeId", r."coverClass", r.id) FROM (
		SELECT id, node_id AS "nodeId", cover_class AS "coverClass", area_km2 AS "areaKm2", density_pct AS "densityPct", factors
		FROM land_cover WHERE project_id = $1) r), '[]'),
	'boreholes', (SELECT json_agg(r ORDER BY r."nodeId", r.name, r.id) FROM (
		SELECT id, node_id AS "nodeId", name, capacity_m3_day AS "capacityM3Day", annual_cap_m3 AS "annualCapM3", mode,
			emergency_below_pct AS "emergencyBelowPct", target, depletion_factor AS "depletionFactor"
		FROM borehole WHERE project_id = $1) r)
)`;

/** Individual boreholes (WP-3.9) are in the document only when there are any, so older documents read back unchanged. */
function withoutEmptyBoreholes(model: ProjectModel): ProjectModel {
	if (!model.boreholes) delete model.boreholes;
	return model;
}

export async function loadModel(db: Db, projectId: string): Promise<ProjectModel> {
	const { rows } = await db.query<{ model: ProjectModel }>(`SELECT ${MODEL_JSON} AS model`, [projectId]);
	return withoutEmptyBoreholes(rows[0]!.model);
}

/** The project's stored settings (unmerged; undefined when the project isn't visible) and its model, in one round trip. */
export async function loadSettingsAndModel(db: Db, projectId: string): Promise<{ settings: unknown; model: ProjectModel }> {
	const { rows } = await db.query<{ settings: unknown; model: ProjectModel }>(
		`SELECT (SELECT settings FROM project WHERE id = $1) AS settings, ${MODEL_JSON} AS model`,
		[projectId]
	);
	return { settings: rows[0]!.settings ?? undefined, model: withoutEmptyBoreholes(rows[0]!.model) };
}

/**
 * Replace the project's model with `m` (already validated). Rows are upserted by
 * id so references from runs survive; rows missing from `m` are deleted.
 * Upserts only touch rows of *this* project — an id that exists in another
 * project is a conflict, never a hijack.
 *
 * Set-based: at most nine statements whatever the model's size, not one per
 * node, crop, transfer, land-cover patch and borehole (a 3-node save was 25 round trips
 * of its own, and every round trip waits its turn on a busy API; issue #41).
 * Each row list goes as one jsonb parameter, read back with
 * jsonb_populate_recordset against the table's own row type, so every column
 * arrives in its stored type.
 */
export async function saveModel(db: Db, projectId: string, m: ProjectModel): Promise<void> {
	const nodeIds = m.nodes.map((n) => n.id);
	const cropIds = m.crops.map((c) => c.id);
	const transferIds = m.transfers.map((t) => t.id);

	// Clear the way, in one statement. Land cover (WP-1.35) and crop areas are
	// rewritten whole (nothing references their rows); transfers, crops and
	// nodes missing from `m` go. Surviving nodes lose their topology, so
	// renames and reorders can't trip the same-project check mid-way (it's
	// restored below), and surviving nodes and crops take a temporary name, so
	// swapping two names in one save works. The CTEs touch disjoint rows; the
	// deletes' cascades (and SET NULLs) run at the end of the statement, onto
	// rows the CTEs have already removed or cleared.
	await db.query(
		`WITH t AS (DELETE FROM transfer WHERE project_id = $1 AND NOT (id = ANY($4::uuid[]))),
			lc AS (DELETE FROM land_cover WHERE project_id = $1),
			bh AS (DELETE FROM borehole WHERE project_id = $1),
			ca AS (DELETE FROM crop_area WHERE project_id = $1),
			cd AS (DELETE FROM crop WHERE project_id = $1 AND NOT (id = ANY($3::uuid[]))),
			cr AS (UPDATE crop SET name = '~' || id::text WHERE project_id = $1 AND id = ANY($3::uuid[])),
			nd AS (DELETE FROM node WHERE project_id = $1 AND NOT (id = ANY($2::uuid[]))),
			nr AS (UPDATE node SET downstream_node_id = NULL, name = '~' || id::text WHERE project_id = $1 AND id = ANY($2::uuid[]))
		 SELECT 1`,
		[projectId, nodeIds, cropIds, transferIds]
	);

	/** Upsert all of `rows` in one statement; a row not written had the id of another project's row. */
	const upsertAll = async (sql: string, rows: object[], what: string) => {
		if (!rows.length) return;
		const { rowCount } = await db.query(sql, [projectId, JSON.stringify(rows)]);
		if (rowCount !== rows.length) throw new ApiError(409, `${what} id already used by another project`);
	};

	// Nodes go in without their topology: the same-project trigger checks a
	// row's downstream node as the row goes in, before later rows exist.
	await upsertAll(
		`INSERT INTO node (id, project_id, name, kind, sort_order, area_km2, area_hi_km2, area_lo_km2,
			flow_share_manual, pct_upstream_to_dam, pct_runoff_to_dam, dam_capacity_m3, dam_initial_pct,
			dam_min_pct, divert_capacity_m3_day, irrigation_efficiency, loss_return_fraction,
			dam_area_full_m2, dam_area_exponent, dam_seepage_per_day, user_demand_m3_day, user_return_pct, user_priority,
			borehole_capacity_m3_day, borehole_rule, borehole_trigger_pct, stream_depletion_frac, stream_depletion_lag_days,
			dam_curve, dam_release_rule, dam_release_m3_day, dam_outlet_capacity_m3_day, dam_seepage_return_pct)
		 SELECT id, $1, name, kind, sort_order, area_km2, area_hi_km2, area_lo_km2,
			flow_share_manual, pct_upstream_to_dam, pct_runoff_to_dam, dam_capacity_m3, dam_initial_pct,
			dam_min_pct, divert_capacity_m3_day, irrigation_efficiency, loss_return_fraction,
			dam_area_full_m2, dam_area_exponent, dam_seepage_per_day, user_demand_m3_day, user_return_pct, user_priority,
			borehole_capacity_m3_day, borehole_rule, borehole_trigger_pct, stream_depletion_frac, stream_depletion_lag_days,
			dam_curve, dam_release_rule, dam_release_m3_day, dam_outlet_capacity_m3_day, dam_seepage_return_pct
		 FROM jsonb_populate_recordset(NULL::node, $2::jsonb)
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
			stream_depletion_frac = EXCLUDED.stream_depletion_frac, stream_depletion_lag_days = EXCLUDED.stream_depletion_lag_days,
			dam_curve = EXCLUDED.dam_curve, dam_release_rule = EXCLUDED.dam_release_rule,
			dam_release_m3_day = EXCLUDED.dam_release_m3_day, dam_outlet_capacity_m3_day = EXCLUDED.dam_outlet_capacity_m3_day,
			dam_seepage_return_pct = EXCLUDED.dam_seepage_return_pct
		 WHERE node.project_id = EXCLUDED.project_id`,
		m.nodes.map((n) => ({
			id: n.id,
			name: n.name,
			kind: n.kind,
			sort_order: n.sortOrder,
			area_km2: n.areaKm2,
			area_hi_km2: n.areaHiKm2,
			area_lo_km2: n.areaLoKm2,
			flow_share_manual: n.flowShareManual,
			pct_upstream_to_dam: n.pctUpstreamToDam,
			pct_runoff_to_dam: n.pctRunoffToDam,
			dam_capacity_m3: n.damCapacityM3,
			dam_initial_pct: n.damInitialPct,
			dam_min_pct: n.damMinPct,
			divert_capacity_m3_day: n.divertCapacityM3Day,
			irrigation_efficiency: n.irrigationEfficiency,
			loss_return_fraction: n.lossReturnFraction,
			dam_area_full_m2: n.damAreaFullM2,
			dam_area_exponent: n.damAreaExponent,
			dam_seepage_per_day: n.damSeepagePerDay,
			user_demand_m3_day: n.userDemandM3Day ?? null,
			user_return_pct: n.userReturnPct ?? 0,
			user_priority: n.userPriority ?? 'senior',
			borehole_capacity_m3_day: n.boreholeCapacityM3Day ?? null,
			borehole_rule: n.boreholeRule ?? 'supplemental',
			borehole_trigger_pct: n.boreholeTriggerPct ?? 0.3,
			stream_depletion_frac: n.streamDepletionFrac ?? 0,
			stream_depletion_lag_days: n.streamDepletionLagDays ?? 0,
			dam_curve: n.damCurve && n.damCurve.length ? n.damCurve : null,
			dam_release_rule: n.damReleaseRule ?? 'none',
			dam_release_m3_day: n.damReleaseM3Day ?? null,
			dam_outlet_capacity_m3_day: n.damOutletCapacityM3Day ?? null,
			dam_seepage_return_pct: n.damSeepageReturnPct ?? 1
		})),
		'node'
	);
	const linked = m.nodes.filter((n) => n.downstreamNodeId);
	if (linked.length) {
		await db.query(
			`UPDATE node SET downstream_node_id = l.down
			 FROM unnest($2::uuid[], $3::uuid[]) AS l(id, down)
			 WHERE node.id = l.id AND node.project_id = $1`,
			[projectId, linked.map((n) => n.id), linked.map((n) => n.downstreamNodeId)]
		);
	}
	await upsertAll(
		`INSERT INTO crop (id, project_id, name, sort_order, crop_factor)
		 SELECT id, $1, name, sort_order, crop_factor FROM jsonb_populate_recordset(NULL::crop, $2::jsonb)
		 ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order,
			crop_factor = EXCLUDED.crop_factor
		 WHERE crop.project_id = EXCLUDED.project_id`,
		// Without an explicit order, the document's order is the display order.
		m.crops.map((c, i) => ({ id: c.id, name: c.name, sort_order: c.sortOrder ?? i, crop_factor: c.cropFactor })),
		'crop'
	);
	const areas = m.cropAreas.filter((a) => a.areaM2 > 0);
	if (areas.length) {
		await db.query(
			`INSERT INTO crop_area (project_id, node_id, crop_id, area_m2)
			 SELECT $1, * FROM unnest($2::uuid[], $3::uuid[], $4::float8[])`,
			[projectId, areas.map((a) => a.nodeId), areas.map((a) => a.cropId), areas.map((a) => a.areaM2)]
		);
	}
	await upsertAll(
		`INSERT INTO transfer (id, project_id, from_node_id, to_node_id, months, max_rate_m3s, daily_cap_m3,
			min_storage_pct, enabled, priority)
		 SELECT id, $1, from_node_id, to_node_id, months, max_rate_m3s, daily_cap_m3, min_storage_pct, enabled, priority
		 FROM jsonb_populate_recordset(NULL::transfer, $2::jsonb)
		 ON CONFLICT (id) DO UPDATE SET from_node_id = EXCLUDED.from_node_id, to_node_id = EXCLUDED.to_node_id,
			months = EXCLUDED.months, max_rate_m3s = EXCLUDED.max_rate_m3s, daily_cap_m3 = EXCLUDED.daily_cap_m3,
			min_storage_pct = EXCLUDED.min_storage_pct, enabled = EXCLUDED.enabled, priority = EXCLUDED.priority
		 WHERE transfer.project_id = EXCLUDED.project_id`,
		m.transfers.map((t) => ({
			id: t.id,
			from_node_id: t.fromNodeId,
			to_node_id: t.toNodeId,
			months: t.months,
			max_rate_m3s: t.maxRateM3s,
			daily_cap_m3: t.dailyCapM3,
			min_storage_pct: t.minStoragePct,
			enabled: t.enabled,
			priority: t.priority
		})),
		'transfer'
	);
	await upsertAll(
		`INSERT INTO land_cover (id, project_id, node_id, cover_class, area_km2, density_pct, factors)
		 SELECT id, $1, node_id, cover_class, area_km2, density_pct, factors
		 FROM jsonb_populate_recordset(NULL::land_cover, $2::jsonb)
		 ON CONFLICT (id) DO NOTHING`,
		(m.landCover ?? []).map((p) => ({
			id: p.id,
			node_id: p.nodeId,
			cover_class: p.coverClass,
			area_km2: p.areaKm2,
			density_pct: p.densityPct,
			factors: p.factors
		})),
		'land cover'
	);
	await upsertAll(
		`INSERT INTO borehole (id, project_id, node_id, name, capacity_m3_day, annual_cap_m3, mode, emergency_below_pct, target, depletion_factor)
		 SELECT id, $1, node_id, name, capacity_m3_day, annual_cap_m3, mode, emergency_below_pct, target, depletion_factor
		 FROM jsonb_populate_recordset(NULL::borehole, $2::jsonb)
		 ON CONFLICT (id) DO NOTHING`,
		(m.boreholes ?? []).map((b) => ({
			id: b.id,
			node_id: b.nodeId,
			name: b.name,
			capacity_m3_day: b.capacityM3Day,
			annual_cap_m3: b.annualCapM3,
			mode: b.mode,
			emergency_below_pct: b.emergencyBelowPct,
			target: b.target,
			depletion_factor: b.depletionFactor
		})),
		'borehole'
	);
	await db.query('UPDATE project SET updated_at = now() WHERE id = $1', [projectId]);
}
