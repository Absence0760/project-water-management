// Structural rules of a model input that a scenario op must not break: the
// model's save rules (modelRules.ts, the one home the backend's modelProblems
// also calls, so a scenario can only produce a model a save would accept),
// plus the catchment area and the settings windows. applyScenario rejects an op that
// introduces an issue the input didn't already have, so a base that already
// carries one (an old project, a fuzz input) can still take unrelated ops.
//
// Keys are id-based so renaming a node doesn't turn an existing issue into a
// "new" one; texts are for people.
import type { ModelInput } from '../project';
import { modelRuleIssues } from '../modelRules';
import { inputFlowShares, overAllocationError } from '../network/shares';
import { resolveCatchmentAreaKm2 } from '../runoff/area';

export type StructureIssues = Map<string, string>;

export function structureIssues(input: ModelInput): StructureIssues {
	const out: StructureIssues = modelRuleIssues(input.model);
	const add = (key: string, text: string) => out.set(key, text);
	const m = input.model;

	// Rain needs land to fall on: runModel refuses a catchment of 0 km² (runoff/area.ts).
	const s = input.settings as Record<string, unknown>;
	const cal = (s.calibration ?? {}) as { catchmentAreaKm2?: number | null };
	if (m.nodes.length && !(resolveCatchmentAreaKm2({ catchmentAreaKm2: cal.catchmentAreaKm2 ?? null }, input) > 0))
		add('area', 'the catchment has no area left: no unit has land and calibration.catchmentAreaKm2 is not set');

	// Flow shares over 100 % make water from nowhere: runModel refuses them (network/shares.ts).
	const over = overAllocationError(inputFlowShares(input).sum);
	if (over) add('shares', over);

	// Windows: a start after its end.
	for (const [a, b, label] of [
		['simulationStart', 'simulationEnd', 'simulation'],
		['reportStart', 'reportEnd', 'reporting'],
		['calibrationStart', 'calibrationEnd', 'calibration']
	] as const) {
		const x = s[a];
		const y = s[b];
		if (typeof x === 'string' && typeof y === 'string' && x > y) add(`window:${label}`, `the ${label} window starts (${x}) after it ends (${y})`);
	}
	return out;
}
