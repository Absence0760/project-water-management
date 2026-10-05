import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import type { Db } from '../db/tx.js';
import { withUser } from '../db/tx.js';
import { recordAudit, recordSeriesRevision, seriesSubject, type SeriesRow } from '../history/record.js';
import { ApiError, mustChange } from '../http/errors.js';
import { requireRole, UUID } from '../projects/access.js';
import { CALIBRATION_FLOW_KINDS } from '@water-management/engine';
import { z } from 'zod';
import {
	bodyOrigin,
	bodyProvenance,
	checkProvenance,
	mergeInto,
	ProvenanceFields,
	rowOrigin,
	rowProvenance,
	SERIES_META as META,
	SourceField,
	SeriesBody as PutBody,
	setDayBoundary,
	type SeriesMetaRow
} from './merge.js';
import { readJson } from '../http/body.js';
import { wakeWorker } from '../jobs/wake.js';
import type { QueuedRerun } from '../runs/autoRun.js';
import { queueAutoCalibrationFor, queueRerunFor } from './newData.js';
import { originChange, provenanceChange, replaceSeries } from './replace.js';

// Moved to merge.ts beside mergeSeries (shared with the data feeds and the
// ingest); re-exported for the project document (projects/document.ts) and
// the history's restore (history/routes.ts).
export { MAX_SERIES_VALUES, SeriesStartDate, setDayBoundary } from './merge.js';

/**
 * After the transaction that ran the new-data hook commits: a re-run due at
 * once (a debounce of 0) is worth waking the worker for; a debounced one is
 * found by the worker's next poll or tick when it falls due.
 */
export async function wakeForRerun(queued: QueuedRerun | null): Promise<void> {
	if (queued?.created && Date.parse(queued.runAfter) <= Date.now()) await wakeWorker(queued.jobId);
}

/**
 * PATCH …/series/:seriesId: say what an existing series holds, or where a flow
 * record was measured (`siteNodeId`, 084_gauge_records: a gauge node inside
 * the network, null = the outlet), without touching its values.
 */
const LabelBody = z
	.object({ ...ProvenanceFields, siteNodeId: z.string().uuid().nullable().optional(), source: SourceField })
	.strict()
	.superRefine(checkProvenance)
	.refine(
		(b) => b.product !== undefined || b.siteNodeId !== undefined || b.source !== undefined,
		'give product and productVersion (both null: not recorded), siteNodeId, or source (null: not recorded)'
	);

/**
 * Say where a series' values came from (107_series_source.sql), without
 * touching them or the unit they were given in (that is the upload's, never
 * a person's to restate). Logged as series.labelled with the change.
 */
async function setSource(db: Db, projectId: string, seriesId: string, source: string | null): Promise<SeriesMetaRow> {
	const { rows: cur } = await db.query<{ kind: string; name: string; source: string | null; sourceUnit: string | null; sourceUnitFactor: number | null }>(
		`SELECT kind, name, source, source_unit AS "sourceUnit", source_unit_factor AS "sourceUnitFactor" FROM time_series WHERE project_id = $1 AND id = $2 FOR UPDATE`,
		[projectId, seriesId]
	);
	if (!cur[0]) throw new ApiError(404, 'not found');
	const { rows } = await db.query<SeriesMetaRow>(`UPDATE time_series SET source = $3 WHERE project_id = $1 AND id = $2 RETURNING ${META}`, [projectId, seriesId, source]);
	const change = originChange(rowOrigin(cur[0]), rowOrigin({ ...cur[0], source }));
	if ('origin' in change) await recordAudit(db, projectId, 'series.labelled', { seriesId, kind: cur[0].kind, name: cur[0].name, ...change });
	return rows[0]!;
}

/**
 * Move a flow record to a site: a gauge node of the project's model that is
 * not the outlet, or null (the outlet). Only the plausibility checks read a
 * gauge's record (engine ≥ 1.4.0), so the outlet's calibration, EWR test and
 * the rest move with it only when it leaves or joins the outlet.
 */
