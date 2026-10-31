// The mitigation alternatives a scenario cites (298_scenario_alternatives;
// docs/scenarios.md § Mitigation alternatives, docs/api.md § Scenarios): up to
// ALTERNATIVES_MAX labelled runs of the caller's own other scenarios on the
// same base run, which the evidence report sets beside the scenario on page 1
// (evidence-26).
//
// Who: whoever may change the scenario (an editor on a team scenario, only the
// applicant on an application) replaces the list, while it is a draft; once
// submitted it is frozen with the ops (scenario_alternative_guard, which also
// refuses a run of another applicant's scenario or on another base run, past
// whatever the route checked). Whoever reads the scenario reads the list.
// Neither an applicant (no model_run row, 046) nor an assessor (no draft
// alternative's scenario) reads every part of it under RLS, so both lists come
// through SECURITY DEFINER functions that check the caller first.
import { ALTERNATIVES_MAX, hasNameControlChars, NAME_CONTROL_MESSAGE } from '@water-management/engine';
import { z } from 'zod';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { lockProjectRuns } from '../runs/execute.js';

/** Most characters in an alternative's label (298's CHECK). */
export const ALTERNATIVE_LABEL_MAX = 80;

/** PUT …/alternatives: the whole list, in page-1 order. */
export const AlternativesBody = z
	.object({
		alternatives: z
			.array(
				z
					.object({
						runId: z.string().uuid(),
						label: z
							.string()
							.trim()
							.min(1, 'give the alternative a label')
							.max(ALTERNATIVE_LABEL_MAX)
							.refine((s) => !hasNameControlChars(s), NAME_CONTROL_MESSAGE)
					})
					.strict()
			)
			.max(ALTERNATIVES_MAX, `an application cites at most ${ALTERNATIVES_MAX} alternatives, so page 1 stays readable`)
			.refine((a) => new Set(a.map((x) => x.runId)).size === a.length, 'each alternative is another run')
	})
	.strict();

/** One cited alternative as the API returns it. */
export interface ScenarioAlternative {
	position: number;
	label: string;
	runId: string;
	/** The run's scenario, and its name (as the run recorded it once the scenario is gone). */
	scenarioId: string;
	scenarioName: string;
	runLabel: string;
	engineVersion: string;
	runCreatedAt: string;
}

/** A run the caller may cite: one of their own other scenarios' runs on the scenario's base run, newest first. */
export interface AlternativeCandidate {
	runId: string;
	scenarioId: string;
	scenarioName: string;
	runLabel: string;
	engineVersion: string;
	runCreatedAt: string;
}

const iso = (d: Date | string) => new Date(d).toISOString();

/** The scenario's alternatives, for a reader of it (app_scenario_alternatives); [] for anyone else. */
export async function loadAlternatives(db: Db, projectId: string, scenarioId: string): Promise<ScenarioAlternative[]> {
	const { rows } = await db.query<{
		ord: number;
		label: string;
		run_id: string;
		alternative_scenario_id: string;
		scenario_name: string | null;
		run_label: string | null;
		engine_version: string;
		run_created_at: Date;
	}>('SELECT * FROM app_scenario_alternatives($1, $2)', [projectId, scenarioId]);
	return rows.map((r) => ({
		position: r.ord,
		label: r.label,
		runId: r.run_id,
		scenarioId: r.alternative_scenario_id,
		scenarioName: r.scenario_name ?? '',
		runLabel: r.run_label ?? '',
		engineVersion: r.engine_version,
		runCreatedAt: iso(r.run_created_at)
	}));
}

/** The runs the caller may cite (app_scenario_alternative_candidates); [] when they may not change the scenario. */
export async function alternativeCandidates(db: Db, projectId: string, scenarioId: string): Promise<AlternativeCandidate[]> {
	const { rows } = await db.query<{
		run_id: string;
		alternative_scenario_id: string;
		scenario_name: string;
		run_label: string | null;
		engine_version: string;
		run_created_at: Date;
	}>('SELECT * FROM app_scenario_alternative_candidates($1, $2)', [projectId, scenarioId]);
	return rows.map((r) => ({
		runId: r.run_id,
		scenarioId: r.alternative_scenario_id,
		scenarioName: r.scenario_name,
		runLabel: r.run_label ?? '',
		engineVersion: r.engine_version,
		runCreatedAt: iso(r.run_created_at)
	}));
}

/** One refusal for a run that isn't a candidate, whatever the reason, so no answer says another applicant's run exists. */
export const NOT_A_CANDIDATE = 'an alternative is a run of another of your own scenarios on the same base run as this one';

/**
 * Replace the scenario's alternatives (the caller's right to change it, and
 * that it is a draft, are the route's to check first; the guard checks both
 * again). Each run must be one of the caller's candidates, else 422 with one
 * refusal. Under the project's run lock, as citing a run is everywhere: a trim
 * or delete under way would miss the citation.
 */
export async function replaceAlternatives(
	db: Db,
	projectId: string,
	scenarioId: string,
	list: readonly { runId: string; label: string }[]
): Promise<ScenarioAlternative[]> {
	await lockProjectRuns(db, projectId);
	const candidates = new Map((await alternativeCandidates(db, projectId, scenarioId)).map((c) => [c.runId, c]));
	const missing = list.filter((x) => !candidates.has(x.runId));
	if (missing.length) throw new ApiError(422, NOT_A_CANDIDATE, { runIds: missing.map((x) => x.runId) });
	await db.query('DELETE FROM scenario_alternative WHERE project_id = $1 AND scenario_id = $2', [projectId, scenarioId]);
	for (const [position, x] of list.entries())
		await db.query(
			`INSERT INTO scenario_alternative (project_id, scenario_id, alternative_scenario_id, run_id, position, label) VALUES ($1, $2, $3, $4, $5, $6)`,
			[projectId, scenarioId, candidates.get(x.runId)!.scenarioId, x.runId, position, x.label]
		);
	return loadAlternatives(db, projectId, scenarioId);
}
