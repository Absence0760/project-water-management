import { Hono } from 'hono';
import { damCapacityOn, fromEpochDay, modelFarmEfficiency, toEpochDay, upgradeLegacyModel, waterYearIndex, type CropArea, type CropDef, type NetworkNode, type RunoffBalance, type RunSummary } from '@water-management/engine';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { type Db, withUser } from '../db/tx.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { recordAudit } from '../history/record.js';
import { queueAlertEval } from '../alerts/queue.js';
import { wakeWorker } from '../jobs/wake.js';
import { requireRole, UUID } from '../projects/access.js';
import { loadDailyScope } from '../export/daily-columns.js';
import { bulkPage } from './bulk.js';
import { runVerified } from './stamp.js';
import { EVIDENCE_STATUS_SQL } from './evidence.js';
import { CITED_BY_SQL, citedMessage, loadModelInput, lockProjectRuns, PINNED_RUNS_PER_PROJECT_MAX, RUN_KEPT_SQL, RUN_PUBLISHED_SQL, runFailure, runLiveModel, trimRuns } from './execute.js';

// A run saved before settings.runoffModel existed (engine < 0.5.0) ran the
// only model there was, legacy — same "absent → legacy" convention the
// engine's compareRuns() uses (packages/engine/src/compare.ts effectiveSettings).
// `evidence` is the run's place in the evidence history (010_run_nomination);
// `pinned` keeps it past the storage cap (015_run_pinned); `published` says
// the project's current publication holds it (022_publication). `scenarioId` /
// `scenarioName`: the scenario that made the run (024_scenarios; the name the
// run recorded once the scenario is gone); `citedBy`: what keeps it for good;
// `reproducible`: its input series are stored (021_series_blob), so
// GET …/reproduce can re-run it. The same test loadRunInput makes: a run
// with input series but no stored references is from before 021;
// `trigger`: what made it, 'manual', 'auto' or 'forecast' (042_auto_rerun,
// WP-2.11, WP-2.12); `forecastFrom`: a forecast run's first forecast day
// (summary.forecast.from), else null.
const RUN_META = `r.id, r.label, r.engine_version AS "engineVersion", r.start_date AS "startDate",
	r.end_date AS "endDate", r.created_at AS "createdAt", u.display_name AS "createdBy",
	COALESCE(r.inputs->'settings'->>'runoffModel', 'legacy') = 'legacy' AS legacy,
	COALESCE(r.inputs->'settings'->>'runoffModel', 'legacy') AS "runoffModel",
	r.notes, r.notes_updated_at AS "notesUpdatedAt", nu.display_name AS "notesUpdatedBy",
	${EVIDENCE_STATUS_SQL} AS evidence, r.pinned,
	EXISTS (SELECT 1 FROM run_publication p WHERE p.run_id = r.id AND p.superseded_at IS NULL) AS published,
	r.scenario_id AS "scenarioId", COALESCE(sc.name, r.inputs->'scenario'->>'name') AS "scenarioName",
	${CITED_BY_SQL} AS "citedBy",
	(EXISTS (SELECT 1 FROM run_input_series i WHERE i.run_id = r.id)
		OR NOT EXISTS (SELECT 1 FROM jsonb_object_keys(COALESCE(r.inputs->'series', '{}'::jsonb)))) AS reproducible,
	r.trigger, r.summary->'forecast'->>'from' AS "forecastFrom"`;
const FROM_RUN = `FROM model_run r JOIN app_user u ON u.id = r.created_by LEFT JOIN app_user nu ON nu.id = r.notes_updated_by
	LEFT JOIN scenario sc ON sc.id = r.scenario_id`;
/** A run's metadata columns and the FROM they need, for routes elsewhere that answer with a run (scenario runs). */
export const RUN_META_SQL = { meta: RUN_META, from: FROM_RUN } as const;

