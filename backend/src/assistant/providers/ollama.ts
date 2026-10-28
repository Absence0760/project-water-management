// The Ollama provider (issue #610): a local model through Ollama's
// OpenAI-compatible chat completions (`${OLLAMA_URL}/v1/chat/completions`),
// streamed, with tools. For local use, so no key: plain HTTP is allowed only
// to this machine (localhost, 127.0.0.0/8, ::1), and anything else must be
// HTTPS. The model needs tool calling (qwen2.5-coder:7b has it,
// deepseek-coder doesn't) and a context raised past Ollama's 4096-token
// default, which silently cuts the system prompt (docs/run-locally.md §
// Assistant).
import type { AssistantConfig } from '../config.js';
import type { AssistantProvider, ProviderEvent, ProviderRequest, ToolCall, TurnMessage } from '../types.js';

export const OLLAMA_DEFAULT_MODEL = 'qwen2.5-coder:7b';
/** One model call, start to last chunk. A 7B model on a laptop GPU reading a long system prompt takes a while. */
export const OLLAMA_TIMEOUT_MS = 300_000;

/** The chat completions URL for a base URL, or why it can't be used. */
export function ollamaEndpoint(base: string): URL {
	let url: URL;
	try {
		url = new URL(base);
	} catch {
		throw new Error('OLLAMA_URL is not a URL.');
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('OLLAMA_URL must be an http or https URL.');
	if (url.username || url.password) throw new Error('OLLAMA_URL must not carry credentials.');
	if (url.protocol === 'http:' && !isLoopback(url.hostname)) throw new Error('OLLAMA_URL may use plain http only to this machine (localhost); use https for any other host.');
	return new URL(`${url.pathname.replace(/\/+$/, '')}/v1/chat/completions`, url);
}

/** localhost, 127.0.0.0/8 or ::1: the hosts plain HTTP stays on this machine for. */
export function isLoopback(hostname: string): boolean {
	const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
	const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
	return !!m && m.slice(1).every((x) => Number(x) <= 255);
}

type OaMessage =
	| { role: 'system' | 'user'; content: string }
	| { role: 'assistant'; content: string; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
	| { role: 'tool'; tool_call_id: string; content: string };

/** The orchestrator's turn as OpenAI chat messages. A call's arguments go back as the JSON text the model wrote. */
export function toOpenAiMessages(system: string, messages: TurnMessage[]): OaMessage[] {
	const out: OaMessage[] = [{ role: 'system', content: system }];
	for (const m of messages) {
		if (m.role === 'user') out.push({ role: 'user', content: m.content });
		else if (m.role === 'tool') out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
		else {
			const calls = (m.toolCalls ?? []).map((c) => ({
				id: c.id,
				type: 'function' as const,
				function: { name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}) }
			}));
			out.push(calls.length ? { role: 'assistant', content: m.content, tool_calls: calls } : { role: 'assistant', content: m.content });
		}
	}
	return out;
}

/** A call's arguments: parsed JSON, `{}` for none, the text itself when it isn't JSON (the tool refuses it). */
export function parseArguments(raw: unknown): unknown {
	if (typeof raw !== 'string') return raw ?? {};
	if (!raw.trim()) return {};
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

interface Chunk {
	choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: unknown } }[] } }[];
	usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
	error?: unknown;
}

/** Roughly four characters a token: Ollama's OpenAI endpoint reports usage, this is for a server that doesn't. */
const estimateTokens = (chars: number) => Math.ceil(chars / 4);

