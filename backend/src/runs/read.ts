// A run's reads, with the withholding inside them (issue #610): the run with
// its summary, settings and model snapshot, one stored series, a node's bulk
// pages and one day of a node or the catchment. The run routes
// (runs/routes.ts) and the assistant's tools (assistant/tools/) both read
// through here, so a viewer kept from each registered volume (162, D3) gets
// neither the run's copy of the volumes (redactRunAllocations) nor the series
// worked out from them (#523 I, withheldSeries.ts) by either path. Nothing
// else may read run_series for a member: a reader that skips this module
// skips the withholding.
//
// Each reader takes the caller's role (requireRole, which the caller has
// already asked) and throws ApiError: 404 for a run or series that isn't
// there, 403 `allocation_series_withheld` for one that is withheld.
import { damCapacityOn, modelFarmEfficiency, runReturnFlow, toEpochDay, upgradeLegacyModel, waterYearIndex, type CropArea, type CropDef, type IrrigationSystemDef, type ModelInput, type NetworkNode, type RunoffBalance, type RunSummary } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { allocationUnitsHidden, redactRunAllocations } from '../allocations/viewerUnits.js';
import { type Role, UUID } from '../projects/access.js';
import { loadDailyScope } from '../export/daily-columns.js';
import { bulkPage } from './bulk.js';
import { allocationSeriesWithheld, keepVisible, seriesWithholding, type SeriesWithholding } from './withheldSeries.js';
import { runVerified } from './stamp.js';
import { EVIDENCE_STATUS_SQL } from './evidence.js';
import type { RunEngines } from '../errata/runs.js';
import { CITED_BY_SQL, loadModelInput } from './execute.js';

// A run saved before settings.runoffModel existed (engine < 0.5.0) ran the
// only model there was, legacy — same "absent → legacy" convention the
// engine's compareRuns() uses (packages/engine/src/compare.ts effectiveSettings).
// `evidence` is the run's place in the evidence history (010_run_nomination);
// `pinned` keeps it past the storage cap (015_run_pinned); `published` says
// the project's current publication holds it (022_publication). `scenarioId` /
// `scenarioName`: the scenario that made the run (024_scenarios; the name the
// run recorded once the scenario is gone); `fromScenario`: a scenario made it,
// also once that scenario is deleted and `scenarioId` is null (188: tell a
// run of the model by this, never by `scenarioId`); `citedBy`: what keeps it for good;
// `reproducible`: its input series are stored (021_series_blob), so
// GET …/reproduce can re-run it. The same test loadRunInput makes: a run
// with input series but no stored references is from before 021;
// `trigger`: what made it, 'manual', 'auto' or 'forecast' (042_auto_rerun,
// WP-2.11, WP-2.12); `forecastFrom`: a forecast run's first forecast day
// (summary.forecast.from), else null; `fitEngineVersion`: the engine of the
// fit its headline parameters came from (run_fit_engine_version, 289: the
// headline gauge's row's fit record, else settings.fitRecord), else null, so
// the run list can flag the errata a `fit` erratum keys on (issue #103).
export const RUN_META = `r.id, r.label, r.engine_version AS "engineVersion", r.start_date AS "startDate",
	r.end_date AS "endDate", r.created_at AS "createdAt", u.display_name AS "createdBy",
	COALESCE(r.inputs->'settings'->>'runoffModel', 'legacy') = 'legacy' AS legacy,
	COALESCE(r.inputs->'settings'->>'runoffModel', 'legacy') AS "runoffModel",
	r.notes, r.notes_updated_at AS "notesUpdatedAt", nu.display_name AS "notesUpdatedBy",
	${EVIDENCE_STATUS_SQL} AS evidence, r.pinned,
	EXISTS (SELECT 1 FROM run_publication p WHERE p.run_id = r.id AND p.superseded_at IS NULL) AS published,
	r.scenario_id AS "scenarioId", COALESCE(sc.name, r.inputs->'scenario'->>'name') AS "scenarioName", r.from_scenario AS "fromScenario",
	${CITED_BY_SQL} AS "citedBy",
	(EXISTS (SELECT 1 FROM run_input_series i WHERE i.run_id = r.id)
		OR NOT EXISTS (SELECT 1 FROM jsonb_object_keys(COALESCE(r.inputs->'series', '{}'::jsonb)))) AS reproducible,
	r.trigger, r.summary->'forecast'->>'from' AS "forecastFrom",
	run_fit_engine_version(r.inputs, r.summary) AS "fitEngineVersion"`;
