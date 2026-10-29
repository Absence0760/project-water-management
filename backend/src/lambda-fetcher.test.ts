import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeedRefusedError, FeedThrottledError } from './feeds/errors.js';
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

// CHC's request slot (feeds/hostSlot.ts): the real one unless a test swaps in its own slots, or shortens a pass's wait.
const slotOverride: { slots?: import('./feeds/hostSlot.js').HostSlots; waitMs?: number } = {};
vi.mock('./feeds/hostSlot.js', async (orig) => {
	const real = await orig<typeof import('./feeds/hostSlot.js')>();
	return {
		...real,
		hostSlots: (url: string | undefined, o?: Parameters<typeof real.hostSlots>[1]) => slotOverride.slots ?? real.hostSlots(url, o),
		takeHostSlotWaiting: (slots: Parameters<typeof real.takeHostSlotWaiting>[0], host: 'chc', o: Parameters<typeof real.takeHostSlotWaiting>[2]) =>
			real.takeHostSlotWaiting(slots, host, slotOverride.waitMs === undefined ? o : { ...o, waitMs: slotOverride.waitMs })
	};
});

const {
	DAILY_INGEST_EVENT,
	DAMS_WEEKLY_EVENT,
	DWS_WEEKLY_EVENT,
	ET_DEKADAL_EVENT,
	FETCH_SEND_MARGIN_MS,
	GEFS_INGEST_EVENT,
	INDICES_INGEST_EVENT,
	failureDetail,
	fetchFailureReason,
	handler,
	isDailyIngestEvent,
	isDamsWeeklyEvent,
	isDwsWeeklyEvent,
	isEtDekadalEvent,
	withDeadline
} =
	await import('./lambda-fetcher.js');
type DamsWeeklyAnswer = import('./lambda-fetcher.js').DamsWeeklyAnswer;