export function ollamaProvider(cfg?: Pick<AssistantConfig, 'ollamaUrl' | 'model'>, opts: { timeoutMs?: number; fetch?: typeof fetch } = {}): AssistantProvider {
	const base = cfg?.ollamaUrl || 'http://localhost:11434';
	const model = cfg?.model || OLLAMA_DEFAULT_MODEL;
	const doFetch = opts.fetch ?? fetch;
	const timeoutMs = opts.timeoutMs ?? OLLAMA_TIMEOUT_MS;
	return {
		name: 'ollama',
		async *complete(req: ProviderRequest): AsyncIterable<ProviderEvent> {
			const endpoint = ollamaEndpoint(base);
			const signal = req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
			const messages = toOpenAiMessages(req.system, req.messages);
			let res: Response;
			try {
				res = await doFetch(endpoint, {
					method: 'POST',
					headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
					body: JSON.stringify({
						model,
						messages,
						tools: req.tools.length ? req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) : undefined,
						max_tokens: req.maxOutputTokens,
						stream: true,
						stream_options: { include_usage: true }
					}),
					signal
				});
			} catch (err) {
				if (signal.aborted) throw abortReason(req.signal, timeoutMs);
				throw new Error(`Ollama is not reachable at ${endpoint.origin} (is it running? ollama serve)`, { cause: err });
			}
			if (!res.ok || !res.body) {
				await res.body?.cancel().catch(() => {});
				if (res.status === 404) throw new Error(`Ollama has no model "${model}" (ollama pull ${model}, or set ASSISTANT_MODEL).`);
				throw new Error(`Ollama answered ${res.status}.`);
			}

			const calls = new Map<number, { id: string; name: string; args: string; raw?: unknown }>();
			let usage: { input: number; output: number } | null = null;
			let outChars = 0;
			const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
			let buf = '';
			let done = false;
			try {
				while (!done) {
					const r = await reader.read();
					if (r.done) break;
					buf += r.value;
					let nl: number;
					while ((nl = buf.indexOf('\n')) !== -1) {
						const line = buf.slice(0, nl).trim();
						buf = buf.slice(nl + 1);
						if (!line.startsWith('data:')) continue;
						const data = line.slice(5).trim();
						if (data === '[DONE]') {
							done = true;
							break;
						}
						let chunk: Chunk;
						try {
							chunk = JSON.parse(data) as Chunk;
						} catch {
							continue; // not a JSON event: skip it, as an SSE reader skips what it doesn't know
						}
						if (chunk.error) throw new Error('Ollama reported an error while answering.');
						if (chunk.usage) usage = { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 };
						const delta = chunk.choices?.[0]?.delta;
						if (delta?.content) {
							outChars += delta.content.length;
							yield { type: 'text', delta: delta.content };
						}
						for (const [n, tc] of (delta?.tool_calls ?? []).entries()) {
							const i = tc.index ?? n;
							const c = calls.get(i) ?? { id: '', name: '', args: '' };
							if (tc.id) c.id = tc.id;
							if (tc.function?.name) c.name += tc.function.name;
							const a = tc.function?.arguments;
							if (typeof a === 'string') c.args += a;
							else if (a !== undefined && a !== null) c.raw = a; // Ollama has been seen to send the arguments as an object
							calls.set(i, c);
						}
					}
				}
			} catch (err) {
				if (signal.aborted) throw abortReason(req.signal, timeoutMs);
				throw err;
			} finally {
				reader.cancel().catch(() => {});
			}

			for (const [i, c] of [...calls.entries()].sort(([a], [b]) => a - b)) {
				if (!c.name) continue;
				outChars += c.args.length;
				const call: ToolCall = { id: c.id || `call_${i}`, name: c.name, arguments: c.raw !== undefined ? c.raw : parseArguments(c.args) };
				yield { type: 'tool_call', call };
			}
			const inChars = messages.reduce((n, m) => n + m.content.length, 0);
			yield { type: 'usage', inputTokens: usage?.input ?? estimateTokens(inChars), outputTokens: usage?.output ?? estimateTokens(outChars) };
		}
	};
}

/** The caller's abort as it gave it, else the timeout's. */
function abortReason(caller: AbortSignal | undefined, timeoutMs: number): unknown {
	if (caller?.aborted) return caller.reason;
	return new Error(`Ollama took longer than ${Math.max(1, Math.round(timeoutMs / 1000))} s to answer.`);
}
