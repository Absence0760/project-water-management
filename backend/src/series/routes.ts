import { SERIES_KINDS } from '@water-management/engine';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { requireRole, UUID } from '../projects/access.js';

export const MAX_SERIES_VALUES = 60_000;

const PutBody = z.object({
	kind: z.enum(SERIES_KINDS),
	name: z.string().trim().max(100).default(''),
	unit: z.string().trim().min(1).max(20),
	startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	values: z.array(z.number().finite().nullable()).min(1).max(MAX_SERIES_VALUES)
});

const META = `id, kind, name, unit, start_date AS "startDate", cardinality("values") AS length`;

export const seriesRoutes = new Hono<AuthEnv>()
	.get('/:id/series', async (c) =>
		withUser(c.get('userId'), async (db) => {
			await requireRole(db, c.req.param('id'), 'viewer');
			const { rows } = await db.query(`SELECT ${META} FROM time_series WHERE project_id = $1 ORDER BY kind, name`, [
				c.req.param('id')
			]);
			return c.json({ series: rows });
		})
	)
	.get('/:id/series/:seriesId', async (c) => {
		const { id, seriesId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			if (!UUID.test(seriesId)) throw new ApiError(404, 'not found');
			const { rows } = await db.query(
				`SELECT ${META}, "values" FROM time_series WHERE project_id = $1 AND id = $2`,
				[id, seriesId]
			);
			if (!rows[0]) throw new ApiError(404, 'not found');
			return c.json(rows[0]);
		});
	})
	.put('/:id/series', async (c) => {
		const body = PutBody.parse(await c.req.json());
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const { rows } = await db.query(
				`INSERT INTO time_series (project_id, kind, name, unit, start_date, "values")
				 VALUES ($1, $2, $3, $4, $5, $6)
				 ON CONFLICT (project_id, kind, name) DO UPDATE SET unit = EXCLUDED.unit,
					start_date = EXCLUDED.start_date, "values" = EXCLUDED."values", updated_at = now()
				 RETURNING ${META}`,
				[id, body.kind, body.name, body.unit, body.startDate, body.values]
			);
			return c.json(rows[0]);
		});
	})
	.delete('/:id/series/:seriesId', async (c) => {
		const { id, seriesId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			if (!UUID.test(seriesId)) throw new ApiError(404, 'not found');
			const { rowCount } = await db.query('DELETE FROM time_series WHERE project_id = $1 AND id = $2', [id, seriesId]);
			if (!rowCount) throw new ApiError(404, 'not found');
			return c.body(null, 204);
		});
	});
