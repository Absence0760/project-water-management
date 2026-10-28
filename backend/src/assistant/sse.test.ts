// The assistant's event stream (sse.ts): the wire format types.ts states,
// the keepalive comment while a turn is quiet, and a client that goes away.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeEvent, KEEPALIVE, sseBody } from './sse.js';

async function readAll(body: ReadableStream<Uint8Array>): Promise<string> {
	return new Response(body).text();
}

afterEach(() => vi.useRealTimers());

describe('encodeEvent', () => {
	it('writes `event: <type>` and one `data:` line of the whole event as JSON', () => {
		expect(encodeEvent({ type: 'text', delta: 'Hello' })).toBe('event: text\ndata: {"type":"text","delta":"Hello"}\n\n');
		expect(encodeEvent({ type: 'done' })).toBe('event: done\ndata: {"type":"done"}\n\n');
	});

	it('keeps line breaks (and U+2028/2029) inside the data line escaped, so an event is never split', () => {
		const wire = encodeEvent({ type: 'text', delta: 'one\ntwo\r\nthree\u2028four\u2029' });
		expect(wire.split('\n').filter(Boolean)).toHaveLength(2);
		expect(wire).not.toMatch(/[\u2028\u2029]/);
		const data = wire.split('\n')[1]!.slice('data: '.length);
		expect(JSON.parse(data)).toEqual({ type: 'text', delta: 'one\ntwo\r\nthree\u2028four\u2029' });
	});
});

describe('sseBody', () => {
	it('streams what the turn sends, then closes', async () => {
		const body = sseBody({ keepaliveSeconds: 15 }, async (out) => {
			out.send({ type: 'text', delta: 'a' });
			out.send({ type: 'done' });
		});
		expect(await readAll(body)).toBe(encodeEvent({ type: 'text', delta: 'a' }) + encodeEvent({ type: 'done' }));
	});

	it('sends a keepalive comment every keepaliveSeconds while the turn is quiet', async () => {
		vi.useFakeTimers();
		let release!: () => void;
		const body = sseBody({ keepaliveSeconds: 15 }, () => new Promise<void>((r) => (release = r)));
		const text = readAll(body);
		await vi.advanceTimersByTimeAsync(31_000);
		release();
		await vi.runAllTimersAsync();
		expect(await text).toBe(KEEPALIVE + KEEPALIVE);
		expect(KEEPALIVE.startsWith(':')).toBe(true);
	});

	it('closes without writing anything a turn throws (its text could be anything)', async () => {
		const body = sseBody({ keepaliveSeconds: 15 }, async (out) => {
			out.send({ type: 'text', delta: 'partial' });
			throw new Error('secret database detail');
		});
		const text = await readAll(body);
		expect(text).toBe(encodeEvent({ type: 'text', delta: 'partial' }));
		expect(text).not.toContain('secret');
	});

	it('aborts the turn’s signal when the client cancels, and stops writing', async () => {
		let seen: AbortSignal | undefined;
		let release!: () => void;
		const body = sseBody({ keepaliveSeconds: 15 }, async (out) => {
			seen = out.signal;
			await new Promise<void>((r) => (release = r));
			out.send({ type: 'done' });
		});
		const reader = body.getReader();
		await reader.cancel();
		expect(seen?.aborted).toBe(true);
		release();
	});

	it('aborts the turn’s signal when the request’s own signal aborts (the Node server on a disconnect)', async () => {
		const req = new AbortController();
		let seen: AbortSignal | undefined;
		const body = sseBody({ keepaliveSeconds: 15, requestSignal: req.signal }, async (out) => {
			seen = out.signal;
			req.abort();
			out.send({ type: 'done' });
		});
		expect(await readAll(body)).toBe('');
		expect(seen?.aborted).toBe(true);
	});
});
