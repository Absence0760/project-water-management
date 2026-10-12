// The EWR is assessed and reported in the baseline, never applied (issue #523
// B4, #90 R4 (b), #507 § Principle; docs/scenarios.md § The EWR-keeping
// rules). The rules that keep water for the EWR (a dam's pass-inflow release
// without amounts, a unit's or a river off-take's `handsOffEwr`, the drought
// restriction's `ewrTrigger`; engine baselineEwrRules) run only in a
// scenario, like allocationMode's cap and full allocation:
//   - a save that switches one on in the project's own model or settings is
//     refused (PUT /projects/:id/model, PATCH /projects/:id): 400
//     `ewr_rule_scenario_only`, `details` one line per rule;
//   - a model or settings arriving from outside a save (an import, a copy, a
//     restore of an older revision or a run's inputs) comes in with them
//     switched off, and the revision's reason says which;
//   - the input every baseline run reads drops them (runs/execute.ts
//     loadLiveInput), so a baseline run is the same with or without them;
//   - 220_baseline_ewr_rules_scenario_only.sql switched off the stored ones.
// A set flow (a hands-off flow by month, a pass-inflow release with amounts)
// is an operating rule the hydrologist enters, and stays.
import {
	baselineEwrRules,
	scenarioOnlyLine,
	withoutEwrKeepingRules,
	type DroughtRestrictionRule,
	type EwrReleaseRule,
	type NetworkNode,
	type ProjectModel,
	type Transfer
} from '@water-management/engine';
import { ApiError } from '../http/errors.js';

export const EWR_SCENARIO_ONLY_ERROR =
	'the rules that keep water for the EWR run only in a scenario: in the baseline the EWR is assessed and reported, never applied (switch them on with a scenario’s ops)';

const refusal = (rules: EwrReleaseRule[]): ApiError | null =>
	rules.length ? ApiError.coded(400, 'ewr_rule_scenario_only', EWR_SCENARIO_ONLY_ERROR, undefined, rules.map(scenarioOnlyLine)) : null;

/** PUT /projects/:id/model's refusal: a node or transfer that keeps the EWR. null when there is none. */
export function baselineModelEwrRefusal(model: Pick<ProjectModel, 'nodes' | 'transfers'>): ApiError | null {
	return refusal(baselineEwrRules({ model: { nodes: model.nodes, transfers: model.transfers ?? [] } }));
}

/**
 * PATCH /projects/:id's refusal: a drought restriction rule with an EWR
 * trigger. Only the patch's own rule is read (a patch replaces the rule
 * whole), so a patch that doesn't send one is never refused for it.
 */
export function baselineSettingsEwrRefusal(patch: { droughtRestriction?: unknown } | undefined): ApiError | null {
	const rule = patch?.droughtRestriction;
	if (!rule || typeof rule !== 'object') return null;
	return refusal(baselineEwrRules({ model: { nodes: [], transfers: [] }, settings: { droughtRestriction: rule as DroughtRestrictionRule } }));
}

/**
 * A model and settings arriving from outside a save (an import, a copy, a
 * restore): the EWR-keeping rules switched off. `settings` is changed in
 * place (its drought restriction loses its EWR trigger); the model comes
 * back (a copy when anything changed). `note` says what was switched off,
 * for the revision's reason; null when nothing was.
 */
export function normaliseBaselineEwrRules<M extends { nodes: NetworkNode[]; transfers?: Transfer[] }>(
	model: M,
	settings: Record<string, unknown>
): { model: M; note: string | null } {
	const { project, removed } = withoutEwrKeepingRules({ model, settings: settings as { droughtRestriction?: DroughtRestrictionRule | null } });
	if (!removed.length) return { model, note: null };
	const rule = (project.settings as Record<string, unknown> | null | undefined)?.droughtRestriction;
	if (rule !== undefined) settings.droughtRestriction = rule;
	const n = removed.length;
	const where = removed.map((r) => r.where).join('; ');
	return {
		model: project.model,
		note: `${n} rule${n === 1 ? '' : 's'} keeping the EWR switched off (${where}): in the baseline the EWR is assessed and reported, never applied; a scenario keeps it.`
	};
}
