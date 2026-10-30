// The scripted provider (mock.ts) driven through the real orchestrator with
// fake tools: the gauge question's four reads and its answer, the
// recommendation through propose_settings, the canned answer, determinism.
import { describe, expect, it } from 'vitest';
import { SettingsPatch } from '../../projects/settings.js';
import { assistantConfig } from '../config.js';
import { runTurn } from '../orchestrator.js';
import { TOOL_NAMES, type AssistantProposal, type AssistantStreamEvent, type AssistantTool, type ChatMessage, type ToolResult } from '../types.js';
import { gaugeAnswer, MOCK_EWR_X1, MOCK_IDLE_ANSWER, MOCK_PROPOSAL, MOCK_READINESS_INTRO, mockEwrProposal, mockProvider, readinessAnswer } from './mock.js';
import type { ModelInput, ProjectModel } from '@water-management/engine';
import { node } from '../../__tests__/helpers.js';
import { mergeSettings } from '../../projects/settings.js';
import { networkView } from '../tools/network.js';
import { proposeSettings } from '../tools/proposeSettings.js';

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
		const proposal: AssistantProposal = {
			goal: 'recalibration',
			title: 'Recalibration: GR4J X4',
			changes: [{ label: 'GR4J X4', lines: ['GR4J X4: 1.7 → 2'], reason: MOCK_PROPOSAL.changes[0]!.reason }],
			apply: { kind: 'settings', patch: { gr4j: { x4: 2 } } }
		};
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

	it('checks what a run needs: says so before its tool call, then answers from it in the sheet’s formatting, the two apart', async () => {
		const readiness = { canStart: false, blockers: ['A run needs a network.', 'A run needs a rainfall series.'], notes: [], notRequired: 'Nothing else stops a run.' };
		const { calls, text, events } = await turn('What do I need before I can run the model?', { [TOOL_NAMES.runReadiness]: { ok: true, data: readiness } });
		expect(calls).toEqual([{ name: TOOL_NAMES.runReadiness, args: {} }]);
		// The text before the call, the tool's line, then the answer as a new paragraph.
		expect(events.findIndex((e) => e.type === 'tool')).toBeGreaterThan(events.findIndex((e) => e.type === 'text'));
		expect(text).toBe(`${MOCK_READINESS_INTRO}\n\n**Before a run**\n- A run needs a network.\n- A run needs a rainfall series.\n\n**Not needed to start a run:** Nothing else stops a run.`);
		expect(readinessAnswer({ blockers: [], notes: ['A note.'], notRequired: 'x' })).toBe('**Before a run**\n- Nothing: the model can run now.\n\nA note.\n\n**Not needed to start a run:** x');
	});

	it('gives the canned answer to anything else, with no tool call', async () => {
		const { calls, text } = await turn('Hello', {});
		expect(calls).toEqual([]);
		expect(text).toBe(MOCK_IDLE_ANSWER);
	});

	it('reaches no management lever on a network without a dam, and says so instead of proposing something else', async () => {
		const { calls, text } = await turn('Which unit has the worst EWR in dry years?', {
			[TOOL_NAMES.network]: { ok: true, data: { nodes: [{ id: 'f1', name: 'Dry Farm', kind: 'farm', dam: null }], transfers: [] } },
			[TOOL_NAMES.proposeSettings]: { ok: false, error: 'gr4j.x1: a calibrated parameter …' }
		});
		expect(calls.map((c) => c.name)).toEqual([TOOL_NAMES.network, TOOL_NAMES.proposeSettings]);
		expect(text).toMatch(/^No unit in this network has a dam, so there is no management lever/);
		expect(mockEwrProposal({ nodes: [] })).toBeNull();
	});

	it('MOCK_PROPOSAL’s change is one SettingsPatch accepts, inside the GR4J bounds (X4 0.5–10 days)', () => {
		const [change] = MOCK_PROPOSAL.changes;
		expect(change!.key).toBe('gr4j.x4');
		expect(SettingsPatch.safeParse({ gr4j: { x4: change!.value } }).success).toBe(true);
		expect(change!.value).toBeGreaterThanOrEqual(0.5);
		expect(change!.value).toBeLessThanOrEqual(10);
	});
});

