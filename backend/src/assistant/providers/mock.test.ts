// The scripted provider (mock.ts) driven through the real orchestrator with
// fake tools: the gauge question's three reads and its answer, the
// recommendation through propose_settings, the canned answer, determinism.
import { describe, expect, it } from 'vitest';
import { SettingsPatch } from '../../projects/settings.js';
import { assistantConfig } from '../config.js';
import { runTurn } from '../orchestrator.js';
import { TOOL_NAMES, type AssistantStreamEvent, type AssistantTool, type ChatMessage, type ToolResult } from '../types.js';
import { gaugeAnswer, MOCK_IDLE_ANSWER, MOCK_PROPOSAL, mockProvider } from './mock.js';

/** An invented network: two farms with dams above gauge G1, one dam below it, a farm without a dam above it. */
const NETWORK = {
	nodes: [
		{ id: 'f1', name: 'Kliphoek', kind: 'farm', downstreamNodeId: 'f2', damCapacityM3: 200_000 },
		{ id: 'f2', name: 'Rietvlei', kind: 'farm', downstreamNodeId: 'g1', damCapacityM3: 50_000 },
		{ id: 'f3', name: 'Dry Farm', kind: 'farm', downstreamNodeId: 'g1', damCapacityM3: 0 },
		{ id: 'g1', name: 'G1 Weir', kind: 'gauge', downstreamNodeId: 'f4', damCapacityM3: 0 },
		{ id: 'f4', name: 'Below', kind: 'farm', downstreamNodeId: null, damCapacityM3: 900_000 }
	]
};
const SERIES = { nodeId: 'g1', series: { runoff_mm: [1, 2, 3], outflow_m3s: [{ month: '2020-01', mean: 0.5 }, { month: '2020-02', mean: 1.5 }] } };
const FIT = { nodeId: 'g1', stats: { NSE: 0.123, KGE: -0.4567, PBIAS: 12.5 } };

function fakeTools(results: Partial<Record<string, ToolResult>>, calls: { name: string; args: unknown }[]): AssistantTool[] {
	return Object.values(TOOL_NAMES).map((name) => ({
		spec: { name, description: name, parameters: { type: 'object', properties: {} } },
		label: name,
		run: async (_ctx, args) => {
			calls.push({ name, args });
			return results[name] ?? { ok: false, error: 'not in this test' };
		}
	}));
}

async function turn(question: string, results: Partial<Record<string, ToolResult>>) {
	const calls: { name: string; args: unknown }[] = [];
	const events: AssistantStreamEvent[] = [];
	const out = await runTurn(
		{
			provider: mockProvider(),
			tools: fakeTools(results, calls),
			cfg: assistantConfig({}),
			runTool: (t, args) => t.run({ db: null as never, userId: 'u', projectId: 'p', runId: null }, args),
			emit: (e) => events.push(e)
		},
		[{ role: 'user', content: question }] satisfies ChatMessage[]
	);
	const text = events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');
	return { out, calls, events, text };
}

const gaugeResults = { [TOOL_NAMES.network]: { ok: true, data: NETWORK }, [TOOL_NAMES.series]: { ok: true, data: SERIES }, [TOOL_NAMES.gaugeFit]: { ok: true, data: FIT } } as const;

