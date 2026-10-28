// The Anthropic provider (issue #610): the Claude Messages API through the
// official SDK (@anthropic-ai/sdk), streamed, with the assistant's tools.
// The SDK is imported when a call is made, never at load, so a process with
// another provider doesn't load it. The key comes from ANTHROPIC_API_KEY
// (production loads it as a runtime secret, config/runtimeSecrets.ts) and is
// never logged or put in an error: an upstream error is reported by its
// HTTP status alone.
//
// The raw event stream is read rather than the SDK's MessageStream helper,
// because the tools stream their input eagerly (eager_input_streaming) and
// the helper throws on input that isn't JSON; here unparseable input is
// passed to the tool as text, which refuses it (types.ts ToolCall).
import type Anthropic from '@anthropic-ai/sdk';
import type { AssistantConfig } from '../config.js';
import type { AssistantProvider, ProviderEvent, ProviderRequest, ToolCall, TurnMessage } from '../types.js';
import { parseArguments } from './ollama.js';

/** Claude Sonnet 5.5: the current Sonnet, for chat with tool use over a project's data. */
export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5-5';
/** One model call, start to last event; a retry starts it again. */
export const ANTHROPIC_TIMEOUT_MS = 120_000;
/**
 * Models that take server-side refusal fallbacks in the `"default"` form
 * (beta server-side-fallback-2026-07-01): a request a safety classifier
 * declines is re-run on the model the API picks, in the same stream.
 */
const FALLBACK_MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** Models that take no `effort` (it errors): older than the 4.6 generation, and Haiku 4.5. */
const NO_EFFORT = /claude-(3|haiku-4|sonnet-4-5|opus-4-[01])/;

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlock = Anthropic.Beta.BetaContentBlockParam;

/**
 * The orchestrator's turn as Messages API messages: a tool result is a
 * `tool_result` block in a user message, and results that follow one
 * another share one message (so the model keeps making parallel calls).
 */
export function toAnthropicMessages(messages: TurnMessage[]): MessageParam[] {
	const out: MessageParam[] = [];
	for (const m of messages) {
		if (m.role === 'user') {
			if (m.content) out.push({ role: 'user', content: m.content });
		} else if (m.role === 'tool') {
			const block: ContentBlock = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
			const last = out[out.length - 1];
			if (last?.role === 'user' && Array.isArray(last.content) && last.content.every((b) => b.type === 'tool_result')) last.content.push(block);
			else out.push({ role: 'user', content: [block] });
		} else {
			const content: ContentBlock[] = [];
			if (m.content) content.push({ type: 'text', text: m.content });
			for (const c of m.toolCalls ?? []) {
				const input = typeof c.arguments === 'object' && c.arguments !== null && !Array.isArray(c.arguments) ? (c.arguments as Record<string, unknown>) : {};
				content.push({ type: 'tool_use', id: c.id, name: c.name, input });
			}
			if (content.length) out.push({ role: 'assistant', content });
		}
	}
	return out;
}

