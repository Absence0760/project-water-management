// The assistant's settings (issue #610), read from the environment on each
// call so tests can change them. Every one falls back to a local-first
// default: ASSISTANT_PROVIDER=off hides the chat, so no dev server needs a
// key. config/production.ts classifies each and refuses `mock` in production.
import type { AssistantProviderName } from './types.js';

const PROVIDERS: readonly AssistantProviderName[] = ['off', 'mock', 'ollama', 'anthropic', 'bedrock'];

/**
 * An output token counts as this many tokens against every cap (the month's
 * per project, per person and in all, and a turn's): Claude's output costs
 * five times its input on Bedrock, so a cap in weighted tokens is a cap in
 * money at the input price (258_assistant_usage.sql weighs the same).
 */
export const OUTPUT_TOKEN_WEIGHT = 5;

/** Tokens as the caps count them: input + OUTPUT_TOKEN_WEIGHT × output. */
export function weightedTokens(inputTokens: number, outputTokens: number): number {
	return inputTokens + OUTPUT_TOKEN_WEIGHT * outputTokens;
}

export interface AssistantConfig {
	provider: AssistantProviderName;
	/** The model id the provider is asked for; empty takes the provider's default. */
	model: string;
	/** Ollama's base URL (its OpenAI-compatible API is under /v1). */
	ollamaUrl: string;
	/** The region Bedrock is called in (its VPC endpoint's region in production). */
	bedrockRegion: string;
	/** Weighted tokens (weightedTokens) one project may use in a calendar month (UTC). */
	tokensPerMonth: number;
	/** Weighted tokens one person may use in a calendar month (UTC), across projects. */
	tokensPerUserMonth: number;
	/** Weighted tokens the whole deployment may use in a calendar month (UTC): the cap no number of projects or accounts gets past. */
	tokensTotalPerMonth: number;
	/** Messages one user may send in an hour, across projects. */
	messagesPerHour: number;
	/** Model calls in one turn; the turn ends with an error event past it. */
	maxHops: number;
	/** Weighted tokens one turn may use, every hop together; the turn ends with an `assistant_turn_limit` error event past it. */
	maxTurnTokens: number;
	/** Tool calls run from one model call; the calls past it get an error result. */
	maxToolCallsPerHop: number;
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
		tokensPerUserMonth: int(env.ASSISTANT_TOKENS_PER_USER_MONTH, 1_000_000),
		tokensTotalPerMonth: int(env.ASSISTANT_TOKENS_PER_MONTH_TOTAL, 20_000_000),
		messagesPerHour: int(env.ASSISTANT_MESSAGES_PER_HOUR, 30),
		maxHops: int(env.ASSISTANT_MAX_HOPS, 6),
		maxTurnTokens: int(env.ASSISTANT_MAX_TURN_TOKENS, 150_000),
		maxToolCallsPerHop: int(env.ASSISTANT_MAX_TOOL_CALLS_PER_HOP, 4),
		maxOutputTokens: int(env.ASSISTANT_MAX_OUTPUT_TOKENS, 1024),
		maxToolResultChars: int(env.ASSISTANT_MAX_TOOL_RESULT_CHARS, 12_000),
		maxInputChars: int(env.ASSISTANT_MAX_INPUT_CHARS, 40_000),
		keepaliveSeconds: int(env.ASSISTANT_KEEPALIVE_SECONDS, 15),
		turnSeconds: int(env.ASSISTANT_TURN_SECONDS, 100)
	};
}
