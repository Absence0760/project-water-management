import { describe, expect, it, vi } from 'vitest';
import { FeedRefusedError, FeedThrottledError, FeedUnavailableError, feedErrorMessage } from './errors.js';
import {
	feedHttp,
	FEED_HOST_PATHS,
	FEED_HOSTS,
	feedSourceMode,
	fileTag,
	hostPacer,
	liveHttp as pacedLiveHttp,
	PACE_JITTER_MS,
	PACE_MIN_SPACING_MS,
	type Pacer,
	REFUSED_PAUSE_SECONDS,
	retryAfterSeconds,
	THROTTLE_DEFAULT_SECONDS,
	THROTTLE_MAX_SECONDS,
	type ThrottleState,
	userAgent
} from './http.js';

/** No pacing: the client's other behaviour, without a second's wait per request (the pacing has its own tests below). */
const noPace: Pacer = { acquire: async () => () => {} };
const liveHttp = (f: Parameters<typeof pacedLiveHttp>[0], throttle?: ThrottleState, pacer: Pacer = noPace, contact?: string) => pacedLiveHttp(f, throttle, pacer, contact);

describe('feedSourceMode', () => {
	it('defaults to fixtures (local-first: no network in dev or CI)', () => {
		expect(feedSourceMode(undefined)).toBe('fixtures');
		expect(feedSourceMode(' ')).toBe('fixtures');
		expect(feedSourceMode('live')).toBe('live');
		expect(() => feedSourceMode('internet')).toThrow(/unknown FEED_SOURCE/);
	});

	it('fixtures never touch the network', async () => {
		const spy = vi.spyOn(globalThis, 'fetch');
		const http = await feedHttp('fixtures');
		expect(await http.text('https://www.dws.gov.za/elsewhere')).toBeNull();
		expect(await http.range('https://example.com/a.tif', 0, 7)).toBeNull();
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
});

describe('liveHttp', () => {
	const respond = (status: number, body = '', headers: Record<string, string> = {}) => vi.fn(async () => new Response(status === 204 ? null : body, { status, headers }));

	it('sends a Range header and our user agent, and returns the bytes of a 206', async () => {
		const f = respond(206, 'abcd');
		const bytes = await liveHttp(f).range('https://data.chc.ucsb.edu/a.tif', 10, 13);
		expect(new TextDecoder().decode(bytes!)).toBe('abcd');
		const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
		expect(init.headers).toMatchObject({ range: 'bytes=10-13', 'user-agent': expect.stringMatching(/^water-management-feeds\//) });
	});

	it('cuts the range out of a 200 (a server that ignores Range)', async () => {
		const bytes = await liveHttp(respond(200, '0123456789')).range('https://data.chc.ucsb.edu/a.tif', 2, 4);
		expect(new TextDecoder().decode(bytes!)).toBe('234');
	});

	it('reads 404 (and 416) as "not published"', async () => {
		expect(await liveHttp(respond(404, 'Not Found')).range('https://data.chc.ucsb.edu/a.tif', 0, 7)).toBeNull();
		expect(await liveHttp(respond(416)).range('https://data.chc.ucsb.edu/a.tif', 99, 100)).toBeNull();
		expect(await liveHttp(respond(404)).text('https://data.chc.ucsb.edu/p')).toBeNull();
	});

	it('turns other statuses, network errors and timeouts into FeedUnavailableError with our own message', async () => {
		await expect(liveHttp(respond(502, '<h1>secret stack</h1>')).text('https://data.chc.ucsb.edu/p')).rejects.toThrow(new FeedUnavailableError('HTTP 502'));
		await expect(liveHttp(respond(500)).text('https://data.chc.ucsb.edu/p')).rejects.toThrow('HTTP 500');
		await expect(liveHttp(vi.fn(async () => { throw new TypeError('fetch failed: getaddrinfo ENOTFOUND'); })).text('https://data.chc.ucsb.edu/p')).rejects.toThrow(
			new FeedUnavailableError('the request failed')
		);
		const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
		await expect(liveHttp(vi.fn(async () => { throw timeout; })).text('https://data.chc.ucsb.edu/p')).rejects.toThrow('the request timed out');
	});

	it('reads HTTP 429 and 503 as throttled, and stops asking that host for the pause its Retry-After asks (positive control: another host is asked)', async () => {
		const throttle: ThrottleState = new Map();
		const busy = vi.fn(async () => new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }));
		const err = await liveHttp(busy, throttle).range('https://data.chc.ucsb.edu/a.tif', 0, 7).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(FeedThrottledError);
		expect(err).toBeInstanceOf(FeedUnavailableError);
		expect(err).toMatchObject({ status: 429, retryAfterSeconds: 120, message: 'HTTP 429: the source asked us to slow down, so the feed tries again later' });
		// The next request to that host, from any client sharing the state, fails at once without asking.
		const ok = respond(206, 'ab');
		await expect(liveHttp(ok, throttle).range('https://data.chc.ucsb.edu/b.tif', 0, 1)).rejects.toMatchObject({ status: 429, retryAfterSeconds: expect.any(Number) });
		expect(ok).not.toHaveBeenCalled();
		expect(await liveHttp(ok, throttle).text('https://www.dws.gov.za/p')).toBe('ab');
		expect(throttle.get('data.chc.ucsb.edu')!.until - Date.now()).toBeGreaterThan(110_000);
		// Once the pause is over, it is asked again.
		throttle.get('data.chc.ucsb.edu')!.until = Date.now() - 1;
		expect(new TextDecoder().decode((await liveHttp(ok, throttle).range('https://data.chc.ucsb.edu/b.tif', 0, 1))!)).toBe('ab');
		expect(throttle.has('data.chc.ucsb.edu')).toBe(false);
	});

	it('reads HTTP 403 as refused, not throttled, and stops asking that host for an hour, whatever Retry-After says (positive control: another host is asked)', async () => {
		const throttle: ThrottleState = new Map();
		const banned = vi.fn(async () => new Response('<h1>403 Forbidden</h1>', { status: 403, headers: { 'retry-after': '5' } }));
		const err = await liveHttp(banned, throttle).range('https://data.chc.ucsb.edu/a.tif', 0, 7).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(FeedRefusedError);
		expect(err).not.toBeInstanceOf(FeedThrottledError);
		// Still a FeedUnavailableError: nothing is written and the fetch stops reading.
		expect(err).toBeInstanceOf(FeedUnavailableError);
		expect(err).toMatchObject({ status: 403, message: 'HTTP 403' });
		expect(feedErrorMessage(err)).toBe('the source refused this server’s requests (HTTP 403): it may have blocked this server’s address, so the feed waits hours before asking again');
		const left = throttle.get('data.chc.ucsb.edu')!.until - Date.now();
		expect(left).toBeGreaterThan((REFUSED_PAUSE_SECONDS - 10) * 1000);
		expect(left).toBeLessThanOrEqual(REFUSED_PAUSE_SECONDS * 1000);
		// Longer than any 429 pause: a ban doesn't lift in a minute.
		expect(REFUSED_PAUSE_SECONDS).toBeGreaterThan(THROTTLE_MAX_SECONDS);
		// The next request to that host fails at once, refused again, without asking.
		const ok = respond(206, 'ab');
		await expect(liveHttp(ok, throttle).range('https://data.chc.ucsb.edu/b.tif', 0, 1)).rejects.toBeInstanceOf(FeedRefusedError);
		await expect(liveHttp(ok, throttle).head!('https://data.chc.ucsb.edu/b.tif')).rejects.toBeInstanceOf(FeedRefusedError);
		expect(ok).not.toHaveBeenCalled();
		expect(await liveHttp(ok, throttle).text('https://www.dws.gov.za/p')).toBe('ab');
		// Once the pause is over, it is asked again.
		throttle.get('data.chc.ucsb.edu')!.until = Date.now() - 1;
		expect(new TextDecoder().decode((await liveHttp(ok, throttle).range('https://data.chc.ucsb.edu/b.tif', 0, 1))!)).toBe('ab');
		expect(throttle.has('data.chc.ucsb.edu')).toBe(false);
	});

	it('a 404 or 416 pauses nothing: "not published" is no refusal', async () => {
		const throttle: ThrottleState = new Map();
		expect(await liveHttp(respond(404), throttle).range('https://data.chc.ucsb.edu/a.tif', 0, 7)).toBeNull();
		expect(await liveHttp(respond(416), throttle).range('https://data.chc.ucsb.edu/a.tif', 0, 7)).toBeNull();
		expect(throttle.size).toBe(0);
	});

	it('a 503 without Retry-After pauses the default; a Retry-After past the cap pauses only the cap', async () => {
		const throttle: ThrottleState = new Map();
		await expect(liveHttp(respond(503), throttle).text('https://data.chc.ucsb.edu/p')).rejects.toMatchObject({ status: 503, retryAfterSeconds: null });
		expect(throttle.get('data.chc.ucsb.edu')!.until - Date.now()).toBeLessThanOrEqual(THROTTLE_DEFAULT_SECONDS * 1000);
		throttle.clear();
		await expect(liveHttp(respond(429, '', { 'retry-after': '86400' }), throttle).text('https://data.chc.ucsb.edu/p')).rejects.toMatchObject({ retryAfterSeconds: 86400 });
		expect(throttle.get('data.chc.ucsb.edu')!.until - Date.now()).toBeLessThanOrEqual(THROTTLE_MAX_SECONDS * 1000);
		expect(throttle.get('data.chc.ucsb.edu')!.until - Date.now()).toBeGreaterThan((THROTTLE_MAX_SECONDS - 10) * 1000);
	});

	it('reads Retry-After as seconds or an HTTP date, and nothing else', () => {
		const now = Date.parse('2026-10-25T00:00:00Z');
		expect(retryAfterSeconds('120', now)).toBe(120);
		expect(retryAfterSeconds(' 0 ', now)).toBe(0);
		expect(retryAfterSeconds('Sun, 25 Oct 2026 00:02:00 GMT', now)).toBe(120);
		expect(retryAfterSeconds('Sat, 24 Oct 2026 23:00:00 GMT', now)).toBe(0);
		expect(retryAfterSeconds(null, now)).toBeNull();
		expect(retryAfterSeconds('soon', now)).toBeNull();
		expect(retryAfterSeconds('-5', now)).toBeNull();
	});

	it('gives a range read the file’s tag: its ETag, else lm: and its Last-Modified, else none', async () => {
		const etag = await liveHttp(respond(206, 'ab', { etag: '"677dc35c-c30e00"', 'last-modified': 'Wed, 08 Jan 2025 00:14:20 GMT' })).rangeTagged!('https://data.chc.ucsb.edu/a.tif', 0, 1);
		expect(etag).toMatchObject({ tag: '"677dc35c-c30e00"' });
		expect(new TextDecoder().decode(etag!.bytes)).toBe('ab');
		expect(await liveHttp(respond(206, 'ab', { 'last-modified': 'Wed, 08 Jan 2025 00:14:20 GMT' })).rangeTagged!('https://data.chc.ucsb.edu/a.tif', 0, 1)).toMatchObject({
			tag: 'lm:Wed, 08 Jan 2025 00:14:20 GMT'
		});
		expect(await liveHttp(respond(206, 'ab')).rangeTagged!('https://data.chc.ucsb.edu/a.tif', 0, 1)).toMatchObject({ tag: null });
		expect(await liveHttp(respond(404)).rangeTagged!('https://data.chc.ucsb.edu/a.tif', 0, 1)).toBeNull();
	});

	it('keeps no tag that isn’t short printable ASCII: an upstream header is never stored unchecked', () => {
		expect(fileTag(new Headers({ etag: `"${'x'.repeat(250)}"` }))).toBeNull();
		expect(fileTag(new Headers({ etag: '"a\tb"' }))).toBeNull();
		expect(fileTag(new Headers({ etag: 'W/"abc"' }))).toBe('W/"abc"');
	});

	it('HEAD asks with method HEAD and no Range, reads no body (a 12 MB file’s content-length is no refusal), and gives the tag', async () => {
		const f = respond(200, '', { etag: '"t1"', 'content-length': String(12 * 1024 * 1024) });
		expect(await liveHttp(f).head!('https://data.chc.ucsb.edu/a.tif')).toEqual({ tag: '"t1"' });
		const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
		expect(init.method).toBe('HEAD');
		expect(init.headers).not.toHaveProperty('range');
		expect(await liveHttp(respond(404)).head!('https://data.chc.ucsb.edu/a.tif')).toBeNull();
		await expect(liveHttp(respond(502)).head!('https://data.chc.ucsb.edu/a.tif')).rejects.toThrow(new FeedUnavailableError('HTTP 502'));
	});

	it('HEAD keeps to the known hosts too (the re-check is no way around the SSRF rule)', async () => {
		const f = vi.fn(async () => new Response(null, { status: 200 }));
		await expect(liveHttp(f).head!('https://169.254.169.254/latest/meta-data/')).rejects.toThrow(/not a known source host/);
		expect(f).not.toHaveBeenCalled();
		const hop = vi.fn<(url: string, init: RequestInit) => Promise<Response>>().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://example.com/a.tif' } }));
		await expect(liveHttp(hop as never).head!('https://data.chc.ucsb.edu/a.tif')).rejects.toThrow(/redirected somewhere it may not/);
	});

	it('asks conditionally with the ETag held: 304 is not-modified, 200 the text with its ETag and Last-Modified (checked), 404 null', async () => {
		const WB = 'https://deafrica-services.s3.af-south-1.amazonaws.com/waterbodies/v0.0.2/surface_area_change/zzzz/zzzzza0001.csv';
		const notModified = () => vi.fn(async () => new Response(null, { status: 304 }));
		const same = notModified();
		expect(await liveHttp(same).textConditional!(WB, '"e1"')).toEqual({ status: 'not-modified' });
		expect((same.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'if-none-match': '"e1"', 'user-agent': expect.stringMatching(/^water-management-feeds\//) });
		const fresh = respond(200, 'date,pc_wet\n', { etag: '"e2"', 'last-modified': 'Mon, 26 Feb 2024 10:00:00 GMT' });
		expect(await liveHttp(fresh).textConditional!(WB, null)).toEqual({ status: 'ok', text: 'date,pc_wet\n', etag: '"e2"', lastModified: 'Mon, 26 Feb 2024 10:00:00 GMT' });
		expect((fresh.mock.calls[0] as unknown as [string, RequestInit])[1].headers).not.toHaveProperty('if-none-match');
		expect(await liveHttp(respond(200, 'x', { etag: '"a\tb"' })).textConditional!(WB, null)).toMatchObject({ etag: null, lastModified: null });
		expect(await liveHttp(respond(404)).textConditional!(WB, '"e1"')).toBeNull();
		// A 304 to a request that wasn't conditional is no answer to it.
		await expect(liveHttp(notModified()).textConditional!(WB, null)).rejects.toThrow(new FeedUnavailableError('HTTP 304'));
		await expect(liveHttp(respond(403), new Map()).textConditional!(WB, '"e1"')).rejects.toBeInstanceOf(FeedRefusedError);
	});

	it('asks for a range only if the file’s ETag changed (the observed ET pass’s re-check of a WaPOR dekad)', async () => {
		const W = 'https://storage.googleapis.com/fao-gismgr-wapor-3-data/DATA/WAPOR-3/MAPSET/L2-AETI-D/WAPOR-3.L2-AETI-D.2024-01-D1.tif';
		const same = vi.fn(async () => new Response(null, { status: 304 }));
		expect(await liveHttp(same).rangeConditional!(W, 0, 15, '"e1"')).toEqual({ status: 'not-modified' });
		expect((same.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ range: 'bytes=0-15', 'if-none-match': '"e1"' });
		const changed = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 206, headers: { etag: '"e2"' } }));
		expect(await liveHttp(changed).rangeConditional!(W, 0, 2, '"e1"')).toEqual({ status: 'ok', bytes: new Uint8Array([1, 2, 3]), tag: '"e2"' });
		// A server that ignores Range: the range cut out of the whole.
		const whole = vi.fn(async () => new Response(new Uint8Array([9, 8, 7, 6]), { status: 200, headers: { etag: '"e3"' } }));
		expect(await liveHttp(whole).rangeConditional!(W, 1, 2, '"e1"')).toEqual({ status: 'ok', bytes: new Uint8Array([8, 7]), tag: '"e3"' });
		expect(await liveHttp(respond(404)).rangeConditional!(W, 0, 1, '"e1"')).toBeNull();
		await expect(liveHttp(respond(403), new Map()).rangeConditional!(W, 0, 1, '"e1"')).rejects.toBeInstanceOf(FeedRefusedError);
	});

	it('refuses a response over 4 MB, declared or streamed', async () => {
		await expect(liveHttp(respond(200, 'x', { 'content-length': String(5 * 1024 * 1024) })).text('https://data.chc.ucsb.edu/p')).rejects.toThrow(/larger than expected/);
		const big = new Uint8Array(4 * 1024 * 1024 + 1);
		await expect(liveHttp(vi.fn(async () => new Response(big, { status: 200 }))).text('https://data.chc.ucsb.edu/p')).rejects.toThrow(/larger than expected/);
	});
});

describe('liveHttp: where it may go', () => {
	const CHC = 'https://data.chc.ucsb.edu/products/a.tif';
	const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });
	type F = (url: string, init: RequestInit) => Promise<Response>;

	it('asks only the known source hosts, over HTTPS', async () => {
		const f = vi.fn(async () => new Response('ok', { status: 200 }));
		const http = liveHttp(f);
		await expect(http.text('https://169.254.169.254/latest/meta-data/')).rejects.toThrow(
			new FeedUnavailableError('the request was refused (not a known source host)')
		);
		await expect(http.text('http://www.dws.gov.za/Hydrology/Verified/HyData.aspx')).rejects.toThrow(/not a known source host/);
		await expect(http.range('https://data.chc.ucsb.edu.evil.example/a.tif', 0, 1)).rejects.toThrow(/not a known source host/);
		await expect(http.text('https://user@www.dws.gov.za:8443/x')).rejects.toThrow(/not a known source host/);
		expect(f).not.toHaveBeenCalled();
		// Positive control: the real hosts are asked.
		expect(await http.text('https://www.dws.gov.za/Hydrology/Verified/HyData.aspx?Station=X0H000')).toBe('ok');
		expect(await http.text(CHC)).toBe('ok');
	});

	it('asks Digital Earth Africa’s Sentinel-2 C1 and Sentinel-1 buckets, and not their other buckets', async () => {
		const f = vi.fn(async () => new Response('ok', { status: 200 }));
		const http = liveHttp(f);
		expect(await http.text('https://deafrica-sentinel-2-l2a-c1.s3.af-south-1.amazonaws.com/sentinel-2-c1-l2a/34/H/BH/2026/10/x/B03.tif')).toBe('ok');
		expect(await http.text('https://deafrica-sentinel-1.s3.af-south-1.amazonaws.com/s1_rtc/S34E019/2026/10/20/0A1B2C/a_VV.tif')).toBe('ok');
		await expect(http.text('https://deafrica-sentinel-2.s3.af-south-1.amazonaws.com/a.tif')).rejects.toThrow(/not a known source host/);
		await expect(http.text('https://deafrica-sentinel-1.s3.us-west-2.amazonaws.com/a.tif')).rejects.toThrow(/not a known source host/);
		expect(f).toHaveBeenCalledTimes(2);
	});

	it('asks the actual ET hosts only under their own prefix: FAO\'s bucket, never another bucket on Google Cloud Storage', async () => {
		const WAPOR = 'https://storage.googleapis.com/fao-gismgr-wapor-3-data/DATA/WAPOR-3/MAPSET/L2-AETI-D/WAPOR-3.L2-AETI-D.2026-10-D2.tif';
		const SSEBOP = 'https://edcintl.cr.usgs.gov/downloads/sciweb1/shared/fews/web/global/dekadal/etav61/downloads/dekadal/d2026102.zip';
		expect(FEED_HOSTS).toEqual(expect.arrayContaining(['storage.googleapis.com', 'edcintl.cr.usgs.gov']));
		expect(FEED_HOST_PATHS).toEqual({
			'storage.googleapis.com': ['/fao-gismgr-wapor-3-data/'],
			'edcintl.cr.usgs.gov': ['/downloads/sciweb1/shared/fews/web/global/dekadal/etav61/']
		});
		const f = vi.fn(async () => new Response('ok', { status: 200 }));
		const http = liveHttp(f);
		for (const url of [
			'https://storage.googleapis.com/isric-share-soilgrids/pre-release/wv0033/x.tif',
			'https://storage.googleapis.com/fao-gismgr-wapor-3-data-evil/a.tif',
			'https://storage.googleapis.com/fao-gismgr-wapor-3-data',
			'https://storage.googleapis.com/fao-gismgr-wapor-3-data/../other/a.tif',
			'https://storage.googleapis.com/fao-gismgr-wapor-3-data/%2e%2e/other/a.tif',
			'https://storage.googleapis.com/fao-gismgr-wapor-3-data%2F..%2Fother/a.tif',
			'https://storage.googleapis.com/storage/v1/b/other/o',
			'https://edcintl.cr.usgs.gov/downloads/sciweb1/shared/fews/web/global/dekadal/eta/downloads/d2021063.zip'
		]) {
			await expect(http.text(url), url).rejects.toThrow(/not a known source host/);
		}
		expect(f).not.toHaveBeenCalled();
		// Positive control: the two trees are asked.
		expect(await http.text(WAPOR)).toBe('ok');
		expect(await http.text(SSEBOP)).toBe('ok');
		// A redirect out of the bucket is refused like one off the hosts.
		const hop = vi.fn<F>().mockResolvedValueOnce(redirect('/isric-share-soilgrids/a.tif'));
		await expect(liveHttp(hop as never).text(WAPOR)).rejects.toThrow(/redirected somewhere it may not/);
	});

	it('gives every hop the one 20 s deadline: a single abort signal, set before the first request and shared by the redirect after it', async () => {
		const timeout = vi.spyOn(AbortSignal, 'timeout');
		const f = vi.fn<F>().mockResolvedValueOnce(redirect('/products/b.tif')).mockResolvedValueOnce(new Response('ok', { status: 200 }));
		await liveHttp(f as never).text(CHC);
		expect(timeout).toHaveBeenCalledTimes(1);
		expect(timeout).toHaveBeenCalledWith(20_000);
		const signals = f.mock.calls.map(([, init]) => init.signal);
		expect(signals[0]).toBe(timeout.mock.results[0]!.value);
		expect(signals[1]).toBe(signals[0]);
		timeout.mockRestore();
	});

	it('never lets fetch follow redirects on its own', async () => {
		const f = vi.fn(async () => new Response('ok', { status: 200 }));
		await liveHttp(f).text(CHC);
		expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe('manual');
	});

	it('follows a redirect to a known host over HTTPS, keeping the headers', async () => {
		const f = vi.fn<F>().mockResolvedValueOnce(redirect('/products/b.tif', 301)).mockResolvedValueOnce(new Response('abcd', { status: 206 }));
		const bytes = await liveHttp(f as never).range(CHC, 4, 7);
		expect(new TextDecoder().decode(bytes!)).toBe('abcd');
		expect(f.mock.calls[1]![0]).toBe('https://data.chc.ucsb.edu/products/b.tif');
		expect(f.mock.calls[1]![1].headers).toMatchObject({ range: 'bytes=4-7' });
	});

	it('refuses a redirect off the known hosts, to plain HTTP, without a Location, or one hop too many', async () => {
		const once = (r: Response) => vi.fn<F>().mockResolvedValueOnce(r) as never;
		await expect(liveHttp(once(redirect('http://169.254.170.2/v2/credentials'))).text(CHC)).rejects.toThrow(
			new FeedUnavailableError('the source redirected somewhere it may not')
		);
		await expect(liveHttp(once(redirect('http://data.chc.ucsb.edu/products/a.tif'))).text(CHC)).rejects.toThrow(/redirected somewhere/);
		await expect(liveHttp(once(new Response(null, { status: 302 }))).text(CHC)).rejects.toThrow(/redirected somewhere/);
		const loop = vi.fn(async () => redirect(CHC));
		await expect(liveHttp(loop).text(CHC)).rejects.toThrow(new FeedUnavailableError('the source redirected too many times'));
		expect(loop).toHaveBeenCalledTimes(4);
	});

	it('a timeout or reset while the body streams is "unavailable" with our message, not an internal error', async () => {
		const failing = (err: Error) =>
			vi.fn(
				async () =>
					new Response(
						new ReadableStream({
							start(c) {
								c.enqueue(new Uint8Array(10));
							},
							pull(c) {
								c.error(err);
							}
						}),
						{ status: 200 }
					)
			);
		const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
		await expect(liveHttp(failing(timeout)).text(CHC)).rejects.toThrow(new FeedUnavailableError('the request timed out'));
		await expect(liveHttp(failing(new TypeError('terminated: other side closed'))).text(CHC)).rejects.toThrow(new FeedUnavailableError('the request failed'));
	});
});

// Issue #604 R3-C: on Lambda only the fetcher asks CHC or DWS. The worker's
// bundle holds the inline fetch path (local dev's), so module reachability
// can't prove it; this runtime refusal does, whatever the flags say.
describe('live requests outside the fetcher Lambda', () => {
	it('on Lambda, liveHttp (and feedHttp live) refuse until the process is the fetcher; fixtures and off-Lambda stay allowed', async () => {
		vi.resetModules();
		const fresh = await import('./http.js');
		const spy = vi.spyOn(globalThis, 'fetch');
		try {
			// Off Lambda: allowed (dev, CI, a hand-run script; positive control).
			expect(() => fresh.liveHttp(vi.fn())).not.toThrow();
			vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'water-management-worker');
			expect(() => fresh.liveHttp()).toThrow(/refusing a live feed request outside the fetcher Lambda/);
			await expect(fresh.feedHttp('live')).rejects.toThrow(/outside the fetcher Lambda/);
			expect(await (await fresh.feedHttp('fixtures')).text('https://www.dws.gov.za/elsewhere')).toBeNull();
			expect(spy).not.toHaveBeenCalled();
			// The fetcher's entry point opts in (positive control).
			fresh.allowLiveFeedRequests();
			expect(() => fresh.liveHttp(vi.fn())).not.toThrow();
		} finally {
			spy.mockRestore();
			vi.unstubAllEnvs();
			vi.resetModules();
		}
	});

	it('only the fetcher Lambda’s entry point opts in', async () => {
		const { readdirSync, readFileSync } = await import('node:fs');
		const { fileURLToPath } = await import('node:url');
		const src = fileURLToPath(new URL('../', import.meta.url));
		const callers = (readdirSync(src, { recursive: true }) as string[])
			.filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
			.filter((f) => /\ballowLiveFeedRequests\(\)/.test(readFileSync(`${src}${f}`, 'utf8')))
			.sort();
		expect(callers).toEqual(['feeds/http.ts', 'lambda-fetcher.ts']);
		// And it does so at init, before any handler runs.
		expect(readFileSync(`${src}lambda-fetcher.ts`, 'utf8')).toMatch(/^allowLiveFeedRequests\(\);$/m);
	});
});

