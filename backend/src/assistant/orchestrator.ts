// One assistant turn (issue #610; docs/architecture.md § Assistant): the
// system prompt and the page's conversation (capped) go to the provider, any
// tool calls it asks for run, each in its own read-only transaction as the
// caller (the route's runTool), and their results go back, hop by hop, until
// the model answers in text or a ceiling is hit:
//   - hops: cfg.maxHops model calls; asking for tools on the last one ends the
//     turn with an `assistant_hop_limit` error event;
//   - output: cfg.maxOutputTokens per call, or less when the turn's budget
//     leaves less (below), passed to the provider, and cut here too if a
//     provider streams far past it (`assistant_output_limit`);
//   - tool calls: cfg.maxToolCallsPerHop run per hop; each call past it gets
//     a tool error result saying so, and the model can ask again next hop;
//   - tokens: deps.budget weighted tokens (config.ts weightedTokens) for the
//     whole turn, what app_assistant_begin reserved (264_assistant_reservation:
//     at most cfg.maxTurnTokens, and no more than any monthly cap has left).
//     Before every hop, the first included, the tokens so far plus a
//     conservative estimate of that hop's input plus its output at most
//     (weighted ×5) must fit: the hop's output cap is cut to what the budget
//     leaves, and a hop that couldn't have MIN_HOP_OUTPUT_TOKENS ends the turn
//     with an `assistant_turn_limit` error event instead. So a turn spends no
//     more than its budget while the provider counts no more input tokens
//     than the estimate (firstHopInput) and honours its output cap;
//   - tool results: cfg.maxToolResultChars each, cut with a note;
//   - input: cfg.maxInputChars of conversation, oldest turns dropped first;
//   - time: cfg.turnSeconds for the whole turn (`assistant_timeout`). A tool
//     gets the turn's signal and is raced against it, so one that hangs ends
//     the turn at the deadline like a slow model call, never as a tool failure.
// A malformed or unknown tool call becomes a tool error result the model
// sees, never a crash. A provider failure is an `assistant_provider_error`
// event with fixed words; nothing a provider or a tool throws reaches the
// client or the log as text. Prompts and answers are never logged.
//
// runTurn never throws: it reports the tokens it used whatever happened, so
// the route can charge them (usage.ts).
import { logEvent } from '../logging/logEvent.js';
import { safeError } from '../logging/safeError.js';
import { OUTPUT_TOKEN_WEIGHT, weightedTokens, type AssistantConfig } from './config.js';
import { systemPrompt } from './prompt.js';
import type {
	AssistantProvider,
	AssistantStreamEvent,
	AssistantTool,
	ChatMessage,
	ToolCall,
	ToolResult,
	ToolSpec,
	TurnMessage
} from './types.js';

/** The `error` events a turn can end with (also in http/errors.ts MACHINE_ERROR_CODES). */
export const TURN_ERRORS = {
	assistant_hop_limit: 'The assistant needed more steps than one answer may take. Ask a narrower question.',
	assistant_turn_limit: 'The assistant needed more reading than one answer may take. Ask a narrower question, e.g. about one node or a shorter window.',
	assistant_output_limit: 'The answer was cut off at its length limit.',
	assistant_timeout: 'The assistant took too long to answer. Try again, or ask a narrower question.',
	assistant_provider_error: 'The assistant’s model could not be reached or failed. Try again in a moment.'
} as const;
export type TurnErrorCode = keyof typeof TURN_ERRORS;

/** A provider streaming past its output cap by this factor (in characters per token) is cut off. */
const OUTPUT_CHARS_PER_TOKEN = 8;
/**
 * Tokens of framing a provider may add to one call beyond the text it is
 * sent: the tool-use instructions (Anthropic documents 346 tokens for them on
 * Claude), role and turn markers. Generous on purpose.
 */
export const HOP_FRAMING_TOKENS = 1000;
/** Tokens of framing per message (its role, a tool result's id and name markers). */
export const MESSAGE_FRAMING_TOKENS = 16;
/**
 * The fewest output tokens a hop is worth running with: a hop the budget
 * leaves less for ends the turn (`assistant_turn_limit`) instead.
 */
export const MIN_HOP_OUTPUT_TOKENS = 256;

const utf8 = new TextEncoder();
/** UTF-8 bytes: no fewer than the tokens, since every token of a byte-level BPE (Claude's, Llama's) covers at least one byte. */
const bytes = (s: string) => utf8.encode(s).length;

