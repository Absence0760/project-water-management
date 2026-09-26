// How a worker hears that a job was queued (JOB_TRANSPORT). The job table is
// the source of truth for every transport: a wake-up only says "look at the
// table now", so a lost wake-up delays a job until the next poll or tick, and
// never loses it.
//
//   inprocess — default. The local worker (worker.ts, `pnpm dev:run:worker`)
//               polls every JOB_POLL_SECONDS and LISTENs on `job_queued`,
//               which the job table's insert trigger NOTIFYs at commit. So
//               wakeWorker() has nothing to do. Postgres only; no AWS.
//   memory    — tests: wakeWorker() runs a tick inline, deterministically.
//   sqs       — production: wakeWorker() sends a wake message to the `jobs`
//               queue (JOBS_QUEUE_URL), which triggers the worker Lambda
//               (lambda-worker.ts). An EventBridge tick every 5 minutes runs
//               the same tick, catching anything whose message was lost.
//
// The AWS SDK is imported lazily, so inprocess/memory never load it.
import { z } from 'zod';
import { FetchRequestSchema } from '../feeds/fetch.js';

export const JOB_TRANSPORTS = ['inprocess', 'memory', 'sqs'] as const;
export type JobTransport = (typeof JOB_TRANSPORTS)[number];

export function jobTransport(value: string | undefined = process.env.JOB_TRANSPORT): JobTransport {
	const v = value?.trim() || 'inprocess';
	if (!(JOB_TRANSPORTS as readonly string[]).includes(v)) {
		throw new Error(`unknown JOB_TRANSPORT "${v}" (expected ${JOB_TRANSPORTS.join(', ')})`);
	}
	return v as JobTransport;
}

/**
 * A message on the `jobs` queue. Versioned; carries ids only, never a payload
 * or anything about the project.
 */
export interface WakeMessage {
	v: 1;
	type: 'wake';
	jobId: string;
}

export const wakeMessage = (jobId: string): WakeMessage => ({ v: 1, type: 'wake', jobId });

// The data feeds' two messages (WP-2.10; docs/architecture.md § Data feeds).
// The worker, in the VPC with no internet, sends a FetchRequestMessage to the
// `fetch-requests` queue; the fetcher Lambda, with internet but no database,
// fetches and sends an IngestResultMessage to `ingest-results`, which the
// worker consumes. Both are bounded in size and validated on receipt: the
// fetcher's output is untrusted input.

const Uuid = z.string().uuid();

export const FetchRequestMessage = z
	.object({
		v: z.literal(1),
		type: z.literal('fetch'),
		fetchJobId: Uuid,
		feedId: Uuid,
		/** The feed's version when the fetch was asked for (feeds/store.ts FeedRow.version). */
		feedVersion: z.string().max(40),
		request: FetchRequestSchema
	})
	.strict();
export type FetchRequestMessage = z.output<typeof FetchRequestMessage>;

export const IngestResultMessage = z
	.object({
		v: z.literal(1),
		type: z.literal('ingest'),
		fetchJobId: Uuid,
		feedId: Uuid,
		feedVersion: z.string().max(40),
		// Validated in full (FetchResult) by the feed_ingest job, which records
		// an invalid one as a failed fetch rather than dropping it silently.
		result: z.unknown()
	})
	.strict();
export type IngestResultMessage = z.output<typeof IngestResultMessage>;

// Server-side reports' two messages (WP-2.15 Phase B; docs/architecture.md §
// Server-side reports). The worker, in the VPC with no internet and no
// Chromium, sends a RenderRequestMessage to `render-requests`; the renderer
// Lambda (a container image with Chromium, outside the VPC, no database)
// prints the report, stores the PDF, and answers with a RenderResultMessage
// on `render-results`, which becomes a follow-up `report_render` job. The
// request carries a single-use, 5-minute render token; the answer carries
// only the outcome (the PDF's key is derived from the ids on both sides).

export const RenderRequestMessage = z
	.object({
		v: z.literal(1),
		type: z.literal('render'),
		reportId: Uuid,
		projectId: Uuid,
		runId: Uuid,
		token: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
	})
	.strict();
export type RenderRequestMessage = z.output<typeof RenderRequestMessage>;

/** A render's outcome. `error` is the renderer's own sanitised text (reports/render.ts RenderError). */
export const RenderResult = z.discriminatedUnion('ok', [
	z.object({ ok: z.literal(true), pages: z.number().int().min(0).max(10_000), bytes: z.number().int().min(0), ms: z.number().int().min(0) }).strict(),
	z.object({ ok: z.literal(false), error: z.string().max(300), retry: z.boolean() }).strict()
]);
export type RenderResult = z.output<typeof RenderResult>;

export const RenderResultMessage = z
	.object({
		v: z.literal(1),
		type: z.literal('rendered'),
		reportId: Uuid,
		result: RenderResult
	})
	.strict();
export type RenderResultMessage = z.output<typeof RenderResultMessage>;

/** SQS's message limit: a body over it can't be sent, so it can't be received either. */
export const MAX_MESSAGE_BYTES = 256 * 1024;

const parseJson = (body: string): unknown => {
	if (body.length > MAX_MESSAGE_BYTES) return null;
	try {
		return JSON.parse(body);
	} catch {
		return null;
	}
};

