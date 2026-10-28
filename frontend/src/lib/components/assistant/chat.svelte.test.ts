// The assistant's conversation (issue #610): a turn streams text, tool lines
// and proposals; the conversation sent leaves out unanswered questions; a
// refusal before the stream (the hourly limit, the budget) puts the question
// back; Stop keeps what came. Runs with the client runtime (a .svelte.test.ts).
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '#lib/api/client.js';
import type { AssistantProposal, AssistantRequest, AssistantStatus, AssistantStreamEvent } from '#lib/api/types.js';
import { AssistantChat, MAX_SENT_MESSAGES, applicable, capMessages, waitText, type AssistantTurn } from './chat.svelte';
import { ChatHistory, type ChatRecord, type HistoryBackend } from './history';

const STATUS: AssistantStatus = {
	available: true,
	provider: 'mock',
	canApply: true,
	budget: { tokensPerMonth: 1000, tokensUsed: 100, resetsAt: '2026-11-01T00:00:00Z', scope: 'project' },
	rate: { messagesPerHour: 30 },
	disclaimer: 'Advice, not model output.'
};

const sse = (events: AssistantStreamEvent[]) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

function streamOf(text: string): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(text);
	return new ReadableStream({
		start(c) {
			c.enqueue(bytes);
			c.close();
		}
	});
}

