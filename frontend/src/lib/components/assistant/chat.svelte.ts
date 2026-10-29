// The assistant's conversation on one project (issue #610, docs/ui.md §
// Assistant): what the panel shows and sends. The workspace page holds it
// (routes/projects/[id]/+page.svelte), so closing the drawer or changing tab
// keeps the conversation; nothing is stored on the server, so the whole
// conversation goes with each turn (the server keeps the newest that fit).
// A turn streams: text as it comes, a line per tool the assistant reads the
// project with, any settings it recommends (each a proposal the panel shows
// as a diff with Apply), then `done`. A refusal before the stream (the hourly
// cap, the month's budget spent, the assistant off) puts the message back and
// says why instead.
// Past chats are kept only in this browser (history.ts, loaded with the
// panel): each conversation is saved there when a turn ends, under the
// signed-in person and the project, and the panel's Past chats reopens one.
// A reopened chat's recommended changes are read-only: ask again for a fresh
// one. Storage that fails turns history off; the conversation carries on.
import { ApiError } from '#lib/api/client.js';
import type { AssistantBudgetScope, AssistantRequest, AssistantStatus, AssistantStreamEvent, ChatMessage, AssistantProposal } from '#lib/api/types.js';
import { readEvents } from './stream';
import type { ChatHistory, ChatSummary } from './history';

/** One tool the assistant used in a turn, as its `tool` events said (the label is the server's). */
export interface ToolLine {
	name: string;
	label: string;
	status: 'start' | 'done' | 'error';
}

export interface UserTurn {
	role: 'user';
	text: string;
}

/** A recommended change as the panel shows it; a reopened one (`stale`) has no `apply`. */
export type ShownProposal = Omit<AssistantProposal, 'apply'> & { apply?: AssistantProposal['apply'] };

/**
 * A recommended change in a turn, applied at most once (`applied`: put in the settings form, or made a scenario).
 * `applying` while a scenario is being created, `failed` why it wasn't. `stale`: from a past chat reopened from
 * this browser's history, shown read-only, never applied (the project may have changed since).
 */
export interface ProposalEntry {
	proposal: ShownProposal;
	applied: boolean;
	applying?: boolean;
	failed?: string | null;
	stale?: boolean;
}

/** The change Apply may act on: one from this conversation, with its apply payload; null for a reopened one. */
export const applicable = (p: ProposalEntry): AssistantProposal | null => (p.stale || !p.proposal.apply ? null : (p.proposal as AssistantProposal));

export interface AssistantTurn {
	role: 'assistant';
	text: string;
	tools: ToolLine[];
	proposals: ProposalEntry[];
	/** Why the turn ended early, in words (an `error` event, or the stream cut off). */
	error: string | null;
	/** Stop was pressed: what came before it stays. */
	stopped: boolean;
	/** The server's `done` came. */
	done: boolean;
}

export type Turn = UserTurn | AssistantTurn;

/** Why a message wasn't taken, shown above the box until it no longer holds. */
export type Refusal =
	| { kind: 'rate'; seconds: number; message: string }
	| { kind: 'budget'; scope: AssistantBudgetScope; message: string }
	| { kind: 'error'; message: string };

