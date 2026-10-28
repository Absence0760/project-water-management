// The assistant's settings (issue #610), read from the environment on each
// call so tests can change them. Every one falls back to a local-first
// default: ASSISTANT_PROVIDER=off hides the chat, so no dev server needs a
// key. config/production.ts classifies each and refuses `mock` in production.
import type { AssistantProviderName } from './types.js';

const PROVIDERS: readonly AssistantProviderName[] = ['off', 'mock', 'ollama', 'anthropic', 'bedrock'];

export interface AssistantConfig {
	provider: AssistantProviderName;
	/** The model id the provider is asked for; empty takes the provider's default. */
	model: string;
	/** Ollama's base URL (its OpenAI-compatible API is under /v1). */
	ollamaUrl: string;
	/** The region Bedrock is called in (its VPC endpoint's region in production). */
	bedrockRegion: string;
	/** Tokens (input + output) one project may use in a calendar month (UTC). */
	tokensPerMonth: number;
	/** Messages one user may send in an hour, across projects. */
	messagesPerHour: number;
	/** Model calls in one turn; the turn ends with an error event past it. */
	maxHops: number;
	/** Output tokens one model call may use. */
	maxOutputTokens: number;
	/** Characters of one tool result the model sees; longer results are cut with a note. */
	maxToolResultChars: number;
	/** Characters of conversation the page may send; older turns are dropped first, a newest message past it is refused. */
	maxInputChars: number;
	/** Seconds between `: keepalive` comments on the stream (CloudFront's origin read timeout is 35 s). */
	keepaliveSeconds: number;
	/**
	 * Seconds one turn may take, every hop and tool call included; past it the
	 * turn ends with an `assistant_timeout` error event. Below the assistant
	 * Lambda's timeout, so the turn ends cleanly and its tokens are charged.
	 */
	turnSeconds: number;
}

function int(v: string | undefined, fallback: number): number {
	const n = Number(v);
	return v !== undefined && v !== '' && Number.isInteger(n) && n > 0 ? n : fallback;
}

export function assistantProvider(env: Record<string, string | undefined> = process.env): AssistantProviderName {
	const v = (env.ASSISTANT_PROVIDER ?? '').trim();
	return (PROVIDERS as readonly string[]).includes(v) ? (v as AssistantProviderName) : 'off';
}

export function assistantConfig(env: Record<string, string | undefined> = process.env): AssistantConfig {
	return {
		provider: assistantProvider(env),
		model: (env.ASSISTANT_MODEL ?? '').trim(),
		ollamaUrl: (env.OLLAMA_URL ?? '').trim() || 'http://localhost:11434',
		bedrockRegion: (env.ASSISTANT_BEDROCK_REGION ?? '').trim() || (env.AWS_REGION ?? '').trim() || 'af-south-1',
		tokensPerMonth: int(env.ASSISTANT_TOKENS_PER_MONTH, 2_000_000),
		messagesPerHour: int(env.ASSISTANT_MESSAGES_PER_HOUR, 30),
		maxHops: int(env.ASSISTANT_MAX_HOPS, 6),
		maxOutputTokens: int(env.ASSISTANT_MAX_OUTPUT_TOKENS, 1024),
		maxToolResultChars: int(env.ASSISTANT_MAX_TOOL_RESULT_CHARS, 12_000),
		maxInputChars: int(env.ASSISTANT_MAX_INPUT_CHARS, 40_000),
		keepaliveSeconds: int(env.ASSISTANT_KEEPALIVE_SECONDS, 15),
		turnSeconds: int(env.ASSISTANT_TURN_SECONDS, 100)
	};
}
