// The assistant's conversation (issue #610): a turn streams text, tool lines
// and proposals; the conversation sent leaves out unanswered questions; a
// refusal before the stream (the hourly limit, the budget) puts the question
// back; Stop keeps what came. Runs with the client runtime (a .svelte.test.ts).
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '#lib/api/client.js';
import type { AssistantRequest, AssistantStatus, AssistantStreamEvent } from '#lib/api/types.js';
import { AssistantChat, waitText, type AssistantTurn } from './chat.svelte';

const STATUS: AssistantStatus = {
	available: true,
	provider: 'mock',
	canApply: true,
	budget: { tokensPerMonth: 1000, tokensUsed: 100, resetsAt: '2026-11-01T00:00:00Z' },
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

const PROPOSAL = {
	patch: { gr4j: { x1: 420 } },
	reasons: { gr4j: 'A larger store damps the response.' },
	summary: 'raise GR4J X1 to 420',
	diff: [{ label: 'GR4J X1', before: '350', after: '420' }]
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
					{ type: 'usage', inputTokens: 50, outputTokens: 20, tokensUsed: 170, tokensPerMonth: 1000 },
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
			async () => Promise.reject(new ApiError(429, 'Too many messages', undefined, null, { retryAfter: 120 })),
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

	it('the month’s budget spent: refused before the stream (by code) or as the status says, and nothing is sent', async () => {
		const send = vi.fn(async (_body: AssistantRequest, _signal: AbortSignal): Promise<ReadableStream<Uint8Array>> => Promise.reject(new ApiError(429, 'Budget spent', undefined, 'assistant_budget_spent')));
		const c = chatWith(send);
		await c.load();
		expect(await c.ask('Q')).toBe(false);
		expect(c.refusal?.kind).toBe('budget');
		expect(c.spent).toBe(true);
		expect(await c.ask('Again')).toBe(false);
		expect(send).toHaveBeenCalledTimes(1);

		const used = chatWith(send, { ...STATUS, budget: { ...STATUS.budget, tokensUsed: 1000 } } as AssistantStatus);
		await used.load();
		expect(used.spent).toBe(true);
		expect(await used.ask('Q')).toBe(false);
		expect(send).toHaveBeenCalledTimes(1);
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
