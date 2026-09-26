import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { requireRole, UUID } from '../projects/access.js';
import { mergeInto, SERIES_META as META, SeriesBody as PutBody } from './merge.js';
import { readJson } from '../http/body.js';

// Moved to merge.ts beside mergeInto (shared with the data feeds);
// re-exported for the project document (projects/document.ts).
export { MAX_SERIES_VALUES, SeriesStartDate } from './merge.js';

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
		const body = PutBody.parse(await readJson(c));
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			// The whole series is now the user's: a data feed writing it keeps
			// every day from here on (feed_id NULL clears feed_days, 030_feed_days).
			const { rows } = await db.query(
				`INSERT INTO time_series (project_id, kind, name, unit, start_date, "values")
				 VALUES ($1, $2, $3, $4, $5, $6)
				 ON CONFLICT (project_id, kind, name) DO UPDATE SET unit = EXCLUDED.unit,
					start_date = EXCLUDED.start_date, "values" = EXCLUDED."values", updated_at = now(), feed_id = NULL
				 RETURNING ${META}`,
				[id, body.kind, body.name, body.unit, body.startDate, body.values]
			);
			return c.json(rows[0]);
		});
	})
	// Append / merge new days into a series (daily or batch updates). Creates the
	// series if it doesn't exist. Only the days sent are touched.
	.post('/:id/series/merge', async (c) => {
		const body = PutBody.parse(await readJson(c));
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			return c.json((await mergeInto(db, id, body)).series);
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