describe('userAgent (CHC asked for a contact in it, issue #604)', () => {
	it('names the product and the repo, and the contact when one is given', () => {
		expect(userAgent(undefined)).toBe('water-management-feeds/1 (+https://github.com/Absence0760/project-water-management)');
		expect(userAgent(' ops@example.com ')).toBe('water-management-feeds/1 (+https://github.com/Absence0760/project-water-management; ops@example.com)');
	});

	it('leaves out a contact that is not an address, so nothing unchecked reaches the header', () => {
		for (const bad of ['', 'nobody', 'ops@example.com)\r\nX-Evil: 1', 'ops@example.com; other', '<ops@example.com>']) {
			expect(userAgent(bad), bad).toBe('water-management-feeds/1 (+https://github.com/Absence0760/project-water-management)');
		}
	});

	it('is the agent every request sends', async () => {
		const f = vi.fn(async () => new Response('ab', { status: 206 }));
		await liveHttp(f, new Map(), noPace, 'ops@example.com').range('https://data.chc.ucsb.edu/a.tif', 0, 1);
		const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
		expect((init.headers as Record<string, string>)['user-agent']).toBe(userAgent('ops@example.com'));
	});
});

describe('hostPacer (about one request a second per host, one at a time, issue #604)', () => {
	/** A clock that only moves when the pacer sleeps, or when a test moves it. */
	const clock = () => {
		let t = 1_000_000;
		const sleeps: number[] = [];
		return {
			now: () => t,
			advance: (ms: number) => (t += ms),
			sleep: async (ms: number) => {
				sleeps.push(ms);
				t += ms;
			},
			sleeps
		};
	};

	it('spaces request starts to one host by 1 s plus 0–0.5 s of jitter', async () => {
		expect([PACE_MIN_SPACING_MS, PACE_JITTER_MS]).toEqual([1000, 500]);
		for (const r of [0, 0.5, 0.999]) {
			const c = clock();
			const pacer = hostPacer({ now: c.now, sleep: c.sleep, random: () => r });
			const starts: number[] = [];
			for (let i = 0; i < 3; i++) {
				const release = await pacer.acquire('data.chc.ucsb.edu');
				starts.push(c.now());
				c.advance(200); // the request takes 200 ms
				release();
			}
			const gaps = starts.slice(1).map((t, i) => t - starts[i]!);
			for (const gap of gaps) {
				expect(gap).toBeGreaterThanOrEqual(1000);
				expect(gap).toBeLessThan(1500);
				expect(gap).toBeCloseTo(1000 + r * 500, 6);
			}
		}
	});

	it('never waits for the spacing a slow request already used up', async () => {
		const c = clock();
		const pacer = hostPacer({ now: c.now, sleep: c.sleep, random: () => 0.5 });
		(await pacer.acquire('data.chc.ucsb.edu'))();
		c.advance(3000);
		const release = await pacer.acquire('data.chc.ucsb.edu');
		release();
		expect(c.sleeps).toEqual([]);
	});

	it('the first request to a host waits for nothing', async () => {
		const c = clock();
		(await hostPacer({ now: c.now, sleep: c.sleep }).acquire('data.chc.ucsb.edu'))();
		expect(c.sleeps).toEqual([]);
	});

	it('holds one request in flight per host: the next starts only once the one before is released', async () => {
		const c = clock();
		const pacer = hostPacer({ now: c.now, sleep: c.sleep, random: () => 0 });
		const order: string[] = [];
		const first = await pacer.acquire('data.chc.ucsb.edu');
		const second = pacer.acquire('data.chc.ucsb.edu').then((release) => {
			order.push('second started');
			return release;
		});
		const third = pacer.acquire('data.chc.ucsb.edu').then((release) => {
			order.push('third started');
			return release;
		});
		await new Promise((r) => setTimeout(r, 5));
		expect(order).toEqual([]);
		c.advance(5000); // however long the first takes, the second waits for it
		order.push('first done');
		first();
		(await second)();
		(await third)();
		expect(order).toEqual(['first done', 'second started', 'third started']);
	});

	it('does not delay a request to another host (positive control: the same host is delayed)', async () => {
		const c = clock();
		const pacer = hostPacer({ now: c.now, sleep: c.sleep, random: () => 0 });
		const chc = await pacer.acquire('data.chc.ucsb.edu');
		// CHC's slot is still held: DWS gets its own at once.
		const dws = await Promise.race([pacer.acquire('www.dws.gov.za'), new Promise<null>((r) => setTimeout(() => r(null), 20))]);
		expect(dws).not.toBeNull();
		dws!();
		chc();
		expect(c.sleeps).toEqual([]);
		(await pacer.acquire('data.chc.ucsb.edu'))();
		expect(c.sleeps).toEqual([1000]);
	});

	it('a release twice frees the slot once', async () => {
		const c = clock();
		const pacer = hostPacer({ now: c.now, sleep: c.sleep, random: () => 0 });
		const a = await pacer.acquire('h');
		const b = pacer.acquire('h');
		a();
		a();
		const release = await b;
		const third = Promise.race([pacer.acquire('h'), new Promise<null>((r) => setTimeout(() => r(null), 20))]);
		expect(await third).toBeNull(); // b still holds it
		release();
	});
});

