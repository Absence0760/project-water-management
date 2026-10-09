// Download endpoints (docs/api.md § Export). Read-only, viewer role, RLS-bound
// through withUser like every other project route. The CSVs are streamed
// (download.ts csvDownload, capped at MAX_CSV_EXPORT_BYTES; WP-1.29a): the
// route loads what it needs inside its transaction, and the body is written
// from memory as the client reads it. export.json is built in memory and
// keeps the JSON cap (MAX_JSON_EXPORT_BYTES), so it always imports back.
import { damCapacityOn, fromEpochDay, parseGaugeSeriesKey, parseUnitRainSeriesKey, toEpochDay, type NetworkNode, type RunSummary, isIsoDate } from '@water-management/engine';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser, type Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { allocationUnitsHidden, redactRunAllocations } from '../allocations/viewerUnits.js';
import { requireRole, UUID } from '../projects/access.js';
import { loadProjectDocument } from '../projects/document.js';
import { listNominations, runEvidence } from '../runs/evidence.js';
import { seriesHash } from '../runs/execute.js';
import { mergeSettings } from '../projects/settings.js';
import {
	attachment,
	dailyCsvLines,
	dayRange,
	exportFilename,
	forecastColumn,
	MAX_JSON_EXPORT_BYTES,
	withResultComments,
	withRunComments,
	type DailyColumn,
	type RunProvenance
} from './csv.js';
import { csvDownload, csvTooLarge } from './download.js';
import { loadDailyScope } from './daily-columns.js';
import { RUN_CATCHMENT_KEYS, seriesExportColumns, type ExportSeries, type ReadingRun, type RunColumn } from './series-columns.js';
import { loadFlowDuration } from './fdc.js';
import { FARM_SERIES_KEYS, nodeColumnHeader, summaryCsvLines } from './run-tables.js';

/** A real calendar date: 2024-02-31 is rejected (Date.parse would roll it over). */
const isoDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.refine((s) => isIsoDate(s), 'not a date');
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

const JSON_MB = (MAX_JSON_EXPORT_BYTES / 1024 / 1024).toFixed(0);
const NARROW = 'narrow it with ?from=YYYY-MM-DD&to=YYYY-MM-DD';

