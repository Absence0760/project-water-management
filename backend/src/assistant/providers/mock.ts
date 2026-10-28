// The scripted provider (ASSISTANT_PROVIDER=mock; issue #610): no model, no
// network, the same answer for the same conversation and tool results, for
// the tests and the e2e suite. production.ts refuses it in production.
//
// It reads the newest user message and the tool results that followed it in
// this turn, and takes one step per call, against the real tools' arguments
// (tools/*.ts):
//
// 1. "recommend" or "improve the fit" (checked first): calls propose_settings
//    once with MOCK_PROPOSAL (`{ goal: 'recalibration', changes: [{ key:
//    'gr4j.x4', value: 2, reason }] }`, a GR4J X4 change a save accepts), then
//    answers: "I have proposed one change: GR4J X4 (unit hydrograph time base)
//    to 2 days. Review it below; nothing changes until you save it." or, when
//    the tool refused it, "I could not make a proposal the settings would
//    accept: <the tool's error>".
//
// 1b. "ewr" (issue #640, the production incident's shape): calls get_network
//    {}, then propose_settings with MOCK_EWR_X1 (the incident's mistake: GR4J
//    X1 lowered, goal 'outcome'), which the tool refuses, then with the
//    management levers instead (mockEwrProposal: the first unit with a dam
//    keeps half its own runoff out of the dam, and the first transfer from it
//    moves only when the dam is fuller), then answers "I have proposed a
//    management change to try as a scenario: <the tool's title>. …", or,
//    with no unit with a dam, that no management lever exists.
//
// 2. "gauge" with "rain" or "respon": calls get_network {}, then, for the
//    first gauge in it, get_series { node: <the unit above it>, key: 'runoff' }
//    (a gauge has no runoff of its own: the unit is the first dam above it, else
//    the first unit draining into it), get_series { node: <the gauge>, key:
//    'outflow' } (monthly, the default) and get_gauge_fit { node: <the gauge> },
//    one per call, and answers in exactly these lines (the e2e asserts on them):
//
//      Gauge <name> has <n> dam(s) upstream: <names, comma-separated, or none>.
//      Runoff at <unit, or "no unit above it"> averages <r> and the gauge’s outflow <o> in the series read.
//      The fit at the gauge: NSE <nse>, KGE <kge>, PBIAS <pbias>.
//      <one advice line: dams hold back the response / look at GR4J X1>
//
//    Each number has 2 decimals, or reads "not available" when no tool
//    result had it. Names and numbers come only from the tool results: the
//    network's `nodes` (the gauge is the first with kind 'gauge'; its dams are
//    its `above.dams`, get_network's list of the dams above each gauge; a
//    unit draining into it is a node whose `drainsInto` is the gauge), each
//    series result's `mean` (the window's mean, in its `unit`), and the fit's
//    `stats.nse` / `kge` / `pbias`. With no gauge in the network it answers
//    "I found no gauge in this project's network."
//
// 3. Anything else: "I can answer questions about this project's model and
//    results, and propose settings to try. Ask about a gauge, a dam or the fit."
//
// Usage is reported as characters ÷ 4, rounded up: input over the system
// prompt and every message, output over the text and the tool calls.
import type { AssistantConfig } from '../config.js';
import { TOOL_NAMES, type AssistantProvider, type ProviderEvent, type ProviderRequest, type ToolCall, type TurnMessage } from '../types.js';

/** What propose_settings is called with: GR4J's X4 (days, bounds 0.5–10), a change a save accepts. */
export const MOCK_PROPOSAL = {
	goal: 'recalibration',
	changes: [{ key: 'gr4j.x4', value: 2, reason: 'A longer unit hydrograph spreads each storm over more days, which the observed flow suggests.' }]
};

/** The incident's mistake (issue #640): a calibrated parameter changed to improve the EWR. The tool refuses it. */
export const MOCK_EWR_X1 = {
	goal: 'outcome',
	changes: [{ key: 'gr4j.x1', value: 1200, reason: 'A smaller production store would let more of the rain run off in dry years.' }]
};

