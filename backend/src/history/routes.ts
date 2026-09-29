// The change history (roadmap WP-2.4, 030_history.sql, docs/api.md §
// History): the project's timeline of revisions and audit events, a
// revision's snapshot with what restoring it would change, restoring a
// revision or a run's inputs, and a series' kept values and restoring them.
// Viewers read; editors restore. Farmers get 403 (requireRole 'viewer'), and
// RLS shows them nothing either way (D4).
import { diffInputs, upgradeLegacyModel, type InputChange, type RunInputsSnapshot } from '@water-management/engine';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { type Db, withUser } from '../db/tx.js';
import { readJson } from '../http/body.js';
import { ApiError, mustChange } from '../http/errors.js';
import { DEFAULT_TIME_ZONE, localDate } from '../projects/timeZone.js';
import { saveModel } from '../model/store.js';
import { ModelBody, modelProblems } from '../model/validate.js';
import { requireRole, UUID } from '../projects/access.js';
import { loadModelInput, seriesHash } from '../runs/execute.js';
import { rowOrigin, rowProvenance } from '../series/merge.js';
import { replaceSeries, setDayBoundary } from '../series/routes.js';
import { fieldHistory } from './fields.js';
import {
	beginModelChange,
	describeChange,
	inputsSnapshot,
	Reason,
	recordDroppedLinks,
	recordModelRevision,
	relinkCandidates,
	type InputsSnapshot,
	type Relink,
	type RevisionRow,
	type RevisionSource
} from './record.js';

/** Most items per page of GET /history. */
export const HISTORY_PAGE_MAX = 100;
const HISTORY_PAGE_DEFAULT = 50;

/** A revision or series revision id (bigint identity). */
const BIGINT_ID = /^[1-9]\d{0,17}$/;
const revisionId = (raw: string) => {
	if (!BIGINT_ID.test(raw)) throw new ApiError(404, 'not found');
	return raw;
};

/**
 * `before`: the `next` of the previous page, "<created_at>|<type>|<id>"
 * (created_at to the microsecond, so no two items are skipped or repeated).
 */
const Cursor = z
	.string()
	.max(80)
	.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\|(event|revision)\|[1-9]\d{0,17}$/, 'not a history cursor')
	.transform((s) => {
		const [ts, type, id] = s.split('|') as [string, string, string];
		return { ts, type, id };
	});

const HistoryQuery = z.object({
	before: Cursor.optional(),
	limit: z.coerce.number().int().min(1).max(HISTORY_PAGE_MAX).default(HISTORY_PAGE_DEFAULT),
	/** Only what touched this node: revisions that changed it, events about it (farmer links). */
	nodeId: z.string().uuid().optional(),
	/** 'revision' (model and settings changes), an event kind ('series.replaced') or its noun ('series'). */
	kind: z
		.string()
		.max(60)
		.regex(/^[a-z_]+(\.[a-z_]+)?$/)
		.optional(),
	/**
	 * The parameter filter's words (any order, any case): only revisions with a
	 * change line holding every word. Events aren't filtered here (their
	 * sentences are written by the client); the client filters those.
	 */
	q: z
		.string()
		.max(200)
		.optional()
		.transform((s) => {
			const words = (s ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 10);
			return words.length ? words : undefined;
		})
});

export interface RevisionItem {
	type: 'revision';
	id: string;
	createdAt: string;
	changeSet: string | null;
	/** Display name of who made it; null when that account is gone. */
	actor: string | null;
	source: RevisionSource;
	reason: string | null;
	changes: InputChange[];
	restoredFrom: string | null;
	restoredFromRun: string | null;
}

export interface EventItem {
	type: 'event';
	id: string;
	createdAt: string;
	changeSet: string | null;
	/** Display name when it happened. */
	actor: string;
	kind: string;
	subject: Record<string, unknown>;
}

type ItemRow = {
	type: 'revision' | 'event';
	id: string;
	ts: string;
	change_set: string | null;
	actor: string | null;
	kind: string;
	reason: string | null;
	changes: InputChange[] | null;
	subject: Record<string, unknown> | null;
	restored_from: string | null;
	restored_from_run: string | null;
};

