import { describe, expect, it, vi } from 'vitest';
import { FeedUnavailableError } from './errors.js';
import { feedHttp, feedSourceMode, fileTag, liveHttp } from './http.js';

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
		await expect(liveHttp(respond(503, '<h1>secret stack</h1>')).text('https://data.chc.ucsb.edu/p')).rejects.toThrow(new FeedUnavailableError('HTTP 503'));
		await expect(liveHttp(respond(403)).text('https://data.chc.ucsb.edu/p')).rejects.toThrow('HTTP 403');
		await expect(liveHttp(vi.fn(async () => { throw new TypeError('fetch failed: getaddrinfo ENOTFOUND'); })).text('https://data.chc.ucsb.edu/p')).rejects.toThrow(
			new FeedUnavailableError('the request failed')
		);
		const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
		await expect(liveHttp(vi.fn(async () => { throw timeout; })).text('https://data.chc.ucsb.edu/p')).rejects.toThrow('the request timed out');
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
		await expect(liveHttp(respond(503)).head!('https://data.chc.ucsb.edu/a.tif')).rejects.toThrow(new FeedUnavailableError('HTTP 503'));
	});

	it('HEAD keeps to the known hosts too (the re-check is no way around the SSRF rule)', async () => {
		const f = vi.fn(async () => new Response(null, { status: 200 }));
		await expect(liveHttp(f).head!('https://169.254.169.254/latest/meta-data/')).rejects.toThrow(/not a known source host/);
		expect(f).not.toHaveBeenCalled();
		const hop = vi.fn<(url: string, init: RequestInit) => Promise<Response>>().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://example.com/a.tif' } }));
		await expect(liveHttp(hop as never).head!('https://data.chc.ucsb.edu/a.tif')).rejects.toThrow(/redirected somewhere it may not/);
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