/** Longest run note, in characters (007_run_notes.sql CHECK). */
export const RUN_NOTES_MAX = 4000;
/** PATCH …/runs/:runId: the note, the pin, or both; nothing else about a run may change. */
const RunPatchBody = z
	.object({
		notes: z
			.string()
			.trim()
			.max(RUN_NOTES_MAX)
			// Postgres text can't hold NUL; refuse it here rather than surface a database error.
			.refine((s) => !s.includes('\u0000'), 'notes cannot contain NUL characters')
			.optional(),
		pinned: z.boolean().optional()
	})
	.strict()
	.refine((b) => b.notes !== undefined || b.pinned !== undefined, 'send notes, pinned or both');

export const runRoutes = new Hono<AuthEnv>()
	.post('/:id/runs', async (c) => {
		// forecast (WP-2.12): a forecast-mode run, kept apart from the manual runs' cap (one per project).
		const body = z
			.object({ label: z.string().trim().max(200).default(''), forecast: z.boolean().default(false) })
			.parse(await readJson(c, { optional: true }));
		const id = c.req.param('id');
		// Inputs read in one transaction, the engine run with none open, the run
		// stored in a second (runLiveModel): a long run holds no pooled connection.
		const { alertJob, ...result } = await runLiveModel(c.get('userId'), id, body.label, body.forecast ? 'forecast' : 'manual', async (db, run) => {
			// Keep the newest N manual runs per project (the new one included), and the newest unkept run of each automatic trigger (a forecast run replaces the last).
			const removedRunIds = await trimRuns(db, id);
			const { rows } = await db.query(`SELECT ${RUN_META}, r.summary ${FROM_RUN} WHERE r.id = $1`, [run.id]);
			// A forecast run made by hand replaces the scheduled one, so the EWR
			// forecast alert is re-checked against it, as after a scheduled one
			// (jobs/handlers/rerun.ts): nothing queued when alerts are off.
			const alertJob = body.forecast ? await queueAlertEval(db, id, 'forecast') : null;
			return { run: rows[0], removedRunIds, alertJob };
		}).catch(runFailure);
		if (alertJob?.created) await wakeWorker(alertJob.id);
		return c.json(result, 201);
	})
	// The exact input a run would use (merged settings, the model, the first
	// series of each kind by name), for running the engine in the browser:
	// automatic calibration (issue #4 phase 5). Read-only, so viewers may fit
	// too; only editors can save what they find.
	.get('/:id/model-input', async (c) => {
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			return c.json({ input: await loadModelInput(db, id) });
		});
	})
	.get('/:id/runs', async (c) =>
		withUser(c.get('userId'), async (db) => {
			await requireRole(db, c.req.param('id'), 'viewer');
			const { rows } = await db.query(`SELECT ${RUN_META} ${FROM_RUN} WHERE r.project_id = $1 ORDER BY r.created_at DESC`, [
				c.req.param('id')
			]);
			return c.json({ runs: rows });
		})
	)
	.get('/:id/runs/:runId', async (c) => {
		const { id, runId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			if (!UUID.test(runId)) throw new ApiError(404, 'not found');
			// The run's own settings snapshot: its fit record and calibration
			// exclusions are the provenance of its parameters and scores. Its
			// model snapshot (nodes, crops, transfers as they were when it ran)
			// names its nodes and fills the workbook's Inputs sheet. Its input
			// series' dates, hashes and product/version (inputSeries; the values
			// are in series_blob): the fit record compares the CHIRPS version.
			// forecastRainSource: a forecast run's rain source ('chirps_gefs' |
			// 'other', runs/execute.ts forecastRainSource), null otherwise.
			const { rows } = await db.query(
				`SELECT ${RUN_META}, r.summary, r.inputs->'settings' AS settings, r.inputs->'model' AS model, r.inputs->'series' AS "inputSeries",
					r.inputs->>'forecastRainSource' AS "forecastRainSource" ${FROM_RUN}
				 WHERE r.project_id = $1 AND r.id = $2`,
				[
					id,
					runId
				]
			);
			if (!rows[0]) throw new ApiError(404, 'not found');
			// Its server stamp still matches its rows (077, runs/stamp.ts): false for a
			// run written past the model run, or changed since, which can't be signed off.
			rows[0].verified = await runVerified(db, runId);
			const { rows: series } = await db.query(
				`SELECT node_id AS "nodeId", key, meta->>'label' AS label, meta->>'unit' AS unit
				 FROM run_series WHERE run_id = $1 ORDER BY node_id NULLS FIRST, key`,
				[runId]
			);
			return c.json({ run: rows[0], series });
		});
	})
	.get('/:id/runs/:runId/series', async (c) => {
		const { id, runId } = c.req.param();
		const q = z.object({ key: z.string().min(1).max(100), nodeId: z.string().uuid().optional() }).parse(c.req.query());
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			if (!UUID.test(runId)) throw new ApiError(404, 'not found');
			const { rows } = await db.query<{ startDate: string; values: number[] }>(
				`SELECT r.start_date AS "startDate", s."values"
				 FROM run_series s JOIN model_run r ON r.id = s.run_id
				 WHERE r.project_id = $1 AND s.run_id = $2 AND s.key = $3 AND s.node_id IS NOT DISTINCT FROM $4::uuid`,
				[id, runId, q.key, q.nodeId ?? null]
			);
			if (!rows[0]) throw new ApiError(404, 'not found');
			return c.json(rows[0]);
		});
	})
	// Every stored series of one node (the catchment's without nodeId), in the
	// daily CSV's column order and with its headers: what the browser-built
	// .xlsx workbook fetches, one request per node (docs/api.md § Export).
	// Paged by `offset` so no response passes the 5 MB export cap; a node over
	// a record of up to ~6 000 days (32 columns) fits in one page.
	.get('/:id/runs/:runId/series/bulk', async (c) => {
		const { id, runId } = c.req.param();
		const q = z
			.object({ nodeId: z.string().uuid().optional(), offset: z.coerce.number().int().min(0).max(1_000_000).default(0) })
			.parse(c.req.query());
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			if (!UUID.test(runId)) throw new ApiError(404, 'not found');
			const { rows } = await db.query<{ startDate: string; summary: RunSummary }>(
				'SELECT start_date AS "startDate", summary FROM model_run WHERE project_id = $1 AND id = $2',
				[id, runId]
			);
			const run = rows[0];
			if (!run) throw new ApiError(404, 'not found');
			const scope = await loadDailyScope(db, runId, q.nodeId ?? null, run.summary);
			if (!scope) throw new ApiError(404, 'not found');
			const page = bulkPage(scope, q.nodeId ?? null, run.startDate, q.offset);
			if (!page) throw new ApiError(400, 'offset is past the end of the run');
			return c.json(page);
		});
	})
	// One node's every column on one day, with the day before's storage and the
	// node's parameters from the run's own input snapshot: what the day trace
	// needs to redo the day's arithmetic (docs/ui.md § Self-checks). Without a
	// nodeId it traces the catchment: the runoff model's day.
	.get('/:id/runs/:runId/day', async (c) => {
		const { id, runId } = c.req.param();
		const q = z
			.object({
				nodeId: z.string().uuid().optional(),
				// A real calendar date (2024-02-31 would roll over, or reach Postgres as an error).
				date: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
					.refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && fromEpochDay(toEpochDay(s)) === s, 'not a date')
			})
			.parse(c.req.query());
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			if (!UUID.test(runId)) throw new ApiError(404, 'not found');
			if (!q.nodeId) return c.json(await catchmentDay(db, id, runId, q.date));
			const { rows: run } = await db.query<{
				index: number | null;
				days: number;
				node: Record<string, unknown> | null;
				crops: CropDef[] | null;
				crop_areas: CropArea[] | null;
				apan_mm: unknown;
			}>(
				`SELECT ($3::date - r.start_date) AS index, (r.end_date - r.start_date + 1) AS days,
					(SELECT n FROM jsonb_array_elements(r.inputs->'model'->'nodes') n WHERE n->>'id' = $4) AS node,
					r.inputs->'model'->'crops' AS crops, r.inputs->'model'->'cropAreas' AS crop_areas, r.inputs->'settings'->'apanMm' AS apan_mm
				 FROM model_run r WHERE r.project_id = $1 AND r.id = $2`,
				[id, runId, q.date, q.nodeId]
			);
			const r = run[0];
			if (!r) throw new ApiError(404, 'not found');
			if (r.index === null || r.index < 0 || r.index >= r.days) throw new ApiError(400, 'the date is outside the run');
			// Postgres arrays are 1-based: day t is values[t + 1], the day before values[t].
			const { rows } = await db.query<{ key: string; label: string | null; unit: string | null; value: number | null; previous: number | null }>(
				`SELECT key, meta->>'label' AS label, meta->>'unit' AS unit, "values"[$3::int + 1] AS value,
					CASE WHEN $3::int > 0 THEN "values"[$3::int] END AS previous
				 FROM run_series WHERE run_id = $1 AND node_id = $2::uuid`,
				[runId, q.nodeId, r.index]
			);
			if (!rows.length || !r.node) throw new ApiError(404, 'not found');
			const node = r.node as { name: string; kind: 'farm' | 'gauge'; damCapacityM3?: number; damInitialPct?: number };
			const storage = rows.find((x) => x.key === 'dam_storage');
			// Storage at the end of the day before: the run's initial storage on its first day, a share of
			// the capacity on that day (engine ≥ 1.30.0: sediment, an in-service date; network/development.ts).
			const previousStorageM3 =
				node.kind !== 'farm'
					? null
					: r.index === 0
						? (node.damInitialPct ?? 0) * damCapacityOn({ ...(r.node as unknown as NetworkNode), damCapacityM3: node.damCapacityM3 ?? 0 }, toEpochDay(q.date))
						: (storage?.previous ?? null);
			// Soil-water store at the end of the day before (engine ≥ 0.14.0): empty on the first day; null without the column.
			const soil = rows.find((x) => x.key === 'soil_water');
			const previousSoilWaterMm = node.kind !== 'farm' || !soil ? null : r.index === 0 ? 0 : soil.previous;
			return c.json({
				date: q.date,
				nodeId: q.nodeId,
				name: node.name,
				kind: node.kind,
				previousStorageM3,
				previousSoilWaterMm,
				// A run saved before engine 0.16.0 reads as migration 006 stored its model (return flow % → efficiency).
				params: dayParams(upgradeLegacyModel({ nodes: [r.node] }).nodes[0] as unknown as NetworkNode, r.crops ?? [], r.crop_areas ?? [], r.apan_mm, q.date),
				columns: rows.map(({ key, label, unit, value }) => ({ key, label: label ?? key, unit, value }))
			});
		});
	})
	// The run's written explanation (007_run_notes) and its pin (015_run_pinned):
	// the only things about a run that may change after it is made. The column
	// grants make every other column read-only to the app, whatever this
	// handler does.
	.patch('/:id/runs/:runId', async (c) => {
		const { id, runId } = c.req.param();
		const body = RunPatchBody.parse(await readJson(c, { optional: true }));
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			if (!UUID.test(runId)) throw new ApiError(404, 'not found');
			const { rows: found } = await db.query<{ pinned: boolean; cited: boolean; notes: string }>(
				'SELECT pinned, notes, model_run_cited(id) AS cited FROM model_run WHERE project_id = $1 AND id = $2',
				[id, runId]
			);
			if (!found[0]) throw new ApiError(404, 'not found');
			// Unpinning a cited run would change nothing (it stays kept), so say why instead.
			if (body.pinned === false && found[0].pinned && found[0].cited) throw new ApiError(409, await citedMessage(db, id, runId, 'so it stays kept'));
			if (body.pinned && !found[0].pinned && !found[0].cited) {
				// The friendly answer; the model_run_pin_limit trigger enforces it again, race-free.
				// A cited run's pin doesn't count (024_scenarios): it is kept anyway.
				const { rows: n } = await db.query<{ n: number }>(
					'SELECT count(*)::int AS n FROM model_run WHERE project_id = $1 AND pinned AND NOT model_run_cited(id)',
					[id]
				);
				if (n[0]!.n >= PINNED_RUNS_PER_PROJECT_MAX) throw pinLimit();
			}
			// Only the columns sent: a pin leaves the note (and its stamp) alone, and the other way round.
			const set = Object.entries({ notes: body.notes, pinned: body.pinned }).filter(([, v]) => v !== undefined);
			// The note's text stays on the run (notes_updated_by/at stamp it); the log says what changed,
			// and nothing when a PATCH re-sends what the run already has.
			const changed = set.filter(([k, v]) => (k === 'notes' ? v !== found[0]!.notes : v !== found[0]!.pinned)).map(([k]) => k);
			if (changed.length) {
				const pinChanged = changed.includes('pinned');
				await recordAudit(db, id, 'run.changed', { runId, fields: changed, ...(pinChanged ? { pinned: body.pinned } : {}) });
			}
			await db
				.query(`UPDATE model_run SET ${set.map(([k], i) => `${k} = $${i + 3}`).join(', ')} WHERE project_id = $1 AND id = $2`, [
					id,
					runId,
					...set.map(([, v]) => v)
				])
				.catch((err: { code?: string }) => {
					throw err.code === '23514' && body.pinned ? pinLimit() : err;
				});
			const { rows } = await db.query(`SELECT ${RUN_META} ${FROM_RUN} WHERE r.id = $1`, [runId]);
			return c.json({ run: rows[0] });
		});
	})
	.delete('/:id/runs/:runId', async (c) => {
		const { id, runId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			if (!UUID.test(runId)) throw new ApiError(404, 'not found');
			// The run's stored inputs may be garbage-collected with it: not while a
			// new run of this project is taking a reference to them (lockProjectRuns).
			await lockProjectRuns(db, id);
			// A kept run (RUN_KEPT_SQL) isn't deleted: one a publication holds, or
			// something else cites (model_run_cited, 021_series_blob and
			// 022_publication), or the evidence history names is kept (their foreign
			// keys refuse it too); a pinned one until it is unpinned. The row is
			// locked (FOR UPDATE) so the check and the DELETE see the same run.
			const { rows: kept } = await db.query<{ pinned: boolean; published: boolean; cited: boolean; kept: boolean }>(
				`SELECT r.pinned, ${RUN_PUBLISHED_SQL} AS published, model_run_cited(r.id) AS cited, ${RUN_KEPT_SQL} AS kept FROM model_run r WHERE r.project_id = $1 AND r.id = $2 FOR UPDATE`,
				[id, runId]
			);
			if (!kept[0]) throw new ApiError(404, 'not found');
			if (kept[0].kept)
				throw new ApiError(
					409,
					kept[0].published
						? 'run is published: it is, or was, the published baseline, so it is kept'
						: kept[0].cited
							? await citedMessage(db, id, runId)
							: kept[0].pinned
								? 'this run is pinned; unpin it before deleting it'
								: 'this run is or was nominated as evidence, so it is kept'
				);
			const { rows: gone } = await db.query<{ label: string; created_at: Date }>(
				'DELETE FROM model_run WHERE project_id = $1 AND id = $2 RETURNING label, created_at',
				[id, runId]
			);
			// The row is locked and was readable, so nothing else removed it: row-level
			// security refused the delete. That is a refusal, not "not found".
			if (!gone[0]) throw new ApiError(409, "this run can't be deleted");
			await recordAudit(db, id, 'run.deleted', { runIds: [runId], label: gone[0].label, runCreatedAt: gone[0].created_at.toISOString(), reason: 'deleted' });
			return c.body(null, 204);
		});
	});

