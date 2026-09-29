// Download endpoints (docs/api.md § Export). Read-only, viewer role, RLS-bound
// through withUser like every other project route. Bodies are built in memory
// and size-capped (MAX_EXPORT_BYTES) because Lambda's buffered responses stop
// at 6 MB.
import { damCapacityOn, fromEpochDay, toEpochDay, type NetworkNode, type RunSummary } from '@water-management/engine';
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
	forecastColumn,
	MAX_EXPORT_BYTES,
	seriesHeader,
	withResultComments,
	withRunComments,
	type DailyColumn,
	type RunProvenance
} from './csv.js';
import { loadDailyScope } from './daily-columns.js';
import { loadFlowDuration } from './fdc.js';
import { FARM_SERIES_KEYS, nodeColumnHeader, summaryCsvLines } from './run-tables.js';

/** A real calendar date: 2024-02-31 is rejected (Date.parse would roll it over). */
const isoDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && fromEpochDay(toEpochDay(s)) === s, 'not a date');
const DailyQuery = z
	.object({ nodeId: z.string().uuid().optional(), from: isoDate.optional(), to: isoDate.optional() })
	.refine((q) => !q.from || !q.to || q.from <= q.to, { message: '`from` must not be after `to`', path: ['from'] });
const FarmsQuery = z
	.object({
		key: z.string().refine((k) => FARM_SERIES_KEYS.has(k), 'not a farm series'),
		from: isoDate.optional(),
		to: isoDate.optional()
	})
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

