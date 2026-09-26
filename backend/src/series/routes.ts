import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import type { Db } from '../db/tx.js';
import { withUser } from '../db/tx.js';
import { lockSeries, recordAudit, recordSeriesRevision, seriesSubject, valuesSha256, type SeriesRow } from '../history/record.js';
import { ApiError } from '../http/errors.js';
import { requireRole, UUID } from '../projects/access.js';
import { mergeSeries, SERIES_META as META, SeriesBody as PutBody, type SeriesMetaRow } from './merge.js';
import { readJson } from '../http/body.js';

// Moved to merge.ts beside mergeSeries (shared with the data feeds);
// re-exported for the project document (projects/document.ts).
export { MAX_SERIES_VALUES, SeriesStartDate } from './merge.js';

const sameValues = (a: SeriesRow, unit: string, startDate: string, values: readonly (number | null)[]) =>
	a.unit === unit && a.startDate === startDate && valuesSha256(a.values) === valuesSha256(values);

/**
 * Replace a series whole, keeping its previous values as a series revision
 * first (the history's restore point), so a replace, and a restore too, can
 * be undone. Unchanged values record nothing. `restoredFrom`: this puts a
 * series revision back (POST …/revisions/:revId/restore), logged as `restore`.
 */
export async function replaceSeries(
	db: Db,
	projectId: string,
	body: { kind: string; name: string; unit: string; startDate: string; values: (number | null)[] },
	opts: { restoredFrom?: string } = {}
): Promise<SeriesMetaRow> {
	const existing = await lockSeries(db, projectId, body.kind, body.name);
	const { rows } = await db.query<SeriesMetaRow>(
		`INSERT INTO time_series (project_id, kind, name, unit, start_date, "values")
		 VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (project_id, kind, name) DO UPDATE SET unit = EXCLUDED.unit,
			start_date = EXCLUDED.start_date, "values" = EXCLUDED."values", updated_at = now()
		 RETURNING ${META}`,
		[projectId, body.kind, body.name, body.unit, body.startDate, body.values]
	);
	const meta = rows[0]!;
	const restore = opts.restoredFrom ? { target: 'series', restoredFrom: opts.restoredFrom } : null;
	if (!existing) {
		await recordAudit(db, projectId, restore ? 'restore' : 'series.created', seriesSubject(meta, null, body, restore ?? {}));
	} else if (!sameValues(existing, body.unit, body.startDate, body.values)) {
		const revisionId = await recordSeriesRevision(db, projectId, existing, 'replace');
		await recordAudit(db, projectId, restore ? 'restore' : 'series.replaced', seriesSubject(meta, existing, body, { revisionId, ...restore }));
	}
	return meta;
}

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
			return c.json(await replaceSeries(db, id, body));
		});
	})
	// Append / merge new days into a series (daily or batch updates). Creates the
	// series if it doesn't exist. Only the days sent are touched. A person's
	// merge keeps the previous values as a series revision; a data feed's
	// (feeds/ingest.ts) doesn't.
	.post('/:id/series/merge', async (c) => {
		const body = PutBody.parse(await readJson(c));
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const r = await mergeSeries(db, id, body);
			const subject = seriesSubject(r.meta, r.before, r.after);
			if (!r.before) await recordAudit(db, id, 'series.created', subject);
			else if (subject.daysChanged || r.before.unit !== r.meta.unit) {
				const revisionId = await recordSeriesRevision(db, id, { ...r.before, kind: r.meta.kind, name: r.meta.name }, 'manual_merge');
				await recordAudit(db, id, 'series.merged', { ...subject, revisionId });
			}
			return c.json(r.meta);
		});
	})
	.delete('/:id/series/:seriesId', async (c) => {
		const { id, seriesId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			if (!UUID.test(seriesId)) throw new ApiError(404, 'not found');
			const { rows } = await db.query<SeriesRow>(
				`SELECT id, kind, name, unit, start_date AS "startDate", "values" FROM time_series WHERE project_id = $1 AND id = $2 FOR UPDATE`,
				[id, seriesId]
			);
			const existing = rows[0];
			if (!existing) throw new ApiError(404, 'not found');
			const revisionId = await recordSeriesRevision(db, id, existing, 'delete');
			await db.query('DELETE FROM time_series WHERE project_id = $1 AND id = $2', [id, seriesId]);
			// The range and hash of the values that went.
			await recordAudit(db, id, 'series.deleted', { ...seriesSubject(existing, null, existing), revisionId });
			return c.body(null, 204);
		});
	});
