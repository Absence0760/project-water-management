import { describe, expect, it, vi } from 'vitest';
import { FeedUnavailableError } from './errors.js';
import { feedHttp, feedSourceMode, liveHttp } from './http.js';

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
		const bytes = await liveHttp(f).range('https://x/a.tif', 10, 13);
		expect(new TextDecoder().decode(bytes!)).toBe('abcd');
		const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
		expect(init.headers).toMatchObject({ range: 'bytes=10-13', 'user-agent': expect.stringMatching(/^water-management-feeds\//) });
	});

	it('cuts the range out of a 200 (a server that ignores Range)', async () => {
		const bytes = await liveHttp(respond(200, '0123456789')).range('https://x/a.tif', 2, 4);
		expect(new TextDecoder().decode(bytes!)).toBe('234');
	});

	it('reads 404 (and 416) as "not published"', async () => {
		expect(await liveHttp(respond(404, 'Not Found')).range('https://x/a.tif', 0, 7)).toBeNull();
		expect(await liveHttp(respond(416)).range('https://x/a.tif', 99, 100)).toBeNull();
		expect(await liveHttp(respond(404)).text('https://x/p')).toBeNull();
	});

	it('turns other statuses, network errors and timeouts into FeedUnavailableError with our own message', async () => {
		await expect(liveHttp(respond(503, '<h1>secret stack</h1>')).text('https://x/p')).rejects.toThrow(new FeedUnavailableError('HTTP 503'));
		await expect(liveHttp(respond(403)).text('https://x/p')).rejects.toThrow('HTTP 403');
		await expect(liveHttp(vi.fn(async () => { throw new TypeError('fetch failed: getaddrinfo ENOTFOUND'); })).text('https://x/p')).rejects.toThrow(
			new FeedUnavailableError('the request failed')
		);
		const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
		await expect(liveHttp(vi.fn(async () => { throw timeout; })).text('https://x/p')).rejects.toThrow('the request timed out');
	});

	it('refuses a response over 4 MB, declared or streamed', async () => {
		await expect(liveHttp(respond(200, 'x', { 'content-length': String(5 * 1024 * 1024) })).text('https://x/p')).rejects.toThrow(/larger than expected/);
		const big = new Uint8Array(4 * 1024 * 1024 + 1);
		await expect(liveHttp(vi.fn(async () => new Response(big, { status: 200 }))).text('https://x/p')).rejects.toThrow(/larger than expected/);
	});
});
