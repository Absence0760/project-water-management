// The assistant's event stream (issue #610; docs/api.md § Assistant): each
// AssistantStreamEvent is `event: <type>\ndata: <json>\n\n`, and a
// `: keepalive` comment goes out every keepaliveSeconds while the turn is
// quiet, so CloudFront's 35 s origin read timeout never cuts a long tool call
// off. The body is a plain ReadableStream, which @hono/node-server pipes
// locally and http/lambdaStream.ts pipes in Lambda (RESPONSE_STREAM), one
// code path as the CSV downloads (export/download.ts).
//
// The browser reads it with fetch on a POST (the CSRF and auth middleware
// apply), not EventSource, so nothing here needs `id:` or `retry:`.
import type { AssistantStreamEvent } from './types.js';

export const KEEPALIVE = ': keepalive\n\n';

/**
 * One event on the wire. JSON.stringify escapes every line break inside a
 * string, so `data:` is always one line; U+2028/2029 are escaped too, since
 * some SSE readers split on them.
 */
export function encodeEvent(event: AssistantStreamEvent): string {
	const json = JSON.stringify(event).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
	return `event: ${event.type}\ndata: ${json}\n\n`;
}

/** What a turn writes with: `send` never throws, and does nothing once the client has gone. */
export interface SseWriter {
	send(event: AssistantStreamEvent): void;
	/** Aborted when the client disconnects (the stream was cancelled). */
	signal: AbortSignal;
}

export interface SseOptions {
	keepaliveSeconds: number;
	/** The request's own signal (aborted on a disconnect by the Node server); joined with the stream's cancel. */
	requestSignal?: AbortSignal;
}

/**
 * A text/event-stream body that runs `turn`. The stream closes when `turn`
 * settles; `turn` must catch its own errors (whatever escapes is dropped
 * here, never written to the client, since its text could be anything).
 */
export function sseBody(opts: SseOptions, turn: (out: SseWriter) => Promise<void>): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const gone = new AbortController();
	const onRequestAbort = () => gone.abort();
	if (opts.requestSignal?.aborted) gone.abort();
	else opts.requestSignal?.addEventListener('abort', onRequestAbort, { once: true });
	let timer: ReturnType<typeof setInterval> | undefined;
	let closed = false;

	return new ReadableStream<Uint8Array>({
		start(controller) {
			const write = (text: string) => {
				if (closed || gone.signal.aborted) return;
				try {
					controller.enqueue(encoder.encode(text));
				} catch {
					// The consumer went away between the check and the write.
				}
			};
			const finish = () => {
				if (timer) clearInterval(timer);
				opts.requestSignal?.removeEventListener('abort', onRequestAbort);
				if (closed) return;
				closed = true;
				try {
					controller.close();
				} catch {
					// Already cancelled.
				}
			};
			timer = setInterval(() => write(KEEPALIVE), opts.keepaliveSeconds * 1000);
			gone.signal.addEventListener('abort', () => {
				if (timer) clearInterval(timer);
			});
			turn({ send: (e) => write(encodeEvent(e)), signal: gone.signal })
				.catch(() => {})
				.finally(finish);
		},
		cancel() {
			gone.abort();
			if (timer) clearInterval(timer);
		}
	});
}
