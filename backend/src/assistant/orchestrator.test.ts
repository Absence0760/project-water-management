// One assistant turn (orchestrator.ts) against scripted providers and fake
// tools: the hop cap, the tool calls per hop cap, the turn's token budget (spend never past it, the first hop checked, the last hop's output cut), a
// malformed and an unknown tool call, the tool result cap, the conversation
// cap, the proposal event, the output cap, the turn deadline (a hanging tool
// included), a provider failure, and the client going away.
import { describe, expect, it } from 'vitest';
import { assistantConfig, weightedTokens, type AssistantConfig } from './config.js';
import {
	capConversation,
	capToolResult,
	firstHopInput,
	HOP_FRAMING_TOKENS,
	MESSAGE_FRAMING_TOKENS,
	messageTokens,
	MIN_HOP_OUTPUT_TOKENS,
	parseArguments,
	runTurn,
	toolCallLimitError,
	turnFloor,
	TURN_ERRORS,
	type TurnDeps
} from './orchestrator.js';
import type { AssistantProvider, AssistantStreamEvent, AssistantProposal, AssistantTool, ProviderEvent, ProviderRequest, ToolResult } from './types.js';

const cfg = (over: Partial<AssistantConfig> = {}): AssistantConfig => ({ ...assistantConfig({}), ...over });

/** A provider that answers hop n with script(n, request). */
function scripted(script: (hop: number, req: ProviderRequest) => ProviderEvent[]): AssistantProvider & { requests: ProviderRequest[] } {
	const requests: ProviderRequest[] = [];
	return {
		name: 'mock',
		requests,
		async *complete(req) {
			requests.push({ ...req, messages: [...req.messages] });
			for (const ev of script(requests.length - 1, req)) yield ev;
		}
	};
}

const usage = (i = 10, o = 5): ProviderEvent => ({ type: 'usage', inputTokens: i, outputTokens: o });
const call = (name: string, args: unknown = {}, id = 'c1'): ProviderEvent => ({ type: 'tool_call', call: { id, name, arguments: args } });

function tool(name: string, run: (args: unknown) => ToolResult | Promise<ToolResult>): AssistantTool {
	return { spec: { name, description: name, parameters: { type: 'object', properties: {} } }, label: `Running ${name}`, run: async (_ctx, args) => run(args) };
}

function deps(provider: AssistantProvider, tools: AssistantTool[] = [], over: Partial<TurnDeps> = {}) {
	const events: AssistantStreamEvent[] = [];
	const seenArgs: unknown[] = [];
	const d: TurnDeps = {
		provider,
		tools,
		cfg: cfg(),
		runTool: (t, args) => {
			seenArgs.push(args);
			return t.run({ db: null as never, userId: 'u', projectId: 'p', runId: null }, args);
		},
		emit: (e) => events.push(e),
		system: 'SYSTEM',
		...over
	};
	return { d, events, seenArgs };
}

const ask = [{ role: 'user' as const, content: 'Why?' }];