export const FROM_RUN = `FROM model_run r LEFT JOIN app_user u ON u.id = r.created_by LEFT JOIN app_user nu ON nu.id = r.notes_updated_by
	LEFT JOIN scenario sc ON sc.id = r.scenario_id`;

/** One stored series of a run, as the run detail lists it. */
export interface ListedSeries {
	nodeId: string | null;
	key: string;
	label: string | null;
	unit: string | null;
}

/** A run as its detail answers, its copy of the registered volumes left out for a caller kept from them. */
export type RunDetail = RunEngines & {
	id: string;
	startDate: string;
	endDate: string;
	summary: RunSummary;
	settings: Record<string, unknown> | null;
	model: ModelInput['model'] | null;
	verified: boolean;
	[k: string]: unknown;
};

const notFound = () => new ApiError(404, 'not found');

/** The exact input a run would use now (GET …/model-input): its allocations are what RLS gives the caller (execute.ts allocationsForRun). */
export const readModelInput = (db: Db, projectId: string): Promise<ModelInput> => loadModelInput(db, projectId);

/**
 * The project's latest run: the newest of the model's own runs (not a
 * scenario's, not a forecast), else the newest of any. null without a run.
 */
export async function latestRunId(db: Db, projectId: string): Promise<string | null> {
	const { rows } = await db.query<{ id: string }>(
		`SELECT id FROM model_run WHERE project_id = $1 ORDER BY (from_scenario OR trigger = 'forecast'), created_at DESC, id LIMIT 1`,
		[projectId]
	);
	return rows[0]?.id ?? null;
}

/**
 * GET …/runs/:runId: the run with its summary, settings and model snapshots,
 * its stored series listed, and those withheld from the caller named in
 * `withheldSeries` instead.
 */
export async function readRun(db: Db, projectId: string, role: Role, runId: string): Promise<{ run: RunDetail; series: ListedSeries[]; withheldSeries: { nodeId: string | null; key: string }[] }> {
	if (!UUID.test(runId)) throw notFound();
	// The run's own settings snapshot: its fit record and calibration
	// exclusions are the provenance of its parameters and scores. Its
	// model snapshot (nodes, crops, transfers as they were when it ran)
	// names its nodes and fills the workbook's Inputs sheet. Its input
	// series' dates, hashes and product/version (inputSeries; the values
	// are in series_blob): the fit record compares the CHIRPS version.
	// forecastRainSource: a forecast run's rain source ('chirps_gefs' |
	// 'ecmwf_ens' | 'other', runs/execute.ts forecastRainSource), null otherwise;
	// forecastRainEcmwf: any of its forecast days was an ECMWF feed's (ECMWF's credit, execute.ts forecastRainEcmwf);
	// et0Products: the reference ET products GR4J read on some run day (their credits, execute.ts storeRun), [] when none.
	const { rows } = await db.query<RunDetail>(
		`SELECT ${RUN_META}, r.summary, r.inputs->'settings' AS settings, r.inputs->'model' AS model, r.inputs->'series' AS "inputSeries",
			r.inputs->>'forecastRainSource' AS "forecastRainSource", r.inputs->'forecastRainEcmwf' = 'true'::jsonb IS TRUE AS "forecastRainEcmwf",
			CASE WHEN jsonb_typeof(r.inputs->'et0Products') = 'array' THEN r.inputs->'et0Products' ELSE '[]'::jsonb END AS "et0Products" ${FROM_RUN}
		 WHERE r.project_id = $1 AND r.id = $2`,
		[projectId, runId]
	);
	if (!rows[0]) throw notFound();
	// Its server stamp still matches its rows (077, runs/stamp.ts): false for a
	// run written past the model run, or changed since, which can't be signed off.
	rows[0].verified = await runVerified(db, runId);
	const { rows: listed } = await db.query<ListedSeries>(
		`SELECT node_id AS "nodeId", key, meta->>'label' AS label, meta->>'unit' AS unit
		 FROM run_series WHERE run_id = $1 ORDER BY node_id NULLS FIRST, key`,
		[runId]
	);
	// A viewer who can't read each registered volume (162, D3) gets the run without its copy of them,
	// and without the series worked out from them, listed as withheld (#523 I, withheldSeries.ts).
	const run = (await allocationUnitsHidden(db, projectId, role)) ? redactRunAllocations(rows[0]) : rows[0];
	const w = await seriesWithholding(db, projectId, role, runId);
	const series = w ? listed.filter((s) => !w.withheld(s.nodeId, s.key)) : listed;
	const withheldSeries = w ? listed.filter((s) => w.withheld(s.nodeId, s.key)).map(({ nodeId, key }) => ({ nodeId, key })) : [];
	return { run, series, withheldSeries };
}

