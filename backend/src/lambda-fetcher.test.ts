import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeedThrottledError } from './feeds/errors.js';
import type { FeedHttp } from './feeds/http.js';

const sent: { url: string | undefined; message: unknown }[] = [];
const sendToQueue = vi.fn(async (url: string | undefined, _name: string, message: unknown) => {
	sent.push({ url, message });
});
vi.mock('./jobs/transport.js', async (orig) => ({ ...(await orig<typeof import('./jobs/transport.js')>()), sendToQueue: (u: string, n: string, m: unknown) => sendToQueue(u, n, m) }));

// The real client (FEED_SOURCE=fixtures) unless a test swaps in its own.
const httpOverride: { next?: FeedHttp } = {};
vi.mock('./feeds/http.js', async (orig) => {
	const real = await orig<typeof import('./feeds/http.js')>();
	return { ...real, feedHttp: async () => httpOverride.next ?? real.feedHttp() };
});

const { FETCH_SEND_MARGIN_MS, failureDetail, fetchFailureReason, handler, withDeadline } = await import('./lambda-fetcher.js');

afterEach(() => {
	sent.length = 0;
	sendToQueue.mockClear();
	delete httpOverride.next;
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

const ids = { fetchJobId: '00000000-0000-4000-8000-000000000002', feedId: '00000000-0000-4000-8000-000000000003', feedVersion: 'v1' };
const record = (messageId: string, body: unknown) => ({ messageId, body: typeof body === 'string' ? body : JSON.stringify(body) });
const today = new Date().toISOString().slice(0, 10);

describe('fetcher Lambda (FEED_SOURCE=fixtures here: no network)', () => {
	it('fetches each request and sends the result, success or failure, to ingest-results', async () => {
		vi.stubEnv('INGEST_RESULTS_QUEUE_URL', 'https://sqs.example/ingest-results');
		vi.spyOn(console, 'info').mockImplementation(() => {});
		const ok = { v: 1, type: 'fetch', ...ids, request: { source: 'chirps_gefs', config: { cells: [{ lat: -20.12, lon: 25.17, weight: 1 }] }, start: today, end: today, today } };
		const sea = { ...ok, request: { ...ok.request, config: { cells: [{ lat: -20.27, lon: 25.37, weight: 1 }] } } };
		const res = await handler({ Records: [record('m1', ok), record('m2', sea)] } as never);
		expect(res).toEqual({ batchItemFailures: [] });
		expect(sent).toHaveLength(2);
		expect(sent[0]).toMatchObject({ url: 'https://sqs.example/ingest-results', message: { v: 1, type: 'ingest', ...ids, result: { ok: true, startDate: today } } });
		expect((sent[0]!.message as { result: { values: unknown[] } }).result.values).toHaveLength(16);
		expect(sent[1]).toMatchObject({ message: { type: 'ingest', result: { ok: false, error: expect.stringMatching(/no data at -20.27, 25.37/) } } });
	});

	it('answers a CHIRPS request with a cell plan (the cell cache, 208) with each cell’s own values, and logs how many cell-days it read', async () => {
		vi.stubEnv('INGEST_RESULTS_QUEUE_URL', 'https://sqs.example/ingest-results');
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		const start = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
		const end = new Date(Date.now() - 58 * 86_400_000).toISOString().slice(0, 10);
		// The fixture cell's grid cell, and the one east of it; the middle day skipped (the cache holds it).
		const cells = [
			[1602, 4103],
			[1602, 4104]
		];
		const req = { v: 1, type: 'fetch', ...ids, request: { source: 'chirps', config: { cells: [{ lat: -20.12, lon: 25.17, weight: 1 }] }, start, end, today, cells: { cells, plan: '010' } } };
		expect(await handler({ Records: [record('m1', req)] } as never)).toEqual({ batchItemFailures: [] });
		const result = (sent[0]!.message as { result: { ok: boolean; cells: { read: string; cells: unknown; values: (number | null)[][] } } }).result;
		expect(result).toMatchObject({ ok: true, cells: { product: 'sat', startDate: start, read: 'f-f', cells } });
		expect(result.cells.values.map((row) => row.map((v) => v === null))).toEqual([
			[false, true, false],
			[false, true, false]
		]);
		// Ids, counts and the time only, never the values.
		const logged = info.mock.calls.map(([line]) => JSON.parse(line as string)).find((l) => l.event === 'feed_fetched');
		expect(logged).toEqual({ event: 'feed_fetched', feedId: ids.feedId, source: 'chirps', ok: true, days: 3, cellDaysRead: 4, ms: expect.any(Number) });
	});

	it('drops a message it cannot parse at all (a retry can’t fix it), and logs only ids', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const res = await handler({ Records: [record('m1', 'garbage'), record('m2', { v: 1, type: 'fetch', fetchJobId: 'nope', request: {} })] } as never);
		expect(res).toEqual({ batchItemFailures: [] });
		expect(sent).toHaveLength(0);
		expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'fetch_request_ignored', messageId: 'm1' }));
		expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'fetch_request_ignored', messageId: 'm2' }));
	});

	it('answers a request it can route but not run (e.g. a source it doesn’t know yet) with a failure, so the feed shows failing', async () => {
		vi.stubEnv('INGEST_RESULTS_QUEUE_URL', 'https://sqs.example/ingest-results');
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const res = await handler({ Records: [record('m1', { v: 1, type: 'fetch', ...ids, request: { source: 'x' } })] } as never);
		expect(res).toEqual({ batchItemFailures: [] });
		expect(sent).toEqual([
			{ url: 'https://sqs.example/ingest-results', message: { v: 1, type: 'ingest', ...ids, result: { ok: false, error: 'the fetch request was not valid, so nothing was fetched' } } }
		]);
		expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: 'fetch_request_invalid', messageId: 'm1', feedId: ids.feedId }));
	});

	it('answers a fetch that outruns the Lambda’s time with a failure, instead of timing out into retries and the DLQ', async () => {
		vi.stubEnv('INGEST_RESULTS_QUEUE_URL', 'https://sqs.example/ingest-results');
		vi.spyOn(console, 'info').mockImplementation(() => {});
		let calls = 0;
		// An upstream that never answers.
		const hung: FeedHttp = { range: () => (calls++, new Promise(() => {})), text: () => (calls++, new Promise(() => {})) };
		const req = { v: 1, type: 'fetch', ...ids, request: { source: 'dws', config: { station: 'X0H000' }, start: '2020-01-01', end: '2020-01-10', today } };
		const started = Date.now();
		httpOverride.next = hung;
		const res = await handler({ Records: [record('m1', req)] } as never, { getRemainingTimeInMillis: () => FETCH_SEND_MARGIN_MS + 50 });
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(res).toEqual({ batchItemFailures: [] });
		expect(calls).toBe(1);
		expect(sent).toEqual([
			{ url: 'https://sqs.example/ingest-results', message: { v: 1, type: 'ingest', ...ids, result: { ok: false, error: 'the source is unreachable: it did not answer in time' } } }
		]);
	});

	it('refuses further requests once the deadline has passed (the abandoned fetch stops)', async () => {
		const inner: FeedHttp = { range: async () => new Uint8Array(1), text: async () => 'page' };
		const d = withDeadline(inner, Date.now() - 1);
		await expect(d.text('https://x')).rejects.toMatchObject({ name: 'FeedUnavailableError' });
		await expect(d.range('https://x', 0, 1)).rejects.toMatchObject({ name: 'FeedUnavailableError' });
		const live = withDeadline(inner, Date.now() + 60_000);
		expect(await live.text('https://x')).toBe('page');
		// The re-check's tagged reads and HEADs stop at the deadline too, and are there only when the client has them.
		expect(d.head).toBeUndefined();
		const tagged: FeedHttp = { ...inner, head: async () => ({ tag: '"t"' }), rangeTagged: async () => ({ bytes: new Uint8Array(1), tag: '"t"' }) };
		const late = withDeadline(tagged, Date.now() - 1);
		await expect(late.head!('https://x')).rejects.toMatchObject({ name: 'FeedUnavailableError' });
		await expect(late.rangeTagged!('https://x', 0, 1)).rejects.toMatchObject({ name: 'FeedUnavailableError' });
		expect(await withDeadline(tagged, Date.now() + 60_000).head!('https://x')).toEqual({ tag: '"t"' });
	});

	it('logs one feed_fetch_failed line per failed answer, with a reason code and never the stored message (infra/feeds.tf alarms on it)', async () => {
		vi.stubEnv('INGEST_RESULTS_QUEUE_URL', 'https://sqs.example/ingest-results');
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const ok = { v: 1, type: 'fetch', ...ids, request: { source: 'chirps_gefs', config: { cells: [{ lat: -20.12, lon: 25.17, weight: 1 }] }, start: today, end: today, today } };
		const sea = { ...ok, request: { ...ok.request, config: { cells: [{ lat: -20.27, lon: 25.37, weight: 1 }] } } };
		const invalid = { v: 1, type: 'fetch', ...ids, request: { source: 'x' } };
		await handler({ Records: [record('m1', ok), record('m2', sea), record('m3', invalid)] } as never);
		const failed = warn.mock.calls.map((c) => JSON.parse(String(c[0]))).filter((l) => l.event === 'feed_fetch_failed');
		// The successful fetch logs none; the answered failures one each.
		expect(failed).toEqual([
			{
				event: 'feed_fetch_failed',
				feedId: ids.feedId,
				fetchJobId: ids.fetchJobId,
				source: 'chirps_gefs',
				reason: fetchFailureReason((sent[1]!.message as { result: { error: string } }).result.error),
				// A format error's text names the cell: no detail.
				detail: null
			},
			{ event: 'feed_fetch_failed', feedId: ids.feedId, fetchJobId: ids.fetchJobId, source: null, reason: 'invalid_request', detail: null }
		]);
		expect(failed[0]!.reason).not.toBe('other');
		// The stored message names the grid cell; the log never does.
		expect(JSON.stringify(warn.mock.calls)).not.toContain('-20.27');
	});

	it('logs no feed_fetch_failed line for a send that failed (it is retried, and logs once it goes through)', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		sendToQueue.mockRejectedValueOnce(new Error('INGEST_RESULTS_QUEUE_URL is not set'));
		await handler({ Records: [record('m1', { v: 1, type: 'fetch', ...ids, request: { source: 'x' } })] } as never);
		expect(warn.mock.calls.filter((c) => String(c[0]).includes('feed_fetch_failed'))).toEqual([]);
	});

	it('logs what the source did with a failed live fetch (HTTP 429 here), and its job, so a dropped answer can be traced', async () => {
		vi.stubEnv('INGEST_RESULTS_QUEUE_URL', 'https://sqs.example/ingest-results');
		vi.spyOn(console, 'info').mockImplementation(() => {});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		httpOverride.next = {
			range: async () => {
				throw new FeedThrottledError(429, 120);
			},
			text: async () => null
		};
		const req = { v: 1, type: 'fetch', ...ids, request: { source: 'chirps_gefs', config: { cells: [{ lat: -20.12, lon: 25.17, weight: 1 }] }, start: today, end: today, today } };
		await handler({ Records: [record('m1', req)] } as never);
		const failed = warn.mock.calls.map((c) => JSON.parse(String(c[0]))).filter((l) => l.event === 'feed_fetch_failed');
		expect(failed).toEqual([{ event: 'feed_fetch_failed', feedId: ids.feedId, fetchJobId: ids.fetchJobId, source: 'chirps_gefs', reason: 'throttled', detail: 'HTTP 429' }]);
		// The feed's row gets the whole sentence.
		expect(sent[0]).toMatchObject({ message: { result: { ok: false, error: 'the source is unreachable: HTTP 429: the source asked us to slow down, so the feed tries again later' } } });
	});

	it('logs a failure’s detail only when it is the live client’s own text or an HTTP status, never a cell or a station', () => {
		expect(failureDetail('the source is unreachable: HTTP 403')).toBe('HTTP 403');
		expect(failureDetail('the source is unreachable: HTTP 503: the source asked us to slow down, so the feed tries again later')).toBe('HTTP 503');
		expect(failureDetail('the source is unreachable: the request timed out')).toBe('the request timed out');
		expect(failureDetail('the source is unreachable: the response is larger than expected')).toBe('the response is larger than expected');
		expect(failureDetail('the source is unreachable: it did not answer in time')).toBe('it did not answer in time');
		// Not ours to trust: a forecast's issue date, a format error's cell, anything else.
		expect(failureDetail('the source is unreachable: the newest forecast (issued 2026-03-10) is still being published: 4 of its 16 days are out')).toBeNull();
		expect(failureDetail('the source’s data could not be read: the grid has no data at -20.27, 25.37')).toBeNull();
		expect(failureDetail('the source is unreachable: HTTP 4290 at -20.27')).toBeNull();
		expect(failureDetail('the fetch failed with an internal error')).toBeNull();
	});

	it('maps each failure message to a fixed reason code', () => {
		expect(fetchFailureReason('the source is unreachable: it did not answer in time')).toBe('timeout');
		expect(fetchFailureReason('the fetch request was not valid, so nothing was fetched')).toBe('invalid_request');
		expect(fetchFailureReason('the source is unreachable: HTTP 403')).toBe('unavailable');
		expect(fetchFailureReason('the source is unreachable: HTTP 503')).toBe('throttled');
		expect(fetchFailureReason('the source is unreachable: HTTP 429: the source asked us to slow down, so the feed tries again later')).toBe('throttled');
		expect(fetchFailureReason('the source’s data could not be read: no station X0H000')).toBe('format');
		expect(fetchFailureReason('the fetch failed with an internal error')).toBe('internal');
		expect(fetchFailureReason('something new')).toBe('other');
	});

	it('logs a failed send by its error name only, never its message', async () => {
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		sendToQueue.mockRejectedValueOnce(Object.assign(new Error('arn:aws:sqs:af-south-1:123456789012:secret-queue'), { name: 'AccessDenied' }));
		await handler({ Records: [record('m1', { v: 1, type: 'fetch', ...ids, request: { source: 'x' } })] } as never);
		expect(err).toHaveBeenCalledWith(JSON.stringify({ event: 'fetch_result_send_failed', messageId: 'm1', error: 'AccessDenied' }));
	});

	it('reports a failed send as a batch item failure, so SQS retries just that message', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'info').mockImplementation(() => {});
		sendToQueue.mockRejectedValueOnce(new Error('INGEST_RESULTS_QUEUE_URL is not set'));
		const req = { v: 1, type: 'fetch', ...ids, request: { source: 'dws', config: { station: 'X0H000' }, start: '2020-01-01', end: '2020-01-10', today } };
		const res = await handler({ Records: [record('m1', req), record('m2', req)] } as never);
		expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
	});
});