describe('liveHttp paced (issue #604)', () => {
	const clockPacer = () => {
		let t = 0;
		const sleeps: number[] = [];
		const pacer = hostPacer({
			now: () => t,
			sleep: async (ms) => {
				sleeps.push(ms);
				t += ms;
			},
			random: () => 0
		});
		return { pacer, sleeps };
	};

	it('a run of range reads to CHC goes one at a time, each start a spacing after the last', async () => {
		const { pacer, sleeps } = clockPacer();
		let inFlight = 0;
		let most = 0;
		const f = vi.fn(async () => {
			most = Math.max(most, ++inFlight);
			await new Promise((r) => setTimeout(r, 2));
			inFlight--;
			return new Response('ab', { status: 206 });
		});
		const http = liveHttp(f, new Map(), pacer);
		// Six asked at once, as the old fetcher did: they still go one at a time.
		await Promise.all(Array.from({ length: 6 }, (_, i) => http.range(`https://data.chc.ucsb.edu/${i}.tif`, 0, 1)));
		expect(f).toHaveBeenCalledTimes(6);
		expect(most).toBe(1);
		expect(sleeps).toEqual(new Array(5).fill(1000));
	});

	it('paces each redirect hop too: every request CHC sees counts', async () => {
		const { pacer, sleeps } = clockPacer();
		const f = vi
			.fn()
			.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://data.chc.ucsb.edu/products/b.tif' } }))
			.mockResolvedValueOnce(new Response('ab', { status: 206 }));
		await liveHttp(f as never, new Map(), pacer).range('https://data.chc.ucsb.edu/products/a.tif', 0, 1);
		expect(f).toHaveBeenCalledTimes(2);
		expect(sleeps).toEqual([1000]);
	});

	it('frees the slot when a request fails, so the next one still goes', async () => {
		const { pacer } = clockPacer();
		const f = vi
			.fn()
			.mockRejectedValueOnce(new TypeError('fetch failed'))
			.mockResolvedValueOnce(new Response('ab', { status: 206 }));
		const http = liveHttp(f as never, new Map(), pacer);
		await expect(http.range('https://data.chc.ucsb.edu/a.tif', 0, 1)).rejects.toThrow(FeedUnavailableError);
		expect(await http.range('https://data.chc.ucsb.edu/a.tif', 0, 1)).not.toBeNull();
	});

	it('a 403 still stops the fetch: a request queued behind it is refused without asking (positive control: DWS is asked)', async () => {
		const { pacer } = clockPacer();
		const throttle: ThrottleState = new Map();
		const f = vi.fn(async (url: string) => new Response(url.includes('dws') ? 'ab' : 'Forbidden', { status: url.includes('dws') ? 200 : 403 }));
		const http = liveHttp(f as never, throttle, pacer);
		const [a, b] = await Promise.allSettled([http.range('https://data.chc.ucsb.edu/a.tif', 0, 1), http.range('https://data.chc.ucsb.edu/b.tif', 0, 1)]);
		expect(a).toMatchObject({ status: 'rejected', reason: expect.any(FeedRefusedError) });
		expect(b).toMatchObject({ status: 'rejected', reason: expect.any(FeedRefusedError) });
		expect(f).toHaveBeenCalledTimes(1);
		expect(await http.text('https://www.dws.gov.za/p')).toBe('ab');
	});

	it('a 429 pauses the host for the requests queued behind it too', async () => {
		const { pacer } = clockPacer();
		const throttle: ThrottleState = new Map();
		const f = vi.fn(async () => new Response('slow down', { status: 429, headers: { 'retry-after': '60' } }));
		const http = liveHttp(f as never, throttle, pacer);
		const got = await Promise.allSettled([1, 2, 3].map((i) => http.range(`https://data.chc.ucsb.edu/${i}.tif`, 0, 1)));
		expect(got.every((g) => g.status === 'rejected' && g.reason instanceof FeedThrottledError)).toBe(true);
		expect(f).toHaveBeenCalledTimes(1);
	});
});