/** One message's input tokens at most: its bytes (a tool call's arguments as JSON included) plus its framing. */
export function messageTokens(m: TurnMessage): number {
	let n = MESSAGE_FRAMING_TOKENS + bytes(m.content);
	if (m.role === 'assistant' && m.toolCalls?.length) n += bytes(JSON.stringify(m.toolCalls));
	// A provider's id and name could be anything; counted as the text they'd be sent as.
	if (m.role === 'tool') n += bytes(String(m.toolCallId ?? '')) + bytes(String(m.name ?? ''));
	return n;
}

/**
 * A call's input tokens at most, from scratch: the framing, the system
 * prompt, the tool specs as JSON and every message, each counted by its UTF-8
 * bytes. Deliberately high (English runs about four characters a token), so
 * the budget checks err towards spending less, never more. After the first
 * hop runTurn starts from the provider's own count of the previous call's
 * input instead, and adds only the messages since by this rule.
 */
export function firstHopInput(system: string, specs: readonly ToolSpec[], messages: readonly TurnMessage[]): number {
	return messages.reduce((n, m) => n + messageTokens(m), HOP_FRAMING_TOKENS + bytes(system) + bytes(JSON.stringify(specs)));
}

/**
 * The weighted tokens a turn needs reserved before it starts: its first
 * call's input at most, plus a whole call's output (cfg.maxOutputTokens)
 * weighted. app_assistant_begin refuses a turn when a monthly cap has less
 * than this left; the route refuses a conversation whose floor passes
 * cfg.maxTurnTokens (413) before that.
 */
export function turnFloor(
	cfg: Pick<AssistantConfig, 'maxOutputTokens' | 'maxInputChars'>,
	system: string,
	tools: readonly AssistantTool[],
	conversation: readonly ChatMessage[]
): number {
	const kept = capConversation(conversation, cfg.maxInputChars) ?? [];
	return firstHopInput(system, tools.map((t) => t.spec), kept) + OUTPUT_TOKEN_WEIGHT * cfg.maxOutputTokens;
}

export interface TurnDeps {
	provider: AssistantProvider;
	tools: readonly AssistantTool[];
	cfg: AssistantConfig;
	/**
	 * Runs one tool as the caller, inside withUser(…, { readOnly: true })
	 * (routes.ts). `signal` is the turn's: it fires at the deadline or when the
	 * client goes away, and the turn stops waiting for the tool then.
	 */
	runTool: (tool: AssistantTool, args: unknown, signal: AbortSignal) => Promise<ToolResult>;
	emit: (event: AssistantStreamEvent) => void;
	/** Aborted when the client goes away: the turn stops quietly. */
	signal?: AbortSignal;
	/** The system prompt; prompt.ts by default. */
	system?: string;
	/**
	 * Weighted tokens this turn may spend, every hop together: what
	 * app_assistant_begin reserved for it (usage.ts beginTurn). cfg.maxTurnTokens
	 * when absent.
	 */
	budget?: number;
}

export interface TurnOutcome {
	inputTokens: number;
	outputTokens: number;
	/** How the turn ended: answered, an error event, or the client went away. */
	end: 'answered' | TurnErrorCode | 'aborted';
}

/**
 * The newest messages that fit in `maxChars`, oldest dropped first, starting
 * with a user message (providers refuse a conversation that opens with the
 * assistant). Null when the newest message alone doesn't fit: the route
 * refuses that one (413) before any stream.
 */
export function capConversation(messages: readonly ChatMessage[], maxChars: number): ChatMessage[] | null {
	const last = messages.at(-1);
	if (!last || last.content.length > maxChars) return null;
	let total = 0;
	let from = messages.length;
	while (from > 0 && total + messages[from - 1]!.content.length <= maxChars) {
		total += messages[from - 1]!.content.length;
		from--;
	}
	const kept = messages.slice(from);
	while (kept.length > 1 && kept[0]!.role !== 'user') kept.shift();
	return kept;
}

/** `text` cut to `max` characters, with a note the model can read. */
export function capToolResult(text: string, max: number): string {
	if (text.length <= max) return text;
	const note = `\n[cut: the result was ${text.length} characters; only the first ${max} are shown. Ask for less, e.g. a shorter window or fewer series.]`;
	return text.slice(0, Math.max(0, max - note.length)) + note;
}

/** A tool call's arguments as an object, or why they can't be used. */
export function parseArguments(raw: unknown): { ok: true; args: unknown } | { ok: false; error: string } {
	let args = raw;
	if (typeof raw === 'string') {
		if (!raw.trim()) return { ok: true, args: {} };
		try {
			args = JSON.parse(raw);
		} catch {
			return { ok: false, error: 'The arguments were not valid JSON. Send a JSON object matching the tool’s parameters.' };
		}
	}
	if (args === undefined || args === null) return { ok: true, args: {} };
	if (typeof args !== 'object' || Array.isArray(args)) return { ok: false, error: 'The arguments must be a JSON object matching the tool’s parameters.' };
	return { ok: true, args };
}


