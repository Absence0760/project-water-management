import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { requireRole, UUID } from '../projects/access.js';
import { executeRun } from './execute.js';

const RUN_META = `r.id, r.label, r.engine_version AS "engineVersion", r.start_date AS "startDate",
	r.end_date AS "endDate", r.created_at AS "createdAt", u.display_name AS "createdBy"`;
const FROM_RUN = `FROM model_run r JOIN app_user u ON u.id = r.created_by`;

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
			const { rows } = await db.query(`SELECT ${RUN_META}, r.summary ${FROM_RUN} WHERE r.id = $1`, [runId]);
			return c.json({ run: rows[0] }, 201);
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
			const { rows } = await db.query(`SELECT ${RUN_META}, r.summary ${FROM_RUN} WHERE r.project_id = $1 AND r.id = $2`, [
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
	.delete('/:id/runs/:runId', async (c) => {
		const { id, runId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			if (!UUID.test(runId)) throw new ApiError(404, 'not found');
			const { rowCount } = await db.query('DELETE FROM model_run WHERE project_id = $1 AND id = $2', [id, runId]);
			if (!rowCount) throw new ApiError(404, 'not found');
			return c.body(null, 204);
		});
	});