const toItem = (r: ItemRow): RevisionItem | EventItem =>
	r.type === 'revision'
		? {
				type: 'revision',
				id: String(r.id),
				createdAt: r.ts,
				changeSet: r.change_set,
				actor: r.actor,
				source: r.kind as RevisionSource,
				reason: r.reason,
				changes: r.changes ?? [],
				restoredFrom: r.restored_from === null ? null : String(r.restored_from),
				restoredFromRun: r.restored_from_run
			}
		: { type: 'event', id: String(r.id), createdAt: r.ts, changeSet: r.change_set, actor: r.actor ?? '', kind: r.kind, subject: r.subject ?? {} };

// created_at to the microsecond, as text: a JS Date keeps milliseconds only, and the cursor must not lose the rest.
const TS = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * One page of the project's timeline, newest first: revisions and audit
 * events in one order (created_at, then type, then id, all descending).
 * Items of one change set share created_at (one transaction's now()), so
 * they come out together.
 */
async function historyPage(db: Db, projectId: string, q: z.infer<typeof HistoryQuery>) {
	const kind = q.kind ?? null;
	const wantRevisions = kind === null || kind === 'revision';
	const wantEvents = kind !== 'revision';
	const { rows } = await db.query<ItemRow>(
		`SELECT * FROM (
			SELECT 'revision' AS type, r.id, ${TS.replace('created_at', 'r.created_at')} AS ts, r.created_at, r.change_set,
				u.display_name AS actor, r.source AS kind, r.reason, r.changes, NULL::jsonb AS subject, r.restored_from, r.restored_from_run
			FROM model_revision r LEFT JOIN app_user u ON u.id = r.created_by
			WHERE $2 AND r.project_id = $1 AND ($4::uuid IS NULL OR r.node_ids @> ARRAY[$4::uuid])
				AND ($10::text[] IS NULL OR EXISTS (
					SELECT 1 FROM jsonb_array_elements(r.changes) c
					WHERE NOT EXISTS (SELECT 1 FROM unnest($10::text[]) w WHERE strpos(lower(c->>'text'), w) = 0)))
			UNION ALL
			SELECT 'event', e.id, ${TS.replace('created_at', 'e.created_at')}, e.created_at, e.change_set,
				e.actor_label, e.kind, NULL, NULL, e.subject, NULL, NULL
			FROM audit_event e
			WHERE $3 AND e.project_id = $1 AND ($4::uuid IS NULL OR e.subject->>'nodeId' = $4::text)
				AND ($5::text IS NULL OR e.kind = $5 OR e.kind LIKE $5 || '.%')
		) items
		WHERE $6::timestamptz IS NULL OR (created_at, type, id) < ($6::timestamptz, $7::text, $8::bigint)
		ORDER BY created_at DESC, type DESC, id DESC
		LIMIT $9`,
		[
			projectId,
			wantRevisions,
			wantEvents,
			q.nodeId ?? null,
			kind === 'revision' ? null : kind,
			q.before?.ts ?? null,
			q.before?.type ?? null,
			q.before?.id ?? null,
			q.limit + 1,
			q.q ?? null
		]
	);
	const more = rows.length > q.limit;
	const page = rows.slice(0, q.limit);
	const last = page.at(-1);
	return { items: page.map(toItem), next: more && last ? `${last.ts}|${last.type}|${last.id}` : null };
}

/**
 * The revisions made between two runs of a project (after the earlier ran,
 * up to and including when the later ran: a run's created_at is its
 * transaction's, and it read the inputs saved before it), newest first,
 * without the baseline. At most HISTORY_PAGE_MAX; `truncated` when there
 * were more (the oldest are left out). For the compare page (issue #42).
 */
export async function revisionsBetween(db: Db, projectId: string, earlierRunId: string, laterRunId: string): Promise<{ revisions: RevisionItem[]; truncated: boolean }> {
	const { rows } = await db.query<ItemRow>(
		`SELECT 'revision' AS type, r.id, ${TS.replace('created_at', 'r.created_at')} AS ts, r.change_set, u.display_name AS actor,
			r.source AS kind, r.reason, r.changes, NULL::jsonb AS subject, r.restored_from, r.restored_from_run
		 FROM model_revision r LEFT JOIN app_user u ON u.id = r.created_by
		 WHERE r.project_id = $1 AND r.source <> 'baseline'
			AND r.created_at > (SELECT created_at FROM model_run WHERE project_id = $1 AND id = $2)
			AND r.created_at <= (SELECT created_at FROM model_run WHERE project_id = $1 AND id = $3)
		 ORDER BY r.created_at DESC, r.id DESC LIMIT $4`,
		[projectId, earlierRunId, laterRunId, HISTORY_PAGE_MAX + 1]
	);
	return { revisions: rows.slice(0, HISTORY_PAGE_MAX).map(toItem) as RevisionItem[], truncated: rows.length > HISTORY_PAGE_MAX };
}

/** The current inputs as a revision would store them, and what restoring `target` would change. */
async function restorePreview(db: Db, projectId: string, target: InputsSnapshot): Promise<InputChange[]> {
	return describeChange(await inputsSnapshot(db, projectId), normalise(target));
}

/** A stored snapshot in today's shape: a run from an older engine carries an older model. */
function normalise(s: InputsSnapshot): InputsSnapshot {
	return { settings: s.settings ?? {}, model: upgradeLegacyModel((s.model ?? {}) as Parameters<typeof upgradeLegacyModel>[0]) as InputsSnapshot['model'] };
}

/**
 * Put `target`'s settings and model back, as a new revision (source
 * `restore`): history is never rewritten. The model must still pass today's
 * validation. A farm the restore brings back returns without its farmer
 * links (they went when it was removed); `relink` lists whom to link again,
 * from the farmer.unlinked events.
 */
async function restoreInputs(
	db: Db,
	projectId: string,
	target: InputsSnapshot,
	o: { reason?: string; restoredFrom?: string; restoredFromRun?: string }
): Promise<{ revision: RevisionRow; relink: Relink[] }> {
	const parsed = ModelBody.safeParse(normalise(target).model);
	if (!parsed.success) throw new ApiError(409, "this version can't be restored: its model doesn't pass today's checks");
	const problems = modelProblems(parsed.data);
	if (problems.length) throw new ApiError(409, "this version can't be restored: its model doesn't pass today's checks", problems);
	const change = await beginModelChange(db, projectId);
	await saveModel(db, projectId, parsed.data);
	mustChange(await db.query('UPDATE project SET settings = $2, updated_at = now() WHERE id = $1', [projectId, JSON.stringify(target.settings ?? {})]));
	await recordDroppedLinks(db, projectId, change, 'restore');
	const revision = await recordModelRevision(db, projectId, { source: 'restore', before: change.before, ...o });
	// Nothing to restore: the transaction rolls back, so nothing was written.
	if (!revision) throw new ApiError(409, 'the current inputs already match this version');
	const farms = parsed.data.nodes.filter((n) => n.kind === 'farm').map((n) => n.id);
	return { revision, relink: await relinkCandidates(db, projectId, farms) };
}

const RestoreBody = z.object({ reason: Reason }).strict();
// An empty body is fine: the reason is optional.
const readRestoreBody = async (c: Context): Promise<{ reason?: string }> => RestoreBody.parse(await readJson(c, { optional: true }));

/** A run's settings and model (its input snapshot minus series), or null when the run isn't visible. */
async function runInputs(db: Db, projectId: string, runId: string) {
	if (!UUID.test(runId)) return null;
	// A scenario run: scenario_id, or its snapshot's scenario once the scenario is deleted (024_scenarios).
	const { rows } = await db.query<{ inputs: RunInputsSnapshot; created_at: Date; label: string; scenario: boolean }>(
		`SELECT inputs, created_at, label, (scenario_id IS NOT NULL OR inputs ? 'scenario') AS scenario FROM model_run WHERE project_id = $1 AND id = $2`,
		[projectId, runId]
	);
	return rows[0] ?? null;
}

export const historyRoutes = new Hono<AuthEnv>()
	.get('/:id/history', async (c) => {
		const q = HistoryQuery.parse(c.req.query());
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			const { rows } = await db.query<{ since: Date }>('SELECT history_since AS since FROM project WHERE id = $1', [id]);
			return c.json({ ...(await historyPage(db, id, q)), historySince: rows[0]!.since.toISOString() });
		});
	})
	// Per field: how often it changed and the last change (docs/api.md § Field history).
	.get('/:id/history/fields', async (c) => {
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			return c.json({ fields: await fieldHistory(db, id) });
		});
	})
	.get('/:id/history/revisions/:revId', async (c) => {
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			const rev = revisionId(c.req.param('revId'));
			const { rows } = await db.query<ItemRow & { snapshot: InputsSnapshot }>(
				`SELECT 'revision' AS type, r.id, ${TS.replace('created_at', 'r.created_at')} AS ts, r.change_set, u.display_name AS actor,
					r.source AS kind, r.reason, r.changes, r.restored_from, r.restored_from_run, r.snapshot
				 FROM model_revision r LEFT JOIN app_user u ON u.id = r.created_by
				 WHERE r.project_id = $1 AND r.id = $2`,
				[id, rev]
			);
			const row = rows[0];
			if (!row) throw new ApiError(404, 'not found');
			// What "Restore this version" would change, from the inputs as they are now.
			return c.json({ revision: { ...toItem(row), snapshot: row.snapshot }, preview: await restorePreview(db, id, row.snapshot) });
		});
	})
	.post('/:id/history/revisions/:revId/restore', async (c) => {
		const body = await readRestoreBody(c);
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const rev = revisionId(c.req.param('revId'));
			const { rows } = await db.query<{ snapshot: InputsSnapshot }>('SELECT snapshot FROM model_revision WHERE project_id = $1 AND id = $2', [id, rev]);
			if (!rows[0]) throw new ApiError(404, 'not found');
			return c.json(await restoreInputs(db, id, rows[0].snapshot, { reason: body.reason, restoredFrom: rev }), 201);
		});
	})
	// "Changes since this run": the input lines between the run's snapshot and
	// now (series by their hashes), and the revisions made since it ran.
	.get('/:id/runs/:runId/changes-since', async (c) => {
		const { id, runId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			const run = await runInputs(db, id, runId);
			if (!run) throw new ApiError(404, 'not found');
			const now = await loadModelInput(db, id);
			const current: RunInputsSnapshot = {
				settings: now.settings as RunInputsSnapshot['settings'],
				model: now.model,
				series: Object.fromEntries(
					Object.entries(now.series).map(([k, v]) => [k, { startDate: v.startDate, length: v.values.length, valuesSha256: seriesHash(v.values), provenance: v.provenance ?? null }])
				)
			};
			// The run's settings carry its resolved fit record; compare like with like.
			const { fitRecord: _a, ...runSettings } = (run.inputs.settings ?? {}) as Record<string, unknown>;
			const { fitRecord: _b, ...nowSettings } = current.settings as Record<string, unknown>;
			const changes = diffInputs(
				{ ...run.inputs, settings: runSettings as RunInputsSnapshot['settings'], model: upgradeLegacyModel(run.inputs.model ?? {}) as RunInputsSnapshot['model'] },
				{ ...current, settings: nowSettings as RunInputsSnapshot['settings'] }
			);
			const { rows } = await db.query<ItemRow>(
				`SELECT 'revision' AS type, r.id, ${TS.replace('created_at', 'r.created_at')} AS ts, r.change_set, u.display_name AS actor,
					r.source AS kind, r.reason, r.changes, NULL::jsonb AS subject, r.restored_from, r.restored_from_run
				 FROM model_revision r LEFT JOIN app_user u ON u.id = r.created_by
				 WHERE r.project_id = $1 AND r.created_at > $2 AND r.source <> 'baseline'
				 ORDER BY r.created_at DESC, r.id DESC LIMIT $3`,
				[id, run.created_at, HISTORY_PAGE_MAX]
			);
			return c.json({ changes, revisions: rows.map(toItem) });
		});
	})
	.post('/:id/runs/:runId/restore-inputs', async (c) => {
		const body = await readRestoreBody(c);
		const { id, runId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const run = await runInputs(db, id, runId);
			if (!run) throw new ApiError(404, 'not found');
			// A scenario run's inputs are its scenario applied to a base run (024_scenarios), not a state the project was ever in.
			if (run.scenario) throw new ApiError(409, "this is a scenario run: its inputs are the scenario's changes on its base run, so they aren't restored into the project");
			const settings = { ...(run.inputs.settings ?? {}) };
			// The run's day where the catchment is (project.time_zone, 058), as its readers date it.
			const { rows: tz } = await db.query<{ time_zone: string }>('SELECT time_zone FROM project WHERE id = $1', [id]);
			const reason = body.reason ?? `Inputs of the run${run.label ? ` "${run.label}"` : ''} of ${localDate(run.created_at, tz[0]?.time_zone ?? DEFAULT_TIME_ZONE)}`.slice(0, 500);
			return c.json(await restoreInputs(db, id, { settings, model: run.inputs.model }, { reason, restoredFromRun: runId }), 201);
		});
	})
	// A series' kept values (series_revision), newest first: by the series' id,
	// or, for a live series, any earlier series of the same kind and name (a
	// delete and a new upload give it a new id).
	.get('/:id/series/:seriesId/revisions', async (c) => {
		const { id, seriesId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			if (!UUID.test(seriesId)) throw new ApiError(404, 'not found');
			const { rows } = await db.query(
				`SELECT r.id::text AS id, r.created_at AS "createdAt", u.display_name AS "createdBy", r.reason,
					to_char(r.start_date, 'YYYY-MM-DD') AS "startDate", cardinality(r."values") AS length, r.values_sha256 AS "valuesSha256",
					r.kind, r.name, r.unit, r.product, r.product_version AS "productVersion", r.day_boundary AS "dayBoundary", r.site_node_id AS "siteNodeId",
					r.source, r.source_unit AS "sourceUnit", r.source_unit_factor AS "sourceUnitFactor"
				 FROM series_revision r LEFT JOIN app_user u ON u.id = r.created_by
				 WHERE r.project_id = $1 AND (r.series_id = $2
					OR (r.kind, r.name) IN (SELECT kind, name FROM time_series WHERE project_id = $1 AND id = $2))
				 ORDER BY r.created_at DESC, r.id DESC`,
				[id, seriesId]
			);
			return c.json({ revisions: rows });
		});
	})
	.post('/:id/series/:seriesId/revisions/:revId/restore', async (c) => {
		const { id, seriesId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			if (!UUID.test(seriesId)) throw new ApiError(404, 'not found');
			const rev = revisionId(c.req.param('revId'));
			const { rows } = await db.query<{
				kind: string;
				name: string;
				unit: string;
				startDate: string;
				values: (number | null)[];
				product: string | null;
				productVersion: string | null;
				dayBoundary: string | null;
				siteNodeId: string | null;
				source: string | null;
				sourceUnit: string | null;
				sourceUnitFactor: number | null;
			}>(
				`SELECT r.kind, r.name, r.unit, to_char(r.start_date, 'YYYY-MM-DD') AS "startDate", r."values", r.product, r.product_version AS "productVersion",
					r.day_boundary AS "dayBoundary", r.site_node_id AS "siteNodeId",
					r.source, r.source_unit AS "sourceUnit", r.source_unit_factor AS "sourceUnitFactor"
				 FROM series_revision r
				 WHERE r.project_id = $1 AND r.id = $3 AND (r.series_id = $2
					OR (r.kind, r.name) IN (SELECT kind, name FROM time_series WHERE project_id = $1 AND id = $2))`,
				[id, seriesId, rev]
			);
			if (!rows[0]) throw new ApiError(404, 'not found');
			// The values it replaces are kept as a revision in turn, so a restore can be undone.
			// The label comes back with the values (032_series_provenance): they are what it describes.
			// So does the day boundary (033_series_day_boundary).
			// A restore puts back values the project had, not new data, so it queues no automatic re-run.
			// And its source and given unit (107_series_source).
			const { siteNodeId, source, sourceUnit, sourceUnitFactor, ...body } = rows[0];
			const { meta } = await replaceSeries(
				db,
				id,
				{ ...body, provenance: rowProvenance(body), origin: rowOrigin({ source, sourceUnit, sourceUnitFactor }) },
				{ restoredFrom: rev }
			);
			// And its site (085): a gauge record comes back at its gauge, never quietly at the outlet.
			if (meta.siteNodeId !== siteNodeId) {
				if (siteNodeId !== null) {
					const { rows: node } = await db.query('SELECT 1 FROM node WHERE project_id = $1 AND id = $2', [id, siteNodeId]);
					if (!node[0]) {
						throw new ApiError(
							409,
							"this record was measured at a gauge that is no longer in the model: restoring it would make it the outlet's record. Add the gauge back from the model's history first"
						);
					}
				}
				await db.query('UPDATE time_series SET site_node_id = $3 WHERE project_id = $1 AND id = $2', [id, meta.id, siteNodeId]);
				meta.siteNodeId = siteNodeId;
			}
			return c.json(await setDayBoundary(db, id, meta, body.dayBoundary));
		});
	});