/**
 * What goes between the text streamed so far this turn (`before`, its last characters are enough) and a later hop's
 * first delta: a blank line, so the text before a tool call and the answer after it are two paragraphs ("…at the
 * same time.The project is…" in the 2026-10-30 production test). Nothing at the turn's start or where the break
 * is already there.
 */
export function textJoin(before: string, next: string): string {
	if (!before || /^\s*\n\s*\n/.test(next)) return '';
	const lead = /^[ \t]*\n/.test(next) ? 1 : 0;
	const tail = /\n[ \t]*\n[ \t]*$/.test(before) ? 2 : /\n[ \t]*$/.test(before) ? 1 : 0;
	return '\n'.repeat(Math.max(0, 2 - tail - lead));
}

/** The words a tool call past cfg.maxToolCallsPerHop gets instead of running. */
export const toolCallLimitError = (max: number) =>
	`Not run: one step may run at most ${max} tool calls, and the first ${max} ran. Ask for this one again in the next step if you still need it.`;

/** Rejects once `signal` aborts (with its reason), so a tool that ignores the signal can't hold the turn. */
function abortion(signal: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		if (signal.aborted) reject(signal.reason);
		else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
	});
}

export async function runTurn(deps: TurnDeps, conversation: readonly ChatMessage[]): Promise<TurnOutcome> {
	const { provider, cfg, emit } = deps;
	const system = deps.system ?? systemPrompt();
	const byName = new Map(deps.tools.map((t) => [t.spec.name, t]));
	const specs = deps.tools.map((t) => t.spec);
	const usage = { inputTokens: 0, outputTokens: 0 };
	const outcome = (end: TurnOutcome['end']): TurnOutcome => ({ ...usage, end });
	const fail = (code: TurnErrorCode): TurnOutcome => {
		emit({ type: 'error', code, error: TURN_ERRORS[code] });
		return outcome(code);
	};

	// The turn's own deadline, joined with the client's disconnect.
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(), cfg.turnSeconds * 1000);
	const signal = deps.signal ? AbortSignal.any([deps.signal, deadline.signal]) : deadline.signal;
	const stopped = (): TurnOutcome | null => (deps.signal?.aborted ? outcome('aborted') : deadline.signal.aborted ? fail('assistant_timeout') : null);

	const transcript: TurnMessage[] = (capConversation(conversation, cfg.maxInputChars) ?? []).map((m) => ({ role: m.role, content: m.content }));
	const budget = deps.budget ?? cfg.maxTurnTokens;
	const minOutput = Math.min(MIN_HOP_OUTPUT_TOKENS, cfg.maxOutputTokens);
	// The previous call's input tokens (as the provider counted them, else as estimated), and how many messages it was sent.
	let lastInput = 0;
	let lastSent = 0;
	// The end of the text streamed so far this turn, every hop together: a hop's text after a tool call starts a
	// new paragraph (textJoin), so the page never runs two hops' sentences together.
	let streamed = '';
	let said = false;
	try {
		for (let hop = 0; hop < cfg.maxHops; hop++) {
			const early = stopped();
			if (early) return early;
			// Each hop resends the whole transcript, so input grows hop by hop. This hop's input at most: from scratch on
			// the first, else the previous call's plus the messages added since, each at most (messageTokens).
			const hopInput = hop === 0 ? firstHopInput(system, specs, transcript) : lastInput + transcript.slice(lastSent).reduce((n, m) => n + messageTokens(m), 0);
			// The output this hop may have: the turn's spend so far, this hop's input and its output (weighted) fit the budget.
			const hopOutput = Math.min(cfg.maxOutputTokens, Math.floor((budget - weightedTokens(usage.inputTokens, usage.outputTokens) - hopInput) / OUTPUT_TOKEN_WEIGHT));
			if (hopOutput < minOutput) return fail('assistant_turn_limit');
			let text = '';
			const calls: ToolCall[] = [];
			let reported = false;
			let hopReportedInput = 0;
			let cut = false;
			// A call the provider never reported (it failed, or doesn't report): counted at its most, this hop's input
			// estimate and the output it streamed, no more than the cap the provider honours, so the budget still sees it.
			const countUnreported = () => {
				usage.inputTokens += hopInput;
				usage.outputTokens += Math.min(hopOutput, bytes(text) + (calls.length ? bytes(JSON.stringify(calls)) : 0));
			};
			lastSent = transcript.length;
			try {
				for await (const ev of provider.complete({ system, messages: transcript, tools: specs, maxOutputTokens: hopOutput, signal })) {
					if (ev.type === 'text') {
						if (!ev.delta) continue;
						if (!text) {
							const sep = said ? textJoin(streamed, ev.delta) : '';
							if (sep) emit({ type: 'text', delta: sep });
						}
						text += ev.delta;
						streamed = (streamed + ev.delta).slice(-16);
						said ||= ev.delta.trim() !== '';
						emit({ type: 'text', delta: ev.delta });
						if (text.length > hopOutput * OUTPUT_CHARS_PER_TOKEN) {
							cut = true;
							break;
						}
					} else if (ev.type === 'tool_call') {
						calls.push(ev.call);
					} else if (ev.type === 'usage') {
						const input = Math.max(0, Math.round(ev.inputTokens) || 0);
						usage.inputTokens += input;
						usage.outputTokens += Math.max(0, Math.round(ev.outputTokens) || 0);
						hopReportedInput += input;
						reported = true;
					}
				}
			} catch (err) {
				if (!reported) countUnreported();
				const late = stopped();
				if (late) return late;
				logEvent('warn', { event: 'assistant_provider_failed', provider: provider.name, ...safeError(err) });
				return fail('assistant_provider_error');
			}
			if (!reported) countUnreported();
			lastInput = reported ? hopReportedInput : hopInput;
			if (cut) return fail('assistant_output_limit');
			const late = stopped();
			if (late) return late;
			transcript.push({ role: 'assistant', content: text, ...(calls.length ? { toolCalls: calls } : {}) });
			if (!calls.length) return outcome('answered');
			// Tools asked for on the last allowed call would need another call to be read.
			if (hop === cfg.maxHops - 1) return fail('assistant_hop_limit');
			for (const [i, call] of calls.entries()) {
				// Every call gets a result (providers refuse a tool call left unanswered); those past the cap get an error instead of running.
				let content: string;
				if (i >= cfg.maxToolCallsPerHop) content = JSON.stringify({ ok: false, error: toolCallLimitError(cfg.maxToolCallsPerHop) });
				else {
					try {
						content = await dispatch(deps, byName, call, signal);
					} catch (err) {
						// Only the turn's signal escapes dispatch: the deadline or the client going away.
						const s = stopped();
						if (s) return s;
						throw err;
					}
				}
				transcript.push({ role: 'tool', toolCallId: call.id, name: call.name, content });
				const after = stopped();
				if (after) return after;
			}
		}
		return fail('assistant_hop_limit');
	} finally {
		clearTimeout(timer);
	}
}

