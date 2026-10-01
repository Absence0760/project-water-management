// GET /compare/runs — compare two runs, possibly from two different projects
// (docs/api.md § Compare runs, docs/run-comparison.md). Both runs are loaded
// inside one withUser transaction, so RLS decides visibility for each side.
import {
	compareRuns,
	diffInputs,
	type InputChange,
	type RunInputsSnapshot,
	type StoredSeriesValues,
	type RunSummary
} from '@water-management/engine';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser, type Db } from '../db/tx.js';
import { attributeChanges } from '../history/attribute.js';
import { revisionsBetween, type RevisionItem } from '../history/routes.js';
import { ApiError } from '../http/errors.js';
import { requireRole, UUID } from '../projects/access.js';
import { listNominations, runEvidence, type RunEvidence } from '../runs/evidence.js';
import type { RunScenarioSnapshot } from '../runs/execute.js';

/** "<projectId>:<runId>" */
const RunRef = z
	.string()
	.max(80)
	.transform((s, ctx) => {
		const [projectId, runId, ...rest] = s.split(':');
		if (rest.length || !projectId || !runId) {
			ctx.addIssue({ code: 'custom', message: 'expected <projectId>:<runId>' });
			return z.NEVER;
		}
		return { projectId, runId };
	});

interface LoadedRun {
	id: string;
	label: string;
	engineVersion: string;
	startDate: string;
	endDate: string;
	createdAt: string;
	createdBy: string | null;
	summary: RunSummary;
	inputs: RunInputsSnapshot;
	/** settings.runoffModel === 'legacy' (audit H1): workbook comparison only, not evidence. */
	legacy: boolean;
	/** The modeller's written explanation (007_run_notes); '' = none. */
	notes: string;
	notesUpdatedAt: string | null;
	notesUpdatedBy: string | null;
	/** The run's place in its project's evidence history (010_run_nomination); null = never nominated. */
	evidence: RunEvidence | null;
	/** The scenario that made the run (024_scenarios); null for a run of the model, or once the scenario is deleted. */
	scenarioId: string | null;
}

/**
 * The scenario a side's run came from, as the run recorded it
 * (`inputs.scenario`, runs/execute.ts RunScenarioSnapshot): the ops exactly as
 * applied and how each was classed, whatever has happened to the scenario
 * since. `name` is the scenario's current name, or the recorded one once it is
 * deleted. Null for a run of the model.
 */
export interface CompareScenario {
	id: string;
	name: string;
	baseRunId: string;
	ops: RunScenarioSnapshot['ops'];
	opsSha256: string;
	ownedNodeIds: string[];
	classified: RunScenarioSnapshot['classified'];
}

async function loadSide(db: Db, ref: { projectId: string; runId: string }) {
	// requireRole: 404 when the project is invisible (never 403 — viewer is the floor).
	await requireRole(db, ref.projectId, 'viewer');
	if (!UUID.test(ref.runId)) throw new ApiError(404, 'not found');
	const { rows } = await db.query<Omit<LoadedRun, 'evidence'> & { projectName: string; scenarioName: string | null }>(
		`SELECT r.id, r.label, r.engine_version AS "engineVersion", r.start_date AS "startDate",
		        r.end_date AS "endDate", r.created_at AS "createdAt", u.display_name AS "createdBy",
		        r.summary, r.inputs, p.name AS "projectName",
		        COALESCE(r.inputs->'settings'->>'runoffModel', 'legacy') = 'legacy' AS legacy,
		        r.notes, r.notes_updated_at AS "notesUpdatedAt", nu.display_name AS "notesUpdatedBy",
		        r.scenario_id AS "scenarioId", sc.name AS "scenarioName"
		 FROM model_run r
		 JOIN project p ON p.id = r.project_id
		 LEFT JOIN app_user u ON u.id = r.created_by
		 LEFT JOIN app_user nu ON nu.id = r.notes_updated_by
		 LEFT JOIN scenario sc ON sc.id = r.scenario_id
		 WHERE r.project_id = $1 AND r.id = $2`,
		[ref.projectId, ref.runId]
	);
	const row = rows[0];
	if (!row) throw new ApiError(404, 'not found');
	const { rows: series } = await db.query<{ key: string; label: string; unit: string }>(
		`SELECT key, meta->>'label' AS label, meta->>'unit' AS unit
		 FROM run_series WHERE run_id = $1 AND node_id IS NULL ORDER BY key`,
		[ref.runId]
	);
	const { projectName, scenarioName, ...rest } = row;
	const run: LoadedRun = { ...rest, evidence: runEvidence(await listNominations(db, ref.projectId), ref.runId) };
	const recorded = (row.inputs as { scenario?: RunScenarioSnapshot }).scenario;
	const scenario: CompareScenario | null = recorded
		? {
				id: recorded.id,
				name: scenarioName ?? recorded.name,
				baseRunId: recorded.baseRunId,
				ops: recorded.ops,
				opsSha256: recorded.opsSha256,
				ownedNodeIds: recorded.ownedNodeIds,
				classified: recorded.classified
			}
		: null;
	return { project: { id: ref.projectId, name: projectName }, run, scenario, catchmentSeries: series };
}

