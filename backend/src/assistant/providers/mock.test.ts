// The scripted provider (mock.ts) driven through the real orchestrator with
// fake tools: the gauge question's four reads and its answer, the
// recommendation through propose_settings, the canned answer, determinism.
import { describe, expect, it } from 'vitest';
import { SettingsPatch } from '../../projects/settings.js';
import { assistantConfig } from '../config.js';
import { runTurn } from '../orchestrator.js';
import { TOOL_NAMES, type AssistantStreamEvent, type AssistantTool, type ChatMessage, type ToolResult } from '../types.js';
import { gaugeAnswer, MOCK_IDLE_ANSWER, MOCK_PROPOSAL, mockProvider } from './mock.js';

/** An invented network as get_network answers it: two dams above gauge Moddergat Weir (its `above.dams`), one below. */
const NETWORK = {
	source: 'run',
	nodes: [
		{ id: 'f1', name: 'Kliphoek', kind: 'farm', drainsInto: 'f2', dam: { capacityM3: 200_000 } },
		{ id: 'f2', name: 'Rietvlei', kind: 'farm', drainsInto: 'g1', dam: { capacityM3: 50_000 } },
		{ id: 'f3', name: 'Dry Farm', kind: 'farm', drainsInto: 'g1', dam: null },
		{ id: 'g1', name: 'Moddergat Weir', kind: 'gauge', drainsInto: 'f4', above: { units: 3, dams: [{ id: 'f1', name: 'Kliphoek', capacityM3: 200_000 }, { id: 'f2', name: 'Rietvlei', capacityM3: 50_000 }], gauges: [] } },
		{ id: 'f4', name: 'Below', kind: 'farm', outlet: true, dam: { capacityM3: 900_000 } }
	]
};
const series = (key: string, mean: number) => ({ runId: 'r', node: { id: 'g1', name: 'Moddergat Weir', kind: 'gauge' }, key, unit: 'm³/day', resolution: 'monthly', mean, points: [] });
const FIT = { runId: 'r', gauge: { id: 'g1', name: 'Moddergat Weir' }, source: 'computed', stats: { nse: 0.123, kge: -0.4567, pbias: 12.5, logNse: 0.9 } };

function fakeTools(results: Partial<Record<string, ToolResult | ((args: unknown) => ToolResult)>>, calls: { name: string; args: unknown }[]): AssistantTool[] {
	return Object.values(TOOL_NAMES).map((name) => ({
		spec: { name, description: name, parameters: { type: 'object', properties: {} } },
		label: name,
		run: async (_ctx, args) => {
			calls.push({ name, args });
			const r = results[name];
			return typeof r === 'function' ? r(args) : (r ?? { ok: false, error: 'not in this test' });
		}
	}));
}

async function turn(question: string, results: Partial<Record<string, ToolResult | ((args: unknown) => ToolResult)>>) {
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

/** Fake tools answering by name; get_series by its `key` argument. */
const gaugeResults: Partial<Record<string, ToolResult | ((args: unknown) => ToolResult)>> = {
	[TOOL_NAMES.network]: { ok: true, data: NETWORK },
	[TOOL_NAMES.series]: (args) => {
		const key = (args as { key: string }).key;
		return { ok: true, data: series(key, key === 'runoff' ? 2 : 1) };
	},
	[TOOL_NAMES.gaugeFit]: { ok: true, data: FIT }
};

describe('the mock provider', () => {
	it('answers the gauge question by reading the network, the gauge’s runoff and outflow, and its fit, then citing them', async () => {
		const { out, calls, text } = await turn('Why does the simulated flow at the gauge not respond to rainfall?', gaugeResults);
		expect(out.end).toBe('answered');
		expect(calls).toEqual([
			{ name: TOOL_NAMES.network, args: {} },
			{ name: TOOL_NAMES.series, args: { node: 'f1', key: 'runoff' } },
			{ name: TOOL_NAMES.series, args: { node: 'g1', key: 'outflow' } },
			{ name: TOOL_NAMES.gaugeFit, args: { node: 'g1' } }
		]);
		expect(text.split('\n')).toEqual([
			'Gauge Moddergat Weir has 2 dam(s) upstream: Kliphoek, Rietvlei.',
			'Runoff at Kliphoek averages 2.00 and the gauge’s outflow 1.00 in the series read.',
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
		expect(gaugeAnswer(NETWORK, [{ ok: false, error: 'withheld' }], null)).toContain(
			'Runoff at Kliphoek averages not available and the gauge’s outflow not available in the series read.\nThe fit at the gauge: NSE not available, KGE not available, PBIAS not available.'
		);
		expect(gaugeAnswer({ nodes: NETWORK.nodes.filter((n) => n.kind !== 'gauge') }, [], null)).toBe('I found no gauge in this project’s network.');
		expect(gaugeAnswer({ nodes: [{ id: 'g', name: 'Solo', kind: 'gauge', outlet: true, above: { units: 0, dams: [], gauges: [] } }] }, [], null)).toMatch(/^Gauge Solo has 0 dam\(s\) upstream: none\.\nRunoff at no unit above it averages/);
	});

	it('stops after the network when it has no gauge', async () => {
		const { calls, text } = await turn('Why no response to rain at the gauge?', { [TOOL_NAMES.network]: { ok: true, data: { nodes: [] } } });
		expect(calls.map((c) => c.name)).toEqual([TOOL_NAMES.network]);
		expect(text).toBe('I found no gauge in this project’s network.');
	});

	it('recommends through propose_settings with its fixed change, then points at the proposal', async () => {
		const proposal = { patch: { gr4j: { x4: 2 } }, reasons: { gr4j: MOCK_PROPOSAL.changes[0]!.reason }, summary: MOCK_PROPOSAL.summary, diff: [{ label: 'GR4J X4', before: '1.7', after: '2' }] };
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

	it('MOCK_PROPOSAL’s change is one SettingsPatch accepts, inside the GR4J bounds (X4 0.5–10 days)', () => {
		const [change] = MOCK_PROPOSAL.changes;
		expect(change!.key).toBe('gr4j.x4');
		expect(SettingsPatch.safeParse({ gr4j: { x4: change!.value } }).success).toBe(true);
		expect(change!.value).toBeGreaterThanOrEqual(0.5);
		expect(change!.value).toBeLessThanOrEqual(10);
	});
});
