// The pack_render handler's decisions (116_pack_render; docs/evidence-pack.md §
// The PDF), with the database, browser, storage and queue stubbed. The SQS
// path and the renderer's answers run against Postgres in
// evidence/packs.db.test.ts; the real print through MinIO in the pack e2e.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { calls } = vi.hoisted(() => ({
	calls: {
		sent: [] as unknown[],
		tokens: [] as { projectId: string; packId: string }[],
		enqueued: [] as Record<string, unknown>[],
		puts: [] as { key: string; bytes: number; sha256: string }[]
	}
}));
const renderReportPdf = vi.fn();
const putPackPdf = vi.fn(async (key: string, body: Uint8Array, sha256: string) => void calls.puts.push({ key, bytes: body.length, sha256 }));
vi.mock('../../reports/render.js', async (orig) => ({ ...(await orig<typeof import('../../reports/render.js')>()), renderReportPdf: (...a: unknown[]) => renderReportPdf(...a) }));
vi.mock('../../reports/storage.js', async (orig) => ({
	...(await orig<typeof import('../../reports/storage.js')>()),
	putPackPdf: (k: string, b: Uint8Array, h: string) => putPackPdf(k, b, h)
}));
vi.mock('../../reports/tokens.js', () => ({
	issuePackRenderToken: async (_db: unknown, projectId: string, packId: string) => (calls.tokens.push({ projectId, packId }), 'T'.repeat(43))
}));
vi.mock('../../db/tx.js', () => ({ withUser: async (_u: string, fn: (db: unknown) => unknown) => fn({}) }));
vi.mock('../transport.js', async (orig) => ({
	...(await orig<typeof import('../transport.js')>()),
	sendToQueue: async (_url: string | undefined, _name: string, message: unknown) => void calls.sent.push(message)
}));
vi.mock('../queue.js', () => ({ enqueueJob: async (_db: unknown, j: Record<string, unknown>) => (calls.enqueued.push(j), { job: { id: 'j2' }, created: true }) }));

const { packRenderHandler } = await import('./pack-render.js');
const { JobError } = await import('../errors.js');
const { RenderError } = await import('../../reports/render.js');

const P = '00000000-0000-4000-8000-000000000002';
const K = '00000000-0000-4000-8000-000000000006';
const job = { id: 'j1', projectId: P, kind: 'pack_render' as const, actingUserId: 'u1', leaseToken: 'l', attempts: 1, maxAttempts: 3 };
const bytes = Buffer.from('%PDF-1.7 an issued pack');
const SHA = createHash('sha256').update(bytes).digest('hex');

/** A database whose pack is in `state`, recording what the handler asks of it. */
function db(state: { issued: boolean; hasPdf: boolean } | null, o: { requestsMade?: number; recorded?: boolean } = {}) {
	const queries: { sql: string; params: unknown[] }[] = [];
	return {
		queries,
		async query(sql: string, params: unknown[] = []) {
			queries.push({ sql, params });
			if (sql.includes('FROM evidence_pack')) return { rows: state ? [state] : [] };
			if (sql.includes('app_record_pack_pdf')) return { rows: [{ recorded: o.recorded ?? true }] };
			if (sql.includes('count(*)')) return { rows: [{ n: o.requestsMade ?? 1 }] };
			throw new Error(`unexpected query: ${sql}`);
		}
	};
}
const run = (d: ReturnType<typeof db>, payload: Record<string, unknown> = { packId: K }) =>
	packRenderHandler.run({ db: d as never, job, payload: packRenderHandler.payload.parse(payload), progress: async () => true });
const recorded = (d: ReturnType<typeof db>) => d.queries.filter((q) => q.sql.includes('app_record_pack_pdf')).map((q) => q.params);