// The production incident of 2026-10-28 (issue #640), in synthetic names: asked which unit does worst on the EWR in
// dry years and what to change, the model proposed lowering GR4J X1 (a calibrated parameter) under a title that
// named dam and transfer changes it didn't make. Here the mock repeats that first move against the real
// propose_settings, on a synthetic run (unit Upper Dam takes 40 % of its runoff into its dam and transfers to
// Lower Fields): the tool refuses the X1 change, and the proposal that reaches the card holds only management
// changes, under a title built from exactly those changes.
describe('the EWR incident (issue #640), through the real propose_settings', () => {
	const outlet = node('River Mouth', null);
	const upper = node('Upper Dam', outlet.id, { pctRunoffToDam: 0.4, damCapacityM3: 800_000 });
	const lower = node('Lower Fields', outlet.id, { damCapacityM3: 0, pctRunoffToDam: 0 });
	const transferId = '00000000-0000-4000-8000-00000000c0de';
	const runId = '00000000-0000-4000-8000-00000000beef';
	const base: ModelInput = {
		settings: mergeSettings({ gr4j: { x1: 1915 } }) as unknown as ModelInput['settings'],
		model: {
			nodes: [outlet, upper, lower],
			crops: [],
			cropAreas: [],
			transfers: [
				{ id: transferId, fromNodeId: upper.id, toNodeId: lower.id, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], maxRateM3s: 0.08, dailyCapM3: null, minStoragePct: 0.1, enabled: true, priority: 0 }
			]
		} as unknown as ProjectModel,
		series: {}
	};
	const QUESTION = 'Which unit has the worst EWR performance in dry years, and what would you change in the settings to improve it?';
	const ctx = { db: null as never, userId: 'u', projectId: 'p', runId: null };
	const propose = (args: unknown) => proposeSettings(ctx, args, async () => ({ runId, input: structuredClone(base) }));

	it('refuses the X1 change, then proposes only management levers, and the card says exactly what changes', async () => {
		const calls: { name: string; args: unknown }[] = [];
		const events: AssistantStreamEvent[] = [];
		const results: Record<string, (args: unknown) => Promise<ToolResult>> = {
			[TOOL_NAMES.network]: async () => ({ ok: true, data: { source: 'run', runId, ...networkView(base.model) } }),
			[TOOL_NAMES.proposeSettings]: propose
		};
		const tools: AssistantTool[] = Object.entries(results).map(([name, run]) => ({
			spec: { name, description: name, parameters: { type: 'object', properties: {} } },
			label: name,
			run: async (_ctx, args) => (calls.push({ name, args }), run(args))
		}));
		const out = await runTurn(
			{ provider: mockProvider(), tools, cfg: assistantConfig({}), runTool: (t, args) => t.run(ctx, args), emit: (e) => events.push(e) },
			[{ role: 'user', content: QUESTION }]
		);
		expect(out.end).toBe('answered');
		expect(calls.map((c) => c.name)).toEqual([TOOL_NAMES.network, TOOL_NAMES.proposeSettings, TOOL_NAMES.proposeSettings]);
		expect(calls[1]!.args).toEqual(MOCK_EWR_X1);

		// The incident's move is refused, and the model is told why and what to use instead.
		const states = events.flatMap((e) => (e.type === 'tool' && e.name === TOOL_NAMES.proposeSettings ? [e.status] : []));
		expect(states).toEqual(['start', 'error', 'start', 'done']);
		const refused = await propose(MOCK_EWR_X1);
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.error).toMatch(/^gr4j\.x1: a calibrated parameter .* never changed to improve an outcome/);

		// One proposal reaches the page: management changes only, as a scenario on the run.
		const proposals = events.flatMap((e) => (e.type === 'proposal' ? [e.proposal] : []));
		expect(proposals).toHaveLength(1);
		const p = proposals[0]!;
		expect(p.goal).toBe('outcome');
		if (p.apply.kind !== 'scenario') throw new Error('not a scenario');
		expect(p.apply.baseRunId).toBe(runId);
		expect(p.apply.ops).toEqual([
			{ op: 'node.set', nodeId: upper.id, field: 'pctRunoffToDam', value: 0.2 },
			{ op: 'transfer.set', transferId, field: 'minStoragePct', value: 0.5 }
		]);
		expect(JSON.stringify(p)).not.toMatch(/gr4j|X1/i);

		// The card's words match its changes: the title lists exactly the changes made, each with its own lines and reason.
		expect(p.changes.map((c) => c.label)).toEqual(['Upper Dam: own runoff to dam', 'transfer Upper Dam → Lower Fields: minimum dam storage to transfer']);
		expect(p.title).toBe(`Management change: ${p.changes.map((c) => c.label).join('; ')}`);
		expect(p.changes[0]!.lines).toEqual(['Upper Dam: own runoff to dam 40% → 20%']);
		expect(p.changes[1]!.lines.join(' ')).toMatch(/10%.*50%/);
		expect(p.changes.map((c) => c.reason)).toEqual(mockEwrProposal(networkView(base.model))!.changes.map((c) => c.reason));

		// And the answer describes the proposal the tool accepted, by its title.
		const text = events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');
		expect(text).toBe(`I have proposed a management change to try as a scenario: ${p.title}. GR4J X1 is calibrated to the observed flow, so I have not changed it to improve the EWR.`);
	});
});