async function setSite(db: Db, projectId: string, seriesId: string, siteNodeId: string | null): Promise<SeriesMetaRow> {
	const { rows: cur } = await db.query<{ kind: string; name: string; siteNodeId: string | null }>(
		`SELECT kind, name, site_node_id AS "siteNodeId" FROM time_series WHERE project_id = $1 AND id = $2 FOR UPDATE`,
		[projectId, seriesId]
	);
	if (!cur[0]) throw new ApiError(404, 'not found');
	if (siteNodeId !== null && !(CALIBRATION_FLOW_KINDS as readonly string[]).includes(cur[0].kind)) {
		throw new ApiError(400, 'only an observed or logger flow record has a site: rain and evaporation are the catchment\'s');
	}
	if (siteNodeId !== null) {
		const { rows: node } = await db.query<{ kind: string; downstream: string | null }>(
			'SELECT kind, downstream_node_id AS downstream FROM node WHERE project_id = $1 AND id = $2',
			[projectId, siteNodeId]
		);
		if (!node[0]) throw new ApiError(400, 'siteNodeId: no such hydrological unit in this project (save the model first)');
		if (node[0].kind !== 'gauge') throw new ApiError(400, 'siteNodeId: a record\'s site is a gauge');
		if (node[0].downstream === null) throw new ApiError(400, 'siteNodeId: that gauge is the outlet, whose records have no site (null)');
	}
	const { rows } = await db.query<SeriesMetaRow>(
		`UPDATE time_series SET site_node_id = $3 WHERE project_id = $1 AND id = $2 RETURNING ${META}`,
		[projectId, seriesId, siteNodeId]
	);
	if (cur[0].siteNodeId !== siteNodeId) {
		const names = await nodeNames(db, projectId, [cur[0].siteNodeId, siteNodeId]);
		await recordAudit(db, projectId, 'series.site_changed', {
			seriesId,
			kind: cur[0].kind,
			name: cur[0].name,
			site: { from: names(cur[0].siteNodeId), to: names(siteNodeId) }
		});
	}
	return rows[0]!;
}

/** A site as the audit line says it: the outlet, the gauge's name, or a node that has gone. */
async function nodeNames(db: Db, projectId: string, ids: (string | null)[]): Promise<(id: string | null) => string> {
	const wanted = ids.filter((x): x is string => x !== null);
	const { rows } = wanted.length
		? await db.query<{ id: string; name: string }>('SELECT id, name FROM node WHERE project_id = $1 AND id = ANY($2::uuid[])', [projectId, wanted])
		: { rows: [] };
	const byId = new Map(rows.map((r) => [r.id, r.name]));
	return (id) => (id === null ? 'the outlet' : (byId.get(id) ?? 'a removed node'));
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
		const { meta, queued } = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			// A replace says how its days were built (a sub-daily upload's day boundary), or clears it.
			const r = await replaceSeries(db, id, { ...body, provenance: bodyProvenance(body) ?? null, origin: bodyOrigin(body) });
			// The new-data hook (series/newData.ts): a replace that changed days is new data too.
			const change = { seriesId: r.meta.id, kind: r.meta.kind, name: r.meta.name, daysChanged: r.daysChanged, via: 'user' as const };
			const queued = await queueRerunFor(db, id, change);
			// And a run of the calibration rules, when they ask for one (issue #153).
			await queueAutoCalibrationFor(db, id, change);
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
			const sited = body.siteNodeId !== undefined ? await setSite(db, id, seriesId, body.siteNodeId) : null;
			const sourced = body.source !== undefined ? await setSource(db, id, seriesId, body.source) : null;
			if (body.product === undefined) return c.json((sourced ?? sited)!);
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
				`SELECT id, kind, name, unit, start_date AS "startDate", "values", product, product_version AS "productVersion", day_boundary AS "dayBoundary",
					source, source_unit AS "sourceUnit", source_unit_factor AS "sourceUnitFactor"
				 FROM time_series WHERE project_id = $1 AND id = $2 FOR UPDATE`,
				[id, seriesId]
			);
			const existing = rows[0];
			if (!existing) throw new ApiError(404, 'not found');
			const revisionId = await recordSeriesRevision(db, id, existing, 'delete');
			mustChange(await db.query('DELETE FROM time_series WHERE project_id = $1 AND id = $2', [id, seriesId]));
			// The range and hash of the values that went.
			await recordAudit(db, id, 'series.deleted', { ...seriesSubject(existing, null, existing), revisionId });
			return c.body(null, 204);
		});
	});
