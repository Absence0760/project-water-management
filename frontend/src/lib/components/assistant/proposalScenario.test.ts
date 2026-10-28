// A management change made a scenario (issue #640): its name is the card's
// title, its description the changes and their reasons, its ops the server's;
// a name the project already has gets a number, and any other refusal reaches
// the card as it came. Invented names.
import { describe, expect, it } from 'vitest';
import { ApiError } from '#lib/api/client.js';
import type { AssistantProposal } from '#lib/api/types.js';
import { createProposalScenario, DESCRIPTION_MAX, NAME_MAX, scenarioDescription, scenarioName } from './proposalScenario.js';

const OPS = [{ op: 'node.set', nodeId: '00000000-0000-4000-8000-000000000001', field: 'pctRunoffToDam', value: 0.2 }] as never[];
const P: AssistantProposal = {
	goal: 'outcome',
	title: 'Management change: Hill Dam: own runoff to dam',
	changes: [{ label: 'Hill Dam: own runoff to dam', lines: ['Hill Dam: own runoff to dam 40% → 20%'], reason: 'The dam holds back dry-year runoff.' }],
	apply: { kind: 'scenario', baseRunId: 'run-1', ops: OPS }
};
const APPLY = { baseRunId: 'run-1', ops: OPS };

describe('createProposalScenario', () => {
	it('sends the title as the name, the changes and reasons as the description, and the server’s ops on its run', async () => {
		const sent: unknown[] = [];
		const id = await createProposalScenario('p1', P, APPLY, async (projectId, body) => (sent.push({ projectId, ...body }), { scenario: { id: 's1' } }));
		expect(id).toBe('s1');
		expect(sent).toEqual([
			{
				projectId: 'p1',
				name: 'Assistant: Management change: Hill Dam: own runoff to dam',
				baseRunId: 'run-1',
				ops: OPS,
				description: expect.stringContaining('Hill Dam: own runoff to dam 40% → 20%\nWhy: The dam holds back dry-year runoff.')
			}
		]);
	});

	it('numbers the name when the project already has it, and passes any other refusal on', async () => {
		const names: string[] = [];
		const clash = new ApiError(409, 'this project already has a scenario with that name');
		const id = await createProposalScenario('p1', P, APPLY, async (_p, body) => {
			names.push(body.name);
			if (names.length < 3) throw clash;
			return { scenario: { id: 's3' } };
		});
		expect(id).toBe('s3');
		expect(names.slice(1)).toEqual([`${names[0]} (2)`, `${names[0]} (3)`]);
		await expect(createProposalScenario('p1', P, APPLY, async () => Promise.reject(new ApiError(404, 'base run not found')))).rejects.toThrow('base run not found');
		// Gives up after a few clashes rather than looping.
		await expect(createProposalScenario('p1', P, APPLY, async () => Promise.reject(clash))).rejects.toBe(clash);
	});

	it('keeps the name and description inside the scenario’s limits', () => {
		const long = 'x'.repeat(500);
		expect(scenarioName(long).length).toBeLessThanOrEqual(NAME_MAX);
		expect(scenarioName(long, 4)).toMatch(/… \(4\)$/);
		expect(scenarioName(long, 4).length).toBeLessThanOrEqual(NAME_MAX);
		const many = { ...P, changes: Array.from({ length: 50 }, () => ({ ...P.changes[0]!, reason: long })) };
		expect(scenarioDescription(many).length).toBeLessThanOrEqual(DESCRIPTION_MAX);
	});
});
