import type { RunMeta } from '$lib/api/types';

/** The fields of a run that say whether a scenario made it. */
export type ScenarioRunFields = Partial<Pick<RunMeta, 'fromScenario' | 'scenarioId' | 'scenarioName'>>;

/**
 * A run a scenario made (024_scenarios), also once that scenario is deleted:
 * its `scenarioId` is then null, but the run still holds the scenario's
 * changes on a base run (188_scenario_run_flag, issue #381), so it is never a
 * run of the model, a base, or the default run to show. `fromScenario` is the
 * API's answer; an older API without it still names the scenario the run
 * recorded (`scenarioName`). Never test `!run.scenarioId` for "a run of the
 * model" (scenarioRun.test.ts guards it).
 */
export function isScenarioRun(r: ScenarioRunFields): boolean {
	return r.fromScenario ?? (!!r.scenarioId || !!r.scenarioName);
}
