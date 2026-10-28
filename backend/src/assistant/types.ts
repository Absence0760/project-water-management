// The assistant's shared contract (issue #610): the provider interface every
// adapter implements (providers/mock.ts, ollama.ts, anthropic.ts,
// bedrock.ts), the tool shape the orchestrator dispatches (tools/*.ts), and
// the wire format of the API (routes.ts) that the frontend mirrors in
// frontend/src/lib/api/types.ts (there is no codegen, so change both).
import type { Db } from '../db/tx.js';

/** Which model the assistant talks to (ASSISTANT_PROVIDER). `off`, the default, hides the chat. */
export type AssistantProviderName = 'off' | 'mock' | 'ollama' | 'anthropic' | 'bedrock';

/** One turn of the conversation the page keeps and sends back each time (no transcript is stored). */
export interface ChatMessage {
	role: 'user' | 'assistant';
	content: string;
}

/** A tool the model may call. `parameters` is a JSON Schema object. */
export interface ToolSpec {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

/** A call the model asked for, in one hop. `id` pairs it with its result. */
export interface ToolCall {
	id: string;
	name: string;
	/** The arguments as the model sent them; unparsed JSON text is passed through as a string for the tool to refuse. */
	arguments: unknown;
}

/** The provider-neutral transcript of one turn inside the orchestrator (never stored, never logged). */
export type TurnMessage =
	| { role: 'user'; content: string }
	| { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
	| { role: 'tool'; toolCallId: string; name: string; content: string };

export interface ProviderRequest {
	system: string;
	messages: TurnMessage[];
	tools: ToolSpec[];
	/** Output tokens this hop may use (ASSISTANT_MAX_OUTPUT_TOKENS). */
	maxOutputTokens: number;
	signal?: AbortSignal;
}

/** What a provider streams back for one hop. */
export type ProviderEvent =
	| { type: 'text'; delta: string }
	| { type: 'tool_call'; call: ToolCall }
	| { type: 'usage'; inputTokens: number; outputTokens: number };

export interface AssistantProvider {
	readonly name: Exclude<AssistantProviderName, 'off'>;
	/** One model call: text deltas, then any tool calls, then exactly one usage event. Throws on a transport or upstream error. */
	complete(req: ProviderRequest): AsyncIterable<ProviderEvent>;
}

/** What a tool runs with: the signed-in user, inside withUser(userId, …, { readOnly: true }). */
export interface ToolContext {
	db: Db;
	userId: string;
	projectId: string;
	/** The run the conversation is about (the page's selected run), else the project's latest. */
	runId: string | null;
}

/** A tool's result: JSON the orchestrator serializes and size-caps (ASSISTANT_MAX_TOOL_RESULT_CHARS) before the model sees it. */
export type ToolResult = { ok: true; data: unknown; proposal?: SettingsProposal } | { ok: false; error: string };

export interface AssistantTool {
	spec: ToolSpec;
	/** A short line the panel shows while the tool runs ("Reading the run summary"). */
	label: string;
	run(ctx: ToolContext, args: unknown): Promise<ToolResult>;
}

/** A recommended settings change from propose_settings, validated and dry-run before it reaches the page. */
export interface SettingsProposal {
	/** A patch SettingsPatch accepts and patchSettings applies without error. */
	patch: Record<string, unknown>;
	/** Why, one per changed top-level key (key → reason). */
	reasons: Record<string, string>;
	/** One-line summary, prefilled as the revision reason: "Assistant suggestion: …". */
	summary: string;
	/** The engine's input-diff lines (compare.ts diffInputs) between the stored and the patched settings. */
	diff: { label: string; before: string; after: string }[];
}

// ---- Wire format -------------------------------------------------------

/** GET /projects/:id/assistant */
export type AssistantStatus =
	| { available: false }
	| {
			available: true;
			provider: Exclude<AssistantProviderName, 'off'>;
			/** The caller's role allows Apply (editor or above). */
			canApply: boolean;
			/**
			 * The month's cap nearest its end (usage.ts bindingBudget), in weighted tokens (input + 5 × output):
			 * the project's, the caller's across projects (`user`) or the deployment's (`total`).
			 */
			budget: { tokensPerMonth: number; tokensUsed: number; resetsAt: string; scope: 'project' | 'user' | 'total' };
			rate: { messagesPerHour: number };
			/** The report disclaimer (liability/disclaimer.ts DISCLAIMER), shown under the panel. */
			disclaimer: string;
	  };

/** POST /projects/:id/assistant/messages body. The last message is the user's new one. */
export interface AssistantRequest {
	messages: ChatMessage[];
	runId?: string;
}

/**
 * The POST answers `text/event-stream`. Each event is `event: <type>\ndata: <json>\n\n`
 * with the json below; a `: keepalive` comment line comes every ~15 s.
 * A refusal before the stream starts (off, role, budget spent, 429, bad body) is a normal
 * JSON ApiError response instead, never a stream.
 */
export type AssistantStreamEvent =
	| { type: 'text'; delta: string }
	| { type: 'tool'; name: string; label: string; status: 'start' | 'done' | 'error' }
	| { type: 'proposal'; proposal: SettingsProposal }
	/** After a turn: its tokens, and the month's cap nearest its end as the status's budget (tokensUsed, tokensPerMonth, scope). */
	| { type: 'usage'; inputTokens: number; outputTokens: number; tokensUsed: number; tokensPerMonth: number; scope: 'project' | 'user' | 'total' }
	| { type: 'error'; code: string; error: string }
	| { type: 'done' };

/** The tools' names, fixed here so the mock provider's script and the tools agree. */
export const TOOL_NAMES = {
	runSummary: 'get_run_summary',
	settings: 'get_settings',
	network: 'get_network',
	series: 'get_series',
	gaugeFit: 'get_gauge_fit',
	searchHelp: 'search_help',
	proposeSettings: 'propose_settings'
} as const;
