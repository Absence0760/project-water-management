// The Anthropic provider against a stubbed Messages API on localhost (issue
// #610): the real SDK, a fake key, no network.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderEvent, ProviderRequest } from '../types.js';
import { anthropicProvider, anthropicRequest, toAnthropicMessages } from './anthropic.js';

const KEY = 'sk-ant-test-not-a-real-key-0000';
let server: Server | null = null;
afterEach(async () => {
	server?.closeAllConnections();
	await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
	server = null;
});

interface Seen {
	url: string;
	headers: IncomingMessage['headers'];
	body: Record<string, unknown>;
}

async function stub(handler: (res: ServerResponse) => void, seen: Seen[] = []): Promise<string> {
	server = createServer((req, res) => {
		let raw = '';
		req.on('data', (c) => (raw += c));
		req.on('end', () => {
			seen.push({ url: req.url ?? '', headers: req.headers, body: JSON.parse(raw || '{}') });
			handler(res);
		});
	});
	await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
	return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

/** The Messages API's stream: one `event:` + `data:` pair per event. */
const sse = (events: Record<string, unknown>[], end = true) => (res: ServerResponse) => {
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	for (const e of events) res.write(`event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`);
	if (end) res.end();
};

const start = (input = 100) => ({
	type: 'message_start',
	message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: input, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
});
const text = (index: number, t: string) => [
	{ type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
	{ type: 'content_block_delta', index, delta: { type: 'text_delta', text: t } },
	{ type: 'content_block_stop', index }
];
const toolUse = (index: number, id: string, name: string, parts: string[]) => [
	{ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } },
	...parts.map((p) => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: p } })),
	{ type: 'content_block_stop', index }
];
const delta = (stop: string, output: number, extra: Record<string, unknown> = {}) => ({
	type: 'message_delta',
	delta: { stop_reason: stop, stop_sequence: null },
	usage: { output_tokens: output, input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null, ...extra }
});
const stop = { type: 'message_stop' };

const req = (over: Partial<ProviderRequest> = {}): ProviderRequest => ({
	system: 'You help with a catchment model.',
	messages: [{ role: 'user', content: 'Why no response at gauge X?' }],
	tools: [{ name: 'get_series', description: 'A series', parameters: { type: 'object', properties: { node: { type: 'string' } } } }],
	maxOutputTokens: 512,
	...over
});

async function collect(it: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
	const out: ProviderEvent[] = [];
	for await (const e of it) out.push(e);
	return out;
}