/**
 * A run's stored input values (021_series_blob) for the given series kinds, so
 * the input diff can compare the days both runs cover rather than trust a
 * whole-series hash that any date change breaks. Runs from before stored
 * inputs have none; the diff says their shared days weren't checked.
 */
export async function storedValues(db: Db, runId: string, kinds: string[]): Promise<StoredSeriesValues> {
	if (!kinds.length) return {};
	const { rows } = await db.query<{ kind: string; values: (number | null)[] | null }>(
		`SELECT i.kind, b."values"
		 FROM run_input_series i JOIN series_blob b ON b.project_id = i.project_id AND b.sha256 = i.sha256
		 WHERE i.run_id = $1 AND i.kind = ANY($2::text[])`,
		[runId, kinds]
	);
	return Object.fromEntries(rows.filter((r) => r.values).map((r) => [r.kind, r.values!]));
}

/** Series kinds both runs used whose dates or content hash differ: the only ones worth fetching. */
export function differingKinds(a: RunInputsSnapshot, b: RunInputsSnapshot): string[] {
	const sa = a?.series ?? {};
	const sb = b?.series ?? {};
	return Object.keys(sa).filter((k) => {
		const x = sa[k];
		const y = sb[k];
		return x && y && !(x.startDate === y.startDate && x.length === y.length && x.valuesSha256 && x.valuesSha256 === y.valuesSha256);
	});
}

/**
 * Who changed the inputs between the two runs (issue #42): the project's
 * revisions after run A ran and up to when run B ran, and for each line of
 * `changes` the id of the revision that set it (history/attribute.ts), or
 * null. Only for two runs of one project, A before B, neither a scenario
 * run (a scenario run's inputs are its scenario on a base run, not a state
 * the project was in); otherwise null.
 */
export interface CompareAttribution {
	revisions: RevisionItem[];
	/** More revisions than listed: the oldest are left out. */
	truncated: boolean;
	/** changedBy[i]: the revision (in `revisions`) that set changes[i]; null when none recorded did. */
	changedBy: (string | null)[];
}

async function attribution(
	db: Db,
	a: Awaited<ReturnType<typeof loadSide>>,
	b: Awaited<ReturnType<typeof loadSide>>,
	changes: InputChange[]
): Promise<CompareAttribution | null> {
	if (a.project.id !== b.project.id || a.scenario || b.scenario || a.run.scenarioId || b.run.scenarioId) return null;
	// Ordered in SQL: created_at to the microsecond (a JS Date keeps milliseconds).
	const { rows } = await db.query<{ forward: boolean }>(
		`SELECT (SELECT created_at FROM model_run WHERE id = $1) < (SELECT created_at FROM model_run WHERE id = $2) AS forward`,
		[a.run.id, b.run.id]
	);
	if (!rows[0]?.forward) return null;
	const { revisions, truncated } = await revisionsBetween(db, a.project.id, a.run.id, b.run.id);
	return { revisions, truncated, changedBy: attributeChanges(changes, revisions) };
}

/**
 * What changed in the inputs from run A to run B, and who changed it: the
 * compare route's `changes` and `attribution`, for a caller that needs only
 * those (the report's changes since the previous publication, publish/runPublication.ts).
 */
export async function compareInputs(
	db: Db,
	refA: { projectId: string; runId: string },
	refB: { projectId: string; runId: string }
): Promise<{ changes: InputChange[]; attribution: CompareAttribution | null }> {
	const a = await loadSide(db, refA);
	const b = await loadSide(db, refB);
	const kinds = differingKinds(a.run.inputs, b.run.inputs);
	const changes = diffInputs(a.run.inputs, b.run.inputs, { a: await storedValues(db, a.run.id, kinds), b: await storedValues(db, b.run.id, kinds) });
	return { changes, attribution: await attribution(db, a, b, changes) };
}

export const compareRoutes = new Hono<AuthEnv>().get('/runs', async (c) => {
	const q = z.object({ a: RunRef, b: RunRef }).parse(c.req.query());
	return withUser(c.get('userId'), async (db) => {
		const a = await loadSide(db, q.a);
		const b = await loadSide(db, q.b);
		// Catchment series both runs stored with the same unit — the ones that can be overlaid.
		const inB = new Map(b.catchmentSeries.map((s) => [s.key, s]));
		const catchmentSeries = a.catchmentSeries.filter((s) => inB.get(s.key)?.unit === s.unit);
		const kinds = differingKinds(a.run.inputs, b.run.inputs);
		const changes = diffInputs(a.run.inputs, b.run.inputs, { a: await storedValues(db, a.run.id, kinds), b: await storedValues(db, b.run.id, kinds) });
		return c.json({
			a: { project: a.project, run: a.run, scenario: a.scenario },
			b: { project: b.project, run: b.run, scenario: b.scenario },
			comparison: compareRuns(a.run, b.run),
			changes,
			attribution: await attribution(db, a, b, changes),
			catchmentSeries
		});
	});
});