function chatWith(send: (body: AssistantRequest, signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>, status: AssistantStatus = STATUS, later?: (fn: () => void, ms: number) => void) {
	const c = new AssistantChat({ status: async () => structuredClone(status), send, later });
	return c;
}

const PROPOSAL: AssistantProposal = {
	goal: 'recalibration',
	title: 'Recalibration: GR4J X1',
	changes: [{ label: 'GR4J X1', lines: ['GR4J X1: 350 → 420'], reason: 'A larger store damps the response.' }],
	apply: { kind: 'settings', patch: { gr4j: { x1: 420 } } }
};

describe('AssistantChat', () => {
	it('is available only once the status says so, and hides on a status it can’t read', async () => {
		const on = chatWith(async () => streamOf(''));
		expect(on.available).toBe(false);
		await on.load();
		expect(on.available).toBe(true);
		expect(on.canApply).toBe(true);
		expect(on.tokensLeft).toBe(900);

		const off = new AssistantChat({ status: async () => ({ available: false }), send: async () => streamOf('') });
		await off.load();
		expect(off.available).toBe(false);
		const failed = new AssistantChat({ status: async () => Promise.reject(new ApiError(403, 'no')), send: async () => streamOf('') });
		await failed.load();
		expect(failed.status).toEqual({ available: false });
	});

	it('streams a turn: tool lines started and finished, the text, a proposal, and the budget from usage', async () => {
		const send = vi.fn(async (_body: AssistantRequest, _signal: AbortSignal) =>
			streamOf(
				sse([
					{ type: 'tool', name: 'get_network', label: 'Reading the network', status: 'start' },
					{ type: 'tool', name: 'get_network', label: 'Reading the network', status: 'done' },
					{ type: 'tool', name: 'get_gauge_fit', label: 'Scoring the fit', status: 'start' },
					{ type: 'tool', name: 'get_gauge_fit', label: 'Scoring the fit', status: 'error' },
					{ type: 'text', delta: 'The gauge ' },
					{ type: 'text', delta: 'is fed by a dam.' },
					{ type: 'proposal', proposal: PROPOSAL },
					{ type: 'usage', inputTokens: 50, outputTokens: 20, tokensUsed: 170, tokensPerMonth: 1000, scope: 'project' },
					{ type: 'done' }
				])
			)
		);
		const c = chatWith(send);
		await c.load();
		expect(await c.ask('  Why no response?  ', 'run-1')).toBe(true);
		expect(send).toHaveBeenCalledWith({ messages: [{ role: 'user', content: 'Why no response?' }], runId: 'run-1' }, expect.any(AbortSignal));
		expect(c.busy).toBe(false);
		const t = c.turns[1] as AssistantTurn;
		expect(t.tools).toEqual([
			{ name: 'get_network', label: 'Reading the network', status: 'done' },
			{ name: 'get_gauge_fit', label: 'Scoring the fit', status: 'error' }
		]);
		expect(t.text).toBe('The gauge is fed by a dam.');
		expect(t.proposals).toEqual([{ proposal: PROPOSAL, applied: false }]);
		expect(t.done).toBe(true);
		expect(t.error).toBeNull();
		expect(c.tokensLeft).toBe(830);
	});

	it('sends the whole conversation each turn, leaving out a question that got no answer', async () => {
		let reply: AssistantStreamEvent[] = [{ type: 'text', delta: 'First answer.' }, { type: 'done' }];
		const send = vi.fn(async (_body: AssistantRequest, _signal: AbortSignal) => streamOf(sse(reply)));
		const c = chatWith(send);
		await c.load();
		await c.ask('One?');
		reply = [{ type: 'error', code: 'assistant_failed', error: 'The model had a problem.' }];
		await c.ask('Two?');
		expect((c.turns[3] as AssistantTurn).error).toBe('The model had a problem.');
		reply = [{ type: 'text', delta: 'Third answer.' }, { type: 'done' }];
		await c.ask('Three?');
		expect(send.mock.lastCall![0]).toEqual({
			messages: [
				{ role: 'user', content: 'One?' },
				{ role: 'assistant', content: 'First answer.' },
				{ role: 'user', content: 'Three?' }
			]
		});
	});

	it('says so when the stream ends without its done', async () => {
		const c = chatWith(async () => streamOf(sse([{ type: 'text', delta: 'Half' }])));
		await c.load();
		await c.ask('Q');
		expect((c.turns[1] as AssistantTurn).error).toMatch(/stopped before it finished/);
	});

	it('a 429 before the stream: the question isn’t taken, the wait is shown, and lifts after Retry-After', async () => {
		const timers: { fn: () => void; ms: number }[] = [];
		const c = chatWith(
			async () => Promise.reject(new ApiError(429, 'Too many messages', undefined, 'assistant_rate_limited', { retryAfter: 120, seconds: 120 })),
			STATUS,
			(fn, ms) => timers.push({ fn, ms })
		);
		await c.load();
		expect(await c.ask('Q')).toBe(false);
		expect(c.turns).toEqual([]);
		expect(c.refusal).toEqual({ kind: 'rate', seconds: 120, message: 'Too many messages' });
		// Nothing more goes while it holds.
		expect(timers).toHaveLength(1);
		expect(timers[0]!.ms).toBe(120_000);
		timers[0]!.fn();
		expect(c.refusal).toBeNull();
	});

	it('a 429 without the assistant’s rate code (a WAF block, say) is an error, not the hourly limit', async () => {
		const c = chatWith(async () => Promise.reject(new ApiError(429, 'Too many requests', undefined, null, { retryAfter: 30 })), STATUS);
		await c.load();
		expect(await c.ask('Q')).toBe(false);
		expect(c.refusal).toEqual({ kind: 'error', message: 'Too many requests' });
	});

	it('the month’s budget spent: refused before the stream (by code) or as the status says, and nothing is sent', async () => {
		const send = vi.fn(async (_body: AssistantRequest, _signal: AbortSignal): Promise<ReadableStream<Uint8Array>> => Promise.reject(new ApiError(429, 'Budget spent', undefined, 'assistant_budget_spent')));
		const c = chatWith(send);
		await c.load();
		expect(await c.ask('Q')).toBe(false);
		expect(c.refusal).toMatchObject({ kind: 'budget', scope: 'project' });
		expect(c.spent).toBe(true);
		expect(c.spentScope).toBe('project');
		expect(await c.ask('Again')).toBe(false);
		expect(send).toHaveBeenCalledTimes(1);

		const used = chatWith(send, { ...STATUS, budget: { ...STATUS.budget, tokensUsed: 1000 } } as AssistantStatus);
		await used.load();
		expect(used.spent).toBe(true);
		expect(used.spentScope).toBe('project');
		expect(await used.ask('Q')).toBe(false);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it('names whose month is spent: the person’s across projects, or the server’s, by the refusal’s code', async () => {
		for (const [code, scope] of [
			['assistant_user_budget_spent', 'user'],
			['assistant_total_budget_spent', 'total']
		] as const) {
			const send = vi.fn(async (): Promise<ReadableStream<Uint8Array>> => Promise.reject(new ApiError(429, 'Spent', undefined, code)));
			const c = chatWith(send);
			await c.load();
			expect(await c.ask('Q')).toBe(false);
			expect(c.refusal).toMatchObject({ kind: 'budget', scope });
			expect(c.spentScope).toBe(scope);
			expect(await c.ask('Again')).toBe(false);
			expect(send).toHaveBeenCalledTimes(1);
		}
		// The status's own cap when it is the one used up.
		const used = chatWith(vi.fn(), { ...STATUS, budget: { ...STATUS.budget, tokensUsed: 1000, scope: 'user' } } as AssistantStatus);
		await used.load();
		expect(used.spentScope).toBe('user');
	});

	it('Stop aborts the fetch and keeps what had come', async () => {
		let signal: AbortSignal | null = null;
		const c = chatWith(async (_b, s) => {
			signal = s;
			return new ReadableStream<Uint8Array>({
				start(ctrl) {
					ctrl.enqueue(new TextEncoder().encode(sse([{ type: 'text', delta: 'Partial' }, { type: 'tool', name: 'get_series', label: 'Reading a series', status: 'start' }])));
					s.addEventListener('abort', () => ctrl.error(new DOMException('aborted', 'AbortError')));
				}
			});
		});
		await c.load();
		const going = c.ask('Q');
		await vi.waitFor(() => expect((c.turns[1] as AssistantTurn | undefined)?.text).toBe('Partial'));
		expect(c.busy).toBe(true);
		c.stop();
		expect(await going).toBe(true);
		expect(signal!.aborted).toBe(true);
		const t = c.turns[1] as AssistantTurn;
		expect(t.stopped).toBe(true);
		expect(t.text).toBe('Partial');
		expect(t.error).toBeNull();
		// The tool it was running when stopped didn't finish.
		expect(t.tools[0]!.status).toBe('error');
		expect(c.busy).toBe(false);
	});

	it('words a wait', () => {
		expect(waitText(20)).toBe('20 s');
		expect(waitText(90)).toBe('2 min');
		expect(waitText(3600)).toBe('1 h');
		expect(waitText(5400)).toBe('1 h 30 min');
	});
});

// Past chats in this browser (history.ts): each turn is kept when it ends, under the person and project; a
// reopened chat continues with the existing send path; its changes are read-only; storage that fails turns
// history off and the conversation carries on.
describe('AssistantChat past chats', () => {
	function memory(): HistoryBackend & { rows: Map<string, ChatRecord> } {
		const rows = new Map<string, ChatRecord>();
		return {
			rows,
			all: async () => [...rows.values()].map((r) => structuredClone(r)),
			put: async (r) => void rows.set(r.key, structuredClone(r)),
			remove: async (keys) => keys.forEach((k) => rows.delete(k))
		};
	}
	const answerWith = (text: string, extra: AssistantStreamEvent[] = []) => async () => streamOf(sse([{ type: 'text', delta: text }, ...extra, { type: 'done' }]));
	let n = 0;
	function chatOn(be: HistoryBackend | null, send: (body: AssistantRequest, signal: AbortSignal) => Promise<ReadableStream<Uint8Array>> = answerWith('An answer.'), userId = 'user-a', projectId = 'p1') {
		return new AssistantChat({
			status: async () => structuredClone(STATUS),
			send,
			history: async () => (be ? new ChatHistory(be, userId, projectId) : null),
			newId: () => `chat-${++n}`
		});
	}

	it('keeps each answered turn, and lists it for this person only', async () => {
		const be = memory();
		const a = chatOn(be);
		await a.load();
		await a.loadPast();
		expect(a.past).toEqual([]);
		expect(await a.ask('Why is the outlet flat?')).toBe(true);
		expect(a.id).not.toBeNull();
		expect(a.past?.map((p) => p.title)).toEqual(['Why is the outlet flat?']);

		// Positive control: A, on a fresh page, sees it; B on the same browser and project sees none.
		const again = chatOn(be);
		await again.loadPast();
		expect(again.past?.map((p) => p.title)).toEqual(['Why is the outlet flat?']);
		const b = chatOn(be, undefined, 'user-b');
		await b.loadPast();
		expect(b.past).toEqual([]);
	});

	it('reopens a past chat and continues it: the next turn sends the transcript and updates the same chat', async () => {
		const be = memory();
		const first = chatOn(be);
		await first.load();
		await first.ask('First question');
		const id = first.id!;

		const send = vi.fn(answerWith('A second answer.'));
		const page = chatOn(be, send);
		await page.load();
		await page.loadPast();
		expect(await page.reopen(id)).toBe(true);
		expect(page.id).toBe(id);
		expect(page.turns.map((t) => t.text)).toEqual(['First question', 'An answer.']);
		await page.ask('A follow-up');
		expect(send.mock.calls[0]![0].messages).toEqual([
			{ role: 'user', content: 'First question' },
			{ role: 'assistant', content: 'An answer.' },
			{ role: 'user', content: 'A follow-up' }
		]);
		expect(page.past).toHaveLength(1);
		expect(be.rows.get(`user-a/p1/${id}`)!.turns.map((t) => t.text)).toEqual(['First question', 'An answer.', 'A follow-up', 'A second answer.']);
	});

	it('a reopened chat’s recommended change is read-only: nothing to apply', async () => {
		const be = memory();
		const first = chatOn(be, answerWith('One change.', [{ type: 'proposal', proposal: PROPOSAL }]));
		await first.load();
		await first.ask('Recommend something');
		const live = (first.turns[1] as AssistantTurn).proposals[0]!;
		// Positive control: in the conversation it came in, the change applies.
		expect(applicable(live)).toEqual(PROPOSAL);

		const later = chatOn(be);
		await later.reopen(first.id!);
		const old = (later.turns[1] as AssistantTurn).proposals[0]!;
		expect(old.stale).toBe(true);
		expect(old.proposal.apply).toBeUndefined();
		expect(applicable(old)).toBeNull();
		expect(old.proposal.title).toBe(PROPOSAL.title);
	});

	it('deleting the open chat starts a new conversation; Clear history empties the list', async () => {
		const be = memory();
		const c = chatOn(be);
		await c.load();
		await c.ask('One');
		const one = c.id!;
		c.clear();
		await c.ask('Two');
		expect(c.past?.map((p) => p.title)).toEqual(['Two', 'One']);
		await c.remove(c.id!);
		expect(c.turns).toEqual([]);
		expect(c.id).toBeNull();
		expect(c.past?.map((p) => p.id)).toEqual([one]);
		await c.clearHistory();
		expect(c.past).toEqual([]);
		expect(be.rows.size).toBe(0);
	});

	it('with no storage, history is off and the conversation still works', async () => {
		const none = chatOn(null);
		await none.load();
		await none.loadPast();
		expect(none.historyOff).toBe(true);
		expect(none.past).toBeNull();
		expect(await none.ask('Still there?')).toBe(true);
		expect((none.turns[1] as AssistantTurn).text).toBe('An answer.');
	});

	it('storage that throws turns history off; the answer still shows', async () => {
		const broken: HistoryBackend = {
			all: () => Promise.reject(new DOMException('blocked', 'SecurityError')),
			put: () => Promise.reject(new Error('full')),
			remove: () => Promise.reject(new Error('blocked'))
		};
		const c = chatOn(broken);
		await c.load();
		await c.loadPast();
		expect(c.historyOff).toBe(true);
		expect(await c.ask('Does it answer?')).toBe(true);
		expect((c.turns[1] as AssistantTurn).text).toBe('An answer.');
		expect(await c.reopen('anything')).toBe(false);

		// A loader that throws (IndexedDB missing in a sandboxed frame) is the same.
		const thrower = new AssistantChat({ status: async () => structuredClone(STATUS), send: answerWith('Fine.'), history: () => Promise.reject(new Error('no idb')) });
		await thrower.load();
		await thrower.loadPast();
		expect(thrower.historyOff).toBe(true);
		expect(await thrower.ask('Hello')).toBe(true);
	});

	it('sends at most the server’s message count, starting at a question', () => {
		const many = Array.from({ length: MAX_SENT_MESSAGES + 5 }, (_, i) => ({ role: i % 2 ? ('assistant' as const) : ('user' as const), content: `m${i}` }));
		many.push({ role: 'user', content: 'last' });
		const sent = capMessages(many);
		expect(sent.length).toBeLessThanOrEqual(MAX_SENT_MESSAGES);
		expect(sent[0]!.role).toBe('user');
		expect(sent.at(-1)!.content).toBe('last');
		const few = [{ role: 'user' as const, content: 'q' }];
		expect(capMessages(few)).toBe(few);
	});
});