/** The management levers for the EWR question, from get_network's answer, or null when no unit has a dam. */
export function mockEwrProposal(network: unknown): { goal: 'outcome'; changes: Record<string, unknown>[] } | null {
	const unit = nodesOf(network).find((n) => n.kind === 'farm' && isObj((n as { dam?: unknown }).dam));
	if (!unit) return null;
	const dam = (unit as unknown as { dam: { pctRunoffToDam?: unknown } }).dam;
	const share = num(dam.pctRunoffToDam) ?? 1;
	const changes: Record<string, unknown>[] = [
		{ node: unit.id, field: 'pctRunoffToDam', value: Math.round(share * 50) / 100, reason: `The dam on ${unit.name} captures its runoff before it reaches the river in dry years.` }
	];
	const transfers = isObj(network) && Array.isArray(network.transfers) ? (network.transfers as Record<string, unknown>[]) : [];
	const t = transfers.find((x) => x.from === unit.name && typeof x.id === 'string');
	if (t) {
		const floor = num(t.minStoragePct) ?? 0;
		changes.push({
			transfer: t.id,
			field: 'minStoragePct',
			value: floor < 0.5 ? 0.5 : Math.min(0.9, Math.round((floor + 0.2) * 100) / 100),
			reason: 'The transfer keeps drawing the dam down in dry years; moving water only when the dam is fuller leaves more for the river.'
		});
	}
	return { goal: 'outcome', changes };
}

export const MOCK_IDLE_ANSWER = 'I can answer questions about this project’s model and results, and propose settings to try. Ask about a gauge, a dam or the fit.';

type Result = { ok: boolean; data?: unknown; error?: string };

