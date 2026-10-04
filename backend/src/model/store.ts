import { CROP_SUPPLY_DEFAULTS, OFFTAKE_DEFAULTS, OPERATING_DEFAULTS, WATER_SOURCE_DEFAULTS, type ProjectModel } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';

// The model as one JSON document, built in one statement: each table as a
// json_agg, in the order the per-table queries used. One round trip, not
// five: the history snapshots load the model twice more on every save, and a
// round trip is what queues when the API is busy (issue #41). Every column is
// float8, float8[], smallint[], jsonb, text or uuid, all of which JSON carries
// exactly (float8 prints its shortest round-trip form, which pg's own parser
// would read as the same number); the node's dates (migration 110) go out as
// YYYY-MM-DD text through to_char, the engine's date form.
const MODEL_JSON = `json_build_object(
	'nodes', coalesce((SELECT json_agg(r ORDER BY r."sortOrder", r.name) FROM (
		SELECT id, name, kind, downstream_node_id AS "downstreamNodeId", sort_order AS "sortOrder",
			area_km2 AS "areaKm2", area_hi_km2 AS "areaHiKm2", area_lo_km2 AS "areaLoKm2",
			flow_share_manual AS "flowShareManual", pct_upstream_to_dam AS "pctUpstreamToDam",
			pct_runoff_to_dam AS "pctRunoffToDam", dam_capacity_m3 AS "damCapacityM3",
			dam_initial_pct AS "damInitialPct", dam_min_pct AS "damMinPct",
			divert_capacity_m3_day AS "divertCapacityM3Day", irrigation_efficiency AS "irrigationEfficiency",
			return_flow_fraction AS "returnFlowFraction", dam_area_full_m2 AS "damAreaFullM2",
			dam_area_exponent AS "damAreaExponent", dam_seepage_per_day AS "damSeepagePerDay",
			user_demand_m3_day AS "userDemandM3Day", user_return_pct AS "userReturnPct", user_priority AS "userPriority",
			borehole_capacity_m3_day AS "boreholeCapacityM3Day", borehole_rule AS "boreholeRule",
			borehole_trigger_pct AS "boreholeTriggerPct", stream_depletion_frac AS "streamDepletionFrac",
			stream_depletion_lag_days AS "streamDepletionLagDays",
			dam_curve AS "damCurve", dam_release_rule AS "damReleaseRule", dam_release_m3_day AS "damReleaseM3Day",
			dam_outlet_capacity_m3_day AS "damOutletCapacityM3Day", dam_seepage_return_pct AS "damSeepageReturnPct",
			to_char(dam_survey_date, 'YYYY-MM-DD') AS "damSurveyDate", dam_sediment_pct_per_year AS "damSedimentPctPerYear",
			to_char(dam_in_service_from, 'YYYY-MM-DD') AS "damInServiceFrom", to_char(abstraction_from, 'YYYY-MM-DD') AS "abstractionFrom",
			supply_rule AS "supplyRule", pump_capacity_m3_day AS "pumpCapacityM3Day",
			supply_trigger_pct AS "supplyTriggerPct", supply_stop_pct AS "supplyStopPct",
			crop_water_source AS "cropWaterSource", crop_river_pump_m3_day AS "cropRiverPumpM3Day", crop_river_pool_m3 AS "cropRiverPoolM3",
			crop_share_dam AS "cropShareDam", crop_share_river AS "cropShareRiver", crop_share_remote AS "cropShareRemote",
			crop_remote_node_id AS "cropRemoteNodeId", crop_remote_cap_m3_day AS "cropRemoteCapM3Day",
			hands_off_m3_day AS "handsOffM3Day", hands_off_ewr AS "handsOffEwr", divert_monthly_m3_day AS "divertMonthlyM3Day",
			ewr_site AS "ewrSite",
			ga_property_area_ha AS "gaPropertyAreaHa", ga_rate_m3_ha_year AS "gaRateM3HaYear"
		FROM node WHERE project_id = $1) r), '[]'),
	'crops', coalesce((SELECT json_agg(json_strip_nulls(row_to_json(r)) ORDER BY r."sortOrder", r.name) FROM (
		SELECT id, name, sort_order AS "sortOrder", crop_factor AS "cropFactor", irrigation_system_id AS "irrigationSystemId"
		FROM crop WHERE project_id = $1) r), '[]'),
	'cropAreas', coalesce((SELECT json_agg(json_strip_nulls(row_to_json(r))) FROM (
		SELECT node_id AS "nodeId", crop_id AS "cropId", area_m2 AS "areaM2", irrigation_system_id AS "irrigationSystemId"
		FROM crop_area WHERE project_id = $1) r), '[]'),
	'irrigationSystems', coalesce((SELECT json_agg(r ORDER BY r."sortOrder", r.name, r.id) FROM (
		SELECT id, name, efficiency, preset, sort_order AS "sortOrder" FROM irrigation_system WHERE project_id = $1) r), '[]'),
	'transfers', coalesce((SELECT json_agg(r ORDER BY r.priority, r.id) FROM (
		SELECT id, from_node_id AS "fromNodeId", to_node_id AS "toNodeId", months::int[] AS months,
			max_rate_m3s AS "maxRateM3s", daily_cap_m3 AS "dailyCapM3", min_storage_pct AS "minStoragePct", enabled, priority,
			monthly_rate_m3s AS "monthlyRateM3s", source, hands_off_m3_day AS "handsOffM3Day", hands_off_ewr AS "handsOffEwr",
			loss_pct AS "lossPct", sizing, top_up_dam AS "topUpDam",
			loss_return_pct AS "lossReturnPct", loss_return_node_id AS "lossReturnNodeId"
		FROM transfer WHERE project_id = $1) r), '[]'),
	'landCover', coalesce((SELECT json_agg(r ORDER BY r."nodeId", r."coverClass", r.id) FROM (
		SELECT id, node_id AS "nodeId", cover_class AS "coverClass", area_km2 AS "areaKm2", density_pct AS "densityPct", factors
		FROM land_cover WHERE project_id = $1) r), '[]'),
	'boreholes', (SELECT json_agg(r ORDER BY r."nodeId", r.name, r.id) FROM (
		SELECT id, node_id AS "nodeId", name, capacity_m3_day AS "capacityM3Day", annual_cap_m3 AS "annualCapM3", mode,
			emergency_below_pct AS "emergencyBelowPct", target, depletion_factor AS "depletionFactor"
		FROM borehole WHERE project_id = $1) r),
	'demandObjects', (SELECT json_agg(r ORDER BY r."nodeId", r.name, r.id) FROM (
		SELECT id, node_id AS "nodeId", name, category, sizing, monthly_m3_day AS "monthlyM3Day", monthly_unit AS "monthlyUnit", unit_count AS "count",
			litres_per_unit_day AS "litresPerUnitDay", loss_pct AS "lossPct", monthly_factor AS "monthlyFactor",
			return_pct AS "returnPct", priority, priority_rank AS "rank", destination, enabled, schedule, population, source,
			water_source AS "waterSource", river_pump_m3_day AS "riverPumpM3Day", river_pool_m3 AS "riverPoolM3", note
		FROM demand_object WHERE project_id = $1) r)
)`;

