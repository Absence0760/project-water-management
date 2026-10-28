// The Ollama provider against a stubbed OpenAI-compatible server on
// localhost (issue #610): no Ollama, no network.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderEvent, ProviderRequest } from '../types.js';
import { isLoopback, ollamaEndpoint, ollamaProvider, toOpenAiMessages } from './ollama.js';

let server: Server | null = null;
afterEach(async () => {
	await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
	server = null;
});

/** A server answering every request with `handler`; resolves to its base URL. Each request body is pushed to `bodies`. */
async function stub(handler: (req: IncomingMessage, res: ServerResponse) => void, bodies: unknown[] = []): Promise<string> {
	server = createServer((req, res) => {
		let raw = '';
		req.on('data', (c) => (raw += c));
		req.on('end', () => {
			bodies.push(JSON.parse(raw || 'null'));
			handler(req, res);
		});
	});
	await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
	return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

/** Writes the chunks as SSE `data:` lines, then [DONE]. */
const sse = (chunks: unknown[], done = true) => (_req: IncomingMessage, res: ServerResponse) => {
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
	if (done) res.write('data: [DONE]\n\n');
	res.end();
};

const req = (over: Partial<ProviderRequest> = {}): ProviderRequest => ({
	system: 'You help with a catchment model.',
	messages: [{ role: 'user', content: 'Why no response at gauge X?' }],
	tools: [{ name: 'get_run_summary', description: 'The run summary', parameters: { type: 'object', properties: {} } }],
	maxOutputTokens: 256,
	...over
});

async function collect(it: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
	const out: ProviderEvent[] = [];
	for await (const e of it) out.push(e);
	return out;
}

describe('ollama provider', () => {
	it('streams text and ends with the usage from the final chunk', async () => {
		const bodies: unknown[] = [];
		const url = await stub(
			sse([
				{ choices: [{ delta: { content: 'The gauge ' } }] },
				{ choices: [{ delta: { content: 'sits below a dam.' } }] },
				{ choices: [], usage: { prompt_tokens: 120, completion_tokens: 9 } }
			]),
			bodies
		);
		const events = await collect(ollamaProvider({ ollamaUrl: url, model: '' }).complete(req()));
		expect(events).toEqual([
			{ type: 'text', delta: 'The gauge ' },
			{ type: 'text', delta: 'sits below a dam.' },
			{ type: 'usage', inputTokens: 120, outputTokens: 9 }
		]);
		const body = bodies[0] as Record<string, unknown>;
		expect(body).toMatchObject({ model: 'qwen2.5-coder:7b', stream: true, stream_options: { include_usage: true }, max_tokens: 256 });
		expect(body.tools).toEqual([{ type: 'function', function: { name: 'get_run_summary', description: 'The run summary', parameters: { type: 'object', properties: {} } } }]);
		expect((body.messages as { role: string }[]).map((m) => m.role)).toEqual(['system', 'user']);
	});

	it('assembles tool calls from deltas spread over chunks, in index order, after the text', async () => {
		const url = await stub(
			sse([
				{ choices: [{ delta: { content: 'Let me look.' } }] },
				{ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'get_series', arguments: '{"node":' } }] } }] },
				{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'get_run_summary', arguments: '' } }] } }] },
				{ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"Gauge X"}' } }] } }] },
				{ choices: [{ delta: { tool_calls: [{ index: 2, function: { name: 'get_network', arguments: '{not json' } }] } }] },
				{ choices: [], usage: { prompt_tokens: 50, completion_tokens: 20 } }
			])
		);
		const events = await collect(ollamaProvider({ ollamaUrl: url, model: 'qwen2.5-coder-32k' }).complete(req()));
		expect(events).toEqual([
			{ type: 'text', delta: 'Let me look.' },
			{ type: 'tool_call', call: { id: 'call_a', name: 'get_run_summary', arguments: {} } },
			{ type: 'tool_call', call: { id: 'call_b', name: 'get_series', arguments: { node: 'Gauge X' } } },
			// No id from the server: one is made up; JSON that doesn't parse goes to the tool as text, for it to refuse.
			{ type: 'tool_call', call: { id: 'call_2', name: 'get_network', arguments: '{not json' } },
			{ type: 'usage', inputTokens: 50, outputTokens: 20 }
		]);
	});

	it('sends the turn back as OpenAI messages: tool calls with their JSON text, results by call id', () => {
		const out = toOpenAiMessages('sys', [
			{ role: 'user', content: 'q' },
			{ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_settings', arguments: { a: 1 } }] },
			{ role: 'tool', toolCallId: 'c1', name: 'get_settings', content: '{"ok":true}' },
			{ role: 'assistant', content: 'Done.' }
		]);
		expect(out).toEqual([
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'q' },
			{ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_settings', arguments: '{"a":1}' } }] },
			{ role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
			{ role: 'assistant', content: 'Done.' }
		]);
	});

	it('estimates usage when the server reports none, so the budget still counts the turn', async () => {
		const url = await stub(sse([{ choices: [{ delta: { content: 'abcdefgh' } }] }]));
		const events = await collect(ollamaProvider({ ollamaUrl: url, model: '' }).complete(req({ system: 'x'.repeat(40), messages: [{ role: 'user', content: 'y'.repeat(40) }] })));
		expect(events.at(-1)).toEqual({ type: 'usage', inputTokens: 20, outputTokens: 2 });
	});

	it('throws on an upstream error without its body, and names a missing model', async () => {
		const url = await stub((_q, res) => {
			res.writeHead(500, { 'content-type': 'application/json' });
			res.end('{"error":"secret upstream detail"}');
		});
		const err = await collect(ollamaProvider({ ollamaUrl: url, model: '' }).complete(req())).catch((e: Error) => e);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toBe('Ollama answered 500.');
		expect((err as Error).message).not.toContain('secret');

		await new Promise<void>((r) => server!.close(() => r()));
		const url404 = await stub((_q, res) => {
			res.writeHead(404);
			res.end('{"error":"model not found"}');
		});
		await expect(collect(ollamaProvider({ ollamaUrl: url404, model: 'nope:1b' }).complete(req()))).rejects.toThrow('Ollama has no model "nope:1b"');
	});

	it('throws on an error event inside the stream', async () => {
		const url = await stub(sse([{ choices: [{ delta: { content: 'a' } }] }, { error: { message: 'out of memory: secret' } }]));
		await expect(collect(ollamaProvider({ ollamaUrl: url, model: '' }).complete(req()))).rejects.toThrow('Ollama reported an error while answering.');
	});

	it('stops when the caller aborts, with the caller’s reason', async () => {
		const url = await stub((_q, res) => {
			res.writeHead(200, { 'content-type': 'text/event-stream' });
			res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`);
			// …and never finishes.
		});
		const ac = new AbortController();
		const seen: ProviderEvent[] = [];
		const run = (async () => {
			for await (const e of ollamaProvider({ ollamaUrl: url, model: '' }).complete(req({ signal: ac.signal }))) {
				seen.push(e);
				ac.abort(new Error('the reader left'));
			}
		})();
		await expect(run).rejects.toThrow('the reader left');
		expect(seen).toEqual([{ type: 'text', delta: 'partial' }]);
		server!.closeAllConnections();
	});

	it('times out a server that never answers', async () => {
		const url = await stub(() => {
			/* never answers */
		});
		await expect(collect(ollamaProvider({ ollamaUrl: url, model: '' }, { timeoutMs: 200 }).complete(req()))).rejects.toThrow('Ollama took longer than 1 s to answer.');
		server!.closeAllConnections();
	});

	it('refuses plain http to anything but this machine, and credentials in the URL', () => {
		expect(ollamaEndpoint('http://localhost:11434').href).toBe('http://localhost:11434/v1/chat/completions');
		expect(ollamaEndpoint('http://127.0.0.1:11434/').href).toBe('http://127.0.0.1:11434/v1/chat/completions');
		expect(ollamaEndpoint('http://[::1]:11434/ollama').href).toBe('http://[::1]:11434/ollama/v1/chat/completions');
		expect(ollamaEndpoint('https://ollama.example.org').href).toBe('https://ollama.example.org/v1/chat/completions');
		expect(() => ollamaEndpoint('http://ollama.example.org:11434')).toThrow('plain http only to this machine');
		expect(() => ollamaEndpoint('http://10.0.0.5:11434')).toThrow('plain http only to this machine');
		expect(() => ollamaEndpoint('http://127.0.0.1.nip.io')).toThrow('plain http only to this machine');
		expect(() => ollamaEndpoint('http://user:pw@localhost:11434')).toThrow('must not carry credentials');
		expect(() => ollamaEndpoint('file:///etc/passwd')).toThrow('http or https');
		expect(() => ollamaEndpoint('not a url')).toThrow('not a URL');
		expect(isLoopback('127.255.0.1')).toBe(true);
		expect(isLoopback('127.256.0.1')).toBe(false);
	});

	it('refuses a non-loopback http URL before sending anything', async () => {
		let called = false;
		const fake = (async () => {
			called = true;
			return new Response('');
		}) as typeof fetch;
		await expect(collect(ollamaProvider({ ollamaUrl: 'http://192.168.1.10:11434', model: '' }, { fetch: fake }).complete(req()))).rejects.toThrow('plain http only');
		expect(called).toBe(false);
	});
});
