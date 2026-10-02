// The job system's queue messages and the SQS sender every Lambda shares
// (docs/architecture.md § Background jobs). How a worker is woken
// (JOB_TRANSPORT, wakeWorker) lives in wake.ts, apart from this module on
// purpose: wakeWorker's memory transport reaches the job runner (and so `pg`,
// every handler and the engine), and the fetcher and renderer Lambdas, which
// have no database, import this module (lambda-fetcher.test.ts guards it).
//
// The AWS SDK is imported lazily, so local dev and tests never load it.
import { z } from 'zod';
import { FetchRequestSchema } from '../feeds/fetch.js';

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
		/** An impact report's baseline (082). The render session's scope, not this, decides what the page may read. */
		against: z.object({ projectId: Uuid, runId: Uuid }).strict().optional(),
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

// An evidence pack's PDF (119_pack_render; docs/evidence-pack.md § The PDF)
// goes the same way on the same two queues: a PackRenderRequestMessage asks
// the renderer to print the pack's page; it stores the PDF under the key
// derived from the ids and the PDF's SHA-256 (reports/storage.ts packPdfKey)
// and answers with a PackRenderResultMessage carrying that hash, which
// becomes a follow-up `pack_render` job that records it on the pack once
// (app_record_pack_pdf).

export const PackRenderRequestMessage = z
	.object({
		v: z.literal(1),
		type: z.literal('render_pack'),
		packId: Uuid,
		projectId: Uuid,
		/** An applicant's copy (165_applicant_copy): the pack's application, whose party's page is printed and stored under applicantPackPdfKey. */
		scenarioId: Uuid.optional(),
		token: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
	})
	.strict();
export type PackRenderRequestMessage = z.output<typeof PackRenderRequestMessage>;

/** A pack render's outcome: a report's, plus the stored PDF's SHA-256. */
export const PackRenderResult = z.discriminatedUnion('ok', [
	z
		.object({
			ok: z.literal(true),
			pages: z.number().int().min(1).max(10_000),
			bytes: z.number().int().min(1),
			ms: z.number().int().min(0),
			sha256: z.string().regex(/^[0-9a-f]{64}$/)
		})
		.strict(),
	z.object({ ok: z.literal(false), error: z.string().max(300), retry: z.boolean() }).strict()
]);
export type PackRenderResult = z.output<typeof PackRenderResult>;

export const PackRenderResultMessage = z
	.object({
		v: z.literal(1),
		type: z.literal('rendered_pack'),
		packId: Uuid,
		/** The answer is about an applicant's copy (165), not the pack's own PDF. */
		copy: z.literal('applicant').optional(),
		result: PackRenderResult
	})
	.strict();
export type PackRenderResultMessage = z.output<typeof PackRenderResultMessage>;

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
export function parseWorkerMessage(body: string): WakeMessage | IngestResultMessage | RenderResultMessage | PackRenderResultMessage | null {
	const m = parseJson(body) as Partial<WakeMessage> | null;
	if (m && m.v === 1 && m.type === 'wake' && typeof m.jobId === 'string') return { v: 1, type: 'wake', jobId: m.jobId };
	const ingest = IngestResultMessage.safeParse(m);
	if (ingest.success) return ingest.data;
	const rendered = RenderResultMessage.safeParse(m);
	if (rendered.success) return rendered.data;
	const pack = PackRenderResultMessage.safeParse(m);
	return pack.success ? pack.data : null;
}

/** A `render-requests` message body (a report's or a pack's), or null (the renderer logs and drops it). */
export function parseRenderRequest(body: string): RenderRequestMessage | PackRenderRequestMessage | null {
	const json = parseJson(body);
	const m = RenderRequestMessage.safeParse(json);
	if (m.success) return m.data;
	const pack = PackRenderRequestMessage.safeParse(json);
	return pack.success ? pack.data : null;
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

export type Send = (body: string) => Promise<void>;
const sqsSends = new Map<string, Send>();
let sqsClient: Promise<{ client: import('@aws-sdk/client-sqs').SQSClient; Command: typeof import('@aws-sdk/client-sqs').SendMessageCommand }> | undefined;

/** A sender for one queue, cached per URL. Exported for wake.ts only. */
export async function sqs(url: string): Promise<Send> {
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
