// The scripted provider (ASSISTANT_PROVIDER=mock; issue #610): no model, no
// network, the same answer for the same conversation and tool results, for
// the tests and the e2e suite. production.ts refuses it in production.
//
// It reads the newest user message and the tool results that followed it in
// this turn, and takes one step per call:
//
// 1. "recommend" or "improve the fit" (checked first): calls propose_settings
//    once with MOCK_PROPOSAL (a GR4J X4 tweak SettingsPatch accepts), then
//    answers: "I have proposed one change: GR4J X4 (unit hydrograph time
//    base) to 2 days. Review it below; nothing changes until you save it." or,
//    when the tool refused it, "I could not make a proposal the settings would
//    accept: <the tool's error>".
//
// 2. "gauge" with "rain" or "respon": calls get_network, then (for the first
//    gauge node in it) get_series with that node's runoff and outflow, then
//    get_gauge_fit, one per call, and answers in exactly these lines (the
//    e2e asserts on them):
//
//      Gauge <name> has <n> dam(s) upstream: <names, comma-separated, or none>.
//      Runoff there averages <r> and outflow <o> in the series read.
//      The fit at the gauge: NSE <nse>, KGE <kge>, PBIAS <pbias>.
//      <one advice line: dams hold back the response / look at GR4J X1>
//
//    Each number has 2 decimals, or reads "not available" when no tool
//    result had it. Names and numbers come only from the tool results: the
//    network's nodes ({ id, name, kind, downstreamNodeId, damCapacityM3 },
//    the engine's node fields, found at `nodes` anywhere in the result), the
//    mean of any numeric array under a key containing "runoff" / "outflow"
//    in the series result (or its objects' `value` / `mean`), and the first
//    `nse` / `kge` / `pbias` keys (any case) in the fit. With no gauge in the
//    network it answers "I found no gauge in this project's network."
//
// 3. Anything else: "I can answer questions about this project's model and
//    results, and propose settings to try. Ask about a gauge, a dam or the fit."
//
// Usage is reported as characters ÷ 4, rounded up: input over the system
// prompt and every message, output over the text and the tool calls.
import type { AssistantConfig } from '../config.js';
import { TOOL_NAMES, type AssistantProvider, type ProviderEvent, type ProviderRequest, type ToolCall, type TurnMessage } from '../types.js';

/** The patch propose_settings is called with: GR4J's X4 (days, bounds 0.5–10), a valid SettingsPatch. */
export const MOCK_PROPOSAL = {
	patch: { gr4j: { x4: 2 } },
	reasons: { gr4j: 'A longer unit hydrograph spreads each storm over more days, which the observed flow suggests.' },
	summary: 'lengthen the GR4J unit hydrograph (X4 to 2 days)'
};

export const MOCK_IDLE_ANSWER = 'I can answer questions about this project’s model and results, and propose settings to try. Ask about a gauge, a dam or the fit.';

