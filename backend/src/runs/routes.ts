import { Hono } from 'hono';
import { isIsoDate } from '@water-management/engine';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { recordAudit } from '../history/record.js';
import { queueAlertEval } from '../alerts/queue.js';
import { wakeWorker } from '../jobs/wake.js';
import { requireRole, UUID } from '../projects/access.js';
import { withErrata, type RunEngines } from '../errata/runs.js';
import { citedMessage, lockProjectRuns, PINNED_RUNS_PER_PROJECT_MAX, RUN_KEPT_SQL, RUN_PUBLISHED_SQL, runFailure, runLiveModel, trimRuns } from './execute.js';
// The reads (the run, a series, its bulk pages, a day, the model input) and their withholding (#523 I, D3) live in
// read.ts, which the assistant's tools read through too (issue #610).
import { FROM_RUN, readDay, readModelInput, readRun, readSeries, readSeriesBulk, RUN_META } from './read.js';

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
			return c.json({ input: await readModelInput(db, id) });
		});
	})
	.get('/:id/runs', async (c) =>
		withUser(c.get('userId'), async (db) => {
			await requireRole(db, c.req.param('id'), 'viewer');
			const { rows } = await db.query<RunEngines>(`SELECT ${RUN_META} ${FROM_RUN} WHERE r.project_id = $1 ORDER BY r.created_at DESC`, [
				c.req.param('id')
			]);
			// The known engine bugs that may affect each run (issue #103, errata/runs.ts).
			return c.json({ runs: rows.map((r) => withErrata(r)) });
		})
	)
	.get('/:id/runs/:runId', async (c) => {
		const { id, runId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			const role = await requireRole(db, id, 'viewer');
			const { run, series, withheldSeries } = await readRun(db, id, role, runId);
			return c.json({ run: withErrata(run as RunEngines), series, withheldSeries });
		});
	})
	.get('/:id/runs/:runId/series', async (c) => {
		const { id, runId } = c.req.param();
		const q = z.object({ key: z.string().min(1).max(100), nodeId: z.string().uuid().optional() }).parse(c.req.query());
		return withUser(c.get('userId'), async (db) => {
			const role = await requireRole(db, id, 'viewer');
			return c.json(await readSeries(db, id, role, runId, q.key, q.nodeId ?? null));
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
			const role = await requireRole(db, id, 'viewer');
			return c.json(await readSeriesBulk(db, id, role, runId, q.nodeId ?? null, q.offset));
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
					.refine((s) => isIsoDate(s), 'not a date')
			})
			.parse(c.req.query());
		return withUser(c.get('userId'), async (db) => {
			const role = await requireRole(db, id, 'viewer');
			return c.json(await readDay(db, id, role, runId, q.nodeId ?? null, q.date));
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