/** A queue message body the worker understands, or null (logged and dropped by the caller). */
export function parseWorkerMessage(body: string): WakeMessage | IngestResultMessage | RenderResultMessage | null {
	const m = parseJson(body) as Partial<WakeMessage> | null;
	if (m && m.v === 1 && m.type === 'wake' && typeof m.jobId === 'string') return { v: 1, type: 'wake', jobId: m.jobId };
	const ingest = IngestResultMessage.safeParse(m);
	if (ingest.success) return ingest.data;
	const rendered = RenderResultMessage.safeParse(m);
	return rendered.success ? rendered.data : null;
}

/** A `render-requests` message body, or null (the renderer logs and drops it). */
export function parseRenderRequest(body: string): RenderRequestMessage | null {
	const m = RenderRequestMessage.safeParse(parseJson(body));
	return m.success ? m.data : null;
}

/**
 * Where a report_render job prints (REPORT_RENDERER):
 *   inline — the default: in the job itself, with the local Playwright
 *            Chromium, against RENDER_SITE_URL / RENDER_API_URL. Local dev,
 *            CI and e2e.
 *   sqs    — production: the worker has neither Chromium nor internet, so it
 *            hands the render to the renderer Lambda through
 *            RENDER_REQUESTS_QUEUE_URL.
 */
export const REPORT_RENDERERS = ['inline', 'sqs'] as const;
export type ReportRenderer = (typeof REPORT_RENDERERS)[number];

export function reportRenderer(value: string | undefined = process.env.REPORT_RENDERER): ReportRenderer {
	const v = value?.trim() || 'inline';
	if (!(REPORT_RENDERERS as readonly string[]).includes(v)) throw new Error(`unknown REPORT_RENDERER "${v}" (expected ${REPORT_RENDERERS.join(', ')})`);
	return v as ReportRenderer;
}

/** A `fetch-requests` message body, or null (the fetcher logs and drops it). */
export function parseFetchRequest(body: string): FetchRequestMessage | null {
	const m = FetchRequestMessage.safeParse(parseJson(body));
	return m.success ? m.data : null;
}

/**
 * Where a feed_fetch job fetches (FEED_FETCHER):
 *   inline — the default: in the job itself, from FEED_SOURCE (fixtures unless
 *            set to live). Local dev, CI and e2e.
 *   sqs    — production: the worker has no internet, so it hands the request
 *            to the fetcher Lambda through FETCH_REQUESTS_QUEUE_URL.
 */
export const FEED_FETCHERS = ['inline', 'sqs'] as const;
export type FeedFetcher = (typeof FEED_FETCHERS)[number];

export function feedFetcher(value: string | undefined = process.env.FEED_FETCHER): FeedFetcher {
	const v = value?.trim() || 'inline';
	if (!(FEED_FETCHERS as readonly string[]).includes(v)) throw new Error(`unknown FEED_FETCHER "${v}" (expected ${FEED_FETCHERS.join(', ')})`);
	return v as FeedFetcher;
}

/** Send a message to a queue by URL. Throws: the caller decides whether that fails its job. */
export async function sendToQueue(url: string | undefined, name: string, message: object): Promise<void> {
	if (!url) throw new Error(`${name} is not set`);
	const body = JSON.stringify(message);
	if (Buffer.byteLength(body) > MAX_MESSAGE_BYTES) throw new Error(`the message is larger than SQS allows (${MAX_MESSAGE_BYTES} bytes)`);
	await (await sqs(url))(body);
}

type Send = (body: string) => Promise<void>;
const sqsSends = new Map<string, Send>();
let sqsClient: Promise<{ client: import('@aws-sdk/client-sqs').SQSClient; Command: typeof import('@aws-sdk/client-sqs').SendMessageCommand }> | undefined;

async function sqs(url: string): Promise<Send> {
	const known = sqsSends.get(url);
	if (known) return known;
	sqsClient ??= import('@aws-sdk/client-sqs').then(({ SQSClient, SendMessageCommand }) => ({
		// Credentials and region come from the Lambda's role and environment.
		client: new SQSClient({}),
		Command: SendMessageCommand
	}));
	const { client, Command } = await sqsClient;
	const send: Send = async (body) => {
		await client.send(new Command({ QueueUrl: url, MessageBody: body }));
	};
	sqsSends.set(url, send);
	return send;
}

/**
 * Tell a worker a job was queued. Call after the enqueueing transaction
 * commits. Never throws: the job is already safe in the table, and the next
 * poll or tick runs it, so a failed wake-up is logged, not surfaced.
 */
export async function wakeWorker(jobId: string): Promise<void> {
	try {
		switch (jobTransport()) {
			case 'inprocess':
				return; // The insert trigger's NOTIFY already woke it.
			case 'memory': {
				const { runTick } = await import('./runner.js');
				await runTick();
				return;
			}
			case 'sqs': {
				const url = process.env.JOBS_QUEUE_URL;
				if (!url) throw new Error('JOBS_QUEUE_URL is not set');
				await (await sqs(url))(JSON.stringify(wakeMessage(jobId)));
				return;
			}
		}
	} catch (err) {
		console.error(`waking the job worker failed (job ${jobId} runs on the next tick):`, (err as Error).message);
	}
}