/** The project's name and time zone (the date in a download's file name is the project's, 058_project_time_zone). */
async function projectInfo(db: Db, id: string): Promise<{ name: string; timeZone: string }> {
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

async function loadRun(db: Db, projectId: string, runId: string): Promise<RunRow> {
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

/** The project's node names by id (the drought restriction rule's dams, units and EWR site in the summary sheet). */
async function loadNodeNames(db: Db, projectId: string): Promise<Record<string, string>> {
	const { rows } = await db.query<{ id: string; name: string }>('SELECT id, name FROM node WHERE project_id = $1', [projectId]);
	return Object.fromEntries(rows.map((r) => [r.id, r.name]));
}

/** Each node's dam capacity as the run's stored model had it (m³ by node id); a node without one is left out. */
async function loadDamCapacities(db: Db, runId: string): Promise<Record<string, number>> {
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
 * (a sediment rate, an in-service date; engine ≥ 1.30.0, docs/model.md
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

/** Said under the provenance line when the series has changed since the run read it: the run's columns are what it read then. */
export const SERIES_CHANGED_COMMENT = '# series_changed_since_run=true; the run columns show the values the run read, not the ones above';

function* withChangedNote(changed: boolean, lines: Iterable<string>): Generator<string> {
	if (changed) yield SERIES_CHANGED_COMMENT;
	yield* lines;
}

/**
 * The latest run (visible to the caller) that read this series, as
 * run_input_series.series_id records it (056_accepted_series: never a scenario
 * run, nor one from before 056), with the series it stored for the download.
 */
async function loadReadingRun(
	db: Db,
	projectId: string,
	seriesId: string,
	s: { startDate: string; values: (number | null)[] }
): Promise<{ run: RunRow; columns: ReadingRun; changed: boolean } | null> {
	const { rows } = await db.query<{ runId: string; inputKey: string; inputStart: string; sha256: string; threshold: number | null }>(
		`SELECT i.run_id AS "runId", i.kind AS "inputKey", i.start_date AS "inputStart", i.sha256,
			(r.inputs->'settings'->'calibration'->>'rainThresholdMm')::float8 AS threshold
		 FROM run_input_series i JOIN model_run r ON r.id = i.run_id
		 WHERE i.project_id = $1 AND i.series_id = $2
		 ORDER BY r.created_at DESC, r.id DESC LIMIT 1`,
		[projectId, seriesId]
	);
	const hit = rows[0];
	if (!hit) return null;
	const run = await loadRun(db, projectId, hit.runId);
	// A gauge's record (`<kind>@<gauge>`, 084): the gauge's simulated outflow beside it. A land unit's own rain
	// (`<kind>@<unit>`, 209, issue #482): the rain the run used on that unit (`rain_unit`, under settings.unitRain perUnit).
	const gauge = parseGaugeSeriesKey(hit.inputKey);
	const unitRain = gauge ? null : parseUnitRainSeriesKey(hit.inputKey);
	const siteNodeId = gauge?.nodeId ?? unitRain?.nodeId ?? null;
	const { rows: stored } = await db.query<{ nodeId: string | null; nodeName: string | null; key: string; label: string | null; unit: string | null; values: (number | null)[] }>(
		`SELECT s.node_id AS "nodeId", n.name AS "nodeName", s.key, s.meta->>'label' AS label, s.meta->>'unit' AS unit, s."values"
		 FROM run_series s LEFT JOIN node n ON n.id = s.node_id
		 WHERE s.run_id = $1 AND ((s.node_id IS NULL AND s.key = ANY($2)) OR (s.node_id = $3::uuid AND s.key = $4))`,
		[hit.runId, RUN_CATCHMENT_KEYS, siteNodeId, unitRain ? 'rain_unit' : 'outflow']
	);
	const catchment: Record<string, RunColumn> = {};
	let gaugeFlow: ReadingRun['gaugeFlow'] = null;
	let unitRainUsed: ReadingRun['unitRain'] = null;
	for (const r of stored) {
		const col = { label: r.label ?? r.key, unit: r.unit || null, values: r.values };
		if (r.nodeId === null) catchment[r.key] = col;
		else if (unitRain) unitRainUsed = { ...col, unitName: r.nodeName ?? 'the unit' };
		else gaugeFlow = { ...col, gaugeName: r.nodeName ?? 'the gauge' };
	}
	return {
		run,
		changed: hit.inputStart !== s.startDate || hit.sha256 !== seriesHash(s.values),
		columns: {
			name: run.label || new Date(run.createdAt).toISOString().slice(0, 10),
			startDate: run.startDate,
			inputKey: hit.inputKey,
			rainThresholdMm: hit.threshold,
			catchment,
			gaugeFlow,
			unitRain: unitRainUsed
		}
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
			const parts = [run.label || 'run', scope, 'daily'];
			return csvDownload(
				c,
				() => withRunComments(run.legacy, provenance(run, dam), dailyCsvLines(run.startDate, columns, range)),
				exportFilename(name, parts, 'csv', timeZone),
				csvTooLarge(NARROW)
			);
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

			return csvDownload(
				c,
				() => withRunComments(run.legacy, provenance(run), dailyCsvLines(run.startDate, columns, range)),
				exportFilename(name, [run.label || 'run', 'all-farms', q.key, 'daily'], 'csv', timeZone),
				csvTooLarge(NARROW)
			);
		});
	})
	// Per-farm summary table + catchment + calibration, as one sheet.
	.get('/:id/runs/:runId/export/summary.csv', async (c) => {
		const { id, runId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			const role = await requireRole(db, id, 'viewer');
			const loaded = await loadRun(db, id, runId);
			// A viewer who can't read each registered volume (162, D3): no per-unit allocation cap table.
			const run = (await allocationUnitsHidden(db, id, role)) ? redactRunAllocations(loaded) : loaded;
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
					damCapacityEndM3: await loadDamCapacitiesOn(db, runId, summaryEnd(run)),
					// The drought restriction rule's dams, units and EWR site by name (engine ≥ 1.54.0).
					...(run.summary.droughtRestriction ? { nodeNames: await loadNodeNames(db, id) } : {})
				},
				run.summary
			);
			// A few hundred lines: kept, since the download walks them twice (csvDownload).
			const rows = [...withResultComments(run.legacy, lines)];
			return csvDownload(
				c,
				() => rows,
				exportFilename(name, [run.label || 'run', 'summary'], 'csv', timeZone),
				csvTooLarge('the run summary is unexpectedly large')
			);
		});
	})
	// One input series (rain, flow …): date, the value, its checks and, from the latest run that read it, how the model used it.
	.get('/:id/series/:seriesId/export.csv', async (c) => {
		const { id, seriesId } = c.req.param();
		const q = WindowQuery.parse(c.req.query());
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			if (!UUID.test(seriesId)) throw new ApiError(404, 'not found');
			const { rows } = await db.query<{ kind: string; name: string; unit: string; startDate: string; values: (number | null)[]; siteNodeId: string | null; settings: unknown }>(
				`SELECT kind, name, unit, start_date AS "startDate", "values", site_node_id AS "siteNodeId",
					(SELECT settings FROM project WHERE id = $1) AS settings
				 FROM time_series WHERE project_id = $1 AND id = $2`,
				[id, seriesId]
			);
			const s = rows[0];
			if (!s) throw new ApiError(404, 'not found');
			const { name, timeZone } = await projectInfo(db, id);
			const range = dayRange(s.startDate, s.values.length, q.from, q.to);
			if (!range) throw new ApiError(400, 'the window is outside the series');
			const series: ExportSeries = { ...s, label: s.name ? `${s.kind} – ${s.name}` : s.kind };
			const reading = await loadReadingRun(db, id, seriesId, s);
			const columns = seriesExportColumns(series, mergeSettings(s.settings), reading?.columns ?? null);
			const lines = () => dailyCsvLines(s.startDate, columns, range);
			return csvDownload(
				c,
				() => (reading ? withRunComments(reading.run.legacy, provenance(reading.run), withChangedNote(reading.changed, lines())) : lines()),
				exportFilename(name, [s.name ? `${s.kind}-${s.name}` : s.kind], 'csv', timeZone),
				csvTooLarge(NARROW)
			);
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
			if (Buffer.byteLength(body, 'utf8') > MAX_JSON_EXPORT_BYTES) {
				throw new ApiError(413, `export larger than ${JSON_MB} MB — export the series one by one as CSV, or delete unused series`);
			}
			return c.body(body, 200, {
				'Content-Type': 'application/json; charset=utf-8',
				'Content-Disposition': attachment(exportFilename(doc.name, ['project'], 'json', doc.timeZone)),
				'Cache-Control': 'no-store'
			});
		});
	});