/** Runs one call and returns what the model sees: the result's JSON, size-capped. Emits the panel's tool events. */
async function dispatch(deps: TurnDeps, byName: Map<string, AssistantTool>, call: ToolCall, signal: AbortSignal): Promise<string> {
	const { emit, cfg } = deps;
	const tool = typeof call.name === 'string' ? byName.get(call.name) : undefined;
	const name = typeof call.name === 'string' ? call.name.slice(0, 64) : '';
	let result: ToolResult;
	if (!tool) {
		emit({ type: 'tool', name, label: 'Unknown tool', status: 'error' });
		result = { ok: false, error: `There is no tool named "${name}". The tools are: ${[...byName.keys()].join(', ')}.` };
	} else {
		emit({ type: 'tool', name: tool.spec.name, label: tool.label, status: 'start' });
		const parsed = parseArguments(call.arguments);
		if (!parsed.ok) {
			result = { ok: false, error: parsed.error };
		} else {
			try {
				const running = deps.runTool(tool, parsed.args, signal);
				running.catch(() => {}); // settles after the race when the turn stopped first
				result = await Promise.race([running, abortion(signal)]);
			} catch (err) {
				if (signal.aborted) {
					// The turn stopped (deadline or client gone), not the tool: runTurn ends it as such.
					emit({ type: 'tool', name: tool.spec.name, label: tool.label, status: 'error' });
					throw err;
				}
				// A tool's thrown text could be a database error: the model gets fixed words, the log only the error's name and frames.
				logEvent('warn', { event: 'assistant_tool_failed', tool: tool.spec.name, ...safeError(err) });
				result = { ok: false, error: 'The tool failed. Answer from what you have, or try another tool.' };
			}
		}
		if (result.ok && result.proposal) emit({ type: 'proposal', proposal: result.proposal });
		emit({ type: 'tool', name: tool.spec.name, label: tool.label, status: result.ok ? 'done' : 'error' });
	}
	let text: string;
	try {
		text = JSON.stringify(result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error }) ?? '{"ok":true}';
	} catch {
		text = JSON.stringify({ ok: false, error: 'The tool’s result could not be read.' });
	}
	return capToolResult(text, cfg.maxToolResultChars);
}
