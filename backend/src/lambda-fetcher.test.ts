import { afterEach, describe, expect, it, vi } from 'vitest';

const sent: { url: string | undefined; message: unknown }[] = [];
const sendToQueue = vi.fn(async (url: string | undefined, _name: string, message: unknown) => {
	sent.push({ url, message });
});
vi.mock('./jobs/transport.js', async (orig) => ({ ...(await orig<typeof import('./jobs/transport.js')>()), sendToQueue: (u: string, n: string, m: unknown) => sendToQueue(u, n, m) }));

const { handler } = await import('./lambda-fetcher.js');

afterEach(() => {
	sent.length = 0;
	sendToQueue.mockClear();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

const ids = { fetchJobId: '00000000-0000-4000-8000-000000000002', feedId: '00000000-0000-4000-8000-000000000003', feedVersion: 'v1' };
const record = (messageId: string, body: unknown) => ({ messageId, body: typeof body === 'string' ? body : JSON.stringify(body) });
const today = new Date().toISOString().slice(0, 10);

describe('fetcher Lambda (FEED_SOURCE=fixtures here: no network)', () => {
	it('fetches each request and sends the result, success or failure, to ingest-results', async () => {
		vi.stubEnv('INGEST_RESULTS_QUEUE_URL', 'https://sqs.example/ingest-results');
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const ok = { v: 1, type: 'fetch', ...ids, request: { source: 'chirps_gefs', config: { cells: [{ lat: -20.12, lon: 25.17, weight: 1 }] }, start: today, end: today, today } };
		const sea = { ...ok, request: { ...ok.request, config: { cells: [{ lat: -20.27, lon: 25.37, weight: 1 }] } } };
		const res = await handler({ Records: [record('m1', ok), record('m2', sea)] } as never);
		expect(res).toEqual({ batchItemFailures: [] });
		expect(sent).toHaveLength(2);
		expect(sent[0]).toMatchObject({ url: 'https://sqs.example/ingest-results', message: { v: 1, type: 'ingest', ...ids, result: { ok: true, startDate: today } } });
		expect((sent[0]!.message as { result: { values: unknown[] } }).result.values).toHaveLength(16);
		expect(sent[1]).toMatchObject({ message: { type: 'ingest', result: { ok: false, error: expect.stringMatching(/no data at -20.27, 25.37/) } } });
	});

	it('drops a request it cannot parse (a retry can’t fix it), and logs only ids', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const res = await handler({ Records: [record('m1', 'garbage'), record('m2', { v: 1, type: 'fetch', ...ids, request: { source: 'x' } })] } as never);
		expect(res).toEqual({ batchItemFailures: [] });
		expect(sent).toHaveLength(0);
		expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'fetch_request_ignored', messageId: 'm1' }));
	});

	it('reports a failed send as a batch item failure, so SQS retries just that message', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'log').mockImplementation(() => {});
		sendToQueue.mockRejectedValueOnce(new Error('INGEST_RESULTS_QUEUE_URL is not set'));
		const req = { v: 1, type: 'fetch', ...ids, request: { source: 'dws', config: { station: 'X0H000' }, start: '2020-01-01', end: '2020-01-10', today } };
		const res = await handler({ Records: [record('m1', req), record('m2', req)] } as never);
		expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
	});
});
