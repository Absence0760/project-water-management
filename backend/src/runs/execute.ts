import { createHash } from 'node:crypto';
import { resolveFitRecord, runModelChecked, type DailySeries, type ModelInput, type ModelOutput, type SeriesKind } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { loadModel } from '../model/store.js';
import { mergeSettings } from '../projects/settings.js';

/** SHA-256 hex of a series' values as JSON (null = missing day), stored in the run's input snapshot. */
export const seriesHash = (values: readonly (number | null)[]): string =>
	createHash('sha256').update(JSON.stringify(values)).digest('hex');

/** Gather everything the engine needs for a project. */
export async function loadModelInput(db: Db, projectId: string): Promise<ModelInput> {
	const { rows: p } = await db.query<{ settings: unknown }>('SELECT settings FROM project WHERE id = $1', [projectId]);
	const model = await loadModel(db, projectId);
	// First series of each kind (ordered by name) — the engine takes one per kind.
	const { rows: s } = await db.query<{ kind: SeriesKind; start_date: string; values: (number | null)[] }>(
		`SELECT DISTINCT ON (kind) kind, start_date, "values" FROM time_series WHERE project_id = $1 ORDER BY kind, name`,
		[projectId]
	);
	const series: Partial<Record<SeriesKind, DailySeries>> = {};
	for (const r of s) series[r.kind] = { startDate: r.start_date, values: r.values };
	return { settings: mergeSettings(p[0]?.settings) as unknown as ModelInput['settings'], model, series };
}

/** Default for RUNS_KEPT_PER_PROJECT. */
export const DEFAULT_RUNS_KEPT = 20;

/**
 * How many runs a project keeps (`RUNS_KEPT_PER_PROJECT`, default 20). A run
 * of a long catchment is several MB of daily outputs, so without a cap
 * storage grows with every press of Run. Invalid values fall back to the
 * default rather than disabling the cap.
 */
export function runsKeptPerProject(env: string | undefined = process.env.RUNS_KEPT_PER_PROJECT): number {
	const n = Number(env);
	return env !== undefined && env.trim() !== '' && Number.isInteger(n) && n >= 1 ? n : DEFAULT_RUNS_KEPT;
}

/**
 * Delete the project's oldest runs beyond the cap (run_series cascades).
 * Runs inside the caller's transaction as the signed-in editor, so RLS
 * (model_run_delete: editor) applies. Returns the ids removed.
 */
export async function trimRuns(db: Db, projectId: string, keep = runsKeptPerProject()): Promise<string[]> {
	const { rows } = await db.query<{ id: string }>(
		`DELETE FROM model_run WHERE id IN (
			SELECT id FROM model_run WHERE project_id = $1 ORDER BY created_at DESC, id DESC OFFSET $2
		) RETURNING id`,
		[projectId, keep]
	);
	return rows.map((r) => r.id);
}

/** Run the engine and persist outputs. Returns the new run id. */
export async function executeRun(db: Db, projectId: string, label: string): Promise<{ id: string; output: ModelOutput }> {
	const input = await loadModelInput(db, projectId);
	// The engine's self-checks and water balance are stored with the run (engine ≥ 0.11.0).
	const output = runModelChecked(input);
	const snapshot = {
		// The fit record as it stands for these parameters (edits since the
		// fit marked), so the run shows which fit and validation produced them.
		settings: { ...input.settings, fitRecord: resolveFitRecord(input.settings) },
		model: input.model,
		// Values aren't copied (they're large); a hash lets "what changed"
		// catch values corrected within the same dates (compare.ts diffSeries).
		series: Object.fromEntries(
			Object.entries(input.series).map(([k, v]) => [
				k,
				{ startDate: v.startDate, length: v.values.length, valuesSha256: seriesHash(v.values) }
			])
		)
	};
	const { rows } = await db.query<{ id: string }>(
		`INSERT INTO model_run (project_id, created_by, label, engine_version, start_date, end_date, inputs, summary)
		 VALUES ($1, app_current_user_id(), $2, $3, $4, $5, $6, $7) RETURNING id`,
		[projectId, label, output.engineVersion, output.startDate, output.endDate, JSON.stringify(snapshot), JSON.stringify(output.summary)]
	);
	const runId = rows[0]!.id;
	// Batch the per-series inserts to keep round-trips low (~150 series per run).
	const BATCH = 25;
	for (let i = 0; i < output.series.length; i += BATCH) {
		const chunk = output.series.slice(i, i + BATCH);
		const params: unknown[] = [runId, projectId];
		const values = chunk.map((s, j) => {
			params.push(s.nodeId, s.key, JSON.stringify({ label: s.label, unit: s.unit }), s.values.map((v) => (Number.isFinite(v) ? v : null)));
			const b = 3 + j * 4;
			return `($1, $2, $${b}::uuid, $${b + 1}, $${b + 2}::jsonb, $${b + 3}::float8[])`;
		});
		await db.query(`INSERT INTO run_series (run_id, project_id, node_id, key, meta, "values") VALUES ${values.join(', ')}`, params);
	}
	return { id: runId, output };
}
