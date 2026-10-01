// A stand-in for the Lambda Node.js runtime's response streaming (the
// `awslambda` global), to drive http/lambdaStream.ts the way a Function URL in
// RESPONSE_STREAM mode does: the handler gets a writable response stream,
// `HttpResponseStream.from` takes the prelude, and what the client receives is
// what was written before the stream ended. A failed invocation (the handler
// rejects) or a destroyed stream is a cut-off response.
import { Writable } from 'node:stream';
import type { Context as LambdaContext, LambdaFunctionURLEvent } from 'aws-lambda';
import { streamingHandler, type StreamMetadata, type StreamingRuntime } from '../http/lambdaStream.js';

type StreamedHandler = (event: LambdaFunctionURLEvent, responseStream: Writable, context: LambdaContext) => Promise<void>;

export const fakeRuntime: StreamingRuntime = {
	streamifyResponse: (handler) => handler,
	HttpResponseStream: {
		from(responseStream, metadata) {
			(responseStream as Writable & { metadata?: StreamMetadata }).metadata = metadata;
			return responseStream;
		}
	}
};

/** What the client of one streamed invocation got. */
export interface Streamed {
	metadata: StreamMetadata | null;
	body: Buffer;
	/** Writes, the empty ones included. */
	writes: number;
	/** The stream ended normally (finished), rather than being destroyed or left open. */
	ended: boolean;
	/** The invocation's error, when the handler rejected. */
	error: unknown;
}

/** A Function URL event (payload format 2.0). */
export function urlEvent(
	rawPath: string,
	{ method = 'GET', headers = {}, cookies, query = '', body }: { method?: string; headers?: Record<string, string>; cookies?: string[]; query?: string; body?: string } = {}
): LambdaFunctionURLEvent {
	const domainName = 'example.lambda-url.af-south-1.on.aws';
	return {
		version: '2.0',
		routeKey: '$default',
		rawPath,
		rawQueryString: query,
		...(cookies ? { cookies } : {}),
		headers: { host: domainName, ...headers },
		requestContext: {
			accountId: 'anonymous',
			apiId: 'example',
			domainName,
			domainPrefix: 'example',
			http: { method, path: rawPath, protocol: 'HTTP/1.1', sourceIp: '192.0.2.1', userAgent: 'test' },
			requestId: 'r',
			routeKey: '$default',
			stage: '$default',
			time: '',
			timeEpoch: 0
		},
		...(body === undefined ? {} : { body, isBase64Encoded: false })
	} as LambdaFunctionURLEvent;
}

/** Invoke `app` through the streaming adapter, as one Function URL request. */
export async function invokeStreamed(app: Parameters<typeof streamingHandler>[0], event: LambdaFunctionURLEvent): Promise<Streamed> {
	const handler = streamingHandler(app, fakeRuntime) as StreamedHandler;
	const parts: Buffer[] = [];
	let writes = 0;
	const stream = new Writable({
		write(chunk: Buffer, _enc, done) {
			writes++;
			parts.push(Buffer.from(chunk));
			done();
		}
	}) as Writable & { metadata?: StreamMetadata };
	let ended = false;
	stream.on('finish', () => (ended = true));
	stream.on('error', () => {});
	let error: unknown = null;
	try {
		await handler(event, stream, {} as LambdaContext);
	} catch (e) {
		error = e;
	}
	return { metadata: stream.metadata ?? null, body: Buffer.concat(parts), writes, ended, error };
}
