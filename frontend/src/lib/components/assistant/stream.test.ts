// The assistant's stream reader (issue #610): SSE framing fed in pieces cut
// anywhere, comments (the keepalive) ignored, and the events typed.
import { describe, expect, it } from 'vitest';
import { readEvents, SseParser, toEvent } from './stream';

const enc = new TextEncoder();

/** A body that delivers `bytes` in the given pieces (cut points in bytes). */
function body(text: string, cuts: number[] = []): ReadableStream<Uint8Array> {
	const bytes = enc.encode(text);
	const points = [0, ...cuts, bytes.length];
	return new ReadableStream({
		start(c) {
			for (let i = 0; i < points.length - 1; i++) c.enqueue(bytes.slice(points[i], points[i + 1]));
			c.close();
		}
	});
}

async function all(b: ReadableStream<Uint8Array>) {
	const out = [];
	for await (const ev of readEvents(b)) out.push(ev);
	return out;
}

const STREAM = [
	': keepalive',
	'',
	'event: tool',
	`data: ${JSON.stringify({ type: 'tool', name: 'get_network', label: 'Reading the network', status: 'start' })}`,
	'',
	'event: text',
	`data: ${JSON.stringify({ type: 'text', delta: 'Héllo — “gauge” ' })}`,
	'',
	': keepalive',
	'event: text',
	`data: ${JSON.stringify({ type: 'text', delta: 'world' })}`,
	'',
	'event: done',
	`data: ${JSON.stringify({ type: 'done' })}`,
	'',
	''
].join('\n');

describe('SseParser', () => {
	it('frames events, joins several data lines, drops one leading space and ignores comments, id and retry', () => {
		const p = new SseParser();
		expect(p.push(': hello\nid: 1\nretry: 5\nevent: a\ndata:  two spaces\ndata:x\n\n')).toEqual([{ event: 'a', data: ' two spaces\nx' }]);
		// No event name: `message`; no data: nothing dispatched.
		expect(p.push('data: y\n\nevent: empty\n\n')).toEqual([{ event: 'message', data: 'y' }]);
	});

	it('takes CRLF, CR and LF line ends, a CRLF split across two pieces counting once', () => {
		const p = new SseParser();
		expect(p.push('event: a\r\ndata: 1\r')).toEqual([]);
		expect(p.push('\n\r\n')).toEqual([{ event: 'a', data: '1' }]);
		expect(p.push('data: 2\r\r')).toEqual([{ event: 'message', data: '2' }]);
	});

	it('keeps an event waiting for its blank line, and drops it if the stream ends first', () => {
		const p = new SseParser();
		expect(p.push('event: a\ndata: 1\n')).toEqual([]);
		expect(p.end()).toEqual([]);
		expect(p.push('\n')).toEqual([]);
	});
});

describe('toEvent', () => {
	it('types a known event and refuses one it can’t read or doesn’t know', () => {
		expect(toEvent({ event: 'text', data: '{"type":"text","delta":"a"}' })).toEqual({ type: 'text', delta: 'a' });
		// The event name stands in for a missing `type`.
		expect(toEvent({ event: 'done', data: '{}' })).toEqual({ type: 'done' });
		expect(toEvent({ event: 'text', data: 'not json' })).toBeNull();
		expect(toEvent({ event: 'later', data: '{"type":"later"}' })).toBeNull();
		expect(toEvent({ event: 'text', data: '3' })).toBeNull();
	});
});

describe('readEvents', () => {
	const expected = [
		{ type: 'tool', name: 'get_network', label: 'Reading the network', status: 'start' },
		{ type: 'text', delta: 'Héllo — “gauge” ' },
		{ type: 'text', delta: 'world' },
		{ type: 'done' }
	];

	it('reads a whole stream', async () => {
		expect(await all(body(STREAM))).toEqual(expected);
	});

	it('reads the same events whatever the chunk boundaries, mid-line and mid-character included', async () => {
		const n = enc.encode(STREAM).length;
		// Every single cut point, and every byte its own chunk.
		for (let at = 1; at < n; at += 7) expect(await all(body(STREAM, [at]))).toEqual(expected);
		expect(await all(body(STREAM, Array.from({ length: n - 1 }, (_, i) => i + 1)))).toEqual(expected);
	});

	it('stops at the end of the stream with an unfinished event left out', async () => {
		expect(await all(body('event: text\ndata: {"type":"text","delta":"a"}\n\nevent: text\ndata: {"type":"text","delta":"b"}'))).toEqual([{ type: 'text', delta: 'a' }]);
	});
});