describe('runTurn', () => {
	it('answers in text: deltas streamed, usage summed, no error', async () => {
		const p = scripted(() => [{ type: 'text', delta: 'Because ' }, { type: 'text', delta: 'rain.' }, usage(12, 3)]);
		const { d, events } = deps(p);
		expect(await runTurn(d, ask)).toEqual({ inputTokens: 12, outputTokens: 3, end: 'answered' });
		expect(events).toEqual([
			{ type: 'text', delta: 'Because ' },
			{ type: 'text', delta: 'rain.' }
		]);
		expect(p.requests[0]!.system).toBe('SYSTEM');
		expect(p.requests[0]!.maxOutputTokens).toBe(cfg().maxOutputTokens);
	});

	it('runs a tool and sends its result back on the next hop, with the panel’s start and done events', async () => {
		const p = scripted((hop) => (hop === 0 ? [call('get_network', { a: 1 }), usage()] : [{ type: 'text', delta: 'done' }, usage()]));
		const { d, events, seenArgs } = deps(p, [tool('get_network', () => ({ ok: true, data: { nodes: [] } }))]);
		const out = await runTurn(d, ask);
		expect(out).toEqual({ inputTokens: 20, outputTokens: 10, end: 'answered' });
		expect(seenArgs).toEqual([{ a: 1 }]);
		expect(events.slice(0, 2)).toEqual([
			{ type: 'tool', name: 'get_network', label: 'Running get_network', status: 'start' },
			{ type: 'tool', name: 'get_network', label: 'Running get_network', status: 'done' }
		]);
		const second = p.requests[1]!.messages;
		expect(second.at(-2)).toEqual({ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_network', arguments: { a: 1 } }] });
		expect(second.at(-1)).toEqual({ role: 'tool', toolCallId: 'c1', name: 'get_network', content: JSON.stringify({ ok: true, data: { nodes: [] } }) });
	});

	it('ends with assistant_hop_limit when the model still wants tools on the last allowed call, without running them', async () => {
		let runs = 0;
		const p = scripted((hop) => [call('t', {}, `c${hop}`), usage(1, 1)]);
		const { d, events } = deps(p, [tool('t', () => (runs++, { ok: true, data: 1 }))], { cfg: cfg({ maxHops: 3 }) });
		const out = await runTurn(d, ask);
		expect(out).toEqual({ inputTokens: 3, outputTokens: 3, end: 'assistant_hop_limit' });
		expect(p.requests).toHaveLength(3);
		expect(runs).toBe(2);
		expect(events.at(-1)).toEqual({ type: 'error', code: 'assistant_hop_limit', error: TURN_ERRORS.assistant_hop_limit });
	});

	it('runs only maxToolCallsPerHop calls of one hop; each call past it gets a tool error saying so', async () => {
		const ran: unknown[] = [];
		const p = scripted((hop) =>
			hop === 0 ? [call('t', { n: 1 }, 'c1'), call('t', { n: 2 }, 'c2'), call('t', { n: 3 }, 'c3'), call('t', { n: 4 }, 'c4'), usage()] : [{ type: 'text', delta: 'ok' }, usage()]
		);
		const { d, events } = deps(p, [tool('t', (args) => (ran.push(args), { ok: true, data: 1 }))], { cfg: cfg({ maxToolCallsPerHop: 2 }) });
		expect((await runTurn(d, ask)).end).toBe('answered');
		expect(ran).toEqual([{ n: 1 }, { n: 2 }]);
		const results = p.requests[1]!.messages.filter((m) => m.role === 'tool') as { toolCallId: string; content: string }[];
		// Every call is answered, in order, so the provider sees no tool call left without a result.
		expect(results.map((r) => r.toolCallId)).toEqual(['c1', 'c2', 'c3', 'c4']);
		expect(JSON.parse(results[1]!.content)).toEqual({ ok: true, data: 1 });
		for (const r of results.slice(2)) expect(JSON.parse(r.content)).toEqual({ ok: false, error: toolCallLimitError(2) });
		expect(events.filter((e) => e.type === 'tool' && e.status === 'start')).toHaveLength(2);
	});

	it('defaults to 4 tool calls a hop', () => {
		expect(cfg().maxToolCallsPerHop).toBe(4);
	});

	it('ends with assistant_turn_limit before a hop that would pass maxTurnTokens, still reporting the tokens spent', async () => {
		const big = 'x'.repeat(4000); // 4,000 bytes of tool result: up to 4,000 tokens more on hop 1
		const p = scripted((hop) => [call('t', {}, `c${hop}`), usage(500, 100)]);
		const tools = [tool('t', () => ({ ok: true, data: big }))];
		// Hop 0 fits (its input estimate + 256 output × 5) with 1,000 to spare; it costs 500 + 5 × 100 = 1,000, and
		// hop 1 would resend 4,000+ tokens more, so the ceiling stops it.
		const maxTurnTokens = firstHopInput('SYSTEM', tools.map((t) => t.spec), ask) + 5 * 256 + 1000;
		const { d, events } = deps(p, tools, { cfg: cfg({ maxTurnTokens, maxOutputTokens: 256, maxToolResultChars: 10_000 }) });
		const out = await runTurn(d, ask);
		expect(out).toEqual({ inputTokens: 500, outputTokens: 100, end: 'assistant_turn_limit' });
		expect(weightedTokens(out.inputTokens, out.outputTokens)).toBe(1000);
		expect(p.requests).toHaveLength(1);
		expect(events.at(-1)).toEqual({ type: 'error', code: 'assistant_turn_limit', error: TURN_ERRORS.assistant_turn_limit });
	});

	it('takes the reserved budget over maxTurnTokens, and checks it before the first hop too: no call when even that can’t fit', async () => {
		const p = scripted(() => [{ type: 'text', delta: 'ok' }, usage(10, 1)]);
		const floor = turnFloor(cfg({ maxOutputTokens: 512 }), 'SYSTEM', [], ask);
		expect(floor).toBe(firstHopInput('SYSTEM', [], ask) + 5 * 512);
		// One token short of the first hop's input + MIN_HOP_OUTPUT_TOKENS (256) output: nothing is called, nothing spent.
		const short = deps(p, [], { cfg: cfg({ maxOutputTokens: 512 }), budget: firstHopInput('SYSTEM', [], ask) + 5 * MIN_HOP_OUTPUT_TOKENS - 1 });
		expect(await runTurn(short.d, ask)).toEqual({ inputTokens: 0, outputTokens: 0, end: 'assistant_turn_limit' });
		expect(p.requests).toHaveLength(0);
		expect(short.events).toEqual([{ type: 'error', code: 'assistant_turn_limit', error: TURN_ERRORS.assistant_turn_limit }]);
		// Positive control: exactly that much runs the hop, its output cut to the 256 the budget leaves.
		const just = deps(p, [], { cfg: cfg({ maxOutputTokens: 512 }), budget: firstHopInput('SYSTEM', [], ask) + 5 * MIN_HOP_OUTPUT_TOKENS });
		expect((await runTurn(just.d, ask)).end).toBe('answered');
		expect(p.requests[0]!.maxOutputTokens).toBe(MIN_HOP_OUTPUT_TOKENS);
		// And the turn's floor runs it with its whole output cap.
		const full = deps(p, [], { cfg: cfg({ maxOutputTokens: 512 }), budget: floor });
		expect((await runTurn(full.d, ask)).end).toBe('answered');
		expect(p.requests[1]!.maxOutputTokens).toBe(512);
	});

	it('cuts a later hop’s output cap to what the budget leaves', async () => {
		const tools = [tool('t', () => ({ ok: true, data: 'result' }))];
		const specs = tools.map((t) => t.spec);
		// Hop 0 reports exactly its estimate as input, and 10 out.
		const p = scripted((hop, req) =>
			hop === 0 ? [call('t', {}, 'c0'), usage(firstHopInput(req.system, req.tools, req.messages), 10)] : [{ type: 'text', delta: 'ok' }, usage(1, 1)]
		);
		const hop0 = firstHopInput('SYSTEM', specs, ask);
		const after = [...ask, { role: 'assistant' as const, content: '', toolCalls: [{ id: 'c0', name: 't', arguments: {} }] }, { role: 'tool' as const, toolCallId: 'c0', name: 't', content: JSON.stringify({ ok: true, data: 'result' }) }];
		const hop1 = firstHopInput('SYSTEM', specs, after);
		// Hop 0 spends hop0 + 5 × 10; hop 1's input is at most hop1, which leaves 400 output of the 600 cap.
		const budget = hop0 + 5 * 10 + hop1 + 5 * 400;
		// Room for hop 0's whole cap (600 × 5) too.
		expect(budget).toBeGreaterThanOrEqual(hop0 + 5 * 600);
		const { d } = deps(p, tools, { cfg: cfg({ maxOutputTokens: 600 }), budget });
		expect((await runTurn(d, ask)).end).toBe('answered');
		expect(p.requests.map((r) => r.maxOutputTokens)).toEqual([600, 400]);
	});

	it('never spends past its budget against a provider that counts input as high as the estimate and writes its whole output cap every hop', async () => {
		// The worst a provider honouring the contract can do: input = firstHopInput (bytes + framing), output = the cap.
		const worst = scripted((hop, req) => [
			{ type: 'text', delta: 'y'.repeat(20) },
			call('t', { hop }, `c${hop}`),
			usage(firstHopInput(req.system, req.tools, req.messages), req.maxOutputTokens)
		]);
		// And one that never reports usage, streaming as much as it may: counted at the same most.
		const silent = scripted((hop, req) => [{ type: 'text', delta: 'z'.repeat(req.maxOutputTokens * 2) }, call('t', { hop }, `c${hop}`)]);
		const tools = [tool('t', () => ({ ok: true, data: 'é'.repeat(3000) }))];
		const hops: number[] = [];
		for (const provider of [worst, silent]) {
			for (const budget of [8_000, 12_345, 20_000, 33_333, 60_000, 150_000]) {
				provider.requests.length = 0;
				const { d } = deps(provider, tools, { cfg: cfg({ maxHops: 8, maxToolResultChars: 12_000 }), budget });
				const out = await runTurn(d, ask);
				const spent = weightedTokens(out.inputTokens, out.outputTokens);
				expect(spent, `${provider === worst ? 'worst' : 'silent'} ${budget}`).toBeLessThanOrEqual(budget);
				// Not vacuous: the turn runs until the budget, not some other ceiling, stops it, and spends most of it.
				expect(out.end).toBe('assistant_turn_limit');
				expect(spent).toBeGreaterThan(budget / 2);
				for (const r of provider.requests) expect(r.maxOutputTokens).toBeGreaterThanOrEqual(MIN_HOP_OUTPUT_TOKENS);
				hops.push(provider.requests.length);
			}
		}
		// Several hops in the larger budgets, each one checked.
		expect(Math.max(...hops)).toBeGreaterThanOrEqual(4);
	});

	it('lets a turn under maxTurnTokens run every hop it needs', async () => {
		const p = scripted((hop) => (hop < 2 ? [call('t', {}, `c${hop}`), usage(500, 100)] : [{ type: 'text', delta: 'ok' }, usage(500, 100)]));
		const { d } = deps(p, [tool('t', () => ({ ok: true, data: 1 }))], { cfg: cfg({ maxTurnTokens: 10_000 }) });
		expect(await runTurn(d, ask)).toEqual({ inputTokens: 1500, outputTokens: 300, end: 'answered' });
	});

	it('answers a malformed call (arguments that are not JSON, or not an object) with a tool error the model sees; the tool never runs', async () => {
		let runs = 0;
		const t = tool('t', () => (runs++, { ok: true, data: 1 }));
		for (const bad of ['{not json', '[1,2]', 42]) {
			const p = scripted((hop) => (hop === 0 ? [call('t', bad), usage()] : [{ type: 'text', delta: 'ok' }, usage()]));
			const { d, events } = deps(p, [t]);
			expect((await runTurn(d, ask)).end).toBe('answered');
			const result = JSON.parse((p.requests[1]!.messages.at(-1) as { content: string }).content);
			expect(result.ok).toBe(false);
			expect(result.error).toMatch(/JSON/);
			expect(events.filter((e) => e.type === 'tool').at(-1)).toMatchObject({ status: 'error' });
		}
		expect(runs).toBe(0);
	});

	it('passes JSON-text arguments to the tool parsed', async () => {
		const p = scripted((hop) => (hop === 0 ? [call('t', '{"nodeId":"g1"}'), usage()] : [usage()]));
		const { d, seenArgs } = deps(p, [tool('t', () => ({ ok: true, data: 1 }))]);
		await runTurn(d, ask);
		expect(seenArgs).toEqual([{ nodeId: 'g1' }]);
	});

	it('answers an unknown tool with an error naming the real ones, not a crash', async () => {
		const p = scripted((hop) => (hop === 0 ? [call('drop_tables'), usage()] : [{ type: 'text', delta: 'sorry' }, usage()]));
		const { d, events } = deps(p, [tool('get_settings', () => ({ ok: true, data: 1 }))]);
		expect((await runTurn(d, ask)).end).toBe('answered');
		const result = JSON.parse((p.requests[1]!.messages.at(-1) as { content: string }).content);
		expect(result).toEqual({ ok: false, error: 'There is no tool named "drop_tables". The tools are: get_settings.' });
		expect(events[0]).toEqual({ type: 'tool', name: 'drop_tables', label: 'Unknown tool', status: 'error' });
	});

	it('turns a tool that throws into fixed words for the model; its text never reaches the model or the stream', async () => {
		const p = scripted((hop) => (hop === 0 ? [call('t'), usage()] : [usage()]));
		const { d, events } = deps(p, [tool('t', () => Promise.reject(new Error('relation "secret_table" does not exist')))]);
		await runTurn(d, ask);
		const content = (p.requests[1]!.messages.at(-1) as { content: string }).content;
		expect(content).not.toContain('secret_table');
		expect(JSON.stringify(events)).not.toContain('secret_table');
		expect(JSON.parse(content).ok).toBe(false);
	});

	it('cuts a tool result at maxToolResultChars, with a note', async () => {
		const p = scripted((hop) => (hop === 0 ? [call('t'), usage()] : [usage()]));
		const { d } = deps(p, [tool('t', () => ({ ok: true, data: 'x'.repeat(5000) }))], { cfg: cfg({ maxToolResultChars: 500 }) });
		await runTurn(d, ask);
		const content = (p.requests[1]!.messages.at(-1) as { content: string }).content;
		expect(content.length).toBeLessThanOrEqual(500);
		expect(content).toMatch(/\[cut: the result was \d+ characters/);
	});

	it('emits a proposal event for a tool result that carries one', async () => {
		const proposal: AssistantProposal = { goal: 'recalibration', title: 'Recalibration: GR4J X4', changes: [{ label: 'GR4J X4', lines: ['GR4J X4: 1.7 → 2'], reason: 'why' }], apply: { kind: 'settings', patch: { gr4j: { x4: 2 } } } };
		const p = scripted((hop) => (hop === 0 ? [call('propose_settings'), usage()] : [{ type: 'text', delta: 'see below' }, usage()]));
		const { d, events } = deps(p, [tool('propose_settings', () => ({ ok: true, data: { accepted: true }, proposal }))]);
		await runTurn(d, ask);
		expect(events).toContainEqual({ type: 'proposal', proposal });
		// The proposal event comes before the tool's done.
		const i = events.findIndex((e) => e.type === 'proposal');
		expect(events[i + 1]).toMatchObject({ type: 'tool', status: 'done' });
	});

	it('sends only the newest conversation that fits maxInputChars, starting with a user message', async () => {
		const p = scripted(() => [usage()]);
		const { d } = deps(p, [], { cfg: cfg({ maxInputChars: 25 }) });
		await runTurn(d, [
			{ role: 'user', content: 'a'.repeat(20) },
			{ role: 'assistant', content: 'b'.repeat(10) },
			{ role: 'user', content: 'c'.repeat(10) }
		]);
		expect(p.requests[0]!.messages).toEqual([{ role: 'user', content: 'c'.repeat(10) }]);
	});

	it('ends with assistant_output_limit when a provider streams far past its output cap', async () => {
		const p = scripted(() => [{ type: 'text', delta: 'x'.repeat(200) }, { type: 'text', delta: 'never read' }, usage()]);
		const { d, events } = deps(p, [], { cfg: cfg({ maxOutputTokens: 10 }) });
		const out = await runTurn(d, ask);
		expect(out.end).toBe('assistant_output_limit');
		expect(out.outputTokens).toBeGreaterThan(0);
		expect(events.filter((e) => e.type === 'text')).toHaveLength(1);
	});

	it('ends with assistant_provider_error in fixed words when the provider throws, and still counts the tokens', async () => {
		const p: AssistantProvider = {
			name: 'mock',
			// eslint-disable-next-line require-yield
			async *complete() {
				throw new Error('upstream said: api key sk-live-123 is invalid');
			}
		};
		const { d, events } = deps(p);
		const out = await runTurn(d, ask);
		expect(out.end).toBe('assistant_provider_error');
		expect(out.inputTokens).toBeGreaterThan(0);
		expect(events).toEqual([{ type: 'error', code: 'assistant_provider_error', error: TURN_ERRORS.assistant_provider_error }]);
	});

	it('ends with assistant_timeout past turnSeconds, aborting the provider’s signal', async () => {
		let signal: AbortSignal | undefined;
		const p: AssistantProvider = {
			name: 'mock',
			// eslint-disable-next-line require-yield
			async *complete(req) {
				signal = req.signal;
				await new Promise((_, reject) => req.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
			}
		};
		const { d, events } = deps(p, [], { cfg: cfg({ turnSeconds: 0.05 }) });
		const out = await runTurn(d, ask);
		expect(signal?.aborted).toBe(true);
		expect(out.end).toBe('assistant_timeout');
		expect(events.at(-1)).toMatchObject({ type: 'error', code: 'assistant_timeout' });
	});

	it('passes the turn’s signal to the tool, and a tool that hangs past turnSeconds ends the turn as a timeout, not a tool failure', async () => {
		let toolSignal: AbortSignal | undefined;
		const p = scripted((hop) => (hop === 0 ? [call('t'), usage(30, 4)] : [{ type: 'text', delta: 'never' }, usage()]));
		// The tool ignores its signal: the turn must still stop waiting for it.
		const { d, events } = deps(p, [tool('t', () => new Promise<ToolResult>(() => {}))], {
			cfg: cfg({ turnSeconds: 0.05 }),
			runTool: (t, args, signal) => {
				toolSignal = signal;
				return t.run({ db: null as never, userId: 'u', projectId: 'p', runId: null }, args);
			}
		});
		const out = await runTurn(d, ask);
		expect(toolSignal?.aborted).toBe(true);
		expect(out).toEqual({ inputTokens: 30, outputTokens: 4, end: 'assistant_timeout' });
		expect(p.requests).toHaveLength(1);
		expect(events.at(-1)).toEqual({ type: 'error', code: 'assistant_timeout', error: TURN_ERRORS.assistant_timeout });
		expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
	});

	it('stops quietly when the client goes away during a tool that rejects on the signal, tokens still reported', async () => {
		const gone = new AbortController();
		const p = scripted((hop) => (hop === 0 ? [call('t'), usage(9, 3)] : [usage()]));
		const { d, events } = deps(p, [tool('t', () => ({ ok: true, data: 1 }))], {
			signal: gone.signal,
			runTool: (_t, _args, signal) =>
				new Promise<ToolResult>((_, reject) => {
					signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
					gone.abort();
				})
		});
		expect(await runTurn(d, ask)).toEqual({ inputTokens: 9, outputTokens: 3, end: 'aborted' });
		expect(events.some((e) => e.type === 'error')).toBe(false);
		expect(p.requests).toHaveLength(1);
	});

	it('stops quietly when the client goes away: no error event, the tokens still reported', async () => {
		const gone = new AbortController();
		const p = scripted((hop) => {
			if (hop === 0) gone.abort();
			return [call('t'), usage(7, 2)];
		});
		const { d, events } = deps(p, [tool('t', () => ({ ok: true, data: 1 }))], { signal: gone.signal });
		expect(await runTurn(d, ask)).toEqual({ inputTokens: 7, outputTokens: 2, end: 'aborted' });
		expect(events.some((e) => e.type === 'error')).toBe(false);
		expect(p.requests).toHaveLength(1);
	});

	it('counts a call the provider never reported usage for at its most: the input estimate, and the output bytes up to the cap', async () => {
		const p = scripted(() => [{ type: 'text', delta: 'x'.repeat(40) }]);
		const { d } = deps(p);
		const out = await runTurn(d, [{ role: 'user', content: 'y'.repeat(94) }]);
		// HOP_FRAMING_TOKENS + 6 system bytes + 2 ("[]", no tools) + MESSAGE_FRAMING_TOKENS + 94 message bytes in; 40 bytes out.
		expect(out).toEqual({ inputTokens: HOP_FRAMING_TOKENS + 6 + 2 + MESSAGE_FRAMING_TOKENS + 94, outputTokens: 40, end: 'answered' });
	});

	it('estimates input by UTF-8 bytes, so text of many bytes a character is never undercounted', () => {
		expect(messageTokens({ role: 'user', content: 'é' })).toBe(MESSAGE_FRAMING_TOKENS + 2);
		expect(messageTokens({ role: 'user', content: '💧' })).toBe(MESSAGE_FRAMING_TOKENS + 4);
		const calls = [{ id: 'c1', name: 't', arguments: { a: 1 } }];
		expect(messageTokens({ role: 'assistant', content: 'ab', toolCalls: calls })).toBe(MESSAGE_FRAMING_TOKENS + 2 + JSON.stringify(calls).length);
		expect(messageTokens({ role: 'tool', toolCallId: 'c1', name: 't', content: 'xyz' })).toBe(MESSAGE_FRAMING_TOKENS + 3 + 2 + 1);
	});
});

describe('capConversation', () => {
	it('refuses (null) a newest message that alone passes the cap, and an empty conversation', () => {
		expect(capConversation([{ role: 'user', content: 'x'.repeat(11) }], 10)).toBeNull();
		expect(capConversation([], 10)).toBeNull();
	});

	it('keeps everything that fits, and drops a leading assistant message', () => {
		const m = [
			{ role: 'user' as const, content: 'aaaa' },
			{ role: 'assistant' as const, content: 'bbbb' },
			{ role: 'user' as const, content: 'cccc' }
		];
		expect(capConversation(m, 12)).toEqual(m);
		expect(capConversation(m, 8)).toEqual([m[2]]);
	});
});

describe('capToolResult and parseArguments', () => {
	it('leaves a short result alone', () => {
		expect(capToolResult('abc', 10)).toBe('abc');
	});

	it('takes empty arguments as {}', () => {
		expect(parseArguments('')).toEqual({ ok: true, args: {} });
		expect(parseArguments(undefined)).toEqual({ ok: true, args: {} });
		expect(parseArguments({ a: 1 })).toEqual({ ok: true, args: { a: 1 } });
	});
});