interface NetNode {
	id: string;
	name: string;
	kind?: unknown;
	type?: unknown;
	downstreamNodeId?: unknown;
	damCapacityM3?: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The tool results since the newest user message, by tool name (the first of each), parsed. */
function resultsThisTurn(messages: TurnMessage[]): { question: string; results: Map<string, { ok: boolean; data?: unknown; error?: string }>; step: number } {
	let from = messages.length - 1;
	while (from >= 0 && messages[from]!.role !== 'user') from--;
	const question = from >= 0 ? messages[from]!.content.toLowerCase() : '';
	const results = new Map<string, { ok: boolean; data?: unknown; error?: string }>();
	let step = 0;
	for (const m of messages.slice(from + 1)) {
		if (m.role === 'assistant') step++;
		if (m.role !== 'tool' || results.has(m.name)) continue;
		try {
			const parsed = JSON.parse(m.content) as unknown;
			results.set(m.name, isObj(parsed) ? { ok: parsed.ok === true, data: parsed.data, error: typeof parsed.error === 'string' ? parsed.error : undefined } : { ok: false });
		} catch {
			// A result cut at its size cap isn't JSON any more: read what can be read from it as text.
			results.set(m.name, { ok: true, data: m.content });
		}
	}
	return { question, results, step };
}

/** Breadth-first: the first array of objects with an id and a name under a `nodes` key. */
function findNodes(data: unknown): NetNode[] {
	const queue: unknown[] = [data];
	while (queue.length) {
		const v = queue.shift();
		if (Array.isArray(v)) queue.push(...v);
		else if (isObj(v)) {
			const nodes = v.nodes;
			if (Array.isArray(nodes) && nodes.every((n) => isObj(n) && typeof n.id === 'string' && typeof n.name === 'string')) return nodes as NetNode[];
			queue.push(...Object.values(v));
		}
	}
	return [];
}

/** Nodes whose downstream chain reaches `gaugeId`. */
function upstreamOf(nodes: NetNode[], gaugeId: string): NetNode[] {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	return nodes.filter((n) => {
		const seen = new Set<string>();
		let cur = n.downstreamNodeId;
		while (typeof cur === 'string' && !seen.has(cur)) {
			if (cur === gaugeId) return true;
			seen.add(cur);
			cur = byId.get(cur)?.downstreamNodeId;
		}
		return false;
	});
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** The mean of the numbers under the first key containing `word`, anywhere in `data`. */
function seriesMean(data: unknown, word: string): number | null {
	const queue: unknown[] = [data];
	while (queue.length) {
		const v = queue.shift();
		if (Array.isArray(v)) queue.push(...v);
		else if (isObj(v)) {
			for (const [k, x] of Object.entries(v)) {
				if (!k.toLowerCase().includes(word) || !Array.isArray(x)) continue;
				const nums = x
					.map((e) => (typeof e === 'number' ? e : isObj(e) ? (typeof e.value === 'number' ? e.value : typeof e.mean === 'number' ? e.mean : null) : null))
					.filter((e): e is number => e !== null && Number.isFinite(e));
				if (nums.length) return mean(nums);
			}
			queue.push(...Object.values(v));
		}
	}
	return null;
}

/** The first number under `key` (any case), anywhere in `data`. */
function findNumber(data: unknown, key: string): number | null {
	const queue: unknown[] = [data];
	while (queue.length) {
		const v = queue.shift();
		if (Array.isArray(v)) queue.push(...v);
		else if (isObj(v)) {
			for (const [k, x] of Object.entries(v)) if (k.toLowerCase() === key && typeof x === 'number' && Number.isFinite(x)) return x;
			queue.push(...Object.values(v));
		}
	}
	return null;
}

const fmt = (n: number | null) => (n === null ? 'not available' : n.toFixed(2));

/** The answer for the gauge question, from the three results (format in the header). */
export function gaugeAnswer(network: unknown, series: unknown, fit: unknown): string {
	const nodes = findNodes(network);
	const gauge = nodes.find((n) => n.kind === 'gauge' || n.type === 'gauge');
	if (!gauge) return 'I found no gauge in this project’s network.';
	const dams = upstreamOf(nodes, gauge.id).filter((n) => typeof n.damCapacityM3 === 'number' && n.damCapacityM3 > 0);
	const names = dams.map((d) => d.name).join(', ') || 'none';
	const advice = dams.length
		? 'The dams upstream fill before they spill, so rain above them reaches the gauge only once they are full: check their capacity and starting level before changing GR4J.'
		: 'No dam holds the flow back above it, so look at GR4J’s X1 (a large production store soaks up the rain) and the rainfall this unit reads.';
	return [
		`Gauge ${gauge.name} has ${dams.length} dam(s) upstream: ${names}.`,
		`Runoff there averages ${fmt(seriesMean(series, 'runoff'))} and outflow ${fmt(seriesMean(series, 'outflow'))} in the series read.`,
		`The fit at the gauge: NSE ${fmt(findNumber(fit, 'nse'))}, KGE ${fmt(findNumber(fit, 'kge'))}, PBIAS ${fmt(findNumber(fit, 'pbias'))}.`,
		advice
	].join('\n');
}

type Step = { call: { name: string; arguments: Record<string, unknown> } } | { text: string };

function nextStep(messages: TurnMessage[]): { step: Step; index: number } {
	const { question, results, step: index } = resultsThisTurn(messages);
	if (question.includes('recommend') || question.includes('improve the fit')) {
		const r = results.get(TOOL_NAMES.proposeSettings);
		if (!r) return { index, step: { call: { name: TOOL_NAMES.proposeSettings, arguments: MOCK_PROPOSAL } } };
		return {
			index,
			step: {
				text: r.ok
					? 'I have proposed one change: GR4J X4 (unit hydrograph time base) to 2 days. Review it below; nothing changes until you save it.'
					: `I could not make a proposal the settings would accept: ${r.error ?? 'the tool refused it'}`
			}
		};
	}
	if (question.includes('gauge') && (question.includes('rain') || question.includes('respon'))) {
		const net = results.get(TOOL_NAMES.network);
		if (!net) return { index, step: { call: { name: TOOL_NAMES.network, arguments: {} } } };
		const gauge = findNodes(net.data).find((n) => n.kind === 'gauge' || n.type === 'gauge');
		if (gauge && !results.has(TOOL_NAMES.series))
			return { index, step: { call: { name: TOOL_NAMES.series, arguments: { nodeId: gauge.id, series: ['runoff', 'outflow'], resolution: 'monthly' } } } };
		if (gauge && !results.has(TOOL_NAMES.gaugeFit)) return { index, step: { call: { name: TOOL_NAMES.gaugeFit, arguments: { nodeId: gauge.id } } } };
		return { index, step: { text: gaugeAnswer(net.data, results.get(TOOL_NAMES.series)?.data, results.get(TOOL_NAMES.gaugeFit)?.data) } };
	}
	return { index, step: { text: MOCK_IDLE_ANSWER } };
}

const chars = (req: ProviderRequest) =>
	req.messages.reduce((n, m) => n + m.content.length + (m.role === 'assistant' && m.toolCalls ? JSON.stringify(m.toolCalls).length : 0), req.system.length);

export function mockProvider(_cfg?: AssistantConfig): AssistantProvider {
	return {
		name: 'mock',
		async *complete(req: ProviderRequest): AsyncIterable<ProviderEvent> {
			if (req.signal?.aborted) throw new DOMException('aborted', 'AbortError');
			const { step, index } = nextStep(req.messages);
			const inputTokens = Math.ceil(chars(req) / 4);
			if ('call' in step) {
				const call: ToolCall = { id: `mock-${index + 1}`, name: step.call.name, arguments: step.call.arguments };
				yield { type: 'tool_call', call };
				yield { type: 'usage', inputTokens, outputTokens: Math.ceil(JSON.stringify(call).length / 4) };
				return;
			}
			// Streamed a line at a time, as a model streams deltas.
			const lines = step.text.split('\n');
			for (let i = 0; i < lines.length; i++) yield { type: 'text', delta: i < lines.length - 1 ? `${lines[i]}\n` : lines[i]! };
			yield { type: 'usage', inputTokens, outputTokens: Math.ceil(step.text.length / 4) };
		}
	};
}
