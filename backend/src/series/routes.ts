import { fromEpochDay, SERIES_KINDS, toEpochDay } from '@water-management/engine';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { requireRole, UUID } from '../projects/access.js';
import { mergeDaily } from './merge.js';
import { readJson } from '../http/body.js';

export const MAX_SERIES_VALUES = 60_000;

/**
 * A series' first day: a real calendar date. The regex alone lets 2021-02-30
 * through to Postgres, which fails it as a 500. Shared with the project
 * document (projects/document.ts).
 */
export const SeriesStartDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && fromEpochDay(toEpochDay(s)) === s, 'not a calendar date');

const PutBody = z.object({
	kind: z.enum(SERIES_KINDS),
	name: z.string().trim().max(100).default(''),
	unit: z.string().trim().min(1).max(20),
	startDate: SeriesStartDate,
	values: z.array(z.number().finite().nullable()).min(1).max(MAX_SERIES_VALUES)
});

// updatedAt: when the values last changed (upload, merge) — lets the UI tell
// "new data since the last run" even for corrections inside the run period.
const META = `id, kind, name, unit, start_date AS "startDate", cardinality("values") AS length, updated_at AS "updatedAt"`;

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
	// Append / merge new days into a series (daily or batch updates). Creates the
	// series if it doesn't exist. Only the days sent are touched.
	.post('/:id/series/merge', async (c) => {
		const body = PutBody.parse(await readJson(c));
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			// Lock the row so two concurrent batches can't lose each other's days.
			const { rows: cur } = await db.query<{ start_date: string; values: (number | null)[] }>(
				`SELECT start_date, "values" FROM time_series WHERE project_id = $1 AND kind = $2 AND name = $3 FOR UPDATE`,
				[id, body.kind, body.name]
			);
			const existing = cur[0] ? { startDate: cur[0].start_date, values: cur[0].values } : null;
			const merged = mergeDaily(existing, { startDate: body.startDate, values: body.values });
			if (merged.values.length > MAX_SERIES_VALUES) throw new ApiError(413, `series would exceed ${MAX_SERIES_VALUES} days`);
			const { rows } = await db.query(
				`INSERT INTO time_series (project_id, kind, name, unit, start_date, "values")
				 VALUES ($1, $2, $3, $4, $5, $6)
				 ON CONFLICT (project_id, kind, name) DO UPDATE SET unit = EXCLUDED.unit,
					start_date = EXCLUDED.start_date, "values" = EXCLUDED."values", updated_at = now()
				 RETURNING ${META}`,
				[id, body.kind, body.name, body.unit, merged.startDate, merged.values]
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
