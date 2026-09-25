import { Hono } from 'hono';
import { fromEpochDay, toEpochDay, upgradeLegacyModel, type RunoffBalance } from '@water-management/engine';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { type Db, withUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { requireRole, UUID } from '../projects/access.js';
import { EVIDENCE_STATUS_SQL } from './evidence.js';
import { executeRun, loadModelInput, trimRuns } from './execute.js';

// A run saved before settings.runoffModel existed (engine < 0.5.0) ran the
// only model there was, legacy — same "absent → legacy" convention the
// engine's compareRuns() uses (packages/engine/src/compare.ts effectiveSettings).
// `evidence` is the run's place in the evidence history (010_run_nomination).
const RUN_META = `r.id, r.label, r.engine_version AS "engineVersion", r.start_date AS "startDate",
	r.end_date AS "endDate", r.created_at AS "createdAt", u.display_name AS "createdBy",
	COALESCE(r.inputs->'settings'->>'runoffModel', 'legacy') = 'legacy' AS legacy,
	COALESCE(r.inputs->'settings'->>'runoffModel', 'legacy') AS "runoffModel",
	r.notes, r.notes_updated_at AS "notesUpdatedAt", nu.display_name AS "notesUpdatedBy",
	${EVIDENCE_STATUS_SQL} AS evidence`;
const FROM_RUN = `FROM model_run r JOIN app_user u ON u.id = r.created_by LEFT JOIN app_user nu ON nu.id = r.notes_updated_by`;

/** Longest run note, in characters (007_run_notes.sql CHECK). */
export const RUN_NOTES_MAX = 4000;
const NotesBody = z
	.object({
		notes: z
			.string()
			.trim()
			.max(RUN_NOTES_MAX)
			// Postgres text can't hold NUL; refuse it here rather than surface a database error.
			.refine((s) => !s.includes('\u0000'), 'notes cannot contain NUL characters')
	})
	.strict();

export const runRoutes = new Hono<AuthEnv>()
	.post('/:id/runs', async (c) => {
		const body = z.object({ label: z.string().trim().max(200).default('') }).parse(await c.req.json().catch(() => ({})));
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const { id: runId } = await executeRun(db, id, body.label).catch((err: Error) => {
				// Engine problems (bad inputs, missing series) are the user's to fix.
				if (err instanceof ApiError || (err as { code?: string }).code) throw err;
				throw new ApiError(400, `model run failed: ${err.message}`);
			});
			// Keep the newest N runs per project (the new one included).
			const removedRunIds = await trimRuns(db, id);
			const { rows } = await db.query(`SELECT ${RUN_META}, r.summary ${FROM_RUN} WHERE r.id = $1`, [runId]);
			return c.json({ run: rows[0], removedRunIds }, 201);
		});
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
			// exclusions are the provenance of its parameters and scores.
			const { rows } = await db.query(`SELECT ${RUN_META}, r.summary, r.inputs->'settings' AS settings ${FROM_RUN} WHERE r.project_id = $1 AND r.id = $2`, [
				id,
				runId
			]);
			if (!rows[0]) throw new ApiError(404, 'not found');
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
			const { rows: run } = await db.query<{ index: number | null; days: number; node: Record<string, unknown> | null }>(
				`SELECT ($3::date - r.start_date) AS index, (r.end_date - r.start_date + 1) AS days,
					(SELECT n FROM jsonb_array_elements(r.inputs->'model'->'nodes') n WHERE n->>'id' = $4) AS node
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
			// Storage at the end of the day before: the run's initial storage on its first day.
			const previousStorageM3 =
				node.kind !== 'farm' ? null : r.index === 0 ? (node.damInitialPct ?? 0) * (node.damCapacityM3 ?? 0) : (storage?.previous ?? null);
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
				params: pick(upgradeLegacyModel({ nodes: [r.node] }).nodes[0] as Record<string, unknown>, DAY_PARAMS),
				columns: rows.map(({ key, label, unit, value }) => ({ key, label: label ?? key, unit, value }))
			});
		});
	})
	// The run's written explanation (007_run_notes): the one thing about a run
	// that may change after it is made. The column grant makes every other
	// column read-only to the app, whatever this handler does.
	.patch('/:id/runs/:runId', async (c) => {
		const { id, runId } = c.req.param();
		const body = NotesBody.parse(await c.req.json().catch(() => ({})));
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			if (!UUID.test(runId)) throw new ApiError(404, 'not found');
			const { rowCount } = await db.query('UPDATE model_run SET notes = $3 WHERE project_id = $1 AND id = $2', [id, runId, body.notes]);
			if (!rowCount) throw new ApiError(404, 'not found');
			const { rows } = await db.query(`SELECT ${RUN_META} ${FROM_RUN} WHERE r.id = $1`, [runId]);
			return c.json({ run: rows[0] });
		});
	})
	.delete('/:id/runs/:runId', async (c) => {
		const { id, runId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			if (!UUID.test(runId)) throw new ApiError(404, 'not found');
			// A run the evidence history names is kept for good (the foreign key refuses it too).
			const { rowCount: cited } = await db.query('SELECT 1 FROM run_nomination WHERE project_id = $1 AND run_id = $2 LIMIT 1', [id, runId]);
			if (cited) throw new ApiError(409, 'this run is or was nominated as evidence, so it is kept');
			const { rowCount } = await db.query('DELETE FROM model_run WHERE project_id = $1 AND id = $2', [id, runId]);
			if (!rowCount) throw new ApiError(404, 'not found');
			return c.body(null, 204);
		});
	});

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
	// A conceptual model's stores the day before. Only their total is recorded
	// at the start of the run (after the warm-up), so on its first day each
	// store is null and the total is the run's starting storage.
	const byKey = new Map(rows.map((x) => [x.key, x]));
	const previousStores = b
		? (Object.fromEntries(RUNOFF_STORES.map((k) => [k, r.index === 0 ? null : (byKey.get(k)?.previous ?? null)])) as Record<(typeof RUNOFF_STORES)[number], number | null>)
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