/** The project's name and time zone (the date in a download's file name is the project's, 058_project_time_zone). */
async function projectInfo(db: import('../db/tx.js').Db, id: string): Promise<{ name: string; timeZone: string }> {
	const { rows } = await db.query<{ name: string; timeZone: string }>('SELECT name, time_zone AS "timeZone" FROM project WHERE id = $1', [id]);
	if (!rows[0]) throw new ApiError(404, 'not found');
	return rows[0];
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
	/** settings.runoffModel as the run stored it ('legacy' when absent). */
	runoffModel: string;
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
			COALESCE(inputs->'settings'->>'runoffModel', 'legacy') AS "runoffModel",
			notes, notes_updated_at AS "notesUpdatedAt",
			(SELECT display_name FROM app_user WHERE id = notes_updated_by) AS "notesUpdatedBy"
		 FROM model_run WHERE project_id = $1 AND id = $2`,
		[projectId, runId]
	);
	if (!rows[0]) throw new ApiError(404, 'not found');
	return rows[0];
}

/** Each node's dam capacity as the run's stored model had it (m³ by node id); a node without one is left out. */
async function loadDamCapacities(db: import('../db/tx.js').Db, runId: string): Promise<Record<string, number>> {
	const { rows } = await db.query<{ id: string; capacity: number }>(
		`SELECT n->>'id' AS id, (n->>'damCapacityM3')::float8 AS capacity
		 FROM model_run, jsonb_array_elements(COALESCE(inputs->'model'->'nodes', '[]'::jsonb)) n
		 WHERE model_run.id = $1 AND jsonb_typeof(n->'damCapacityM3') = 'number'`,
		[runId]
	);
	return Object.fromEntries(rows.map((r) => [r.id, r.capacity]));
}

/**
 * The capacity on `date` of each dam whose capacity changes over the run
 * (a sediment rate, an in-service date; engine ≥ 1.27.0, docs/model.md
 * §2.7g), m³ by node id; a dam whose capacity that day is the entered one is
 * left out, so a run without such dams has none.
 */
async function loadDamCapacitiesOn(db: import('../db/tx.js').Db, runId: string, date: string): Promise<Record<string, number>> {
	const { rows } = await db.query<{ node: NetworkNode }>(
		`SELECT n AS node
		 FROM model_run, jsonb_array_elements(COALESCE(inputs->'model'->'nodes', '[]'::jsonb)) n
		 WHERE model_run.id = $1 AND n->>'kind' = 'farm' AND jsonb_typeof(n->'damCapacityM3') = 'number'
		   AND (jsonb_typeof(n->'damSedimentPctPerYear') = 'number' OR jsonb_typeof(n->'damInServiceFrom') = 'string')`,
		[runId]
	);
	const day = toEpochDay(date);
	const out: Record<string, number> = {};
	for (const { node } of rows) {
		const cap = damCapacityOn(node, day);
		if (cap !== node.damCapacityM3) out[node.id] = cap;
	}
	return out;
}

/** The last day a run's summary covers: its end, or on a forecast run the day before the forecast. */
function summaryEnd(run: { endDate: string; summary: RunSummary }): string {
	const from = run.summary.forecast?.from;
	if (!from) return run.endDate;
	const before = fromEpochDay(toEpochDay(from) - 1);
	return before < run.endDate ? before : run.endDate;
}

/** The daily CSVs' `#` provenance line (csv.ts runProvenanceComment); `damCapacityM3` only on a farm's file. */
function provenance(run: RunRow, damCapacityM3?: number | null): RunProvenance {
	return {
		label: run.label,
		engineVersion: run.engineVersion,
		runoffModel: run.runoffModel,
		createdAt: new Date(run.createdAt).toISOString(),
		startDate: run.startDate,
		endDate: run.endDate,
		...(damCapacityM3 === undefined ? {} : { damCapacityM3 })
	};
}

export const exportRoutes = new Hono<AuthEnv>()
	// Every daily series of one node (or the catchment when nodeId is omitted).
	.get('/:id/runs/:runId/export/daily.csv', async (c) => {
		const { id, runId } = c.req.param();
		const q = DailyQuery.parse(c.req.query());
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			const run = await loadRun(db, id, runId);
			const { name, timeZone } = await projectInfo(db, id);
			const daily = await loadDailyScope(db, runId, q.nodeId ?? null, run.summary);
			if (!daily) throw new ApiError(404, 'not found');
			const scope = daily.name;
			const flag = forecastColumn(run.startDate, run.summary.forecast);
			const columns: DailyColumn[] = [...(flag ? [flag] : []), ...daily.series.map((s) => ({ header: s.header, values: s.values }))];
			const length = Math.max(...daily.series.map((s) => s.values.length));
			const range = dayRange(run.startDate, length, q.from, q.to);
			if (!range) throw new ApiError(400, `the window is outside the run (${run.startDate} … ${run.endDate})`);

			// A farm's file also says how big its dam was in the run's model (it bounds the storage columns).
			const dam = daily.kind === 'farm' && q.nodeId ? ((await loadDamCapacities(db, runId))[q.nodeId] ?? null) : undefined;
			const body = collectCsv(withRunComments(run.legacy, provenance(run, dam), dailyCsvLines(run.startDate, columns, range)));
			if (body === null) throw tooLarge('narrow it with ?from=YYYY-MM-DD&to=YYYY-MM-DD');
			const parts = [run.label || 'run', scope, 'daily'];
			return csvResponse(c, body, exportFilename(name, parts, 'csv', timeZone));
		});
	})
	// One farm series for every farm side by side (date + a column per farm, in
	// the run's network order), like the workbook's [Fragmented flow] (key=runoff)
	// and [Fragmented EWR] (key=ewr) sheets.
	.get('/:id/runs/:runId/export/farms.csv', async (c) => {
		const { id, runId } = c.req.param();
		const q = FarmsQuery.parse(c.req.query());
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			const run = await loadRun(db, id, runId);
			const { name, timeZone } = await projectInfo(db, id);
			const { rows } = await db.query<{ nodeId: string; nodeName: string | null; unit: string | null; values: (number | null)[] }>(
				`SELECT s.node_id AS "nodeId", n.name AS "nodeName", s.meta->>'unit' AS unit, s."values"
				 FROM run_series s LEFT JOIN node n ON n.id = s.node_id
				 WHERE s.run_id = $1 AND s.key = $2 AND s.node_id = ANY($3::uuid[])`,
				[runId, q.key, run.summary.farms.map((f) => f.nodeId)]
			);
			// The run's farm order, not the table's; a farm with no such series (e.g. a dam column on a farm without a dam) is left out.
			const byNode = new Map(rows.map((r) => [r.nodeId, r]));
			const farms = run.summary.farms.flatMap((f) => {
				const r = byNode.get(f.nodeId);
				return r ? [{ ...r, name: r.nodeName ?? f.name }] : [];
			});
			if (!farms.length) throw new ApiError(404, 'not found');
			const flag = forecastColumn(run.startDate, run.summary.forecast);
			const columns: DailyColumn[] = [...(flag ? [flag] : []), ...farms.map((f) => ({ header: nodeColumnHeader(q.key, f.name, f.unit, 'farm'), values: f.values }))];
			const length = Math.max(...farms.map((f) => f.values.length));
			const range = dayRange(run.startDate, length, q.from, q.to);
			if (!range) throw new ApiError(400, `the window is outside the run (${run.startDate} … ${run.endDate})`);

			const body = collectCsv(withRunComments(run.legacy, provenance(run), dailyCsvLines(run.startDate, columns, range)));
			if (body === null) throw tooLarge('narrow it with ?from=YYYY-MM-DD&to=YYYY-MM-DD');
			return csvResponse(c, body, exportFilename(name, [run.label || 'run', 'all-farms', q.key, 'daily'], 'csv', timeZone));
		});
	})
	// Per-farm summary table + catchment + calibration, as one sheet.
	.get('/:id/runs/:runId/export/summary.csv', async (c) => {
		const { id, runId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			const run = await loadRun(db, id, runId);
			const { name, timeZone } = await projectInfo(db, id);
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
					evidence: runEvidence(await listNominations(db, id), runId),
					flowDuration: await loadFlowDuration(db, runId, { startDate: run.startDate, forecastFrom: run.summary.forecast?.from ?? null }),
					runoffModel: run.runoffModel,
					damCapacityM3: await loadDamCapacities(db, runId),
					damCapacityEndM3: await loadDamCapacitiesOn(db, runId, summaryEnd(run))
				},
				run.summary
			);
			const body = collectCsv(withResultComments(run.legacy, lines));
			if (body === null) throw tooLarge('the run summary is unexpectedly large');
			return csvResponse(c, body, exportFilename(name, [run.label || 'run', 'summary'], 'csv', timeZone));
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
			const { name, timeZone } = await projectInfo(db, id);
			const label = s.name ? `${s.kind} – ${s.name}` : s.kind;
			const range = dayRange(s.startDate, s.values.length, q.from, q.to);
			if (!range) throw new ApiError(400, 'the window is outside the series');
			const body = collectCsv(dailyCsvLines(s.startDate, [{ header: seriesHeader(label, s.unit), values: s.values }], range));
			if (body === null) throw tooLarge('narrow it with ?from=YYYY-MM-DD&to=YYYY-MM-DD');
			return csvResponse(c, body, exportFilename(name, [s.name ? `${s.kind}-${s.name}` : s.kind], 'csv', timeZone));
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
				'Content-Disposition': attachment(exportFilename(doc.name, ['project'], 'json', doc.timeZone)),
				'Cache-Control': 'no-store'
			});
		});
	});