describe('anthropic provider', () => {
	it('streams text and reports the usage, with cached input counted', async () => {
		const seen: Seen[] = [];
		const url = await stub(sse([start(80), ...text(0, 'The gauge '), { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'sits below a dam.' } }, delta('end_turn', 12, { cache_read_input_tokens: 40, input_tokens: 80 }), stop]), seen);
		const events = await collect(anthropicProvider({ model: '' }, { baseURL: url, apiKey: KEY }).complete(req()));
		expect(events).toEqual([
			{ type: 'text', delta: 'The gauge ' },
			{ type: 'text', delta: 'sits below a dam.' },
			{ type: 'usage', inputTokens: 120, outputTokens: 12 }
		]);
		expect(seen[0]!.url).toContain('/v1/messages');
		expect(seen[0]!.headers['x-api-key']).toBe(KEY);
		// Claude Sonnet 5.5 by default, with server-side refusal fallbacks.
		expect(seen[0]!.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
		expect(seen[0]!.body).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 512, stream: true, fallbacks: 'default', output_config: { effort: 'low' }, cache_control: { type: 'ephemeral' } });
		expect(seen[0]!.body.tools).toEqual([{ name: 'get_series', description: 'A series', input_schema: { type: 'object', properties: { node: { type: 'string' } } }, eager_input_streaming: true }]);
	});

	it('assembles tool calls from input deltas, after the text; JSON that doesn’t parse goes to the tool as text', async () => {
		const url = await stub(
			sse([start(), ...text(0, 'Let me look.'), ...toolUse(1, 'toolu_1', 'get_series', ['{"no', 'de": "Gau', 'ge X"}']), ...toolUse(2, 'toolu_2', 'get_run_summary', []), ...toolUse(3, 'toolu_3', 'get_network', ['{"a": ']), delta('tool_use', 30), stop])
		);
		const events = await collect(anthropicProvider({ model: 'claude-opus-5-5' }, { baseURL: url, apiKey: KEY }).complete(req()));
		expect(events).toEqual([
			{ type: 'text', delta: 'Let me look.' },
			{ type: 'tool_call', call: { id: 'toolu_1', name: 'get_series', arguments: { node: 'Gauge X' } } },
			{ type: 'tool_call', call: { id: 'toolu_2', name: 'get_run_summary', arguments: {} } },
			{ type: 'tool_call', call: { id: 'toolu_3', name: 'get_network', arguments: '{"a": ' } },
			{ type: 'usage', inputTokens: 100, outputTokens: 30 }
		]);
	});

	it('drops the tool calls a declined model made before a fallback took over, and bills every attempt', async () => {
		const url = await stub(
			sse([
				start(),
				...text(0, 'Looking'),
				...toolUse(1, 'toolu_declined', 'get_series', ['{}']),
				{ type: 'content_block_start', index: 2, content_block: { type: 'fallback', from: { model: 'claude-sonnet-5-5' }, to: { model: 'claude-opus-4-8' } } },
				{ type: 'content_block_stop', index: 2 },
				...toolUse(3, 'toolu_kept', 'get_run_summary', ['{}']),
				delta('tool_use', 9, { iterations: [{ type: 'message', input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, { type: 'fallback_message', input_tokens: 110, output_tokens: 9, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }] }),
				stop
			])
		);
		const events = await collect(anthropicProvider({ model: '' }, { baseURL: url, apiKey: KEY }).complete(req()));
		expect(events.filter((e) => e.type === 'tool_call')).toEqual([{ type: 'tool_call', call: { id: 'toolu_kept', name: 'get_run_summary', arguments: {} } }]);
		expect(events.at(-1)).toEqual({ type: 'usage', inputTokens: 210, outputTokens: 14 });
	});

	it('on a refusal runs no tool and says so', async () => {
		const url = await stub(sse([start(), ...text(0, 'Part'), ...toolUse(1, 'toolu_1', 'get_series', ['{"node": "X"}']), delta('refusal', 4), stop]));
		const events = await collect(anthropicProvider({ model: '' }, { baseURL: url, apiKey: KEY }).complete(req()));
		expect(events.some((e) => e.type === 'tool_call')).toBe(false);
		expect(events).toContainEqual({ type: 'text', delta: '\n\n(The model declined to continue this answer.)' });
		expect(events.at(-1)?.type).toBe('usage');
	});

	it('throws on an upstream error by its status alone: neither the key nor the upstream’s text', async () => {
		const url = await stub((res) => {
			res.writeHead(401, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${KEY} secret detail` } }));
		});
		const err = (await collect(anthropicProvider({ model: '' }, { baseURL: url, apiKey: KEY }).complete(req())).catch((e: unknown) => e)) as Error;
		expect(err.message).toBe('The Anthropic API refused the key (check ANTHROPIC_API_KEY).');
		expect(JSON.stringify({ m: err.message, s: err.stack, c: String(err.cause ?? '') })).not.toContain(KEY);
		expect(err.message).not.toContain('secret');
	});

	it('throws on an error event inside the stream', async () => {
		const url = await stub(sse([start(), ...text(0, 'a'), { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded secret' } }]));
		const err = (await collect(anthropicProvider({ model: '' }, { baseURL: url, apiKey: KEY }).complete(req())).catch((e: unknown) => e)) as Error;
		expect(err).toBeInstanceOf(Error);
		expect(err.message).not.toContain('secret');
	});

	it('refuses without a key, before any request', async () => {
		const seen: Seen[] = [];
		const url = await stub(sse([]), seen);
		const before = process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		try {
			await expect(collect(anthropicProvider({ model: '' }, { baseURL: url }).complete(req()))).rejects.toThrow('ANTHROPIC_API_KEY is not set.');
		} finally {
			if (before !== undefined) process.env.ANTHROPIC_API_KEY = before;
		}
		expect(seen).toEqual([]);
	});

	it('stops when the caller aborts, with the caller’s reason', async () => {
		const url = await stub(sse([start(), { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }], false));
		const ac = new AbortController();
		const seen: ProviderEvent[] = [];
		const run = (async () => {
			for await (const e of anthropicProvider({ model: '' }, { baseURL: url, apiKey: KEY }).complete(req({ signal: ac.signal }))) {
				seen.push(e);
				ac.abort(new Error('the reader left'));
			}
		})();
		await expect(run).rejects.toThrow('the reader left');
		expect(seen).toEqual([{ type: 'text', delta: 'partial' }]);
	});

	it('sends the turn as Messages API messages: parallel results in one user message, empty text left out', () => {
		expect(
			toAnthropicMessages([
				{ role: 'user', content: 'q' },
				{ role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'a', arguments: { x: 1 } }, { id: 't2', name: 'b', arguments: 'not json' }] },
				{ role: 'tool', toolCallId: 't1', name: 'a', content: 'r1' },
				{ role: 'tool', toolCallId: 't2', name: 'b', content: 'r2' },
				{ role: 'assistant', content: 'Done.' }
			])
		).toEqual([
			{ role: 'user', content: 'q' },
			{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'a', input: { x: 1 } }, { type: 'tool_use', id: 't2', name: 'b', input: {} }] },
			{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r1' }, { type: 'tool_result', tool_use_id: 't2', content: 'r2' }] },
			{ role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }
		]);
	});

	it('leaves out fallbacks and effort on models that don’t take them', () => {
		const body = anthropicRequest('claude-haiku-4-5', req({ tools: [] })) as unknown as Record<string, unknown>;
		expect(body.fallbacks).toBeUndefined();
		expect(body.betas).toBeUndefined();
		expect(body.output_config).toBeUndefined();
		expect(body.tools).toBeUndefined();
	});
});