const pinLimit = () =>
	new ApiError(409, `this project already has ${PINNED_RUNS_PER_PROJECT_MAX} pinned runs, the most it can keep; unpin one first`);

/** The runoff model's stores, as run_series keys (engine runoff/gr4j.ts STORES). */
const RUNOFF_STORES = ['production_store', 'routing_store', 'uh_store'] as const;

/**
 * The catchment's day: every catchment series (node_id NULL) that day, the
 * runoff model's stores at the end of the day before and its parameters from
 * the run's summary. A legacy run has no stores (runoffModel 'legacy',
 * previousStorageMm null); the UI says so and lists the [Flow data] columns.
 */
async function catchmentDay(db: Db, projectId: string, runId: string, date: string) {
	const { rows: run } = await db.query<{ index: number | null; days: number; runoff: RunoffBalance | null }>(
		`SELECT ($3::date - r.start_date) AS index, (r.end_date - r.start_date + 1) AS days, r.summary->'runoff' AS runoff
		 FROM model_run r WHERE r.project_id = $1 AND r.id = $2`,
		[projectId, runId, date]
	);
	const r = run[0];
	if (!r) throw new ApiError(404, 'not found');
	if (r.index === null || r.index < 0 || r.index >= r.days) throw new ApiError(400, 'the date is outside the run');
	const { rows } = await db.query<{ key: string; label: string | null; unit: string | null; value: number | null; previous: number | null }>(
		`SELECT key, meta->>'label' AS label, meta->>'unit' AS unit, "values"[$2::int + 1] AS value,
			CASE WHEN $2::int > 0 THEN "values"[$2::int] END AS previous
		 FROM run_series WHERE run_id = $1 AND node_id IS NULL ORDER BY key`,
		[runId, r.index]
	);
	if (!rows.length) throw new ApiError(404, 'not found');
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
		columns: rows.map(({ key, label, unit, value }) => ({ key, label: label ?? key, unit, value }))
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
	'lossReturnFraction',
	'damAreaFullM2',
	'damAreaExponent',
	'damSeepagePerDay'
] as const;