interface NetNode {
	id: string;
	name: string;
	kind?: unknown;
	drainsInto?: unknown;
	above?: { dams?: { id?: unknown; name?: unknown }[] };
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The tool results since the newest user message, by tool name, in order, parsed. */
function resultsThisTurn(messages: TurnMessage[]): { question: string; results: Map<string, Result[]>; step: number } {
	let from = messages.length - 1;
	while (from >= 0 && messages[from]!.role !== 'user') from--;
	const question = from >= 0 ? messages[from]!.content.toLowerCase() : '';
	const results = new Map<string, Result[]>();
	let step = 0;
	for (const m of messages.slice(from + 1)) {
		if (m.role === 'assistant') step++;
		if (m.role !== 'tool') continue;
		let r: Result;
		try {
			const parsed = JSON.parse(m.content) as unknown;
			r = isObj(parsed) ? { ok: parsed.ok === true, data: parsed.data, error: typeof parsed.error === 'string' ? parsed.error : undefined } : { ok: false };
		} catch {
			// A result cut at its size cap isn't JSON any more.
			r = { ok: false, error: 'the result was cut' };
		}
		results.set(m.name, [...(results.get(m.name) ?? []), r]);
	}
	return { question, results, step };
}

/** get_network's `nodes`. */
function nodesOf(network: unknown): NetNode[] {
	const nodes = isObj(network) ? network.nodes : undefined;
	return Array.isArray(nodes) ? (nodes.filter((n) => isObj(n) && typeof n.id === 'string' && typeof n.name === 'string') as unknown as NetNode[]) : [];
}
const gaugeOf = (network: unknown) => nodesOf(network).find((n) => n.kind === 'gauge');
/** The unit whose runoff the answer reads: the first dam above the gauge, else the first unit draining into it. */
function unitAbove(network: unknown, gauge: NetNode): NetNode | undefined {
	const nodes = nodesOf(network);
	const dam = gauge.above?.dams?.[0];
	return (typeof dam?.id === 'string' ? nodes.find((n) => n.id === dam.id) : undefined) ?? nodes.find((n) => n.kind === 'farm' && n.drainsInto === gauge.id);
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const fmt = (n: number | null) => (n === null ? 'not available' : n.toFixed(2));

/** The `mean` of the get_series result for `key`, from its data's own `key`. */
function seriesMean(series: readonly Result[], key: string): number | null {
	const r = series.find((x) => x.ok && isObj(x.data) && x.data.key === key);
	return r && isObj(r.data) ? num(r.data.mean) : null;
}

/** The answer for the gauge question, from the tools' results (format in the header). */
export function gaugeAnswer(network: unknown, series: readonly Result[], fit: unknown): string {
	const gauge = gaugeOf(network);
	if (!gauge) return 'I found no gauge in this project’s network.';
	const dams = (gauge.above?.dams ?? []).map((d) => (typeof d.name === 'string' ? d.name : '')).filter(Boolean);
	const stats = isObj(fit) && isObj(fit.stats) ? fit.stats : {};
	const advice = dams.length
		? 'The dams upstream fill before they spill, so rain above them reaches the gauge only once they are full: check their capacity and starting level before changing GR4J.'
		: 'No dam holds the flow back above it, so look at GR4J’s X1 (a large production store soaks up the rain) and the rainfall this unit reads.';
	return [
		`Gauge ${gauge.name} has ${dams.length} dam(s) upstream: ${dams.join(', ') || 'none'}.`,
		`Runoff at ${unitAbove(network, gauge)?.name ?? 'no unit above it'} averages ${fmt(seriesMean(series, 'runoff'))} and the gauge’s outflow ${fmt(seriesMean(series, 'outflow'))} in the series read.`,
		`The fit at the gauge: NSE ${fmt(num(stats.nse))}, KGE ${fmt(num(stats.kge))}, PBIAS ${fmt(num(stats.pbias))}.`,
		advice
	].join('\n');
}

type Step = { call: { name: string; arguments: Record<string, unknown> } } | { text: string };

function nextStep(messages: TurnMessage[]): { step: Step; index: number } {
	const { question, results, step: index } = resultsThisTurn(messages);
	const call = (name: string, args: Record<string, unknown>) => ({ index, step: { call: { name, arguments: args } } });
	if (question.includes('recommend') || question.includes('improve the fit')) {
		const r = results.get(TOOL_NAMES.proposeSettings)?.[0];
		if (!r) return call(TOOL_NAMES.proposeSettings, MOCK_PROPOSAL);
		return {
			index,
			step: {
				text: r.ok
					? 'I have proposed one change: GR4J X4 (unit hydrograph time base) to 2 days. Review it below; nothing changes until you save it.'
					: `I could not make a proposal the settings would accept: ${r.error ?? 'the tool refused it'}`
			}
		};
	}
	if (question.includes('ewr')) {
		const net = results.get(TOOL_NAMES.network)?.[0];
		if (!net) return call(TOOL_NAMES.network, {});
		const tries = results.get(TOOL_NAMES.proposeSettings) ?? [];
		if (tries.length === 0) return call(TOOL_NAMES.proposeSettings, MOCK_EWR_X1);
		const levers = mockEwrProposal(net.data);
		if (!levers) return { index, step: { text: 'No unit in this network has a dam, so there is no management lever I can change for the EWR; GR4J’s parameters are calibrated to the observed flow, so I have not changed them.' } };
		if (tries.length === 1) return call(TOOL_NAMES.proposeSettings, levers);
		const r = tries[1]!;
		const title = isObj(r.data) && typeof r.data.title === 'string' ? r.data.title : '';
		return {
			index,
			step: {
				text: r.ok
					? `I have proposed a management change to try as a scenario: ${title}. GR4J X1 is calibrated to the observed flow, so I have not changed it to improve the EWR.`
					: `I could not make a proposal the app would accept: ${r.error ?? 'the tool refused it'}`
			}
		};
	}
	if (question.includes('gauge') && (question.includes('rain') || question.includes('respon'))) {
		const net = results.get(TOOL_NAMES.network)?.[0];
		if (!net) return call(TOOL_NAMES.network, {});
		const gauge = gaugeOf(net.data);
		const series = results.get(TOOL_NAMES.series) ?? [];
		const unit = gauge ? unitAbove(net.data, gauge) : undefined;
		if (gauge && unit && series.length === 0) return call(TOOL_NAMES.series, { node: unit.id, key: 'runoff' });
		if (gauge && series.length === (unit ? 1 : 0)) return call(TOOL_NAMES.series, { node: gauge.id, key: 'outflow' });
		const fit = results.get(TOOL_NAMES.gaugeFit)?.[0];
		if (gauge && !fit) return call(TOOL_NAMES.gaugeFit, { node: gauge.id });
		return { index, step: { text: gaugeAnswer(net.data, series, fit?.ok ? fit.data : null) } };
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
