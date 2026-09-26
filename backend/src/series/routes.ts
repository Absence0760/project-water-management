import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import type { Db } from '../db/tx.js';
import { withUser } from '../db/tx.js';
import { lockSeries, recordAudit, recordSeriesRevision, seriesSubject, valuesSha256, type SeriesRow } from '../history/record.js';
import { ApiError } from '../http/errors.js';
import { requireRole, UUID } from '../projects/access.js';
import { provenanceLabel, sameProvenance, type SeriesProvenance } from '@water-management/engine';
import { z } from 'zod';
import {
	bodyProvenance,
	checkProvenance,
	mergeInto,
	ProvenanceFields,
	rowProvenance,
	SERIES_META as META,
	SeriesBody as PutBody,
	setDayBoundary,
	type SeriesMetaRow
} from './merge.js';
import { readJson } from '../http/body.js';
import { wakeWorker } from '../jobs/wake.js';
import type { QueuedRerun } from '../runs/autoRun.js';
import { queueRerunFor } from './newData.js';

// Moved to merge.ts beside mergeSeries (shared with the data feeds and the
// ingest); re-exported for the project document (projects/document.ts) and
// the history's restore (history/routes.ts).
export { MAX_SERIES_VALUES, SeriesStartDate, setDayBoundary } from './merge.js';

const sameValues = (a: SeriesRow, unit: string, startDate: string, values: readonly (number | null)[]) =>
	a.unit === unit && a.startDate === startDate && valuesSha256(a.values) === valuesSha256(values);

/** A version change as the audit subject records it: `{ provenance: { from, to } }` labels, or nothing. */
const provenanceChange = (before: SeriesProvenance | null, after: SeriesProvenance | null) =>
	sameProvenance(before, after) ? {} : { provenance: { from: provenanceLabel(before), to: provenanceLabel(after) } };

/**
 * Replace a series whole, keeping its previous values as a series revision
 * first (the history's restore point), so a replace, and a restore too, can
 * be undone. Unchanged values and label record nothing. `restoredFrom`: this
 * puts a series revision back (POST …/revisions/:revId/restore), logged as
 * `restore`. `provenance` is what the new values are (032_series_provenance;
 * null or absent = not recorded: a replace says what it holds or clears it).
 * `revisionReason` / `audit`: a data feed's confirmed replacement
 * (feeds/ingest.ts) keeps the old values as `feed_replace` and adds its feed.
 * `daysChanged`: days whose value changed (a new series: its days with a
 * value), what the new-data hook (series/newData.ts) keys on.
 */
export async function replaceSeries(
	db: Db,
	projectId: string,
	body: { kind: string; name: string; unit: string; startDate: string; values: (number | null)[]; provenance?: SeriesProvenance | null },
	opts: { restoredFrom?: string; revisionReason?: 'replace' | 'feed_replace'; audit?: Record<string, unknown>; feedId?: string } = {}
): Promise<{ meta: SeriesMetaRow; daysChanged: number }> {
	const existing = await lockSeries(db, projectId, body.kind, body.name);
	const provenance = body.provenance ?? null;
	const { rows } = await db.query<SeriesMetaRow>(
		// A person's replace (or restore) makes the whole series the user's: a
		// data feed writing it keeps every day from here on (feed_id NULL clears
		// feed_days, 031_feed_days). A data feed's confirmed replacement
		// (opts.feedId, feeds/ingest.ts) makes it the feed's: every day of the
		// new record is one it wrote, so its later re-reads still revise them.
		`INSERT INTO time_series (project_id, kind, name, unit, start_date, "values", product, product_version, feed_id, feed_days)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid,
			CASE WHEN $9::uuid IS NULL THEN NULL ELSE datemultirange(daterange($5::date, $5::date + cardinality($6::float8[]))) END)
		 ON CONFLICT (project_id, kind, name) DO UPDATE SET unit = EXCLUDED.unit,
			start_date = EXCLUDED.start_date, "values" = EXCLUDED."values", product = EXCLUDED.product,
			product_version = EXCLUDED.product_version, updated_at = now(), feed_id = EXCLUDED.feed_id, feed_days = EXCLUDED.feed_days
		 RETURNING ${META}`,
		[projectId, body.kind, body.name, body.unit, body.startDate, body.values, provenance?.product ?? null, provenance?.version ?? null, opts.feedId ?? null]
	);
	const meta = rows[0]!;
	// Nor is any day an API key's now (series_key_days, 053: what the ingest hold leaves out of a key's limit).
	await db.query('DELETE FROM series_key_days WHERE project_id = $1 AND series_id = $2', [projectId, meta.id]);
	const restore = opts.restoredFrom ? { target: 'series', restoredFrom: opts.restoredFrom } : null;
	if (!existing) {
		const subject = seriesSubject(meta, null, body, { ...restore, ...opts.audit });
		await recordAudit(db, projectId, restore ? 'restore' : 'series.created', subject);
		return { meta, daysChanged: subject.daysChanged as number };
	}
	const held = rowProvenance({ product: existing.product ?? null, productVersion: existing.productVersion ?? null });
	if (!sameValues(existing, body.unit, body.startDate, body.values) || !sameProvenance(held, provenance)) {
		const revisionId = await recordSeriesRevision(db, projectId, existing, opts.revisionReason ?? 'replace');
		const subject = seriesSubject(meta, existing, body, { revisionId, ...restore, ...provenanceChange(held, provenance), ...opts.audit });
		await recordAudit(db, projectId, restore ? 'restore' : 'series.replaced', subject);
		return { meta, daysChanged: subject.daysChanged as number };
	}
	return { meta, daysChanged: 0 };
}

