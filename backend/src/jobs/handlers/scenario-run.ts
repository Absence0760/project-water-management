// `scenario_run`: run an issued licence's terms in force (293_scenario_run_job,
// scenarios/licensedRun.ts; docs/scenarios.md § Applications). Queued by
// POST …/decide and POST …/appeals when the licence in force afterwards has
// terms other than the ops applied for and no run of them on the scenario's
// base; run as the member who recorded that decision or event, an editor,
// under RLS: what **Run the licensed terms** (POST …/scenarios/:sid/runs
// `terms: 'licensed'`) does, so the evidence report's § 4 counts it without
// anyone pressing the button.
//
// It reads the terms in force when it runs, not when it was queued: a
// variation recorded while it waited is the one run. It does nothing when
// there is nothing left to run: the scenario gone (or of another project),
// its licence no longer in force or back on the ops applied for, or a run of
// those terms already stored (the button pressed meanwhile). Ops that don't
// apply to the base (422) or an engine failure end it at once; another
// attempt would meet them again.
//
// The engine runs inside the job's transaction, as the rerun job's does (a
// retry after a crash never stores the run twice). The project's run lock is
// taken only after the engine, and the scenario read again under it, as
// runScenario's commit does: one deleted, rebased or varied while it ran
// stores nothing (deleted or no longer needing a run) or fails the attempt
// (changed), and the retry runs what is there then.
import { ApiError } from '../../http/errors.js';
import { requireRole } from '../../projects/access.js';
import { computeRun, lockProjectRuns, storeRun, trimRuns } from '../../runs/execute.js';
import { licensedTerms, loadScenario, prepareScenarioRun, scenarioChanged, type ScenarioRow } from '../../scenarios/execute.js';
import { hasRunOfTerms, ScenarioRunPayload, termsToRun } from '../../scenarios/licensedRun.js';
import type { Db } from '../../db/tx.js';
import { JobError } from '../errors.js';
import { defineHandler } from '../registry.js';

/** The scenario as it is now, when its licensed terms still need a run; null when there is nothing to do. */
async function needingRun(db: Db, projectId: string, scenarioId: string): Promise<ScenarioRow | null> {
	let s: ScenarioRow;
	try {
		s = await loadScenario(db, projectId, scenarioId);
	} catch (err) {
		if (err instanceof ApiError && err.status === 404) return null;
		throw err;
	}
	const terms = termsToRun(s);
	return terms && !(await hasRunOfTerms(db, projectId, s, terms.opsSha256)) ? s : null;
}

export const scenarioRunHandler = defineHandler({
	role: 'editor',
	payload: ScenarioRunPayload,
	async run({ db, job, payload }) {
		const role = await requireRole(db, job.projectId, 'editor');
		const s = await needingRun(db, job.projectId, payload.scenarioId);
		if (!s) return;
		let plan;
		try {
			plan = await prepareScenarioRun(db, job.projectId, s, undefined, role, 'licensed');
		} catch (err) {
			// The terms don't apply to the base (422), or the base can't be rebuilt (409): the assessor's to fix. The message
			// only, not the problem lines: a job's error is read by every viewer (GET …/jobs), and the lines are the check's,
			// which the Application panel shows each reader as their role may see it (pressing the button gives them).
			if (err instanceof ApiError) throw new JobError(`${err.message}; run the licensed terms from the Application panel to see why`, { retry: false });
			throw err;
		}
		let output;
		try {
			output = await computeRun(plan.run);
		} catch (err) {
			throw new JobError(`model run failed: ${(err as Error).message}`, { retry: false });
		}
		await lockProjectRuns(db, job.projectId);
		const now = await needingRun(db, job.projectId, payload.scenarioId);
		if (!now) return;
		if (scenarioChanged(s, now) || licensedTerms(now)?.opsSha256 !== plan.run.scenario?.opsSha256)
			throw new JobError('the scenario changed while its licensed terms ran (its ops, base run or licensed terms); running it again');
		await storeRun(db, plan.run, output);
		// A scenario run counts toward the project's cap like any other (as the button's).
		await trimRuns(db, job.projectId);
	}
});