describe('the fetcher bundle', () => {
	it('never reaches dotenv (docs/STACK.md § Two backend entry points; infra/scripts/package-lambdas.sh checks the built zip too)', async () => {
		const { build } = await import('esbuild');
		const out = await build({
			entryPoints: [fileURLToPath(new URL('./lambda-fetcher.ts', import.meta.url))],
			bundle: true,
			platform: 'node',
			format: 'esm',
			// As infra/scripts/package-lambdas.sh builds it: only the renderer ships playwright-core.
			external: ['playwright-core'],
			write: false,
			metafile: true,
			logLevel: 'silent'
		});
		const inputs = Object.keys(out.metafile.inputs);
		expect(inputs.some((f) => f.endsWith('src/lambda-fetcher.ts'))).toBe(true);
		expect(inputs.filter((f) => /(^|\/)dotenv(\/|$)/.test(f))).toEqual([]);
	});

	// The fetcher has no database (issue #34). Checked on the import graph, not
	// the output, so it doesn't lean on tree-shaking: jobs/transport.ts once
	// reached the runner through wakeWorker's memory transport (now jobs/wake.ts),
	// and esbuild only dropped it because nothing called wakeWorker.
	it('never reaches pg, the db layer, the job runner, or any engine module but the calendar, series provenance and DWS table reader', async () => {
		const { build } = await import('esbuild');
		const out = await build({
			entryPoints: [fileURLToPath(new URL('./lambda-fetcher.ts', import.meta.url))],
			bundle: true,
			platform: 'node',
			format: 'esm',
			external: ['playwright-core'],
			write: false,
			metafile: true,
			logLevel: 'silent'
		});
		const inputs = Object.keys(out.metafile.inputs);
		expect(inputs.some((f) => f.endsWith('src/lambda-fetcher.ts'))).toBe(true);
		expect(inputs.filter((f) => /(^|\/)node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?pg[a-z0-9-]*\//.test(f))).toEqual([]);
		expect(inputs.filter((f) => /src\/(db\/|jobs\/(runner|wake|queue)\.ts$)/.test(f))).toEqual([]);
		// The feed sources use the engine's calendar helpers (toEpochDay /
		// fromEpochDay) through the `@water-management/engine/calendar` subpath;
		// the package root would pull in every engine module (the model, ~27 KB
		// of tree-shaken stubs), so nothing the fetcher reaches may import it.
		// feeds/config.ts names the CHIRPS product it writes through the
		// `/provenance` subpath (seriesProvenance.ts: constants, no imports).
		// feeds/sources/dws.ts reads rows through the `/dws` subpath (dws.ts:
		// the row parser it shares with the manual import; imports only calendar.ts).
		const allowed = ['packages/engine/src/calendar.ts', 'packages/engine/src/seriesProvenance.ts', 'packages/engine/src/dws.ts'];
		expect(inputs.filter((f) => f.includes('packages/engine/') && !allowed.some((a) => f.endsWith(a)))).toEqual([]);
	});
});
