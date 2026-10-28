// A management change the assistant recommended (issue #640), made a scenario
// on its run: the scenario's name is the card's title (the server's, built
// from the changes it accepted), its description the changes and their
// reasons, its ops the ones the server checked. POST …/scenarios checks the
// ops again; a name the project already has gets " (2)", " (3)" … instead.
import { ApiError } from '#lib/api/client.js';
import type { AssistantProposal } from '#lib/api/types.js';
import type { ScenarioOp } from '@water-management/engine';

/** The scenario name and description limits (backend/src/scenarios/schema.ts). */
export const NAME_MAX = 200;
export const DESCRIPTION_MAX = 4000;
/** Names tried before giving up on a clash. */
const TRIES = 5;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** The scenario's name, the `n`th try (1: the title alone). */
export function scenarioName(title: string, n = 1): string {
	const suffix = n > 1 ? ` (${n})` : '';
	return clip(`Assistant: ${title}`, NAME_MAX - suffix.length) + suffix;
}

/** The scenario's description: each change's lines and its reason. */
export function scenarioDescription(p: AssistantProposal): string {
	const parts = [
		'Recommended by the assistant; run it and compare it with its base run to judge it.',
		...p.changes.map((c) => `${c.lines.join('\n')}\nWhy: ${c.reason}`)
	];
	return clip(parts.join('\n\n'), DESCRIPTION_MAX);
}

/** POST …/scenarios (the page passes api.scenarios.create). */
export type CreateScenario = (projectId: string, body: { name: string; baseRunId: string; description: string; ops: ScenarioOp[] }) => Promise<{ scenario: { id: string } }>;

/** Make the scenario and answer its id; a refusal other than a name clash is thrown as it came. */
export async function createProposalScenario(projectId: string, p: AssistantProposal, apply: { baseRunId: string; ops: ScenarioOp[] }, create: CreateScenario): Promise<string> {
	const description = scenarioDescription(p);
	for (let n = 1; ; n++) {
		try {
			const made = await create(projectId, { name: scenarioName(p.title, n), baseRunId: apply.baseRunId, description, ops: apply.ops });
			return made.scenario.id;
		} catch (e) {
			if (!(e instanceof ApiError && e.status === 409 && /already has a scenario with that name/.test(e.message)) || n >= TRIES) throw e;
		}
	}
}
