// Download endpoints (docs/api.md § Export). Read-only, viewer role, RLS-bound
// through withUser like every other project route. Bodies are built in memory
// and size-capped (MAX_EXPORT_BYTES) because Lambda's buffered responses stop
// at 6 MB.
import { fromEpochDay, toEpochDay, type RunSummary } from '@water-management/engine';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { requireRole, UUID } from '../projects/access.js';
import { loadProjectDocument } from '../projects/document.js';
import { listNominations, runEvidence } from '../runs/evidence.js';
import {
	attachment,
	collectCsv,
	dailyCsvLines,
	dayRange,
	exportFilename,
	MAX_EXPORT_BYTES,
	seriesHeader,
	withLegacyComment,
	type DailyColumn
} from './csv.js';
import { nodeColumnHeader, seriesKeyOrder, summaryCsvLines } from './run-tables.js';

/** A real calendar date: 2024-02-31 is rejected (Date.parse would roll it over). */
const isoDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && fromEpochDay(toEpochDay(s)) === s, 'not a date');
const DailyQuery = z
	.object({ nodeId: z.string().uuid().optional(), from: isoDate.optional(), to: isoDate.optional() })
	.refine((q) => !q.from || !q.to || q.from <= q.to, { message: '`from` must not be after `to`', path: ['from'] });
const WindowQuery = z
	.object({ from: isoDate.optional(), to: isoDate.optional() })
	.refine((q) => !q.from || !q.to || q.from <= q.to, { message: '`from` must not be after `to`', path: ['from'] });

const MB = (MAX_EXPORT_BYTES / 1024 / 1024).toFixed(0);
const tooLarge = (hint: string) => new ApiError(413, `export larger than ${MB} MB — ${hint}`);

function csvResponse(c: Context, body: string, filename: string) {
	return c.body(body, 200, {
		'Content-Type': 'text/csv; charset=utf-8',
		'Content-Disposition': attachment(filename),
		'Cache-Control': 'no-store'
	});
}

async function projectName(db: import('../db/tx.js').Db, id: string): Promise<string> {
	const { rows } = await db.query<{ name: string }>('SELECT name FROM project WHERE id = $1', [id]);
	if (!rows[0]) throw new ApiError(404, 'not found');
	return rows[0].name;
}

interface RunRow {
	label: string;
	engineVersion: string;
	startDate: string;
	endDate: string;
	createdAt: Date;
	summary: RunSummary;
	/** settings.runoffModel === 'legacy' (absent → legacy, for runs saved before the setting existed). */
	legacy: boolean;
	notes: string;
	notesUpdatedAt: Date | null;
	notesUpdatedBy: string | null;
}

async function loadRun(db: import('../db/tx.js').Db, projectId: string, runId: string): Promise<RunRow> {
	if (!UUID.test(runId)) throw new ApiError(404, 'not found');
	const { rows } = await db.query<RunRow>(
		`SELECT label, engine_version AS "engineVersion", start_date AS "startDate", end_date AS "endDate",
			created_at AS "createdAt", summary,
			COALESCE(inputs->'settings'->>'runoffModel', 'legacy') = 'legacy' AS legacy,
			notes, notes_updated_at AS "notesUpdatedAt",
			(SELECT display_name FROM app_user WHERE id = notes_updated_by) AS "notesUpdatedBy"
		 FROM model_run WHERE project_id = $1 AND id = $2`,
		[projectId, runId]
	);
	if (!rows[0]) throw new ApiError(404, 'not found');
	return rows[0];
}