/**
 * Individual boreholes (WP-3.9) and demand objects (engine 1.7.0) are in the
 * document only when there are any, so older documents read back unchanged.
 */
function withoutEmptyBoreholes(model: ProjectModel): ProjectModel {
	if (!model.boreholes) delete model.boreholes;
	if (!model.demandObjects) delete model.demandObjects;
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
 * Set-based: at most ten statements whatever the model's size, not one per
 * node, crop, transfer, land-cover patch, borehole and demand object (a 3-node save was 25 round trips
 * of its own, and every round trip waits its turn on a busy API; issue #41).
 * Each row list goes as one jsonb parameter, read back with
 * jsonb_populate_recordset against the table's own row type, so every column
 * arrives in its stored type.
 */
export async function saveModel(db: Db, projectId: string, m: ProjectModel): Promise<void> {
	// The irrigation systems first (engine ≥ 1.72.0): crops and plantings name them. A model without a table keeps
	// the project's; a reference by a SABI preset's key ('drip', from a document or the importer) is that preset's row.
	const systemIdOf = await saveIrrigationSystems(db, projectId, m);
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
			dob AS (DELETE FROM demand_object WHERE project_id = $1),
			ca AS (DELETE FROM crop_area WHERE project_id = $1),
			cd AS (DELETE FROM crop WHERE project_id = $1 AND NOT (id = ANY($3::uuid[]))),
			cr AS (UPDATE crop SET name = '~' || id::text WHERE project_id = $1 AND id = ANY($3::uuid[])),
			nd AS (DELETE FROM node WHERE project_id = $1 AND NOT (id = ANY($2::uuid[]))),
			nr AS (UPDATE node SET downstream_node_id = NULL, crop_remote_node_id = NULL, name = '~' || id::text WHERE project_id = $1 AND id = ANY($2::uuid[]))
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
			dam_min_pct, divert_capacity_m3_day, irrigation_efficiency, return_flow_fraction,
			dam_area_full_m2, dam_area_exponent, dam_seepage_per_day, user_demand_m3_day, user_return_pct, user_priority,
			borehole_capacity_m3_day, borehole_rule, borehole_trigger_pct, stream_depletion_frac, stream_depletion_lag_days,
			dam_curve, dam_release_rule, dam_release_m3_day, dam_outlet_capacity_m3_day, dam_seepage_return_pct,
			dam_survey_date, dam_sediment_pct_per_year, dam_in_service_from, abstraction_from,
			supply_rule, pump_capacity_m3_day, supply_trigger_pct, supply_stop_pct,
			crop_water_source, crop_river_pump_m3_day, crop_river_pool_m3,
			crop_share_dam, crop_share_river, crop_share_remote, crop_remote_cap_m3_day,
			hands_off_m3_day, hands_off_ewr, divert_monthly_m3_day, ewr_site, ga_property_area_ha, ga_rate_m3_ha_year)
		 SELECT id, $1, name, kind, sort_order, area_km2, area_hi_km2, area_lo_km2,
			flow_share_manual, pct_upstream_to_dam, pct_runoff_to_dam, dam_capacity_m3, dam_initial_pct,
			dam_min_pct, divert_capacity_m3_day, irrigation_efficiency, return_flow_fraction,
			dam_area_full_m2, dam_area_exponent, dam_seepage_per_day, user_demand_m3_day, user_return_pct, user_priority,
			borehole_capacity_m3_day, borehole_rule, borehole_trigger_pct, stream_depletion_frac, stream_depletion_lag_days,
			dam_curve, dam_release_rule, dam_release_m3_day, dam_outlet_capacity_m3_day, dam_seepage_return_pct,
			dam_survey_date, dam_sediment_pct_per_year, dam_in_service_from, abstraction_from,
			supply_rule, pump_capacity_m3_day, supply_trigger_pct, supply_stop_pct,
			crop_water_source, crop_river_pump_m3_day, crop_river_pool_m3,
			crop_share_dam, crop_share_river, crop_share_remote, crop_remote_cap_m3_day,
			hands_off_m3_day, hands_off_ewr, divert_monthly_m3_day, ewr_site, ga_property_area_ha, ga_rate_m3_ha_year
		 FROM jsonb_populate_recordset(NULL::node, $2::jsonb)
		 ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, sort_order = EXCLUDED.sort_order,
			-- An area accepted from the map (152, geo/routes.ts area-from-map) stays 'map' until the area is typed over (or the node changes kind).
			area_source = CASE WHEN node.area_km2 IS DISTINCT FROM EXCLUDED.area_km2 OR node.kind IS DISTINCT FROM EXCLUDED.kind THEN 'typed' ELSE node.area_source END,
			area_feature_id = CASE WHEN node.area_km2 IS DISTINCT FROM EXCLUDED.area_km2 OR node.kind IS DISTINCT FROM EXCLUDED.kind THEN NULL ELSE node.area_feature_id END,
			-- Which area it took (195), gross or effective, goes with it.
			area_basis = CASE WHEN node.area_km2 IS DISTINCT FROM EXCLUDED.area_km2 OR node.kind IS DISTINCT FROM EXCLUDED.kind THEN NULL ELSE node.area_basis END,
			area_km2 = EXCLUDED.area_km2, area_hi_km2 = EXCLUDED.area_hi_km2, area_lo_km2 = EXCLUDED.area_lo_km2,
			flow_share_manual = EXCLUDED.flow_share_manual, pct_upstream_to_dam = EXCLUDED.pct_upstream_to_dam,
			pct_runoff_to_dam = EXCLUDED.pct_runoff_to_dam, dam_capacity_m3 = EXCLUDED.dam_capacity_m3,
			dam_initial_pct = EXCLUDED.dam_initial_pct, dam_min_pct = EXCLUDED.dam_min_pct,
			divert_capacity_m3_day = EXCLUDED.divert_capacity_m3_day, irrigation_efficiency = EXCLUDED.irrigation_efficiency,
			return_flow_fraction = EXCLUDED.return_flow_fraction, dam_area_full_m2 = EXCLUDED.dam_area_full_m2,
			dam_area_exponent = EXCLUDED.dam_area_exponent, dam_seepage_per_day = EXCLUDED.dam_seepage_per_day,
			user_demand_m3_day = EXCLUDED.user_demand_m3_day, user_return_pct = EXCLUDED.user_return_pct,
			user_priority = EXCLUDED.user_priority, borehole_capacity_m3_day = EXCLUDED.borehole_capacity_m3_day,
			borehole_rule = EXCLUDED.borehole_rule, borehole_trigger_pct = EXCLUDED.borehole_trigger_pct,
			stream_depletion_frac = EXCLUDED.stream_depletion_frac, stream_depletion_lag_days = EXCLUDED.stream_depletion_lag_days,
			dam_curve = EXCLUDED.dam_curve, dam_release_rule = EXCLUDED.dam_release_rule,
			dam_release_m3_day = EXCLUDED.dam_release_m3_day, dam_outlet_capacity_m3_day = EXCLUDED.dam_outlet_capacity_m3_day,
			dam_seepage_return_pct = EXCLUDED.dam_seepage_return_pct,
			dam_survey_date = EXCLUDED.dam_survey_date, dam_sediment_pct_per_year = EXCLUDED.dam_sediment_pct_per_year,
			dam_in_service_from = EXCLUDED.dam_in_service_from, abstraction_from = EXCLUDED.abstraction_from,
			supply_rule = EXCLUDED.supply_rule,
			pump_capacity_m3_day = EXCLUDED.pump_capacity_m3_day, supply_trigger_pct = EXCLUDED.supply_trigger_pct,
			supply_stop_pct = EXCLUDED.supply_stop_pct,
			crop_water_source = EXCLUDED.crop_water_source, crop_river_pump_m3_day = EXCLUDED.crop_river_pump_m3_day,
			crop_river_pool_m3 = EXCLUDED.crop_river_pool_m3,
			crop_share_dam = EXCLUDED.crop_share_dam, crop_share_river = EXCLUDED.crop_share_river,
			crop_share_remote = EXCLUDED.crop_share_remote, crop_remote_cap_m3_day = EXCLUDED.crop_remote_cap_m3_day,
			hands_off_m3_day = EXCLUDED.hands_off_m3_day,
			hands_off_ewr = EXCLUDED.hands_off_ewr, divert_monthly_m3_day = EXCLUDED.divert_monthly_m3_day,
			ewr_site = EXCLUDED.ewr_site,
			ga_property_area_ha = EXCLUDED.ga_property_area_ha, ga_rate_m3_ha_year = EXCLUDED.ga_rate_m3_ha_year
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
			return_flow_fraction: n.returnFlowFraction,
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
			dam_seepage_return_pct: n.damSeepageReturnPct ?? 1,
			dam_survey_date: n.damSurveyDate ?? null,
			dam_sediment_pct_per_year: n.damSedimentPctPerYear ?? null,
			dam_in_service_from: n.damInServiceFrom ?? null,
			abstraction_from: n.abstractionFrom ?? null,
			supply_rule: n.supplyRule ?? 'damFirst',
			pump_capacity_m3_day: n.pumpCapacityM3Day ?? null,
			supply_trigger_pct: n.supplyTriggerPct ?? 0.4,
			supply_stop_pct: n.supplyStopPct ?? 0.6,
			// Where the crops take their water (engine ≥ 1.65.0, migration 170); absent = the dam.
			crop_water_source: n.cropWaterSource ?? WATER_SOURCE_DEFAULTS.cropWaterSource,
			crop_river_pump_m3_day: n.cropRiverPumpM3Day ?? WATER_SOURCE_DEFAULTS.cropRiverPumpM3Day,
			crop_river_pool_m3: n.cropRiverPoolM3 ?? WATER_SOURCE_DEFAULTS.cropRiverPoolM3,
			// The crop supply table (engine ≥ 1.73.0, migration 202); absent = none. Its other unit is linked below, with the topology.
			crop_share_dam: n.cropShareDam ?? CROP_SUPPLY_DEFAULTS.cropShareDam,
			crop_share_river: n.cropShareRiver ?? CROP_SUPPLY_DEFAULTS.cropShareRiver,
			crop_share_remote: n.cropShareRemote ?? CROP_SUPPLY_DEFAULTS.cropShareRemote,
			crop_remote_cap_m3_day: n.cropRemoteCapM3Day ?? CROP_SUPPLY_DEFAULTS.cropRemoteCapM3Day,
			// Hands-off flow and River to dam by month (engine ≥ 1.32.0, migration 114); absent = off.
			hands_off_m3_day: n.handsOffM3Day ?? OPERATING_DEFAULTS.handsOffM3Day,
			hands_off_ewr: n.handsOffEwr ?? OPERATING_DEFAULTS.handsOffEwr,
			divert_monthly_m3_day: n.divertMonthlyM3Day ?? OPERATING_DEFAULTS.divertMonthlyM3Day,
			ewr_site: n.ewrSite ?? true,
			ga_property_area_ha: n.gaPropertyAreaHa ?? null,
			ga_rate_m3_ha_year: n.gaRateM3HaYear ?? null
		})),
		'node'
	);
	const linked = m.nodes.filter((n) => n.downstreamNodeId || n.cropRemoteNodeId);
	if (linked.length) {
		// The topology and each crop supply table's other unit (engine ≥ 1.73.0), once every node exists.
		await db.query(
			`UPDATE node SET downstream_node_id = l.down, crop_remote_node_id = l.remote
			 FROM unnest($2::uuid[], $3::uuid[], $4::uuid[]) AS l(id, down, remote)
			 WHERE node.id = l.id AND node.project_id = $1`,
			[projectId, linked.map((n) => n.id), linked.map((n) => n.downstreamNodeId ?? null), linked.map((n) => n.cropRemoteNodeId ?? null)]
		);
	}
	await upsertAll(
		`INSERT INTO crop (id, project_id, name, sort_order, crop_factor, irrigation_system_id)
		 SELECT id, $1, name, sort_order, crop_factor, irrigation_system_id FROM jsonb_populate_recordset(NULL::crop, $2::jsonb)
		 ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order,
			crop_factor = EXCLUDED.crop_factor, irrigation_system_id = EXCLUDED.irrigation_system_id
		 WHERE crop.project_id = EXCLUDED.project_id`,
		// Without an explicit order, the document's order is the display order. No default
		// system (null) = the unit's own, and the crop reads back without the key.
		m.crops.map((c, i) => ({
			id: c.id,
			name: c.name,
			sort_order: c.sortOrder ?? i,
			crop_factor: c.cropFactor,
			irrigation_system_id: systemIdOf(c.irrigationSystemId)
		})),
		'crop'
	);
	const areas = m.cropAreas.filter((a) => a.areaM2 > 0);
	if (areas.length) {
		await db.query(
			`INSERT INTO crop_area (project_id, node_id, crop_id, area_m2, irrigation_system_id)
			 SELECT $1, * FROM unnest($2::uuid[], $3::uuid[], $4::float8[], $5::uuid[])`,
			[projectId, areas.map((a) => a.nodeId), areas.map((a) => a.cropId), areas.map((a) => a.areaM2), areas.map((a) => systemIdOf(a.irrigationSystemId))]
		);
	}
	await upsertAll(
		`INSERT INTO transfer (id, project_id, from_node_id, to_node_id, months, max_rate_m3s, daily_cap_m3,
			min_storage_pct, enabled, priority, monthly_rate_m3s, source, hands_off_m3_day, hands_off_ewr, loss_pct, sizing,
			top_up_dam, loss_return_pct, loss_return_node_id)
		 SELECT id, $1, from_node_id, to_node_id, months, max_rate_m3s, daily_cap_m3, min_storage_pct, enabled, priority,
			monthly_rate_m3s, source, hands_off_m3_day, hands_off_ewr, loss_pct, sizing, top_up_dam, loss_return_pct, loss_return_node_id
		 FROM jsonb_populate_recordset(NULL::transfer, $2::jsonb)
		 ON CONFLICT (id) DO UPDATE SET from_node_id = EXCLUDED.from_node_id, to_node_id = EXCLUDED.to_node_id,
			months = EXCLUDED.months, max_rate_m3s = EXCLUDED.max_rate_m3s, daily_cap_m3 = EXCLUDED.daily_cap_m3,
			min_storage_pct = EXCLUDED.min_storage_pct, enabled = EXCLUDED.enabled, priority = EXCLUDED.priority,
			monthly_rate_m3s = EXCLUDED.monthly_rate_m3s, source = EXCLUDED.source, hands_off_m3_day = EXCLUDED.hands_off_m3_day,
			hands_off_ewr = EXCLUDED.hands_off_ewr, loss_pct = EXCLUDED.loss_pct, sizing = EXCLUDED.sizing,
			top_up_dam = EXCLUDED.top_up_dam, loss_return_pct = EXCLUDED.loss_return_pct,
			loss_return_node_id = EXCLUDED.loss_return_node_id
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
			priority: t.priority,
			// Monthly rates (engine ≥ 1.14.0); absent = none.
			monthly_rate_m3s: t.monthlyRateM3s ?? null,
			// River off-takes (engine ≥ 1.14.0); absent = a dam transfer.
			source: t.source ?? OFFTAKE_DEFAULTS.source,
			hands_off_m3_day: t.handsOffM3Day ?? null,
			hands_off_ewr: t.handsOffEwr ?? OFFTAKE_DEFAULTS.handsOffEwr,
			loss_pct: t.lossPct ?? OFFTAKE_DEFAULTS.lossPct,
			sizing: t.sizing ?? OFFTAKE_DEFAULTS.sizing,
			top_up_dam: t.topUpDam ?? OFFTAKE_DEFAULTS.topUpDam,
			// Canal seepage back to the river (engine ≥ 1.42.0, migration 126); absent = none returns.
			loss_return_pct: t.lossReturnPct ?? OFFTAKE_DEFAULTS.lossReturnPct,
			loss_return_node_id: t.lossReturnNodeId ?? null
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
	await upsertAll(
		`INSERT INTO demand_object (id, project_id, node_id, name, category, sizing, monthly_m3_day, monthly_unit, unit_count, litres_per_unit_day,
			loss_pct, monthly_factor, return_pct, priority, priority_rank, destination, enabled, schedule, population, source,
			water_source, river_pump_m3_day, river_pool_m3, note)
		 SELECT id, $1, node_id, name, category, sizing, monthly_m3_day, monthly_unit, unit_count, litres_per_unit_day,
			loss_pct, monthly_factor, return_pct, priority, priority_rank, destination, enabled, schedule, population, source,
			water_source, river_pump_m3_day, river_pool_m3, note
		 FROM jsonb_populate_recordset(NULL::demand_object, $2::jsonb)
		 ON CONFLICT (id) DO NOTHING`,
		(m.demandObjects ?? []).map((o) => ({
			id: o.id,
			node_id: o.nodeId,
			name: o.name,
			category: o.category,
			sizing: o.sizing,
			monthly_m3_day: o.monthlyM3Day,
			// The unit it is shown in (199, display only); absent and null alike = m³/day.
			monthly_unit: o.monthlyUnit ?? null,
			unit_count: o.count,
			litres_per_unit_day: o.litresPerUnitDay,
			loss_pct: o.lossPct,
			monthly_factor: o.monthlyFactor,
			return_pct: o.returnPct,
			priority: o.priority,
			// Its rank within its class (engine 1.64.0); absent and null alike = 1.
			priority_rank: o.rank ?? null,
			destination: o.destination,
			enabled: o.enabled,
			// No schedule and an empty one run alike (engine 1.17.0); store both as NULL.
			schedule: o.schedule?.length ? o.schedule : null,
			// The people it serves, for the basic-needs floor (engine 1.44.0); absent and null alike = its count.
			population: o.population ?? null,
			// Where its number comes from (engine 1.56.0); absent and null alike = not recorded.
			source: o.source ?? null,
			// Where its water comes from (engine 1.65.0, migration 170); absent and null alike = the dam.
			water_source: o.waterSource ?? null,
			river_pump_m3_day: o.riverPumpM3Day ?? null,
			river_pool_m3: o.riverPoolM3 ?? null,
			note: o.note
		})),
		'demand object'
	);
	await db.query('UPDATE project SET updated_at = now() WHERE id = $1', [projectId]);
}

/**
 * Write the project's irrigation-systems table (engine ≥ 1.72.0) when `table` is
 * given: rows upserted by id, rows missing from it deleted (a crop or planting on
 * one falls back to none, ON DELETE SET NULL). Returns how a reference is stored:
 * a row id as it is (the foreign key and the same-project trigger hold it to
 * this project), a SABI preset's key ('drip', …) or a document's own key as the
 * project's row for it, null as null; a key with no row is a 400. At most three
 * statements whatever the table's size, none when nothing needs one.
 */
async function saveIrrigationSystems(db: Db, projectId: string, m: ProjectModel): Promise<(ref: string | null | undefined) => string | null> {
	const table = m.irrigationSystems;
	const refs = [...m.crops.map((c) => c.irrigationSystemId), ...m.cropAreas.map((a) => a.irrigationSystemId)];
	// The project's row for each preset, read once and only when a key needs it.
	let presets: Map<string, string> | null = null;
	const presetRows = async () => {
		if (!presets) {
			const { rows } = await db.query<{ id: string; preset: string }>(`SELECT id, preset FROM irrigation_system WHERE project_id = $1 AND preset IS NOT NULL ORDER BY sort_order, id`, [projectId]);
			presets = new Map();
			for (const r of rows) if (!presets.has(r.preset)) presets.set(r.preset, r.id);
		}
		return presets;
	};
	const keyed = new Map<string, string>();
	if (table) {
		// A row named by a preset key (a document's default table) is the project's row for that preset; a new row gets its id here.
		const known = table.some((x) => !UUID.test(x.id)) ? await presetRows() : new Map<string, string>();
		const rows = table.map((x, i) => {
			const id = UUID.test(x.id) ? x.id : (known.get(x.id) ?? crypto.randomUUID());
			if (id !== x.id) keyed.set(x.id, id);
			if (x.preset && !keyed.has(x.preset)) keyed.set(x.preset, id);
			return { id, name: x.name, efficiency: x.efficiency, preset: x.preset ?? null, sort_order: x.sortOrder ?? i };
		});
		await db.query(`DELETE FROM irrigation_system WHERE project_id = $1 AND NOT (id = ANY($2::uuid[]))`, [projectId, rows.map((r) => r.id)]);
		const { rowCount } = await db.query(
			`INSERT INTO irrigation_system (id, project_id, name, efficiency, preset, sort_order)
			 SELECT id, $1, name, efficiency, preset, sort_order FROM jsonb_populate_recordset(NULL::irrigation_system, $2::jsonb)
			 ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, efficiency = EXCLUDED.efficiency, preset = EXCLUDED.preset,
				sort_order = EXCLUDED.sort_order
			 WHERE irrigation_system.project_id = EXCLUDED.project_id`,
			[projectId, JSON.stringify(rows)]
		);
		if (rowCount !== rows.length) throw new ApiError(409, 'irrigation system id already used by another project');
	} else if (refs.some((r) => r != null && !UUID.test(r))) {
		for (const [k, id] of await presetRows()) keyed.set(k, id);
	}
	return (ref) => {
		if (ref == null) return null;
		const k = keyed.get(ref);
		if (k) return k;
		if (UUID.test(ref)) return ref;
		throw new ApiError(400, `irrigation system ${ref} is not in the project's table`);
	};
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