/**
 * After the transaction that ran the new-data hook commits: a re-run due at
 * once (a debounce of 0) is worth waking the worker for; a debounced one is
 * found by the worker's next poll or tick when it falls due.
 */
export async function wakeForRerun(queued: QueuedRerun | null): Promise<void> {
	if (queued?.created && Date.parse(queued.runAfter) <= Date.now()) await wakeWorker(queued.jobId);
}

/** PATCH …/series/:seriesId: say what an existing series holds, without touching its values. */
const LabelBody = z
	.object({ ...ProvenanceFields })
	.strict()
	.superRefine(checkProvenance)
	.refine((b) => b.product !== undefined, 'give product and productVersion (both null: not recorded)');

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
		const { meta, queued } = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			// A replace says how its days were built (a sub-daily upload's day boundary), or clears it.
			const r = await replaceSeries(db, id, { ...body, provenance: bodyProvenance(body) ?? null });
			// The new-data hook (series/newData.ts): a replace that changed days is new data too.
			const queued = await queueRerunFor(db, id, { seriesId: r.meta.id, kind: r.meta.kind, name: r.meta.name, daysChanged: r.daysChanged, via: 'user' });
			return { meta: await setDayBoundary(db, id, r.meta, body.dayBoundary ?? null), queued };
		});
		await wakeForRerun(queued);
		return c.json({ ...meta, rerunQueuedFor: queued?.runAfter ?? null });
	})
	// Say which product and version a series holds (a CHIRPS column imported
	// before the version was asked, or one whose version was only found out
	// later). The values are untouched; the label is logged as series.labelled.
	// A data feed then writes into the series only if it is the same version,
	// so this is also how an owner vouches that an unrecorded series is what
	// the feed writes (docs/api.md § Series).
	.patch('/:id/series/:seriesId', async (c) => {
		const { id, seriesId } = c.req.param();
		const body = LabelBody.parse(await readJson(c));
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			if (!UUID.test(seriesId)) throw new ApiError(404, 'not found');
			const { rows: cur } = await db.query<{ product: string | null; productVersion: string | null }>(
				`SELECT product, product_version AS "productVersion" FROM time_series WHERE project_id = $1 AND id = $2 FOR UPDATE`,
				[id, seriesId]
			);
			if (!cur[0]) throw new ApiError(404, 'not found');
			const next = bodyProvenance(body) ?? null;
			const { rows } = await db.query<SeriesMetaRow>(
				`UPDATE time_series SET product = $3, product_version = $4 WHERE project_id = $1 AND id = $2 RETURNING ${META}`,
				[id, seriesId, next?.product ?? null, next?.version ?? null]
			);
			const meta = rows[0]!;
			const change = provenanceChange(rowProvenance(cur[0]), next);
			if ('provenance' in change) {
				await recordAudit(db, id, 'series.labelled', { seriesId: meta.id, kind: meta.kind, name: meta.name, ...change });
			}
			return c.json(meta);
		});
	})
	// Append / merge new days into a series (daily or batch updates). Creates the
	// series if it doesn't exist. Only the days sent are touched, and a blank
	// (null) day keeps its stored value: a file never erases. A person's
	// merge keeps the previous values as a series revision; a data feed's
	// (feeds/ingest.ts) and an API key's (ingest/routes.ts) don't. The whole
	// sequence is mergeInto, shared with the ingest.
	.post('/:id/series/merge', async (c) => {
		const body = PutBody.parse(await readJson(c));
		const id = c.req.param('id');
		const { meta, queued } = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			// mergeInto runs the new-data hook (series/newData.ts): a re-send that changes nothing queues nothing.
			const r = await mergeInto(db, id, body, { keepRevision: true, via: 'user', keepOnNull: true });
			return { meta: r.meta, queued: r.rerun };
		});
		await wakeForRerun(queued);
		return c.json({ ...meta, rerunQueuedFor: queued?.runAfter ?? null });
	})
	.delete('/:id/series/:seriesId', async (c) => {
		const { id, seriesId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			if (!UUID.test(seriesId)) throw new ApiError(404, 'not found');
			const { rows } = await db.query<SeriesRow>(
				`SELECT id, kind, name, unit, start_date AS "startDate", "values", product, product_version AS "productVersion", day_boundary AS "dayBoundary"
				 FROM time_series WHERE project_id = $1 AND id = $2 FOR UPDATE`,
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