/** GET …/runs/:runId/series: one stored series of a node (the catchment's for null), whole. */
export async function readSeries(db: Db, projectId: string, role: Role, runId: string, key: string, nodeId: string | null): Promise<{ startDate: string; values: number[] }> {
	if (!UUID.test(runId)) throw notFound();
	// Refused by name before it is looked up, so the answer doesn't say whether the unit has one (#523 I).
	if ((await seriesWithholding(db, projectId, role, runId))?.withheld(nodeId, key)) throw allocationSeriesWithheld('this series');
	const { rows } = await db.query<{ startDate: string; values: number[] }>(
		`SELECT r.start_date AS "startDate", s."values"
		 FROM run_series s JOIN model_run r ON r.id = s.run_id
		 WHERE r.project_id = $1 AND s.run_id = $2 AND s.key = $3 AND s.node_id IS NOT DISTINCT FROM $4::uuid`,
		[projectId, runId, key, nodeId]
	);
	if (!rows[0]) throw notFound();
	return rows[0];
}

/** GET …/runs/:runId/series/bulk: one page of every stored series of a node, without the withheld ones (named in `withheld`). */
export async function readSeriesBulk(db: Db, projectId: string, role: Role, runId: string, nodeId: string | null, offset: number) {
	if (!UUID.test(runId)) throw notFound();
	const { rows } = await db.query<{ startDate: string; summary: RunSummary }>('SELECT start_date AS "startDate", summary FROM model_run WHERE project_id = $1 AND id = $2', [
		projectId,
		runId
	]);
	const run = rows[0];
	if (!run) throw notFound();
	const loaded = await loadDailyScope(db, runId, nodeId, run.summary);
	if (!loaded) throw notFound();
	// Without the series worked out from a registered volume, named in `withheld` (#523 I).
	const { kept, withheld } = keepVisible(await seriesWithholding(db, projectId, role, runId), nodeId, loaded.series, "this unit's daily series");
	const page = bulkPage({ ...loaded, series: kept }, nodeId, run.startDate, offset);
	if (!page) throw new ApiError(400, 'offset is past the end of the run');
	return { ...page, withheld };
}