/** The request body for one hop (exported for the tests). */
export function anthropicRequest(model: string, req: ProviderRequest): Anthropic.Beta.MessageCreateParamsStreaming {
	const fallback = FALLBACK_MODELS.has(model);
	return {
		model,
		max_tokens: req.maxOutputTokens,
		system: req.system,
		messages: toAnthropicMessages(req.messages),
		...(req.tools.length
			? {
					tools: req.tools.map((t) => ({
						name: t.name,
						description: t.description,
						input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema,
						eager_input_streaming: true
					}))
				}
			: {}),
		// The system prompt and the tools are the same every turn: cache them (the last cacheable block).
		cache_control: { type: 'ephemeral' },
		// Chat over a project's data with a few tool calls: low effort keeps the thinking, and the spend, small.
		...(NO_EFFORT.test(model) ? {} : { output_config: { effort: 'low' as const } }),
		...(fallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
		stream: true
	};
}

type Usage = { input_tokens?: number | null; output_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null };
const inputOf = (u: Usage) => (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);

/** What a status means to the person reading the chat; never the upstream's own text. */
function statusError(status: number | undefined): Error {
	switch (status) {
		case 401:
		case 403:
			return new Error('The Anthropic API refused the key (check ANTHROPIC_API_KEY).');
		case 404:
			return new Error('The Anthropic API has no such model (check ASSISTANT_MODEL).');
		case 429:
			return new Error('The Anthropic API is rate limiting this account; try again shortly.');
		case 529:
			return new Error('The Anthropic API is overloaded; try again shortly.');
		default:
			return new Error(status ? `The Anthropic API answered ${status}.` : 'The Anthropic API could not be reached.');
	}
}

export interface AnthropicOptions {
	/** The API's base URL (tests point it at a local stub); the SDK's own default otherwise. */
	baseURL?: string;
	apiKey?: string;
	timeoutMs?: number;
}

export function anthropicProvider(cfg?: Pick<AssistantConfig, 'model'>, opts: AnthropicOptions = {}): AssistantProvider {
	const model = cfg?.model || ANTHROPIC_DEFAULT_MODEL;
	return {
		name: 'anthropic',
		async *complete(req: ProviderRequest): AsyncIterable<ProviderEvent> {
			const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
			if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
			const sdk = await import('@anthropic-ai/sdk');
			const client = new sdk.default({ apiKey, baseURL: opts.baseURL, maxRetries: 1, timeout: opts.timeoutMs ?? ANTHROPIC_TIMEOUT_MS });

			let pending: { id: string; name: string; json: string }[] = [];
			const open = new Map<number, { id: string; name: string; json: string }>();
			let input = 0;
			let output = 0;
			let iterations: { input: number; output: number } | null = null;
			let stopReason: string | null = null;
			try {
				const stream = await client.beta.messages.create(anthropicRequest(model, req), { signal: req.signal });
				for await (const ev of stream) {
					switch (ev.type) {
						case 'message_start':
							input = inputOf(ev.message.usage);
							output = ev.message.usage.output_tokens ?? 0;
							break;
						case 'content_block_start': {
							const b = ev.content_block;
							if (b.type === 'tool_use') open.set(ev.index, { id: b.id, name: b.name, json: '' });
							// A safety classifier declined part way and a fallback model carries on (server-side fallbacks): the
							// declined model's tool calls are not part of the answer; its text is the fallback's starting point.
							else if (b.type === 'fallback') {
								pending = [];
								open.clear();
							} else if (b.type === 'text' && b.text) yield { type: 'text', delta: b.text };
							break;
						}
						case 'content_block_delta':
							if (ev.delta.type === 'text_delta') yield { type: 'text', delta: ev.delta.text };
							else if (ev.delta.type === 'input_json_delta') {
								const c = open.get(ev.index);
								if (c) c.json += ev.delta.partial_json;
							}
							break;
						case 'content_block_stop': {
							const c = open.get(ev.index);
							if (c) {
								pending.push(c);
								open.delete(ev.index);
							}
							break;
						}
						case 'message_delta': {
							stopReason = ev.delta.stop_reason ?? stopReason;
							const u = ev.usage;
							if (u.input_tokens != null) input = inputOf(u);
							output = u.output_tokens ?? output;
							// With a fallback the top-level usage is the last attempt's; every attempt is billed.
							if (u.iterations?.length) {
								iterations = { input: 0, output: 0 };
								for (const it of u.iterations) {
									iterations.input += inputOf(it as Usage);
									iterations.output += (it as Usage).output_tokens ?? 0;
								}
							}
							break;
						}
					}
				}
				// The SDK ends the stream quietly on an abort: the hop is cut off, not complete.
				if (req.signal?.aborted) throw req.signal.reason;
			} catch (err) {
				if (req.signal?.aborted) throw req.signal.reason;
				if (err instanceof sdk.APIUserAbortError) throw err;
				if (err instanceof sdk.APIConnectionTimeoutError) throw new Error('The Anthropic API took too long to answer.');
				if (err instanceof sdk.APIError) throw statusError(err.status);
				throw new Error('The Anthropic API stream failed.');
			}

			if (stopReason === 'refusal') {
				// Declined (by every model the fallbacks tried): a cut-off tool call is never run, and the reader is told.
				yield { type: 'text', delta: '\n\n(The model declined to continue this answer.)' };
			} else {
				for (const c of pending) {
					const call: ToolCall = { id: c.id, name: c.name, arguments: parseArguments(c.json) };
					yield { type: 'tool_call', call };
				}
			}
			yield { type: 'usage', inputTokens: iterations?.input ?? input, outputTokens: iterations?.output ?? output };
		}
	};
}
