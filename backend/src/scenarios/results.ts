// The applicant's view of an application run's results (GET …/scenarios/:sid/results,
// WP-3.3, docs/scenarios.md § Applications): read the run and its base past
// RLS for the server only (app_application_run_results, 118), rebuild the
// check that made the run's input (for its reIds), read the catchment series
// under the caller's own RLS, and project it all (applicantResults.ts).
// Nothing but the projection leaves.
import type { ProjectModel, RunSummary, ScenarioOp } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { projectResultsForApplicant, type ApplicantGaugeRecord, type ApplicantResults, type ApplicantSeries, type ApplicantSeriesPair } from './applicantResults.js';
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

	// The river's series at any holder count, the outflow past the k rule only (164); the application's only when
	// every op was a proposal (118). RLS holds the same lines; the projection applies them again.
	const series = await catchmentSeries(db, projectId, r.allProposals ? runId : null, r.startDate, r.baseRunId, r.baseStartDate, r.farmHoldersOk);
	// A published DWS gauge record always (232, #523 G8): the base's, whatever the ops or the holders.
	const gaugeRecords = await publishedGaugeRecords(db, projectId, r.baseRunId, r.baseStartDate);
	const results = projectResultsForApplicant({
		base,
		baseSummary: r.baseSummary,
		runModel: r.model,
		runSummary: r.summary,
		reIds,
		ownNodeIds: s.ownedNodeIds,
		allProposals: r.allProposals,
		farmHoldersOk: r.farmHoldersOk,
		series,
		gaugeRecords
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
 * caller's RLS (run_series_select_contributor: of an application run only
 * when its ops were all proposals, 118; of the published base always; the
 * EWR requirement at any holder count, the outflow only past the k rule,
 * 164). Each pair is null unless the base has it, and its application side
 * null unless the run has it too; `runId` null reads the base's only (a run
 * with a baseline assumption). The outflow is not read below k (`impacted`).
 */
async function catchmentSeries(db: Db, projectId: string, runId: string | null, runStart: string, baseRunId: string, baseStart: string, impacted: boolean) {
	const { rows } = await db.query<{ runId: string; key: string; values: (number | null)[] }>(
		`SELECT run_id AS "runId", key, "values" FROM run_series
		 WHERE project_id = $1 AND run_id = ANY($2::uuid[]) AND node_id IS NULL AND key = ANY($3::text[])`,
		[projectId, runId ? [runId, baseRunId] : [baseRunId], impacted ? ['simulated_outflow', 'ewr'] : ['ewr']]
	);
	const get = (run: string | null, key: string, startDate: string): ApplicantSeries | null => {
		const row = run ? rows.find((x) => x.runId === run && x.key === key) : undefined;
		return row ? { startDate, values: row.values } : null;
	};
	const pair = (key: string): ApplicantSeriesPair | null => {
		const base = get(baseRunId, key, baseStart);
		return base ? { base, application: get(runId, key, runStart) } : null;
	};
	return { outflow: pair('simulated_outflow'), ewr: pair('ewr') };
}

/**
 * The published DWS gauge records at the outlet of the base run, read under
 * the caller's RLS (run_series_select_contributor, 232: a series the run
 * marked `publishedBy: 'DWS'`, of a published run, at any holder count).
 * Only marked series are asked for, so a reader who may see more (an editor)
 * gets the same.
 */
async function publishedGaugeRecords(db: Db, projectId: string, baseRunId: string, baseStart: string): Promise<ApplicantGaugeRecord[]> {
	const { rows } = await db.query<{ key: ApplicantGaugeRecord['key']; label: string | null; station: string | null; values: (number | null)[] }>(
		`SELECT key, meta->>'label' AS label, meta->>'station' AS station, "values" FROM run_series
		 WHERE project_id = $1 AND run_id = $2 AND node_id IS NULL AND key IN ('observed_flow', 'observed_flow_other') AND meta->>'publishedBy' = 'DWS'
		 ORDER BY key`,
		[projectId, baseRunId]
	);
	return rows
		.filter((x) => x.station)
		.map((x) => ({ key: x.key, label: x.label ?? 'Observed flow', station: x.station!, series: { startDate: baseStart, values: x.values } }));
}
