// The renderer Lambda's message handling (lambda-renderer.ts), with the
// browser, storage and queue stubbed: the render itself is covered against
// real Chromium and MinIO in reports/render.db.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';

const sent: { url: string | undefined; message: unknown }[] = [];
const sendToQueue = vi.fn(async (url: string | undefined, _name: string, message: unknown) => {
	sent.push({ url, message });
});
vi.mock('./jobs/transport.js', async (orig) => ({ ...(await orig<typeof import('./jobs/transport.js')>()), sendToQueue: (u: string, n: string, m: unknown) => sendToQueue(u, n, m) }));
const renderReportPdf = vi.fn();
vi.mock('./reports/render.js', async (orig) => ({ ...(await orig<typeof import('./reports/render.js')>()), renderReportPdf: (...a: unknown[]) => renderReportPdf(...a) }));
const putPdf = vi.fn(async (_key: string, _body: Uint8Array) => {});
vi.mock('./reports/storage.js', async (orig) => ({ ...(await orig<typeof import('./reports/storage.js')>()), putPdf: (k: string, b: Uint8Array) => putPdf(k, b) }));

const { handler } = await import('./lambda-renderer.js');
const { RenderError } = await import('./reports/render.js');

afterEach(() => {
	sent.length = 0;
	sendToQueue.mockClear();
	renderReportPdf.mockReset();
	putPdf.mockClear();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

const ids = { reportId: '00000000-0000-4000-8000-000000000001', projectId: '00000000-0000-4000-8000-000000000002', runId: '00000000-0000-4000-8000-000000000003' };
const TOKEN = 'a'.repeat(43);
const request = { v: 1, type: 'render', ...ids, token: TOKEN };
const record = (messageId: string, body: unknown) => ({ messageId, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('renderer Lambda', () => {
	it('renders, stores under the derived key, and answers with the outcome only (never the token)', async () => {
		vi.stubEnv('RENDER_RESULTS_QUEUE_URL', 'https://sqs.example/render-results');
		const log = vi.spyOn(console, 'info').mockImplementation(() => {});
		renderReportPdf.mockResolvedValueOnce({ pdf: Buffer.from('%PDF-1.7 x'), pages: 9, ms: 4200 });
		const res = await handler({ Records: [record('m1', request)] } as never);
		expect(res).toEqual({ batchItemFailures: [] });
		expect(renderReportPdf).toHaveBeenCalledWith({ projectId: ids.projectId, runId: ids.runId, token: TOKEN }, expect.objectContaining({ timeoutMs: 90_000 }));
		expect(putPdf).toHaveBeenCalledWith(`reports/${ids.projectId}/${ids.reportId}.pdf`, expect.any(Buffer));
		expect(sent).toEqual([
			{ url: 'https://sqs.example/render-results', message: { v: 1, type: 'rendered', reportId: ids.reportId, result: { ok: true, pages: 9, bytes: 10, ms: 4200 } } }
		]);
		expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
	});

	it('answers a failed render as a failure (its token is spent: no SQS retry)', async () => {
		vi.spyOn(console, 'info').mockImplementation(() => {});
		renderReportPdf.mockRejectedValueOnce(new RenderError('the render took longer than 90 s'));
		const res = await handler({ Records: [record('m1', request)] } as never);
		expect(res).toEqual({ batchItemFailures: [] });
		expect(putPdf).not.toHaveBeenCalled();
		expect(sent[0]!.message).toEqual({ v: 1, type: 'rendered', reportId: ids.reportId, result: { ok: false, error: 'the render took longer than 90 s', retry: true } });
	});

	it('says only "could not be stored" when storage fails', async () => {
		vi.spyOn(console, 'info').mockImplementation(() => {});
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		renderReportPdf.mockResolvedValueOnce({ pdf: Buffer.from('%PDF'), pages: 1, ms: 1 });
		putPdf.mockRejectedValueOnce(new Error('AccessDenied: arn:aws:s3:::bucket/key'));
		await handler({ Records: [record('m1', request)] } as never);
		expect(sent[0]!.message).toMatchObject({ result: { ok: false, error: 'the PDF could not be stored' } });
		expect(err).toHaveBeenCalled();
	});

	it('drops a request it cannot parse, and retries only a failed answer', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'info').mockImplementation(() => {});
		renderReportPdf.mockResolvedValue({ pdf: Buffer.from('%PDF'), pages: 1, ms: 1 });
		sendToQueue.mockRejectedValueOnce(new Error('RENDER_RESULTS_QUEUE_URL is not set'));
		const res = await handler({ Records: [record('m0', 'garbage'), record('m1', { ...request, token: 'short' }), record('m2', request), record('m3', request)] } as never);
		expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'render_request_ignored', messageId: 'm0' }));
		expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'render_request_ignored', messageId: 'm1' }));
		expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm2' }] });
	});
});
