// The API's Lambda adapter in response-streaming mode (WP-1.29a, issue #283).
// The Function URL's invoke mode is RESPONSE_STREAM (infra/lambda.tf), so a
// response may pass the 6 MB a buffered one stops at, and a streamed body (the
// CSV exports, export/download.ts) is written as the client reads it, the way
// the Node server writes it locally.
//
// Hono ships one (`streamHandle` from hono/aws-lambda), and this follows it:
// the same Request from a Function URL event (payload format 2.0) and the same
// prelude (status, headers, and Set-Cookie as its `cookies` list). It differs
// where a download's integrity is at stake. When the body fails partway,
// Hono's writes "Internal Server Error" after what was sent and ends the
// response normally, so a broken CSV would arrive looking complete; this one
// lets the failure reach the runtime, which cuts the response off (the
// client's download fails) and counts the invocation as an error (the API's
// Errors alarm, infra/alarms.tf). Every response is first written an empty
// string (Hono does it for a null body only): a streamed Function URL response with
// nothing written stays open until the function times out
// (aws-lambda-nodejs-runtime-interface-client issue #95).
//
// lambda.ts is the only production caller; lambdaStream.test.ts drives the
// whole app through it with a stand-in for the runtime's `awslambda` global.
import { Readable, type Writable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { Context as LambdaContext, LambdaFunctionURLEvent } from 'aws-lambda';

/** What `HttpResponseStream.from` takes: the response's prelude. */
export interface StreamMetadata {
	statusCode: number;
	headers: Record<string, string>;
	cookies: string[];
}

/** The part of the Node.js runtime's `awslambda` global this adapter uses. */
export interface StreamingRuntime {
	streamifyResponse(handler: (event: LambdaFunctionURLEvent, responseStream: Writable, context: LambdaContext) => Promise<void>): unknown;
	HttpResponseStream: { from(responseStream: Writable, metadata: StreamMetadata): Writable };
}

/** Anything with Hono's `fetch(request, env)`. */
interface FetchApp {
	fetch(request: Request, env?: unknown): Response | Promise<Response>;
}

declare const awslambda: StreamingRuntime | undefined;

/** The Request a Function URL event stands for (Hono's EventV2Processor, payload format 2.0). */
export function functionUrlRequest(event: LambdaFunctionURLEvent): Request {
	const headers = new Headers();
	if (Array.isArray(event.cookies) && event.cookies.length) headers.set('cookie', event.cookies.join('; '));
	for (const [k, v] of Object.entries(event.headers ?? {})) if (v) headers.set(k, v);
	const host = event.requestContext?.domainName ?? headers.get('host');
	const url = `https://${host}${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ''}`;
	const init: RequestInit = { method: event.requestContext.http.method, headers };
	if (event.body) {
		const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body, 'utf8');
		headers.set('content-length', String(body.byteLength));
		init.body = body;
	}
	return new Request(url, init);
}

/** The prelude of `res`: Set-Cookie goes in `cookies` (one entry each), every other header in `headers`. */
export function streamMetadata(res: Response): StreamMetadata {
	const headers: Record<string, string> = {};
	res.headers.forEach((value, name) => {
		if (name !== 'set-cookie') headers[name] = value;
	});
	return { statusCode: res.status, headers, cookies: res.headers.getSetCookie() };
}

/**
 * The streaming Lambda handler for `app`. `runtime` is the Node.js runtime's
 * `awslambda` global (only Lambda defines it); tests pass a stand-in.
 */
export function streamingHandler(app: FetchApp, runtime: StreamingRuntime | undefined = typeof awslambda === 'undefined' ? undefined : awslambda) {
	if (!runtime) throw new Error('streamingHandler: no awslambda global (response streaming runs only in the Lambda Node.js runtime)');
	return runtime.streamifyResponse(async (event, responseStream, context) => {
		let req: Request;
		try {
			req = functionUrlRequest(event);
		} catch (error) {
			// As hono/aws-lambda's buffered `handle`: an event that makes no Request is the caller's fault.
			console.error('Error processing request:', error);
			const out = runtime.HttpResponseStream.from(responseStream, { statusCode: 400, headers: { 'content-type': 'text/plain; charset=UTF-8' }, cookies: [] });
			out.end('Invalid request');
			await finished(out);
			return;
		}
		// The app maps every route error to a response itself (http/errors.ts handleError), so this
		// only rejects on a fault outside it; that rejection fails the invocation as it should.
		const res = await app.fetch(req, { event, requestContext: event.requestContext, lambdaContext: context });
		const out = runtime.HttpResponseStream.from(responseStream, streamMetadata(res));
		// Written for every response, not only a null body: an empty-string or empty-buffer body is
		// non-null yet writes nothing, and the URL would hang on it the same way.
		out.write('');
		if (!res.body) {
			out.end();
			await finished(out);
			return;
		}
		// pipeline destroys `out` if the body fails, and the rejection reaches the runtime: the
		// client's response is cut off instead of ending as if complete.
		await pipeline(Readable.fromWeb(res.body as NodeReadableStream<Uint8Array>), out);
	});
}
