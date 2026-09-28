import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	feedFetcher,
	MAX_MESSAGE_BYTES,
	parseFetchRequest,
	parseRenderRequest,
	parseWorkerMessage,
	reportRenderer,
	sendToQueue,
	wakeMessage
} from './transport.js';

afterEach(() => vi.unstubAllEnvs());

describe('the SQS message shape', () => {
	it('carries a version, a type and the job id, nothing else', () => {
		const id = '00000000-0000-4000-8000-000000000000';
		expect(wakeMessage(id)).toEqual({ v: 1, type: 'wake', jobId: id });
		expect(JSON.parse(JSON.stringify(wakeMessage(id)))).toEqual({ v: 1, type: 'wake', jobId: id });
	});

	it('round-trips, and rejects anything it does not understand', () => {
		const id = '00000000-0000-4000-8000-000000000001';
		expect(parseWorkerMessage(JSON.stringify(wakeMessage(id)))).toEqual(wakeMessage(id));
		// Extra fields are dropped, not passed on.
		expect(parseWorkerMessage(JSON.stringify({ ...wakeMessage(id), payload: { x: 1 } }))).toEqual(wakeMessage(id));
		for (const body of ['not json', 'null', '{}', JSON.stringify({ v: 2, type: 'wake', jobId: id }), JSON.stringify({ v: 1, type: 'fetch', jobId: id }), JSON.stringify({ v: 1, type: 'wake', jobId: 7 })]) {
			expect(parseWorkerMessage(body)).toBeNull();
		}
	});
});

describe('the data-feed messages (fetch-requests / ingest-results)', () => {
	const ids = { fetchJobId: '00000000-0000-4000-8000-000000000002', feedId: '00000000-0000-4000-8000-000000000003', feedVersion: '2026-09-25T06:00:00.000000' };
	const request = { source: 'dws', config: { station: 'X0H000' }, start: '2026-01-01', end: '2026-09-25', today: '2026-09-25' };

	it('parses a fetch request, and refuses a malformed or mismatched one', () => {
		const m = { v: 1, type: 'fetch', ...ids, request };
		expect(parseFetchRequest(JSON.stringify(m))).toEqual(m);
		for (const bad of [
			{ ...m, v: 2 },
			{ ...m, fetchJobId: 'x' },
			{ ...m, request: { ...request, config: { cells: [] } } },
			{ ...m, request: { ...request, start: '2026-13-01' } },
			{ ...m, extra: 1 }
		]) {
			expect(parseFetchRequest(JSON.stringify(bad))).toBeNull();
		}
		expect(parseFetchRequest('garbage')).toBeNull();
	});

	it('the worker understands an ingest result (its result is validated later, by the job) and still drops the unknown', () => {
		const m = { v: 1, type: 'ingest', ...ids, result: { ok: false, error: 'x' } };
		expect(parseWorkerMessage(JSON.stringify(m))).toEqual(m);
		expect(parseWorkerMessage(JSON.stringify({ ...m, feedId: 'not-a-uuid' }))).toBeNull();
		expect(parseWorkerMessage(JSON.stringify({ ...m, type: 'fetch' }))).toBeNull();
		// Over SQS's 256 KB: can't have come from SQS, never parsed.
		expect(parseWorkerMessage(JSON.stringify({ ...m, result: 'x'.repeat(MAX_MESSAGE_BYTES) }))).toBeNull();
	});

	it('FEED_FETCHER defaults to inline (local-first) and knows only inline and sqs', () => {
		expect(feedFetcher(undefined)).toBe('inline');
		expect(feedFetcher('sqs')).toBe('sqs');
		expect(() => feedFetcher('lambda')).toThrow(/unknown FEED_FETCHER/);
	});

	it('sendToQueue refuses without a queue URL, and a message over the SQS limit, before any AWS call', async () => {
		await expect(sendToQueue(undefined, 'FETCH_REQUESTS_QUEUE_URL', {})).rejects.toThrow('FETCH_REQUESTS_QUEUE_URL is not set');
		await expect(sendToQueue('https://sqs.example/q', 'Q', { x: 'y'.repeat(MAX_MESSAGE_BYTES) })).rejects.toThrow(/larger than SQS allows/);
	});
});

describe('the report messages (render-requests / render-results)', () => {
	const ids = { reportId: '00000000-0000-4000-8000-000000000001', projectId: '00000000-0000-4000-8000-000000000002', runId: '00000000-0000-4000-8000-000000000003' };
	const request = { v: 1, type: 'render', ...ids, token: 'A'.repeat(43) };

	it('parses a render request, and refuses a malformed token, an extra field or a wrong type', () => {
		expect(parseRenderRequest(JSON.stringify(request))).toEqual(request);
		expect(parseRenderRequest(JSON.stringify({ ...request, token: 'short' }))).toBeNull();
		// No URL rides the message: the renderer opens its own configured site only.
		expect(parseRenderRequest(JSON.stringify({ ...request, url: 'http://169.254.169.254/' }))).toBeNull();
		expect(parseRenderRequest(JSON.stringify({ ...request, type: 'rendered' }))).toBeNull();
		expect(parseRenderRequest('garbage')).toBeNull();
	});

	it('carries an impact report’s baseline as two ids, nothing else (082)', () => {
		const against = { projectId: '00000000-0000-4000-8000-000000000004', runId: '00000000-0000-4000-8000-000000000005' };
		expect(parseRenderRequest(JSON.stringify({ ...request, against }))).toEqual({ ...request, against });
		expect(parseRenderRequest(JSON.stringify({ ...request, against: { ...against, runId: 'x' } }))).toBeNull();
		expect(parseRenderRequest(JSON.stringify({ ...request, against: { ...against, url: 'http://169.254.169.254/' } }))).toBeNull();
		expect(parseRenderRequest(JSON.stringify({ ...request, against: `${against.projectId}:${against.runId}` }))).toBeNull();
	});

	it('the worker understands a render result, success or failure, and nothing more', () => {
		const ok = { v: 1, type: 'rendered', reportId: ids.reportId, result: { ok: true, pages: 9, bytes: 1000, ms: 4000 } };
		const failed = { v: 1, type: 'rendered', reportId: ids.reportId, result: { ok: false, error: 'the render took longer than 90 s', retry: true } };
		expect(parseWorkerMessage(JSON.stringify(ok))).toEqual(ok);
		expect(parseWorkerMessage(JSON.stringify(failed))).toEqual(failed);
		// A result can't name a key, a project or a URL.
		expect(parseWorkerMessage(JSON.stringify({ ...ok, key: 'reports/x.pdf' }))).toBeNull();
		expect(parseWorkerMessage(JSON.stringify({ ...ok, result: { ...ok.result, key: 'reports/x.pdf' } }))).toBeNull();
		expect(parseWorkerMessage(JSON.stringify({ ...failed, result: { ...failed.result, error: 'x'.repeat(301) } }))).toBeNull();
	});

	it('REPORT_RENDERER defaults to inline (local-first) and knows only inline and sqs', () => {
		expect(reportRenderer(undefined)).toBe('inline');
		expect(reportRenderer('sqs')).toBe('sqs');
		expect(() => reportRenderer('lambda')).toThrow(/unknown REPORT_RENDERER/);
	});
});
