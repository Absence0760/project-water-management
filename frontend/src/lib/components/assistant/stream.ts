// The assistant's answer as it streams (issue #610, docs/api.md § Assistant):
// a `text/event-stream` read with fetch and a ReadableStream on a POST
// (api.assistant.send), not EventSource, which can only GET and so would skip
// the CSRF and auth handling every other POST goes through. Each event is
// `event: <type>` then `data: <json>` and a blank line; a line starting with
// `:` is a comment (the server's keepalive every ~15 s) and is ignored. A
// chunk may end anywhere, mid-line or mid-character, so the decoder streams
// and lines are cut only at a newline.
import type { AssistantStreamEvent } from '#lib/api/types.js';

/** One event as the stream framed it: its `event:` name (default `message`) and its `data:` lines joined. */
export interface SseFrame {
	event: string;
	data: string;
}

/**
 * The SSE framing, fed text in pieces: `push` returns the events the text completed, and keeps the rest
 * (a partial line, an event whose blank line hasn't come) for the next piece. Per the HTML spec's
 * event-stream rules: CRLF, CR or LF end a line; `field: value` drops one leading space; several `data:`
 * lines join with `\n`; `id` and `retry` are ignored (the panel never reconnects); an event with no data
 * isn't dispatched.
 */
export class SseParser {
	#buf = '';
	#event = '';
	#data: string[] = [];
	/** A CR ended the last piece: an LF opening the next one is the same line end. */
	#cr = false;

	push(text: string): SseFrame[] {
		if (this.#cr && text.startsWith('\n')) text = text.slice(1);
		this.#cr = false;
		this.#buf += text;
		const out: SseFrame[] = [];
		for (;;) {
			const m = /\r\n|\r|\n/.exec(this.#buf);
			if (!m) break;
			// A lone CR at the very end may be the first half of a CRLF split across pieces.
			if (m[0] === '\r' && m.index === this.#buf.length - 1) this.#cr = true;
			const line = this.#buf.slice(0, m.index);
			this.#buf = this.#buf.slice(m.index + m[0].length);
			const frame = this.#line(line);
			if (frame) out.push(frame);
		}
		return out;
	}

	/** The stream ended: an event still waiting for its blank line is dropped, as the spec says. */
	end(): SseFrame[] {
		this.#buf = '';
		this.#event = '';
		this.#data = [];
		return [];
	}

	#line(line: string): SseFrame | null {
		if (line === '') {
			const frame = this.#data.length ? { event: this.#event || 'message', data: this.#data.join('\n') } : null;
			this.#event = '';
			this.#data = [];
			return frame;
		}
		if (line.startsWith(':')) return null;
		const colon = line.indexOf(':');
		const field = colon < 0 ? line : line.slice(0, colon);
		let value = colon < 0 ? '' : line.slice(colon + 1);
		if (value.startsWith(' ')) value = value.slice(1);
		if (field === 'event') this.#event = value;
		else if (field === 'data') this.#data.push(value);
		return null;
	}
}

const TYPES = new Set(['text', 'tool', 'proposal', 'usage', 'error', 'done']);

/** One frame as the assistant's event, or null for one this page doesn't know (a newer server's) or can't read. */
export function toEvent(frame: SseFrame): AssistantStreamEvent | null {
	let data: unknown;
	try {
		data = JSON.parse(frame.data);
	} catch {
		return null;
	}
	if (!data || typeof data !== 'object') return null;
	const type = (data as { type?: unknown }).type ?? frame.event;
	if (typeof type !== 'string' || !TYPES.has(type)) return null;
	return { ...(data as object), type } as AssistantStreamEvent;
}

/** The assistant's events from the POST's body, in order, until the stream ends (or its fetch is aborted, which throws). */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<AssistantStreamEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const sse = new SseParser();
	let finished = false;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			finished = done;
			const frames = done ? [...sse.push(decoder.decode()), ...sse.end()] : sse.push(decoder.decode(value, { stream: true }));
			for (const f of frames) {
				const ev = toEvent(f);
				if (ev) yield ev;
			}
			if (done) return;
		}
	} finally {
		// A consumer that stops early (Stop, the panel closing) cancels the rest of the stream.
		if (!finished) reader.cancel().catch(() => {});
	}
}