/** GET …/runs/:runId/day: one node's every column on one day (the catchment's without a node), as the day trace reads it. */
export async function readDay(db: Db, projectId: string, role: Role, runId: string, nodeId: string | null, date: string) {
	if (!UUID.test(runId)) throw notFound();
	// The catchment's day through the same withholding as a unit's (#523 I, round 5: no series of a cap or full-allocation run).
	if (!nodeId) return catchmentDay(db, projectId, runId, date, await seriesWithholding(db, projectId, role, runId));
	const { rows: run } = await db.query<{
		index: number | null;
		days: number;
		node: Record<string, unknown> | null;
		crops: CropDef[] | null;
		crop_areas: CropArea[] | null;
		irrigation_systems: IrrigationSystemDef[] | null;
		apan_mm: unknown;
	}>(
		`SELECT ($3::date - r.start_date) AS index, (r.end_date - r.start_date + 1) AS days,
			(SELECT n FROM jsonb_array_elements(r.inputs->'model'->'nodes') n WHERE n->>'id' = $4) AS node,
			r.inputs->'model'->'crops' AS crops, r.inputs->'model'->'cropAreas' AS crop_areas, r.inputs->'model'->'irrigationSystems' AS irrigation_systems, r.inputs->'settings'->'apanMm' AS apan_mm
		 FROM model_run r WHERE r.project_id = $1 AND r.id = $2`,
		[projectId, runId, date, nodeId]
	);
	const r = run[0];
	if (!r) throw notFound();
	if (r.index === null || r.index < 0 || r.index >= r.days) throw new ApiError(400, 'the date is outside the run');
	// Postgres arrays are 1-based: day t is values[t + 1], the day before values[t].
	const { rows } = await db.query<{ key: string; label: string | null; unit: string | null; value: number | null; previous: number | null }>(
		`SELECT key, meta->>'label' AS label, meta->>'unit' AS unit, "values"[$3::int + 1] AS value,
			CASE WHEN $3::int > 0 THEN "values"[$3::int] END AS previous
		 FROM run_series WHERE run_id = $1 AND node_id = $2::uuid`,
		[runId, nodeId, r.index]
	);
	if (!rows.length || !r.node) throw notFound();
	// Without the columns worked out from a registered volume, named in `withheld`; a unit's day of a cap or full-allocation run is refused (#523 I).
	const { kept: columns, withheld } = keepVisible(await seriesWithholding(db, projectId, role, runId), nodeId, rows, "this unit's day");
	const node = r.node as { name: string; kind: 'farm' | 'gauge'; damCapacityM3?: number; damInitialPct?: number };
	const storage = rows.find((x) => x.key === 'dam_storage');
	// Storage at the end of the day before: the run's initial storage on its first day, a share of
	// the capacity on that day (engine ≥ 1.30.0: sediment, an in-service date; network/development.ts).
	const previousStorageM3 =
		node.kind !== 'farm'
			? null
			: r.index === 0
				? (node.damInitialPct ?? 0) * damCapacityOn({ ...(r.node as unknown as NetworkNode), damCapacityM3: node.damCapacityM3 ?? 0 }, toEpochDay(date))
				: (storage?.previous ?? null);
	// Soil-water store at the end of the day before (engine ≥ 0.14.0): empty on the first day; null without the column.
	const soil = rows.find((x) => x.key === 'soil_water');
	const previousSoilWaterMm = node.kind !== 'farm' || !soil ? null : r.index === 0 ? 0 : soil.previous;
	return {
		date,
		nodeId,
		name: node.name,
		kind: node.kind,
		previousStorageM3,
		previousSoilWaterMm,
		// A run saved before engine 0.16.0 reads as migration 006 stored its model (return flow % → efficiency).
		params: dayParams(upgradeLegacyModel({ nodes: [r.node] }).nodes[0] as unknown as NetworkNode, r.node, r.crops ?? [], r.crop_areas ?? [], r.apan_mm, date, r.irrigation_systems),
		columns: columns.map(({ key, label, unit, value }) => ({ key, label: label ?? key, unit, value })),
		withheld
	};
}

/** The runoff model's stores, as run_series keys (engine runoff/gr4j.ts STORES). */
const RUNOFF_STORES = ['production_store', 'routing_store', 'uh_store'] as const;

/**
 * The catchment's day: every catchment series (node_id NULL) that day, the
 * runoff model's stores at the end of the day before and its parameters from
 * the run's summary. A legacy run has no stores (runoffModel 'legacy',
 * previousStorageMm null); the UI says so and lists the [Flow data] columns.
 */