afterEach(() => {
	calls.sent.length = 0;
	calls.tokens.length = 0;
	calls.enqueued.length = 0;
	calls.puts.length = 0;
	renderReportPdf.mockReset();
	putPackPdf.mockClear();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe('pack_render, locally (REPORT_RENDERER=inline)', () => {
	it('prints the pack’s page with a token for it, stores the PDF under its hash, and records that hash and the pages', async () => {
		vi.spyOn(console, 'info').mockImplementation(() => {});
		renderReportPdf.mockResolvedValueOnce({ pdf: bytes, pages: 12, ms: 900 });
		const d = db({ issued: true, hasPdf: false });
		await run(d);
		expect(calls.tokens).toEqual([{ projectId: P, packId: K }]);
		expect(renderReportPdf).toHaveBeenCalledWith({ projectId: P, packId: K, token: 'T'.repeat(43) }, expect.anything());
		expect(calls.puts).toEqual([{ key: `packs/${P}/${K}/${SHA}.pdf`, bytes: bytes.length, sha256: SHA }]);
		expect(recorded(d)).toEqual([[K, SHA, 12]]);
		expect(calls.sent).toEqual([]);
	});

	it('passes a render failure on with its retry flag, and records nothing', async () => {
		renderReportPdf.mockRejectedValueOnce(new RenderError('the render token was refused', { retry: false }));
		const d = db({ issued: true, hasPdf: false });
		await expect(run(d)).rejects.toMatchObject({ constructor: JobError, message: 'the render token was refused', retry: false });
		renderReportPdf.mockRejectedValueOnce(new RenderError('the render took longer than 90 s'));
		await expect(run(d)).rejects.toMatchObject({ retry: true });
		expect(calls.puts).toEqual([]);
		expect(recorded(d)).toEqual([]);
	});

	it('refuses a PDF with no pages, and retries a failed store (MinIO down) without recording', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const d = db({ issued: true, hasPdf: false });
		renderReportPdf.mockResolvedValueOnce({ pdf: bytes, pages: 0, ms: 1 });
		await expect(run(d)).rejects.toThrow('no pages');
		expect(calls.puts).toEqual([]);
		renderReportPdf.mockResolvedValueOnce({ pdf: bytes, pages: 3, ms: 1 });
		putPackPdf.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:9002'));
		await expect(run(d)).rejects.toMatchObject({ message: expect.stringContaining('pnpm dev:s3:up'), retry: true });
		expect(recorded(d)).toEqual([]);
	});
});

describe('pack_render, whatever the renderer', () => {
	it('does nothing for a pack whose PDF is recorded (the first stands): no token, no print', async () => {
		await run(db({ issued: true, hasPdf: true }));
		await run(db({ issued: true, hasPdf: true }), { packId: K, result: { ok: true, pages: 1, bytes: 1, ms: 1, sha256: SHA } });
		expect(calls.tokens).toEqual([]);
		expect(renderReportPdf).not.toHaveBeenCalled();
	});

	it('never prints a pack that was never issued, or one the acting user can no longer see (final)', async () => {
		await expect(run(db({ issued: false, hasPdf: false }))).rejects.toMatchObject({ message: expect.stringMatching(/never issued/), retry: false });
		await expect(run(db(null))).rejects.toMatchObject({ message: expect.stringMatching(/gone/), retry: false });
		expect(calls.tokens).toEqual([]);
	});
});

describe('pack_render in production (REPORT_RENDERER=sqs)', () => {
	it('hands the print to the renderer: a render_pack request with the pack’s token, and no browser here', async () => {
		vi.stubEnv('REPORT_RENDERER', 'sqs');
		vi.stubEnv('RENDER_REQUESTS_QUEUE_URL', 'memory://render-requests');
		await run(db({ issued: true, hasPdf: false }));
		expect(calls.sent).toEqual([{ v: 1, type: 'render_pack', packId: K, projectId: P, token: 'T'.repeat(43) }]);
		expect(renderReportPdf).not.toHaveBeenCalled();
	});

	it('records the renderer’s answer: its hash and pages, never a key', async () => {
		vi.spyOn(console, 'info').mockImplementation(() => {});
		const d = db({ issued: true, hasPdf: false });
		await run(d, { packId: K, result: { ok: true, pages: 7, bytes: 10, ms: 5, sha256: SHA } });
		expect(recorded(d)).toEqual([[K, SHA, 7]]);
		expect(calls.tokens).toEqual([]);
	});

	it('asks again after a retryable failure (2^n minutes), until the requests are used up; a final failure fails at once', async () => {
		const failed = (retry: boolean) => ({ packId: K, result: { ok: false, error: 'the page took too long', retry } });
		await run(db({ issued: true, hasPdf: false }, { requestsMade: 1 }), failed(true));
		expect(calls.enqueued).toEqual([{ projectId: P, kind: 'pack_render', payload: { packId: K }, dedupeKey: `pack_retry:${K}:1`, delaySeconds: 120, maxAttempts: 3 }]);
		await expect(run(db({ issued: true, hasPdf: false }, { requestsMade: 3 }), failed(true))).rejects.toMatchObject({
			message: 'the renderer failed: the page took too long',
			retry: false
		});
		await expect(run(db({ issued: true, hasPdf: false }, { requestsMade: 1 }), failed(false))).rejects.toMatchObject({ retry: false });
		expect(calls.enqueued).toHaveLength(1);
	});
});