describe('the mock provider', () => {
	it('answers the gauge question by reading the network, the gauge’s runoff and outflow, and its fit, then citing them', async () => {
		const { out, calls, text } = await turn('Why does the simulated flow at the gauge not respond to rainfall?', gaugeResults);
		expect(out.end).toBe('answered');
		expect(calls).toEqual([
			{ name: TOOL_NAMES.network, args: {} },
			{ name: TOOL_NAMES.series, args: { nodeId: 'g1', series: ['runoff', 'outflow'], resolution: 'monthly' } },
			{ name: TOOL_NAMES.gaugeFit, args: { nodeId: 'g1' } }
		]);
		expect(text.split('\n')).toEqual([
			'Gauge G1 Weir has 2 dam(s) upstream: Kliphoek, Rietvlei.',
			'Runoff there averages 2.00 and outflow 1.00 in the series read.',
			'The fit at the gauge: NSE 0.12, KGE -0.46, PBIAS 12.50.',
			'The dams upstream fill before they spill, so rain above them reaches the gauge only once they are full: check their capacity and starting level before changing GR4J.'
		]);
		expect(out.inputTokens).toBeGreaterThan(0);
		expect(out.outputTokens).toBeGreaterThan(0);
	});

	it('gives the same answer and usage for the same conversation and results', async () => {
		const a = await turn('Gauge response to rain?', gaugeResults);
		const b = await turn('Gauge response to rain?', gaugeResults);
		expect(b.text).toBe(a.text);
		expect(b.out).toEqual(a.out);
	});

	it('says "not available" for numbers no tool gave, and finds no gauge in a network without one', () => {
		expect(gaugeAnswer(NETWORK, { error: 'withheld' }, null)).toContain('NSE not available, KGE not available, PBIAS not available');
		expect(gaugeAnswer({ nodes: NETWORK.nodes.filter((n) => n.kind !== 'gauge') }, null, null)).toBe('I found no gauge in this project’s network.');
		expect(gaugeAnswer({ nodes: [{ id: 'g', name: 'Solo', kind: 'gauge', downstreamNodeId: null }] }, null, null)).toMatch(/^Gauge Solo has 0 dam\(s\) upstream: none\./);
	});

	it('stops after the network when it has no gauge', async () => {
		const { calls, text } = await turn('Why no response to rain at the gauge?', { [TOOL_NAMES.network]: { ok: true, data: { nodes: [] } } });
		expect(calls.map((c) => c.name)).toEqual([TOOL_NAMES.network]);
		expect(text).toBe('I found no gauge in this project’s network.');
	});

	it('recommends through propose_settings with its fixed patch, then points at the proposal', async () => {
		const proposal = { patch: MOCK_PROPOSAL.patch, reasons: MOCK_PROPOSAL.reasons, summary: MOCK_PROPOSAL.summary, diff: [{ label: 'GR4J X4', before: '1.7', after: '2' }] };
		const { calls, events, text } = await turn('Which settings would you change to improve the fit at the outlet?', {
			[TOOL_NAMES.proposeSettings]: { ok: true, data: { valid: true }, proposal }
		});
		expect(calls).toEqual([{ name: TOOL_NAMES.proposeSettings, args: MOCK_PROPOSAL }]);
		expect(events).toContainEqual({ type: 'proposal', proposal });
		expect(text).toMatch(/^I have proposed one change: GR4J X4/);
	});

	it('says why when propose_settings refuses its patch', async () => {
		const { text } = await turn('What do you recommend?', { [TOOL_NAMES.proposeSettings]: { ok: false, error: 'gr4j.x4: too big' } });
		expect(text).toBe('I could not make a proposal the settings would accept: gr4j.x4: too big');
	});

	it('gives the canned answer to anything else, with no tool call', async () => {
		const { calls, text } = await turn('Hello', {});
		expect(calls).toEqual([]);
		expect(text).toBe(MOCK_IDLE_ANSWER);
	});

	it('MOCK_PROPOSAL’s patch is one SettingsPatch accepts, inside the GR4J bounds (X4 0.5–10 days)', () => {
		expect(SettingsPatch.safeParse(MOCK_PROPOSAL.patch).success).toBe(true);
		expect(MOCK_PROPOSAL.patch.gr4j.x4).toBeGreaterThanOrEqual(0.5);
		expect(MOCK_PROPOSAL.patch.gr4j.x4).toBeLessThanOrEqual(10);
		expect(Object.keys(MOCK_PROPOSAL.reasons)).toEqual(Object.keys(MOCK_PROPOSAL.patch));
	});
});
