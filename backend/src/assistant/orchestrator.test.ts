// One assistant turn (orchestrator.ts) against scripted providers and fake
// tools: the hop cap, a malformed and an unknown tool call, the tool result
// cap, the conversation cap, the proposal event, the output cap, the turn
// deadline, a provider failure, and the client going away.
import { describe, expect, it } from 'vitest';
import { assistantConfig, type AssistantConfig } from './config.js';
import { capConversation, capToolResult, parseArguments, runTurn, TURN_ERRORS, type TurnDeps } from './orchestrator.js';
import type { AssistantProvider, AssistantStreamEvent, AssistantTool, ProviderEvent, ProviderRequest, SettingsProposal, ToolResult } from './types.js';

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
		const proposal: SettingsProposal = { patch: { gr4j: { x4: 2 } }, reasons: { gr4j: 'why' }, summary: 'lengthen X4', diff: [{ label: 'GR4J X4', before: '1.7', after: '2' }] };
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

	it('estimates the tokens of a call the provider never reported usage for', async () => {
		const p = scripted(() => [{ type: 'text', delta: 'x'.repeat(40) }]);
		const { d } = deps(p);
		const out = await runTurn(d, [{ role: 'user', content: 'y'.repeat(94) }]);
		// (6 system + 94 message) / 4 = 25 in; 40 / 4 = 10 out.
		expect(out).toEqual({ inputTokens: 25, outputTokens: 10, end: 'answered' });
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