afterEach(() => {
	sent.length = 0;
	sendToQueue.mockClear();
	delete httpOverride.next;
	delete slotOverride.slots;
	delete slotOverride.waitMs;
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

	it('answers a CHIRPS window too long for its time with the days it finished, not a failure (issue #604: about a request a second)', async () => {
		vi.stubEnv('INGEST_RESULTS_QUEUE_URL', 'https://sqs.example/ingest-results');
		vi.spyOn(console, 'info').mockImplementation(() => {});
		const start = new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 10);
		const end = new Date(Date.now() - 61 * 86_400_000).toISOString().slice(0, 10);
		const req = { v: 1, type: 'fetch', ...ids, request: { source: 'chirps', config: { cells: [{ lat: -20.12, lon: 25.17, weight: 1 }] }, start, end, today, cells: { cells: [[1602, 4103]], plan: '0'.repeat(40) } } };
		// 20 s left past the send margin: inside CUT_RESERVE_MIN_MS, so it stops after its first day.
		expect(await handler({ Records: [record('m1', req)] } as never, { getRemainingTimeInMillis: () => FETCH_SEND_MARGIN_MS + 10_000 })).toEqual({ batchItemFailures: [] });
		const result = (sent[0]!.message as { result: { ok: boolean; cells: { read: string; startDate: string } } }).result;
		expect(result).toMatchObject({ ok: true, cells: { startDate: start, read: 'f' } });
		// Positive control: with the time for it, the whole window.
		sent.length = 0;
		await handler({ Records: [record('m2', req)] } as never, { getRemainingTimeInMillis: () => 300_000 });
		expect((sent[0]!.message as { result: { cells: { read: string } } }).result.cells.read).toHaveLength(40);
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

	it('logs a refused live fetch (HTTP 403) as `refused`, not `unavailable` or `throttled`, and stores the refusal’s own sentence', async () => {
		vi.stubEnv('INGEST_RESULTS_QUEUE_URL', 'https://sqs.example/ingest-results');
		vi.spyOn(console, 'info').mockImplementation(() => {});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		httpOverride.next = {
			range: async () => {
				throw new FeedRefusedError();
			},
			text: async () => null
		};
		const req = { v: 1, type: 'fetch', ...ids, request: { source: 'chirps_gefs', config: { cells: [{ lat: -20.12, lon: 25.17, weight: 1 }] }, start: today, end: today, today } };
		await handler({ Records: [record('m1', req)] } as never);
		const failed = warn.mock.calls.map((c) => JSON.parse(String(c[0]))).filter((l) => l.event === 'feed_fetch_failed');
		expect(failed).toEqual([{ event: 'feed_fetch_failed', feedId: ids.feedId, fetchJobId: ids.fetchJobId, source: 'chirps_gefs', reason: 'refused', detail: 'HTTP 403' }]);
		expect(sent[0]).toMatchObject({
			message: { result: { ok: false, error: 'the source refused this server’s requests (HTTP 403): it may have blocked this server’s address, so the feed waits hours before asking again' } }
		});
	});

	it('logs a failure’s detail only when it is the live client’s own text or an HTTP status, never a cell or a station', () => {
		expect(failureDetail('the source is unreachable: HTTP 403')).toBe('HTTP 403');
		expect(failureDetail('the source refused this server’s requests (HTTP 403): it may have blocked this server’s address, so the feed waits hours before asking again')).toBe('HTTP 403');
		// Only the refusal's exact sentence: anything after the prefix is not ours to trust.
		expect(failureDetail('the source refused this server’s requests at -20.27')).toBeNull();
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

	// Production, 2026-10-26: {"reason":"format","detail":null} said nothing of why.
	it('logs DWS’s ScriptServer page as unavailable with a fixed label, and which check a DWS format failure failed', () => {
		const server = 'the source had a server error (the DWS site answered with its ScriptServer error page instead of data), so the feed tries again later';
		expect(fetchFailureReason(server)).toBe('unavailable');
		expect(failureDetail(server)).toBe('ScriptServer error page');
		// Only that exact sentence: anything else after the prefix isn't ours to trust.
		expect(failureDetail('the source had a server error (X0H000 said no)')).toBeNull();
		expect(fetchFailureReason('the source’s data could not be read: the DWS page has no data table')).toBe('format');
		expect(failureDetail('the source’s data could not be read: the DWS page has no data table')).toBe('no data table');
		expect(failureDetail('the source’s data could not be read: the DWS table’s columns changed (expected DATE D AVG F/R QUAL, got DATE COR_LEVEL QUAL)')).toBe('columns changed');
		expect(failureDetail('the source’s data could not be read: the DWS table lists a day twice: 2021-01-01')).toBe('a day listed twice');
		expect(failureDetail('the source’s data could not be read: the DWS page was not found')).toBe('page not found');
	});

	it('logs a DWS ScriptServer page end to end: reason unavailable, detail the label', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		httpOverride.next = { range: async () => null, text: async () => '<html><body>Client unable to establish connection to ScriptServerODBC</body></html>' };
		const req = { v: 1, type: 'fetch', ...ids, request: { source: 'dws', config: { station: 'A2H012' }, start: '2016-10-28', end: '2018-10-27', today: '2026-10-26' } };
		await handler({ Records: [record('m1', req)] } as never);
		const failed = warn.mock.calls.map((c) => JSON.parse(String(c[0]))).filter((l) => l.event === 'feed_fetch_failed');
		expect(failed).toEqual([{ event: 'feed_fetch_failed', feedId: ids.feedId, fetchJobId: ids.fetchJobId, source: 'dws', reason: 'unavailable', detail: 'ScriptServer error page' }]);
	});

	it('maps each failure message to a fixed reason code', () => {
		expect(fetchFailureReason('the source is unreachable: it did not answer in time')).toBe('timeout');
		expect(fetchFailureReason('the fetch request was not valid, so nothing was fetched')).toBe('invalid_request');
		expect(fetchFailureReason('the source refused this server’s requests (HTTP 403): it may have blocked this server’s address, so the feed waits hours before asking again')).toBe('refused');
		// An older stored 403 (before FeedRefusedError) reads as it did.
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

describe('the fetcher’s daily-ingest mode (issue #604 R2-B)', () => {
	const dirs: string[] = [];
	afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
	const mirrorDir = () => {
		const d = mkdtempSync(join(tmpdir(), 'wm-fetcher-daily-'));
		dirs.push(d);
		return d;
	};

	it('routes the scheduled event to the daily ingest, and an SQS batch to the per-feed fetch', () => {
		expect(isDailyIngestEvent(DAILY_INGEST_EVENT)).toBe(true);
		expect(isDailyIngestEvent({ mode: 'daily-ingest', 'detail-type': 'Scheduled Event' })).toBe(true);
		expect(isDailyIngestEvent({ Records: [], mode: 'daily-ingest' })).toBe(false);
		expect(isDailyIngestEvent({ Records: [] })).toBe(false);
		expect(isDailyIngestEvent({ mode: 'monthly' })).toBe(false);
		expect(isDailyIngestEvent(null)).toBe(false);
		expect(isDailyIngestEvent([DAILY_INGEST_EVENT])).toBe(false);
	});

	it('runs the daily ingest into the copy MIRROR_URL names (fixtures here), publishes the lag metric and logs the outcome, sending nothing to a queue', async () => {
		const dir = mirrorDir();
		vi.stubEnv('MIRROR_URL', pathToFileURL(`${dir}/`).href);
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		const res = await handler({ mode: 'daily-ingest' } as never);
		const metric = out.mock.calls.map(([l]) => String(l)).find((l) => l.includes('MirrorLagDays'));
		out.mockRestore();
		// A fresh copy, no finals: it starts PRELIM_LOOKBACK_DAYS back and copies at most DAILY_MAX_FILES days a run.
		expect(res).toMatchObject({ copied: 20, dropped: 0, stopped: 'max_files' });
		expect(JSON.parse(metric!)).toMatchObject({ Product: 'prelim', MirrorLagDays: (res as unknown as { lagDays: number }).lagDays });
		const logged = info.mock.calls.map(([l]) => JSON.parse(l as string)).find((l) => l.event === 'mirror_daily_ingest');
		expect(logged).toMatchObject({ event: 'mirror_daily_ingest', product: 'prelim', copied: 20, stopped: 'max_files', ms: expect.any(Number) });
		expect(sent).toHaveLength(0);
	});

	it('fails the invocation on an HTTP 403, after logging it as refused (no retry: the schedule tries again tomorrow)', async () => {
		vi.stubEnv('MIRROR_URL', pathToFileURL(`${mirrorDir()}/`).href);
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const refuse = async () => {
			throw new FeedRefusedError();
		};
		httpOverride.next = { range: refuse, rangeTagged: refuse, text: refuse };
		await expect(handler({ mode: 'daily-ingest' } as never)).rejects.toBeInstanceOf(FeedRefusedError);
		const logged = error.mock.calls.map(([l]) => JSON.parse(l as string)).find((l) => l.event === 'mirror_daily_ingest');
		expect(logged).toMatchObject({ copied: 0, stopped: 'error', reason: 'refused', detail: 'HTTP 403', requests: 1 });
	});

	it('refuses to run without MIRROR_URL (it never writes the committed synthetic copy)', async () => {
		vi.stubEnv('MIRROR_URL', '');
		await expect(handler({ mode: 'daily-ingest' } as never)).rejects.toThrow(/MIRROR_URL is not set/);
	});

	it('runs the GEFS pass on {"mode":"daily-ingest","pass":"gefs"} (issue #604 R3-A): today’s issue into the copy, its own lag metric and log line', async () => {
		const dir = mirrorDir();
		vi.stubEnv('MIRROR_URL', pathToFileURL(`${dir}/`).href);
		expect(isDailyIngestEvent(GEFS_INGEST_EVENT)).toBe(true);
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		const res = await handler(GEFS_INGEST_EVENT as never);
		const metric = out.mock.calls.map(([l]) => String(l)).find((l) => l.includes('MirrorLagDays'));
		out.mockRestore();
		expect(res).toEqual({ copied: today, newest: today, lagDays: 0, stopped: 'copied' });
		expect(JSON.parse(metric!)).toMatchObject({ Product: 'gefs', MirrorLagDays: 0 });
		const logged = info.mock.calls.map(([l]) => JSON.parse(l as string)).find((l) => l.event === 'mirror_daily_ingest');
		expect(logged).toMatchObject({ product: 'gefs', copied: today, held: 1, stopped: 'copied', requests: 48 });
		// The preliminary pass didn't run: no prelim array.
		expect(existsSync(join(dir, 'prelim'))).toBe(false);
		expect(existsSync(join(dir, 'gefs', today, 'manifest.json'))).toBe(true);
		expect(sent).toHaveLength(0);
	});

	it('runs the indices pass on {"mode":"daily-ingest","pass":"indices"} (issue #620): CPC’s two files into the copy, its own lag metric and log line', async () => {
		const dir = mirrorDir();
		vi.stubEnv('MIRROR_URL', pathToFileURL(`${dir}/`).href);
		expect(isDailyIngestEvent(INDICES_INGEST_EVENT)).toBe(true);
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		const res = (await handler(INDICES_INGEST_EVENT as never)) as unknown as { changed: string[]; lagDays: number; stopped: string };
		const metric = out.mock.calls.map(([l]) => String(l)).find((l) => l.includes('MirrorLagDays'));
		out.mockRestore();
		expect(res).toMatchObject({ changed: ['oni', 'aao'], stopped: 'done' });
		expect(JSON.parse(metric!)).toMatchObject({ Product: 'indices', MirrorLagDays: res.lagDays });
		const logged = info.mock.calls.map(([l]) => JSON.parse(l as string)).find((l) => l.event === 'mirror_daily_ingest');
		expect(logged).toMatchObject({ product: 'indices', changed: ['oni', 'aao'], stopped: 'done', requests: 2 });
		expect(existsSync(join(dir, 'indices', 'manifest.json'))).toBe(true);
		// No other pass ran.
		expect(existsSync(join(dir, 'prelim'))).toBe(false);
		expect(sent).toHaveLength(0);
	});

	it('fails the indices pass on an HTTP 403 after logging it as refused, asking CPC nothing more', async () => {
		vi.stubEnv('MIRROR_URL', pathToFileURL(`${mirrorDir()}/`).href);
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const refuse = async () => {
			throw new FeedRefusedError();
		};
		httpOverride.next = { range: refuse, rangeTagged: refuse, text: refuse };
		await expect(handler(INDICES_INGEST_EVENT as never)).rejects.toBeInstanceOf(FeedRefusedError);
		const logged = error.mock.calls.map(([l]) => JSON.parse(l as string)).find((l) => l.event === 'mirror_daily_ingest');
		expect(logged).toMatchObject({ product: 'indices', changed: [], stopped: 'error', reason: 'refused', detail: 'HTTP 403', requests: 1 });
	});

	it('fails the GEFS pass on an HTTP 403 after logging it as refused, with no request after it', async () => {
		vi.stubEnv('MIRROR_URL', pathToFileURL(`${mirrorDir()}/`).href);
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const refuse = async () => {
			throw new FeedRefusedError();
		};
		httpOverride.next = { range: refuse, rangeTagged: refuse, text: refuse };
		await expect(handler(GEFS_INGEST_EVENT as never)).rejects.toBeInstanceOf(FeedRefusedError);
		const logged = error.mock.calls.map(([l]) => JSON.parse(l as string)).find((l) => l.event === 'mirror_daily_ingest');
		expect(logged).toMatchObject({ product: 'gefs', copied: null, stopped: 'error', reason: 'refused', detail: 'HTTP 403', requests: 1 });
	});

	it('after a 403, the next GEFS run the same UTC day asks CHC nothing and logs that it skipped (refused_today)', async () => {
		vi.stubEnv('MIRROR_URL', pathToFileURL(`${mirrorDir()}/`).href);
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		const refuse = async () => {
			throw new FeedRefusedError();
		};
		httpOverride.next = { range: refuse, rangeTagged: refuse, text: refuse };
		await expect(handler(GEFS_INGEST_EVENT as never)).rejects.toBeInstanceOf(FeedRefusedError);
		// An hour later: a fresh invocation (a cold container), with a client that would answer.
		let asked = 0;
		const count = async () => {
			asked++;
			return null;
		};
		httpOverride.next = { range: count, rangeTagged: count, text: count };
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const res = await handler(GEFS_INGEST_EVENT as never);
		expect(res).toMatchObject({ copied: null, stopped: 'refused_today' });
		expect(asked).toBe(0);
		const logged = warn.mock.calls.map(([l]) => JSON.parse(l as string)).find((l) => l.event === 'mirror_daily_ingest');
		expect(logged).toMatchObject({ product: 'gefs', stopped: 'refused_today', requests: 0, refusedAt: expect.any(String) });
	});

	it('fails an event of neither mode, naming no payload', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		await expect(handler({ mode: 'something-else' } as never)).rejects.toThrow(/does not know/);
		expect(error).toHaveBeenCalledWith(JSON.stringify({ event: 'fetcher_event_unknown' }));
	});
});

describe('the fetcher’s dws-weekly mode (issue #604 R3-B)', () => {
	const dirs: string[] = [];
	afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
	/** A bucket of its own holding the worker's station list. */
	const bucket = async (stations: string[]) => {
		const d = mkdtempSync(join(tmpdir(), 'wm-fetcher-dws-'));
		dirs.push(d);
		const { openStore } = await import('./mirror/store.js');
		const { writeStations } = await import('./ingest/dws.js');
		await writeStations(openStore(pathToFileURL(`${d}/`).href), { v: 1, at: new Date().toISOString(), stations });
		vi.stubEnv('MIRROR_URL', pathToFileURL(`${d}/`).href);
		return d;
	};

	it('routes the scheduled event to the weekly pass, and nothing else', () => {
		expect(isDwsWeeklyEvent(DWS_WEEKLY_EVENT)).toBe(true);
		expect(isDwsWeeklyEvent({ mode: 'dws-weekly', 'detail-type': 'Scheduled Event' })).toBe(true);
		expect(isDwsWeeklyEvent({ Records: [], mode: 'dws-weekly' })).toBe(false);
		expect(isDwsWeeklyEvent(DAILY_INGEST_EVENT)).toBe(false);
		expect(isDailyIngestEvent(DWS_WEEKLY_EVENT)).toBe(false);
		expect(isDwsWeeklyEvent(null)).toBe(false);
	});

	it('runs the pass into the bucket MIRROR_URL names (fixtures here), publishes the dws lag and logs counts, never a station', async () => {
		await bucket(['X0H000']);
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		const res = await handler({ mode: 'dws-weekly' } as never);
		const metric = out.mock.calls.map(([l]) => String(l)).find((l) => l.includes('MirrorLagDays'));
		out.mockRestore();
		expect(res).toEqual({ fetched: 1, failed: 0, fresh: 0, lagDays: 0, stopped: 'done' });
		expect(JSON.parse(metric!)).toMatchObject({ Product: 'dws', MirrorLagDays: 0 });
		const lines = info.mock.calls.map(([l]) => l as string);
		const logged = lines.map((l) => JSON.parse(l)).find((l) => l.event === 'dws_weekly');
		expect(logged).toMatchObject({ fetched: 1, failed: 0, stopped: 'done', requests: 1, ms: expect.any(Number) });
		expect(lines.join('\n')).not.toContain('X0H000');
		expect(sent).toHaveLength(0);
	});

	it('fails the invocation on an HTTP 403, after logging it as refused (no retry: next week’s run tries again)', async () => {
		await bucket(['X0H000', 'X0H001']);
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		const refuse = async () => {
			throw new FeedRefusedError();
		};
		httpOverride.next = { range: refuse, text: refuse };
		await expect(handler({ mode: 'dws-weekly' } as never)).rejects.toBeInstanceOf(FeedRefusedError);
		const logged = error.mock.calls.map(([l]) => JSON.parse(l as string)).find((l) => l.event === 'dws_weekly');
		expect(logged).toMatchObject({ fetched: 0, stopped: 'refused', reason: 'refused', detail: 'HTTP 403', requests: 1 });
	});

	it('logs each station it skipped with the check that failed (never the page), and loads the rest', async () => {
		await bucket(['X0H000', 'X0H001']);
		const { renderDwsPage } = await import('./feeds/fixtures.js');
		const day = today;
		const pageOf = async (url: string) => {
			const station = new URL(url).searchParams.get('Station')!.replace(/100\.00$/, '');
			return renderDwsPage(station, [{ date: day, value: station === 'X0H000' ? 1e9 : 1.5, quality: '1' }]);
		};
		httpOverride.next = { range: async () => null, text: pageOf };
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		const res = await handler({ mode: 'dws-weekly' } as never);
		expect(res).toMatchObject({ fetched: 1, failed: 1, stopped: 'done' });
		const lines = warn.mock.calls.map(([l]) => JSON.parse(l as string));
		expect(lines.find((l) => l.event === 'dws_station_failed')).toEqual({ event: 'dws_station_failed', station: 'X0H000', reason: 'format', detail: 'flow out of range' });
		expect(lines.find((l) => l.event === 'dws_weekly')).toMatchObject({ fetched: 1, failed: 1 });
		expect(warn.mock.calls.join('\n')).not.toContain('1000000000');
	});

	it('refuses to run without MIRROR_URL', async () => {
		vi.stubEnv('MIRROR_URL', '');
		await expect(handler({ mode: 'dws-weekly' } as never)).rejects.toThrow(/MIRROR_URL is not set/);
	});
});

describe('the fetcher’s dams-weekly mode (issue #604 R5)', () => {
	const dirs: string[] = [];
	afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
	/** A bucket of its own holding the worker's wanted list: the committed synthetic uids. */
	const bucket = async (uids?: string[], outlines: import('./dams/observed/handover.js').WantedOutline[] = []) => {
		const d = mkdtempSync(join(tmpdir(), 'wm-fetcher-dams-'));
		dirs.push(d);
		const { openStore } = await import('./mirror/store.js');
		const { writeWanted } = await import('./dams/observed/handover.js');
		const { readdirSync } = await import('node:fs');
		const { WATERBODIES_FIXTURE_DIR } = await import('./dams/observed/waterbodies.js');
		const all = readdirSync(WATERBODIES_FIXTURE_DIR).map((f) => f.slice(0, -4)).sort();
		await writeWanted(openStore(pathToFileURL(`${d}/`).href), { generatedAt: new Date().toISOString(), waterbodies: uids ?? all.slice(0, 2), outlines });
		vi.stubEnv('MIRROR_URL', pathToFileURL(`${d}/`).href);
		return all;
	};

	it('routes the scheduled event to the dam passes, and nothing else', () => {
		expect(isDamsWeeklyEvent(DAMS_WEEKLY_EVENT)).toBe(true);
		expect(isDamsWeeklyEvent({ mode: 'dams-weekly', 'detail-type': 'Scheduled Event' })).toBe(true);
		expect(isDamsWeeklyEvent({ Records: [], mode: 'dams-weekly' })).toBe(false);
		expect(isDamsWeeklyEvent(DWS_WEEKLY_EVENT)).toBe(false);
		expect(isDwsWeeklyEvent(DAMS_WEEKLY_EVENT)).toBe(false);
		expect(isDailyIngestEvent(DAMS_WEEKLY_EVENT)).toBe(false);
	});

	it('runs the Waterbodies pass (fixtures here), publishes its heartbeat and recency, and logs counts, never a uid', async () => {
		const uids = await bucket();
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		const res = await handler({ mode: 'dams-weekly' } as never);
		const metric = out.mock.calls.map(([l]) => String(l)).find((l) => l.includes('DamPassCompleted'));
		out.mockRestore();
		expect(res).toEqual({
			waterbodies: { fetched: 2, unchanged: 0, failed: 0, fresh: 0, recencyDays: expect.any(Number), stopped: 'done' },
			// No outline listed: the WOfS pass has nothing to do.
			wofs: { fetched: 0, unchanged: 0, failed: 0, fresh: 0, recencyDays: null, stopped: 'done' }
		});
		expect(JSON.parse(metric!)).toMatchObject({ Source: 'waterbodies', DamPassCompleted: 1, DamObservationAgeDays: expect.any(Number) });
		const lines = info.mock.calls.map(([l]) => l as string);
		expect(lines.map((l) => JSON.parse(l)).find((l) => l.event === 'dams_pass')).toMatchObject({ source: 'waterbodies', fetched: 2, stopped: 'done', requests: 2 });
		for (const uid of uids) expect(lines.join('\n')).not.toContain(uid);
		expect(sent).toHaveLength(0);
	});

	it('fails the invocation on an HTTP 403, after its heartbeat and a log line saying refused', async () => {
		await bucket();
		vi.stubEnv('FEED_SOURCE', 'live');
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		const refuse = async () => {
			throw new FeedRefusedError();
		};
		httpOverride.next = { range: refuse, text: refuse, textConditional: refuse };
		await expect(handler({ mode: 'dams-weekly' } as never)).rejects.toBeInstanceOf(FeedRefusedError);
		expect(out.mock.calls.some(([l]) => String(l).includes('DamPassCompleted'))).toBe(true);
		const logged = error.mock.calls.map(([l]) => JSON.parse(l as string)).find((l) => l.event === 'dams_pass');
		expect(logged).toMatchObject({ source: 'waterbodies', fetched: 0, stopped: 'refused', reason: 'refused', detail: 'HTTP 403', requests: 1 });
	});

	// An invented dam outline the synthetic WOfS covers (dams/observed/wofs/fixtures.ts), wanted from 60 days back.
	const dam = () => ({
		featureId: '00000000-0000-4000-8000-0000000000d1',
		geometry: {
			type: 'Polygon' as const,
			coordinates: [
				[
					[22.306, -32.123],
					[22.313, -32.124],
					[22.314, -32.118],
					[22.309, -32.116],
					[22.306, -32.123]
				] as [number, number][]
			]
		},
		since: new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10)
	});

	it('runs the WOfS pass after Waterbodies (fixtures here), with its own heartbeat and a log of counts, never a dam', async () => {
		await bucket(undefined, [dam()]);
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		const res = (await handler({ mode: 'dams-weekly' } as never)) as DamsWeeklyAnswer;
		const metrics = out.mock.calls.map(([l]) => String(l)).filter((l) => l.includes('DamPassCompleted'));
		out.mockRestore();
		expect(res.wofs).toEqual({ fetched: 1, unchanged: 0, failed: 0, fresh: 0, recencyDays: expect.any(Number), stopped: 'done' });
		expect(metrics.map((l) => JSON.parse(l).Source)).toEqual(['waterbodies', 'wofs']);
		expect(JSON.parse(metrics[1]!)).toMatchObject({ DamPassCompleted: 1, DamObservationAgeDays: expect.any(Number) });
		const lines = info.mock.calls.map(([l]) => l as string);
		expect(lines.map((l) => JSON.parse(l)).find((l) => l.event === 'dams_pass' && l.source === 'wofs')).toMatchObject({ fetched: 1, stopped: 'done', sceneFailed: 0 });
		expect(lines.join('\n')).not.toContain(dam().featureId);
	});

	it('runs the Sentinel-2 pass after WOfS only with DAM_OBSERVATIONS_S2=on, with its own heartbeat and log (issue #624)', async () => {
		// The same 60 days as WOfS's: without sinceBy.s2 the pass backfills to 2019, years of synthetic 10 m scenes.
		await bucket(undefined, [{ ...dam(), sinceBy: { s2: dam().since } }]);
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		vi.stubEnv('DAM_OBSERVATIONS_S2', 'on');
		const res = (await handler({ mode: 'dams-weekly' } as never)) as DamsWeeklyAnswer;
		const metrics = out.mock.calls.map(([l]) => String(l)).filter((l) => l.includes('DamPassCompleted'));
		out.mockRestore();
		expect(res.s2).toEqual({ fetched: 1, unchanged: 0, failed: 0, fresh: 0, recencyDays: expect.any(Number), stopped: 'done' });
		expect(metrics.map((l) => JSON.parse(l).Source)).toEqual(['waterbodies', 'wofs', 's2']);
		const lines = info.mock.calls.map(([l]) => l as string);
		expect(lines.map((l) => JSON.parse(l)).find((l) => l.event === 'dams_pass' && l.source === 's2')).toMatchObject({ fetched: 1, stopped: 'done', sceneFailed: 0 });
		expect(lines.join('\n')).not.toContain(dam().featureId);
		// Off (or unset): no Sentinel-2 pass, no heartbeat for it.
		vi.stubEnv('DAM_OBSERVATIONS_S2', 'off');
		vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		expect(((await handler({ mode: 'dams-weekly' } as never)) as DamsWeeklyAnswer).s2).toBeUndefined();
		vi.stubEnv('DAM_OBSERVATIONS_S2', 'yes');
		await expect(handler({ mode: 'dams-weekly' } as never)).rejects.toThrow(/unknown DAM_OBSERVATIONS_S2/);
	});

	it('an hourly run with nothing due asks nothing, and still publishes both heartbeats and recencies', async () => {
		await bucket(undefined, [dam()]);
		vi.spyOn(console, 'info').mockImplementation(() => {});
		const quiet = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		await handler({ mode: 'dams-weekly' } as never);
		quiet.mockRestore();
		// The next run, the same day: every uid was fetched within the week and the dam's newest scenes checked today.
		vi.stubEnv('FEED_SOURCE', 'live');
		const asked = vi.fn(async () => {
			throw new Error('nothing should be asked');
		});
		httpOverride.next = { range: asked, text: asked, textConditional: asked };
		const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		const res = (await handler({ mode: 'dams-weekly' } as never)) as DamsWeeklyAnswer;
		const metrics = out.mock.calls.map(([l]) => String(l)).filter((l) => l.includes('DamPassCompleted'));
		out.mockRestore();
		expect(asked).not.toHaveBeenCalled();
		expect(res).toEqual({
			waterbodies: { fetched: 0, unchanged: 0, failed: 0, fresh: 2, recencyDays: expect.any(Number), stopped: 'done' },
			wofs: { fetched: 0, unchanged: 0, failed: 0, fresh: 1, recencyDays: expect.any(Number), stopped: 'done' }
		});
		expect(metrics.map((l) => JSON.parse(l))).toEqual([
			expect.objectContaining({ Source: 'waterbodies', DamPassCompleted: 1, DamObservationAgeDays: expect.any(Number) }),
			expect.objectContaining({ Source: 'wofs', DamPassCompleted: 1, DamObservationAgeDays: expect.any(Number) })
		]);
	});

	it('fails the invocation when STAC refuses the WOfS pass, after its heartbeat', async () => {
		await bucket([], [dam()]);
		vi.stubEnv('FEED_SOURCE', 'live');
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		const refuse = async () => {
			throw new FeedRefusedError();
		};
		httpOverride.next = { range: refuse, text: refuse, textConditional: refuse };
		await expect(handler({ mode: 'dams-weekly' } as never)).rejects.toBeInstanceOf(FeedRefusedError);
		expect(out.mock.calls.some(([l]) => String(l).includes('"Source":"wofs"'))).toBe(true);
		const logged = error.mock.calls.map(([l]) => JSON.parse(l as string)).find((l) => l.event === 'dams_pass' && l.source === 'wofs');
		expect(logged).toMatchObject({ fetched: 0, stopped: 'refused', reason: 'refused', detail: 'HTTP 403', stacRequests: 1 });
	});

	it('pauses a refused source for a day: the next run asks it nothing and publishes no heartbeat for it, the other source goes on', async () => {
		await bucket();
		vi.stubEnv('FEED_SOURCE', 'live');
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'info').mockImplementation(() => {});
		const quiet = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		const refuse = async () => {
			throw new FeedRefusedError();
		};
		httpOverride.next = { range: refuse, text: refuse, textConditional: refuse };
		// Waterbodies is refused; WOfS has no dam listed, so it completes.
		await expect(handler({ mode: 'dams-weekly' } as never)).rejects.toBeInstanceOf(FeedRefusedError);
		quiet.mockRestore();
		// The next hourly run.
		const asked = vi.fn(async () => {
			throw new Error('nothing should be asked while paused');
		});
		httpOverride.next = { range: asked, text: asked, textConditional: asked };
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		const res = (await handler({ mode: 'dams-weekly' } as never)) as DamsWeeklyAnswer;
		const metrics = out.mock.calls.map(([l]) => String(l)).filter((l) => l.includes('DamPassCompleted'));
		out.mockRestore();
		expect(asked).not.toHaveBeenCalled();
		expect(res.waterbodies).toEqual({ fetched: 0, unchanged: 0, failed: 0, fresh: 0, recencyDays: null, stopped: 'paused' });
		expect(res.wofs!.stopped).toBe('done');
		// Only WOfS's heartbeat: the missing Waterbodies one is the alert.
		expect(metrics.map((l) => JSON.parse(l).Source)).toEqual(['wofs']);
		const logged = warn.mock.calls.map(([l]) => JSON.parse(l as string)).find((l) => l.event === 'dams_pass' && l.source === 'waterbodies');
		expect(logged).toMatchObject({ stopped: 'paused', pausedUntil: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
		expect(Date.parse(logged.pausedUntil) - Date.now()).toBeGreaterThan(23 * 3_600_000);
	});

	it('refuses to write the committed synthetic copy, or no bucket at all', async () => {
		vi.stubEnv('MIRROR_URL', '');
		await expect(handler({ mode: 'dams-weekly' } as never)).rejects.toThrow(/MIRROR_URL must name/);
	});
});

describe('CHC’s request slot, shared with the mirror-ingest Lambda (feeds/hostSlot.ts)', () => {
	const dirs: string[] = [];
	afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
	const KEY = 'ingest-state/hosts/chc/lease.json';
	/** A copy for the slot, optionally with the Python ingest holding it (its lease.hold_host body). */
	const mirror = (heldBy?: string) => {
		const d = mkdtempSync(join(tmpdir(), 'wm-fetcher-slot-'));
		dirs.push(d);
		if (heldBy) {
			mkdirSync(join(d, 'ingest-state/hosts/chc'), { recursive: true });
			writeFileSync(join(d, KEY), JSON.stringify({ owner: 'py', expires: Date.now() / 1000 + 600, holder: heldBy }));
		}
		vi.stubEnv('MIRROR_URL', pathToFileURL(`${d}/`).href);
		return d;
	};
	const gefs = { v: 1, type: 'fetch', ...ids, request: { source: 'chirps_gefs', config: { cells: [{ lat: -20.12, lon: 25.17, weight: 1 }] }, start: today, end: today, today } };
	const counting = () => {
		const asked = { n: 0 };
		const count = async () => {
			asked.n++;
			return null;
		};
		httpOverride.next = { range: count, rangeTagged: count, text: count };
		return asked;
	};

	it('a CHC fetch with the slot free takes it, fetches as before, and lets it go (positive control)', async () => {
		vi.stubEnv('INGEST_RESULTS_QUEUE_URL', 'https://sqs.example/ingest-results');
		vi.spyOn(console, 'info').mockImplementation(() => {});
		const d = mirror();
		expect(await handler({ Records: [record('m1', gefs)] } as never)).toEqual({ batchItemFailures: [] });
		expect(sent[0]).toMatchObject({ message: { type: 'ingest', result: { ok: true, startDate: today } } });
		expect(existsSync(join(d, KEY))).toBe(false);
	});

	it('a CHC fetch with the slot held answers host_busy at once: no request, no failure, no retry towards the DLQ', async () => {
		vi.stubEnv('INGEST_RESULTS_QUEUE_URL', 'https://sqs.example/ingest-results');
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const d = mirror('ingest:rnl:backfill');
		const asked = counting();
		// Answered and deleted (no batch item failure): the receive count never climbs.
		expect(await handler({ Records: [record('m1', gefs)] } as never)).toEqual({ batchItemFailures: [] });
		expect(asked.n).toBe(0);
		expect(sent).toEqual([{ url: 'https://sqs.example/ingest-results', message: { v: 1, type: 'ingest', ...ids, result: { ok: false, deferred: 'host_busy' } } }]);
		const lines = [...info.mock.calls, ...warn.mock.calls].map(([l]) => JSON.parse(l as string));
		expect(lines.find((l) => l.event === 'feed_fetch_deferred')).toMatchObject({ feedId: ids.feedId, source: 'chirps_gefs', heldBy: 'ingest:rnl:backfill' });
		expect(lines.some((l) => l.event === 'feed_fetch_failed' || l.event === 'feed_fetched')).toBe(false);
		// The ingest's slot is left alone.
		expect(JSON.parse(readFileSync(join(d, KEY), 'utf8')).owner).toBe('py');
	});

	it('a backfill execution’s hold, or its reservation of the next turn, defers the fetch and names who and why in the log', async () => {
		vi.stubEnv('INGEST_RESULTS_QUEUE_URL', 'https://sqs.example/ingest-results');
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		// Held for the whole run (ingest/lease.py hold_host_for_backfill): the same deferral as any holder, by name.
		mirror('ingest:backfill:run-1');
		const asked = counting();
		expect(await handler({ Records: [record('m1', gefs)] } as never)).toEqual({ batchItemFailures: [] });
		const deferred = () => info.mock.calls.map(([l]) => JSON.parse(l as string)).filter((l) => l.event === 'feed_fetch_deferred');
		expect(deferred().at(-1)).toMatchObject({ heldBy: 'ingest:backfill:run-1', reserved: false });
		// Free, but a waiting backfill month reserved the next turn: the fetch gives the slot back and defers.
		const d = mirror();
		mkdirSync(join(d, 'ingest-state/hosts/chc'), { recursive: true });
		writeFileSync(join(d, 'ingest-state/hosts/chc/reserved.json'), JSON.stringify({ owner: 'backfill:x', expires: Date.now() / 1000 + 300, holder: 'ingest:backfill:run-2' }));
		await handler({ Records: [record('m2', gefs)] } as never);
		expect(deferred().at(-1)).toMatchObject({ heldBy: 'ingest:backfill:run-2', reserved: true });
		expect(existsSync(join(d, KEY))).toBe(false);
		expect(asked.n).toBe(0);
		expect(sent.map((s) => (s.message as { result: unknown }).result)).toEqual([{ ok: false, deferred: 'host_busy' }, { ok: false, deferred: 'host_busy' }]);
	});

	it('a DWS fetch takes no slot: DWS is not CHC', async () => {
		vi.stubEnv('INGEST_RESULTS_QUEUE_URL', 'https://sqs.example/ingest-results');
		vi.spyOn(console, 'info').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		mirror('ingest:rnl:backfill');
		const asked = counting();
		const dws = { v: 1, type: 'fetch', ...ids, request: { source: 'dws', config: { station: 'X0H000' }, start: today, end: today, today } };
		await handler({ Records: [record('m1', dws)] } as never);
		expect(asked.n).toBeGreaterThan(0);
		expect((sent[0]!.message as { result: { deferred?: string } }).result.deferred).toBeUndefined();
	});

	it('fails the fetch closed when the slot can’t be read or written, never asking CHC without it', async () => {
		vi.stubEnv('INGEST_RESULTS_QUEUE_URL', 'https://sqs.example/ingest-results');
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'info').mockImplementation(() => {});
		slotOverride.slots = {
			take: async () => {
				throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
			}
		};
		const asked = counting();
		expect(await handler({ Records: [record('m1', gefs)] } as never)).toEqual({ batchItemFailures: [] });
		expect(asked.n).toBe(0);
		const result = (sent[0]!.message as { result: { ok: boolean; error: string } }).result;
		expect(result.ok).toBe(false);
		expect(fetchFailureReason(result.error)).toBe('unavailable');
		expect(failureDetail(result.error)).toBe('the request slot could not be taken');
		expect(error.mock.calls.map(([l]) => JSON.parse(l as string)).find((l) => l.event === 'host_slot_failed')).toMatchObject({ host: 'chc', feedId: ids.feedId });
		expect(warn.mock.calls.map(([l]) => JSON.parse(l as string)).find((l) => l.event === 'feed_fetch_failed')).toMatchObject({ reason: 'unavailable', detail: 'the request slot could not be taken' });
	});

	it('the daily pass holds the slot while it runs and lets it go (positive control)', async () => {
		vi.spyOn(console, 'info').mockImplementation(() => {});
		vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		let during: unknown = null;
		const d = mirror();
		const real = await (await vi.importActual<typeof import('./feeds/http.js')>('./feeds/http.js')).feedHttp();
		const peek =
			<A extends unknown[], R>(f: (...a: A) => Promise<R>) =>
			async (...a: A) => {
				during ??= JSON.parse(readFileSync(join(d, KEY), 'utf8')).holder;
				return f(...a);
			};
		httpOverride.next = { range: peek(real.range), text: peek(real.text), ...(real.rangeTagged ? { rangeTagged: peek(real.rangeTagged) } : {}) };
		const res = await handler({ mode: 'daily-ingest' } as never);
		expect(res).toMatchObject({ stopped: 'max_files' });
		expect(during).toBe('fetcher:prelim');
		expect(existsSync(join(d, KEY))).toBe(false);
	});

	it('a scheduled pass that finds the slot held past its wait skips the run: asks nothing, logs host_busy, doesn’t fail', async () => {
		slotOverride.waitMs = 0;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const d = mirror('ingest:sat:monthly');
		const asked = counting();
		for (const [event, product] of [
			[DAILY_INGEST_EVENT, 'prelim'],
			[GEFS_INGEST_EVENT, 'gefs']
		] as const) {
			const res = await handler(event as never);
			expect(res).toMatchObject({ stopped: 'host_busy', lagDays: null });
			expect(warn.mock.calls.map(([l]) => JSON.parse(l as string)).find((l) => l.event === 'mirror_daily_ingest' && l.product === product)).toMatchObject({
				stopped: 'host_busy',
				heldBy: 'ingest:sat:monthly',
				requests: 0
			});
		}
		expect(asked.n).toBe(0);
		expect(existsSync(join(d, 'prelim'))).toBe(false);
		expect(existsSync(join(d, 'gefs'))).toBe(false);
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

describe('the fetcher’s et-dekadal mode (issue #623)', () => {
	const dirs: string[] = [];
	afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
	const UNIT = '00000000-0000-4000-8000-0000000000e1';
	/** A bucket of its own holding the worker's wanted list: one invented unit inside the synthetic WaPOR's cover. */
	const bucket = async () => {
		const d = mkdtempSync(join(tmpdir(), 'wm-fetcher-et-'));
		dirs.push(d);
		const { openStore } = await import('./mirror/store.js');
		const { writeWanted } = await import('./water-use/observed/handover.js');
		const ring: [number, number][] = [
			[21.31, -33.69],
			[21.32, -33.69],
			[21.32, -33.68],
			[21.31, -33.68],
			[21.31, -33.69]
		];
		await writeWanted(openStore(pathToFileURL(`${d}/`).href), { generatedAt: new Date().toISOString(), units: [{ unitKey: UNIT, parcels: { type: 'MultiPolygon', coordinates: [[ring]] } }] });
		vi.stubEnv('MIRROR_URL', pathToFileURL(`${d}/`).href);
	};

	it('routes the scheduled event to the ET pass, and nothing else', () => {
		expect(isEtDekadalEvent(ET_DEKADAL_EVENT)).toBe(true);
		expect(isEtDekadalEvent({ mode: 'et-dekadal', 'detail-type': 'Scheduled Event' })).toBe(true);
		expect(isEtDekadalEvent({ Records: [], mode: 'et-dekadal' })).toBe(false);
		expect(isEtDekadalEvent(DAMS_WEEKLY_EVENT)).toBe(false);
		expect(isDamsWeeklyEvent(ET_DEKADAL_EVENT)).toBe(false);
		expect(isDailyIngestEvent(ET_DEKADAL_EVENT)).toBe(false);
	});

	it('runs the WaPOR pass (fixtures here), publishes its heartbeat and recency, and logs counts, never a unit', async () => {
		await bucket();
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		const res = await handler({ mode: 'et-dekadal' } as never);
		const metric = out.mock.calls.map(([l]) => String(l)).find((l) => l.includes('EtPassCompleted'));
		out.mockRestore();
		expect(res).toMatchObject({ written: 1, failed: 0, stopped: 'done', recencyDays: expect.any(Number) });
		expect(JSON.parse(metric!)).toMatchObject({ Source: 'wapor', EtPassCompleted: 1, EtObservationAgeDays: expect.any(Number) });
		const lines = info.mock.calls.map(([l]) => l as string);
		expect(lines.map((l) => JSON.parse(l)).find((l) => l.event === 'et_pass')).toMatchObject({ source: 'wapor', written: 1, stopped: 'done' });
		expect(lines.join('\n')).not.toContain(UNIT);
		expect(sent).toHaveLength(0);
	}, 60_000);

	it('fails the invocation on an HTTP 403, after its heartbeat and a log line saying refused, then pauses with no heartbeat', async () => {
		await bucket();
		vi.stubEnv('FEED_SOURCE', 'live');
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		const refuse = async () => {
			throw new FeedRefusedError();
		};
		httpOverride.next = { range: refuse, text: refuse, rangeTagged: refuse, rangeConditional: refuse };
		await expect(handler({ mode: 'et-dekadal' } as never)).rejects.toBeInstanceOf(FeedRefusedError);
		expect(out.mock.calls.some(([l]) => String(l).includes('EtPassCompleted'))).toBe(true);
		const logged = error.mock.calls.map(([l]) => JSON.parse(l as string)).find((l) => l.event === 'et_pass');
		expect(logged).toMatchObject({ source: 'wapor', stopped: 'refused', reason: 'refused', detail: 'HTTP 403', requests: 1 });
		out.mockClear();
		expect(await handler({ mode: 'et-dekadal' } as never)).toMatchObject({ stopped: 'paused' });
		expect(out.mock.calls.some(([l]) => String(l).includes('EtPassCompleted'))).toBe(false);
		expect(warn.mock.calls.map(([l]) => JSON.parse(l as string)).find((l) => l.event === 'et_pass')).toMatchObject({ stopped: 'paused' });
	});
});
