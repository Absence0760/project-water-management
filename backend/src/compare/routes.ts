// GET /compare/runs — compare two runs, possibly from two different projects
// (docs/api.md § Compare runs, docs/run-comparison.md). Both runs are loaded
// inside one withUser transaction, so RLS decides visibility for each side.
import {
	compareRuns,
	diffInputs,
	type RunInputsSnapshot,
	type RunSummary
} from '@water-management/engine';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser, type Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { requireRole, UUID } from '../projects/access.js';
import { listNominations, runEvidence, type RunEvidence } from '../runs/evidence.js';

/** "<projectId>:<runId>" */
const RunRef = z
	.string()
	.max(80)
	.transform((s, ctx) => {
		const [projectId, runId, ...rest] = s.split(':');
		if (rest.length || !projectId || !runId) {
			ctx.addIssue({ code: 'custom', message: 'expected <projectId>:<runId>' });
			return z.NEVER;
		}
		return { projectId, runId };
	});

interface LoadedRun {
	id: string;
	label: string;
	engineVersion: string;
	startDate: string;
	endDate: string;
	createdAt: string;
	createdBy: string | null;
	summary: RunSummary;
	inputs: RunInputsSnapshot;
	/** settings.runoffModel === 'legacy' (audit H1): workbook comparison only, not evidence. */
	legacy: boolean;
	/** The modeller's written explanation (007_run_notes); '' = none. */
	notes: string;
	notesUpdatedAt: string | null;
	notesUpdatedBy: string | null;
	/** The run's place in its project's evidence history (010_run_nomination); null = never nominated. */
	evidence: RunEvidence | null;
}

async function loadSide(db: Db, ref: { projectId: string; runId: string }) {
	// requireRole: 404 when the project is invisible (never 403 — viewer is the floor).
	await requireRole(db, ref.projectId, 'viewer');
	if (!UUID.test(ref.runId)) throw new ApiError(404, 'not found');
	const { rows } = await db.query<Omit<LoadedRun, 'evidence'> & { projectName: string }>(
		`SELECT r.id, r.label, r.engine_version AS "engineVersion", r.start_date AS "startDate",
		        r.end_date AS "endDate", r.created_at AS "createdAt", u.display_name AS "createdBy",
		        r.summary, r.inputs, p.name AS "projectName",
		        COALESCE(r.inputs->'settings'->>'runoffModel', 'legacy') = 'legacy' AS legacy,
		        r.notes, r.notes_updated_at AS "notesUpdatedAt", nu.display_name AS "notesUpdatedBy"
		 FROM model_run r
		 JOIN project p ON p.id = r.project_id
		 JOIN app_user u ON u.id = r.created_by
		 LEFT JOIN app_user nu ON nu.id = r.notes_updated_by
		 WHERE r.project_id = $1 AND r.id = $2`,
		[ref.projectId, ref.runId]
	);
	const row = rows[0];
	if (!row) throw new ApiError(404, 'not found');
	const { rows: series } = await db.query<{ key: string; label: string; unit: string }>(
		`SELECT key, meta->>'label' AS label, meta->>'unit' AS unit
		 FROM run_series WHERE run_id = $1 AND node_id IS NULL ORDER BY key`,
		[ref.runId]
	);
	const { projectName, ...rest } = row;
	const run: LoadedRun = { ...rest, evidence: runEvidence(await listNominations(db, ref.projectId), ref.runId) };
	return { project: { id: ref.projectId, name: projectName }, run, catchmentSeries: series };
}

export const compareRoutes = new Hono<AuthEnv>().get('/runs', async (c) => {
	const q = z.object({ a: RunRef, b: RunRef }).parse(c.req.query());
	return withUser(c.get('userId'), async (db) => {
		const a = await loadSide(db, q.a);
		const b = await loadSide(db, q.b);
		// Catchment series both runs stored with the same unit — the ones that can be overlaid.
		const inB = new Map(b.catchmentSeries.map((s) => [s.key, s]));
		const catchmentSeries = a.catchmentSeries.filter((s) => inB.get(s.key)?.unit === s.unit);
		return c.json({
			a: { project: a.project, run: a.run },
			b: { project: b.project, run: b.run },
			comparison: compareRuns(a.run, b.run),
			changes: diffInputs(a.run.inputs, b.run.inputs),
			catchmentSeries
		});
	});
});