export const exportRoutes = new Hono<AuthEnv>()
	// Every daily series of one node (or the catchment when nodeId is omitted).
	.get('/:id/runs/:runId/export/daily.csv', async (c) => {
		const { id, runId } = c.req.param();
		const q = DailyQuery.parse(c.req.query());
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			const run = await loadRun(db, id, runId);
			const name = await projectName(db, id);
			const { rows } = await db.query<{ key: string; label: string | null; unit: string | null; values: (number | null)[] }>(
				`SELECT key, meta->>'label' AS label, meta->>'unit' AS unit, "values"
				 FROM run_series WHERE run_id = $1 AND node_id IS NOT DISTINCT FROM $2::uuid`,
				[runId, q.nodeId ?? null]
			);
			if (!rows.length) throw new ApiError(404, 'not found');
			const order = seriesKeyOrder(q.nodeId ? 'node' : 'catchment');
			rows.sort((a, b) => order(a.key, b.key));

			let scope = 'catchment';
			let kind: 'farm' | 'gauge' = 'farm';
			if (q.nodeId) {
				const { rows: n } = await db.query<{ name: string; kind: 'farm' | 'gauge' }>('SELECT name, kind FROM node WHERE id = $1', [q.nodeId]);
				const fromSummary = run.summary.farms.find((f) => f.nodeId === q.nodeId)?.name;
				scope = n[0]?.name ?? fromSummary ?? 'node';
				// A deleted node: a farm has a demand series, a gauge doesn't.
				kind = n[0]?.kind ?? (rows.some((r) => r.key === 'demand') ? 'farm' : 'gauge');
			}
			const columns: DailyColumn[] = rows.map((r) => ({
				header: q.nodeId ? nodeColumnHeader(r.key, r.label ?? r.key, r.unit, kind) : seriesHeader(r.label ?? r.key, r.unit),
				values: r.values
			}));
			const length = Math.max(...rows.map((r) => r.values.length));
			const range = dayRange(run.startDate, length, q.from, q.to);
			if (!range) throw new ApiError(400, `the window is outside the run (${run.startDate} … ${run.endDate})`);

			const body = collectCsv(withLegacyComment(run.legacy, dailyCsvLines(run.startDate, columns, range)));
			if (body === null) throw tooLarge('narrow it with ?from=YYYY-MM-DD&to=YYYY-MM-DD');
			const parts = [run.label || 'run', scope, 'daily'];
			return csvResponse(c, body, exportFilename(name, parts, 'csv'));
		});
	})
	// Per-farm summary table + catchment + calibration, as one sheet.
	.get('/:id/runs/:runId/export/summary.csv', async (c) => {
		const { id, runId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			const run = await loadRun(db, id, runId);
			const name = await projectName(db, id);
			const lines = summaryCsvLines(
				{
					projectName: name,
					runLabel: run.label,
					engineVersion: run.engineVersion,
					startDate: run.startDate,
					endDate: run.endDate,
					createdAt: new Date(run.createdAt).toISOString(),
					notes: run.notes,
					notesUpdatedAt: run.notesUpdatedAt ? new Date(run.notesUpdatedAt).toISOString() : null,
					notesUpdatedBy: run.notesUpdatedBy,
					evidence: runEvidence(await listNominations(db, id), runId)
				},
				run.summary
			);
			const body = collectCsv(withLegacyComment(run.legacy, lines));
			if (body === null) throw tooLarge('the run summary is unexpectedly large');
			return csvResponse(c, body, exportFilename(name, [run.label || 'run', 'summary'], 'csv'));
		});
	})
	// One input series (rain, flow …) as date,value.
	.get('/:id/series/:seriesId/export.csv', async (c) => {
		const { id, seriesId } = c.req.param();
		const q = WindowQuery.parse(c.req.query());
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			if (!UUID.test(seriesId)) throw new ApiError(404, 'not found');
			const { rows } = await db.query<{ kind: string; name: string; unit: string; startDate: string; values: (number | null)[] }>(
				`SELECT kind, name, unit, start_date AS "startDate", "values" FROM time_series WHERE project_id = $1 AND id = $2`,
				[id, seriesId]
			);
			const s = rows[0];
			if (!s) throw new ApiError(404, 'not found');
			const name = await projectName(db, id);
			const label = s.name ? `${s.kind} – ${s.name}` : s.kind;
			const range = dayRange(s.startDate, s.values.length, q.from, q.to);
			if (!range) throw new ApiError(400, 'the window is outside the series');
			const body = collectCsv(dailyCsvLines(s.startDate, [{ header: seriesHeader(label, s.unit), values: s.values }], range));
			if (body === null) throw tooLarge('narrow it with ?from=YYYY-MM-DD&to=YYYY-MM-DD');
			return csvResponse(c, body, exportFilename(name, [s.name ? `${s.kind}-${s.name}` : s.kind], 'csv'));
		});
	})
	// The whole project as a document `pnpm import:project` accepts.
	.get('/:id/export.json', async (c) => {
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			const doc = await loadProjectDocument(db, id);
			if (!doc) throw new ApiError(404, 'not found');
			const body = JSON.stringify(doc);
			if (Buffer.byteLength(body, 'utf8') > MAX_EXPORT_BYTES) {
				throw tooLarge('export the series one by one as CSV, or delete unused series');
			}
			return c.body(body, 200, {
				'Content-Type': 'application/json; charset=utf-8',
				'Content-Disposition': attachment(exportFilename(doc.name, ['project'], 'json')),
				'Cache-Control': 'no-store'
			});
		});
	});
