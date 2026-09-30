// The applicant's view of an application run's results (GET …/scenarios/:sid/results,
// WP-3.3, docs/scenarios.md § Applications): read the run and its base past
// RLS for the server only (app_application_run_results, 118), rebuild the
// check that made the run's input (for its reIds), read the catchment series
// under the caller's own RLS, and project it all (applicantResults.ts).
// Nothing but the projection leaves.
import type { ProjectModel, RunSummary, ScenarioOp } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { projectResultsForApplicant, type ApplicantResults, type ApplicantSeries } from './applicantResults.js';
import { checkScenario, loadBaseInput, type ScenarioRow } from './execute.js';

/** A run of the application as its results carry it. */
export interface ApplicantResultsRun {
	id: string;
	label: string;
	engineVersion: string;
	startDate: string;
	endDate: string;
	createdAt: string;
	baseRunId: string;
	/** Made from the application's ops and base as they are now (not an earlier version of them). */
	current: boolean;
}

interface Row {
	label: string;
	engineVersion: string;
	startDate: string;
	endDate: string;
	createdAt: string;
	scenario: { ops?: ScenarioOp[]; ownedNodeIds?: string[]; baseRunId?: string; opsSha256?: string } | null;
	model: ProjectModel;
	summary: RunSummary;
	baseRunId: string | null;
	baseStartDate: string | null;
	baseSummary: RunSummary | null;
	allProposals: boolean;
	farmHoldersOk: boolean;
}

/** The newest run of an application the caller reads (app_scenario_run_meta, 046), or null. */
export async function newestApplicationRun(db: Db, projectId: string, scenarioId: string): Promise<string | null> {
	const { rows } = await db.query<{ id: string }>('SELECT id FROM app_scenario_run_meta($1, $2) ORDER BY created_at DESC, id DESC LIMIT 1', [projectId, scenarioId]);
	return rows[0]?.id ?? null;
}

/** One run of an application, as its applicant sees it against its base. 404 for a run that isn't one of its runs. */
export async function loadApplicantResults(db: Db, projectId: string, s: ScenarioRow, runId: string): Promise<{ run: ApplicantResultsRun; results: ApplicantResults }> {
	const { rows } = await db.query<Row>(
		`SELECT label, engine_version AS "engineVersion", start_date AS "startDate", end_date AS "endDate", created_at AS "createdAt",
			scenario, model, summary, base_run_id AS "baseRunId", base_start_date AS "baseStartDate", base_summary AS "baseSummary",
			all_proposals AS "allProposals", farm_holders_ok AS "farmHoldersOk"
		 FROM app_application_run_results($1, $2, $3)`,
		[projectId, s.id, runId]
	);
	const r = rows[0];
	if (!r) throw new ApiError(404, 'not found');
	const recorded = r.scenario ?? {};
	if (!r.baseRunId || !r.baseSummary || !r.baseStartDate || !recorded.ops)
		throw new ApiError(409, "this run's base is no longer a published run, so it has nothing to be compared with; run the application again");
	// The check that made the run's input, again: the same base, ops and own
	// units give the same input (applyScenario is pure), so its reIds are the
	// run's. Under the recorded own units, not today's: that is what the run was.
	const base = await loadBaseInput(db, projectId, r.baseRunId, 'contributor');
	const { reIds } = checkScenario(base, { ops: recorded.ops, ownedNodeIds: recorded.ownedNodeIds ?? [], origin: 'applicant' });

	const series = r.allProposals && r.farmHoldersOk ? await catchmentSeries(db, projectId, runId, r.startDate, r.baseRunId, r.baseStartDate) : null;
	const results = projectResultsForApplicant({
		base,
		baseSummary: r.baseSummary,
		runModel: r.model,
		runSummary: r.summary,
		reIds,
		ownNodeIds: s.ownedNodeIds,
		allProposals: r.allProposals,
		farmHoldersOk: r.farmHoldersOk,
		series
	});
	return {
		run: {
			id: runId,
			label: r.label,
			engineVersion: r.engineVersion,
			startDate: r.startDate,
			endDate: r.endDate,
			createdAt: r.createdAt,
			baseRunId: r.baseRunId,
			current: recorded.opsSha256 === s.opsSha256 && recorded.baseRunId === s.baseRunId
		},
		results
	};
}

/**
 * The outflow and EWR series at the outlet of both runs, read under the
 * caller's RLS (run_series_select_contributor: a contributor reads them only
 * past the k rule and, of an application run, only when its ops were all
 * proposals, 118). null unless all four are there.
 */
async function catchmentSeries(db: Db, projectId: string, runId: string, runStart: string, baseRunId: string, baseStart: string) {
	const { rows } = await db.query<{ runId: string; key: string; values: (number | null)[] }>(
		`SELECT run_id AS "runId", key, "values" FROM run_series
		 WHERE project_id = $1 AND run_id = ANY($2::uuid[]) AND node_id IS NULL AND key IN ('simulated_outflow', 'ewr')`,
		[projectId, [runId, baseRunId]]
	);
	const get = (run: string, key: string, startDate: string): ApplicantSeries | null => {
		const row = rows.find((x) => x.runId === run && x.key === key);
		return row ? { startDate, values: row.values } : null;
	};
	const ob = get(baseRunId, 'simulated_outflow', baseStart);
	const oa = get(runId, 'simulated_outflow', runStart);
	const eb = get(baseRunId, 'ewr', baseStart);
	const ea = get(runId, 'ewr', runStart);
	return ob && oa && eb && ea ? { outflow: { base: ob, application: oa }, ewr: { base: eb, application: ea } } : null;
}