const pick = <K extends string>(o: Record<string, unknown>, keys: readonly K[]): Record<K, unknown> =>
	Object.fromEntries(keys.map((k) => [k, o[k] ?? null])) as Record<K, unknown>;

/**
 * The day trace's parameters. `irrigationEfficiency` is the one the run used
 * (D = F ÷ e): a farm whose crops carry their own (engine ≥ 0.43.0) runs on
 * them combined (engine demand.ts modelFarmEfficiency), else its own.
 * `divertCapacityM3Day` is the day's: a farm with River to dam by month
 * (engine ≥ 1.32.0) ran on that month's value.
 */
function dayParams(
	n: NetworkNode,
	crops: readonly CropDef[],
	cropAreas: readonly CropArea[],
	apanMm: unknown,
	date: string
): Record<(typeof DAY_PARAMS)[number], unknown> {
	const p = pick(n as unknown as Record<string, unknown>, DAY_PARAMS);
	if (n.kind === 'farm' && Array.isArray(n.divertMonthlyM3Day) && n.divertMonthlyM3Day.length === 12)
		p.divertCapacityM3Day = n.divertMonthlyM3Day[waterYearIndex(Number(date.slice(5, 7)))] ?? null;
	if (n.kind === 'farm' && typeof n.irrigationEfficiency === 'number' && n.irrigationEfficiency > 0 && n.irrigationEfficiency <= 1) {
		p.irrigationEfficiency = modelFarmEfficiency(n.irrigationEfficiency, n.id, crops, cropAreas, Array.isArray(apanMm) ? apanMm : []);
	}
	return p;
}