async function catchmentDay(db: Db, projectId: string, runId: string, date: string, w: SeriesWithholding | null) {
	const { rows: run } = await db.query<{ index: number | null; days: number; runoff: RunoffBalance | null }>(
		`SELECT ($3::date - r.start_date) AS index, (r.end_date - r.start_date + 1) AS days, r.summary->'runoff' AS runoff
		 FROM model_run r WHERE r.project_id = $1 AND r.id = $2`,
		[projectId, runId, date]
	);
	const r = run[0];
	if (!r) throw notFound();
	if (r.index === null || r.index < 0 || r.index >= r.days) throw new ApiError(400, 'the date is outside the run');
	const { rows } = await db.query<{ key: string; label: string | null; unit: string | null; value: number | null; previous: number | null }>(
		`SELECT key, meta->>'label' AS label, meta->>'unit' AS unit, "values"[$2::int + 1] AS value,
			CASE WHEN $2::int > 0 THEN "values"[$2::int] END AS previous
		 FROM run_series WHERE run_id = $1 AND node_id IS NULL ORDER BY key`,
		[runId, r.index]
	);
	if (!rows.length) throw notFound();
	const { kept, withheld } = keepVisible(w, null, rows, "the catchment's day");
	const b = r.runoff;
	// A conceptual model's stores the day before. On the run's first day that
	// is each store after the warm-up (engine ≥ 1.20.0, summary.runoff.storesStartMm);
	// a run from before kept only their total, so each store is null there and
	// the total is the run's starting storage.
	const byKey = new Map(rows.map((x) => [x.key, x]));
	const startOf = (k: string) => {
		const v = b?.storesStartMm?.[k];
		return typeof v === 'number' ? v : null;
	};
	const previousStores = b
		? (Object.fromEntries(RUNOFF_STORES.map((k) => [k, r.index === 0 ? startOf(k) : (byKey.get(k)?.previous ?? null)])) as Record<(typeof RUNOFF_STORES)[number], number | null>)
		: null;
	const previousStorageMm = !b
		? null
		: r.index === 0
			? b.storageStartMm
			: RUNOFF_STORES.every((k) => typeof previousStores![k] === 'number')
				? RUNOFF_STORES.reduce((s, k) => s + previousStores![k]!, 0)
				: null;
	return {
		date,
		nodeId: null,
		name: 'Catchment',
		kind: 'catchment' as const,
		// Only conceptual models record a runoff balance (engine ≥ 0.5.0); a run without one ran the legacy model.
		runoffModel: b?.model ?? 'legacy',
		areaKm2: b?.areaKm2 ?? null,
		params: b ? { ...b.params, warmupDays: b.warmupDays } : null,
		previousStorageMm,
		previousStores,
		columns: kept.map(({ key, label, unit, value }) => ({ key, label: label ?? key, unit, value })),
		withheld
	};
}

/** The node parameters the day trace needs to redo the day (docs/api.md). */
const DAY_PARAMS = [
	'pctUpstreamToDam',
	'pctRunoffToDam',
	'divertCapacityM3Day',
	'damCapacityM3',
	'damInitialPct',
	'damMinPct',
	'irrigationEfficiency',
	'returnFlowFraction',
	'damAreaFullM2',
	'damAreaExponent',
	'damSeepagePerDay'
] as const;

const pick = <K extends string>(o: Record<string, unknown>, keys: readonly K[]): Record<K, unknown> =>
	Object.fromEntries(keys.map((k) => [k, o[k] ?? null])) as Record<K, unknown>;

/**
 * The day trace's parameters. `irrigationEfficiency` is the one the run used
 * (D = F ÷ e): a farm whose plantings carry their own system (engine ≥ 1.72.0;
 * a crop's own efficiency from 0.43.0) runs on them combined (engine demand.ts
 * modelFarmEfficiency, with the snapshot's irrigation systems), else its own.
 * `divertCapacityM3Day` is the day's: a farm with River to dam by month
 * (engine ≥ 1.32.0) ran on that month's value. `returnFlowFraction` is the
 * share of the water supplied the run returned: its r capped at 1 − e
 * (engine ≥ 1.71.0), or for a run saved by engine 0.16.0–1.70.0, whose
 * snapshot (`raw`) holds β, a share of the losses, β × (1 − e) of the e it used.
 */
function dayParams(
	n: NetworkNode,
	raw: unknown,
	crops: readonly CropDef[],
	cropAreas: readonly CropArea[],
	apanMm: unknown,
	date: string,
	systems: readonly IrrigationSystemDef[] | null
): Record<(typeof DAY_PARAMS)[number], unknown> {
	const p = pick(n as unknown as Record<string, unknown>, DAY_PARAMS);
	if (n.kind === 'farm' && Array.isArray(n.divertMonthlyM3Day) && n.divertMonthlyM3Day.length === 12)
		p.divertCapacityM3Day = n.divertMonthlyM3Day[waterYearIndex(Number(date.slice(5, 7)))] ?? null;
	if (n.kind === 'farm' && typeof n.irrigationEfficiency === 'number' && n.irrigationEfficiency > 0 && n.irrigationEfficiency <= 1) {
		const e = modelFarmEfficiency(n.irrigationEfficiency, n.id, crops, cropAreas, Array.isArray(apanMm) ? apanMm : [], systems);
		p.irrigationEfficiency = e;
		const beta = raw && typeof raw === 'object' ? (raw as { lossReturnFraction?: unknown }).lossReturnFraction : undefined;
		p.returnFlowFraction = typeof beta === 'number' ? Math.min(Math.max(beta, 0), 1) * (1 - e) : runReturnFlow(n.returnFlowFraction, e);
	}
	return p;
}