export interface AssistantDeps {
	status(): Promise<AssistantStatus>;
	send(body: AssistantRequest, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
	/** Waits (the rate limit's lifting); setTimeout by default, replaced in tests. */
	later?: (fn: () => void, ms: number) => void;
	/** This person's past chats on the project, in this browser (history.ts openChatHistory); null when storage is off. */
	history?: () => Promise<ChatHistory | null>;
	/** A new conversation's id; crypto.randomUUID by default. */
	newId?: () => string;
}

/** The server takes at most this many messages a turn (backend/src/assistant/routes.ts MAX_MESSAGES). */
export const MAX_SENT_MESSAGES = 200;

// The server's codes for these refusals (backend/src/http/errors.ts MACHINE_ERROR_CODES; docs/api.md § Assistant).
// A spent month, by the cap that refused it: the project's, the person's across projects, the server's in all.
const BUDGET_SPENT: Record<string, AssistantBudgetScope> = {
	assistant_budget_spent: 'project',
	assistant_user_budget_spent: 'user',
	assistant_total_budget_spent: 'total'
};
const RATE_LIMITED = 'assistant_rate_limited';
const budgetScopeOf = (code: string | null | undefined): AssistantBudgetScope | null => (code && Object.hasOwn(BUDGET_SPENT, code) ? BUDGET_SPENT[code]! : null);

/** "about 3 min" / "about 40 s" for a wait in seconds. */
export function waitText(seconds: number): string {
	if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))} s`;
	if (seconds < 3600) return `${Math.ceil(seconds / 60)} min`;
	const h = Math.floor(seconds / 3600);
	const m = Math.ceil((seconds % 3600) / 60);
	return m ? `${h} h ${m} min` : `${h} h`;
}

/** A new conversation's id. */
function newId(): string {
	try {
		return crypto.randomUUID();
	} catch {
		return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	}
}

/**
 * The newest messages the server takes (MAX_SENT_MESSAGES), starting with a question: a long conversation, or a
 * past chat continued, sends its latest part. The server then keeps the newest that fit its characters cap.
 */
export function capMessages(messages: ChatMessage[]): ChatMessage[] {
	if (messages.length <= MAX_SENT_MESSAGES) return messages;
	const kept = messages.slice(-MAX_SENT_MESSAGES);
	while (kept.length > 1 && kept[0]!.role !== 'user') kept.shift();
	return kept;
}

const isAbort = (e: unknown) => e instanceof DOMException ? e.name === 'AbortError' : e instanceof Error && e.name === 'AbortError';

export class AssistantChat {
	/** Null until loaded; `{ available: false }` when the server has it off or the status couldn't be read. */
	status = $state<AssistantStatus | null>(null);
	turns = $state<Turn[]>([]);
	/** A turn is streaming. */
	busy = $state(false);
	refusal = $state<Refusal | null>(null);
	/** The open conversation's id in the history: null until its first answer is kept. */
	id = $state<string | null>(null);
	/** This project's past chats, newest first; null until read (or with history off). */
	past = $state.raw<ChatSummary[] | null>(null);
	/** History is off: no storage in this browser (a private window, blocked site data), or it failed. */
	historyOff = $state(false);
	#history: Promise<ChatHistory | null> | null = null;
	/** Saves run one after another, so an older one can't land after a newer. */
	#saving: Promise<unknown> = Promise.resolve();
	#ctrl: AbortController | null = null;
	/** Counts refusals, so a rate limit's timer clears only its own. */
	#refusals = 0;
	#deps: AssistantDeps;

	constructor(deps: AssistantDeps) {
		this.#deps = deps;
	}

	get available(): boolean {
		return this.status?.available === true;
	}

	/** May the caller apply a proposal (editor or above)? */
	get canApply(): boolean {
		return this.status?.available === true && this.status.canApply;
	}

	/** Tokens left this month, or null while the status isn't known. */
	get tokensLeft(): number | null {
		if (this.status?.available !== true) return null;
		return Math.max(0, this.status.budget.tokensPerMonth - this.status.budget.tokensUsed);
	}

	/** The month's budget is used up: nothing can be sent until it resets. */
	get spent(): boolean {
		return this.tokensLeft === 0 || this.refusal?.kind === 'budget';
	}

	/** Whose month is used up, while it is: the refusal's cap, else the status's. */
	get spentScope(): AssistantBudgetScope | null {
		if (this.refusal?.kind === 'budget') return this.refusal.scope;
		return this.tokensLeft === 0 && this.status?.available ? this.status.budget.scope : null;
	}

	/** Read whether the assistant is on here (the page hides its button until it is). */
	async load(): Promise<void> {
		try {
			this.status = await this.#deps.status();
		} catch {
			// Not available to this caller (a 403) or not reachable: the panel stays hidden, as when it's off.
			this.status = { available: false };
		}
	}

	/** The conversation as the server takes it: questions that got no answer (refused, failed) are left out. */
	messages(): ChatMessage[] {
		const out: ChatMessage[] = [];
		for (let i = 0; i < this.turns.length; i++) {
			const t = this.turns[i]!;
			const next = this.turns[i + 1];
			if (t.role === 'user') {
				if (next?.role === 'assistant' && next.text.trim()) out.push({ role: 'user', content: t.text });
			} else if (t.text.trim()) out.push({ role: 'assistant', content: t.text });
		}
		return out;
	}

	/**
	 * Send `text` as the next question (about run `runId` when the page shows one). False when it wasn't taken
	 * (empty, a turn already streaming, a refusal before the stream): the caller keeps the text in the box.
	 */
	async ask(text: string, runId?: string | null): Promise<boolean> {
		const q = text.trim();
		if (!q || this.busy || !this.available || this.spent) return false;
		const messages = capMessages([...this.messages(), { role: 'user' as const, content: q }]);
		this.refusal = null;
		this.busy = true;
		const ctrl = new AbortController();
		this.#ctrl = ctrl;
		this.turns.push({ role: 'user', text: q });
		this.turns.push({ role: 'assistant', text: '', tools: [], proposals: [], error: null, stopped: false, done: false });
		// The proxied turn, so the edits below show as they come.
		const turn = this.turns[this.turns.length - 1] as AssistantTurn;
		let body: ReadableStream<Uint8Array>;
		try {
			body = await this.#deps.send({ messages, ...(runId ? { runId } : {}) }, ctrl.signal);
		} catch (e) {
			this.busy = false;
			this.#ctrl = null;
			// Not taken: the question goes back in the box, and the conversation is as it was.
			this.turns.splice(this.turns.length - 2, 2);
			if (!isAbort(e)) this.refusal = this.#refusalOf(e);
			return false;
		}
		try {
			for await (const ev of readEvents(body)) this.#apply(turn, ev);
			if (!turn.done && !turn.error && !turn.stopped) turn.error = 'The answer stopped before it finished. Ask again.';
		} catch (e) {
			if (isAbort(e) || ctrl.signal.aborted) turn.stopped = true;
			else turn.error = 'The connection dropped before the answer finished. Ask again.';
		} finally {
			this.busy = false;
			if (this.#ctrl === ctrl) this.#ctrl = null;
			// A tool still running when the turn ended didn't finish.
			for (const t of turn.tools) if (t.status === 'start' && (turn.stopped || turn.error)) t.status = 'error';
		}
		// Kept unless the conversation was left meanwhile (New conversation, a past chat reopened: #leave kept it).
		if (this.turns.includes(turn)) await this.persist();
		return true;
	}

	/** This browser's history, opened once (null and `historyOff` when there is none). */
	#store(): Promise<ChatHistory | null> {
		this.#history ??= (async () => {
			try {
				const h = (await this.#deps.history?.()) ?? null;
				if (!h && this.#deps.history) this.historyOff = true;
				return h;
			} catch {
				this.historyOff = true;
				return null;
			}
		})();
		return this.#history;
	}

	/** Run a history call; a failure turns history off and answers `fallback`. */
	async #withHistory<T>(fn: (h: ChatHistory) => Promise<T>, fallback: T): Promise<T> {
		const h = await this.#store();
		if (!h || this.historyOff) return fallback;
		try {
			return await fn(h);
		} catch {
			this.historyOff = true;
			this.past = null;
			return fallback;
		}
	}

	/** Read this project's past chats (the panel does, when it opens). */
	async loadPast(): Promise<void> {
		const list = await this.#withHistory((h) => h.list(), null);
		if (!this.historyOff) this.past = list;
	}

	/** Keep the open conversation in this browser's history (after each turn, and after an Apply). */
	persist(): Promise<void> {
		const turns = $state.snapshot(this.turns) as Turn[];
		if (!turns.some((t) => t.role === 'assistant' && t.text.trim())) return Promise.resolve();
		const id = (this.id ??= this.#deps.newId?.() ?? newId());
		const run = this.#saving.then(() =>
			this.#withHistory(async (h) => {
				await h.save(id, turns);
				this.past = await h.list();
			}, undefined)
		);
		this.#saving = run;
		return run;
	}

	/** Open past chat `id` in place of the conversation (stopping one that is streaming). False when it is gone. */
	async reopen(id: string): Promise<boolean> {
		if (id === this.id && this.turns.length) return true;
		const turns = await this.#withHistory((h) => h.get(id), null);
		if (!turns) {
			await this.loadPast();
			return false;
		}
		this.#leave();
		this.turns = turns;
		this.id = id;
		if (this.refusal?.kind === 'error') this.refusal = null;
		return true;
	}

	/** Delete past chat `id`; the open conversation, when it is that one, is cleared too. */
	async remove(id: string): Promise<void> {
		await this.#saving;
		await this.#withHistory((h) => h.remove(id), undefined);
		if (this.id === id) this.clear();
		await this.loadPast();
	}

	/** Delete every past chat on this project in this browser, and start a new conversation. */
	async clearHistory(): Promise<void> {
		await this.#saving;
		await this.#withHistory((h) => h.clear(), undefined);
		this.clear();
		await this.loadPast();
	}

	/** Leaving the open conversation: one still streaming is kept as far as it got, then stopped. */
	#leave(): void {
		if (this.busy) void this.persist();
		this.stop();
	}

	/** Stop the answer streaming now; what came so far stays. */
	stop(): void {
		this.#ctrl?.abort();
	}

	/** Start a new conversation (stopping one that is streaming). */
	clear(): void {
		this.#leave();
		this.turns = [];
		this.id = null;
		if (this.refusal?.kind === 'error') this.refusal = null;
	}

	#apply(turn: AssistantTurn, ev: AssistantStreamEvent): void {
		switch (ev.type) {
			case 'text':
				turn.text += ev.delta;
				break;
			case 'tool': {
				// A tool's `done` or `error` updates the line its `start` opened.
				let open: ToolLine | undefined;
				if (ev.status !== 'start') for (const t of turn.tools) if (t.name === ev.name && t.status === 'start') open = t;
				if (open) {
					open.status = ev.status;
					open.label = ev.label || open.label;
				} else turn.tools.push({ name: ev.name, label: ev.label, status: ev.status });
				break;
			}
			case 'proposal':
				turn.proposals.push({ proposal: ev.proposal, applied: false });
				break;
			case 'usage':
				if (this.status?.available) this.status.budget = { ...this.status.budget, tokensUsed: ev.tokensUsed, tokensPerMonth: ev.tokensPerMonth, scope: ev.scope };
				break;
			case 'error':
				turn.error = ev.error || 'The assistant had a problem answering.';
				{
					const scope = budgetScopeOf(ev.code);
					if (scope) this.refusal = { kind: 'budget', scope, message: ev.error };
				}
				break;
			case 'done':
				turn.done = true;
				break;
		}
	}

	#refusalOf(e: unknown): Refusal {
		if (e instanceof ApiError) {
			this.#refusals++;
			const scope = budgetScopeOf(e.code);
			if (scope) return { kind: 'budget', scope, message: e.message };
			if (e.code === RATE_LIMITED) {
				const seconds = Number(e.params.retryAfter) || Number(e.params.seconds) || 60;
				// Once the wait is over the box takes messages again (unless a newer refusal replaced this one).
				const seq = ++this.#refusals;
				(this.#deps.later ?? ((fn, ms) => setTimeout(fn, ms)))(() => {
					if (this.#refusals === seq && this.refusal?.kind === 'rate') this.refusal = null;
				}, seconds * 1000);
				return { kind: 'rate', seconds, message: e.message };
			}
			return { kind: 'error', message: e.message };
		}
		return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
	}
}
