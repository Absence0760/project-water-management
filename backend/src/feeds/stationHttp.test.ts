import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { describe, expect, it } from 'vitest';
import { feedErrorMessage, FeedFormatError, FeedKeyRefusedError, FeedThrottledError, FeedUnavailableError } from './errors.js';
import { guardedLookup, MAX_HOPS, type Requester, safeUrl, StationAddressError, stationHttp, STATION_FAILURES } from './stationHttp.js';

const KEY = 'sk_test_abcdefghijklmnop';

function res(status: number, headers: Record<string, string> = {}, body: string | Buffer[] = ''): IncomingMessage {
	const chunks = typeof body === 'string' ? (body ? [Buffer.from(body)] : []) : body;
	const r = Readable.from(chunks) as unknown as IncomingMessage;
	r.statusCode = status;
	r.headers = headers;
	return r;
}

/** A requester answering from `route`, recording each URL and its options. */
function fake(route: (url: URL, n: number) => IncomingMessage | Error) {
	const calls: { url: URL; opts: RequestOptions }[] = [];
	const requester: Requester = async (url, opts) => {
		calls.push({ url, opts });
		const a = route(url, calls.length);
		if (a instanceof Error) throw a;
		return a;
	};
	return { requester, calls };
}

const get = (requester: Requester, url: string, headers: Record<string, string> = {}, opts: { maxBytes?: number } = {}) => stationHttp({ requester, ...opts }).get({ url, headers });

describe('stationHttp: what it refuses before asking', () => {
	const never = fake(() => new Error('must not be asked'));
	it.each([
		['http://api.example.com/x', /https/],
		['https://api.example.com:8443/x', /port/],
		['https://me:pw@api.example.com/x', /user name and password/],
		['https://127.0.0.1/x', /private or reserved/],
		['https://169.254.169.254/latest/meta-data/', /private or reserved/],
		['https://[::1]/x', /private or reserved/],
		['https://[::ffff:127.0.0.1]/x', /private or reserved/],
		['https://0x7f.1/x', /private or reserved/],
		['https://[fd00:ec2::254]/x', /private or reserved/],
		['https://localhost/x', /public internet name/],
		['https://metadata.internal/x', /public internet name/]
	])('%s', async (url, why) => {
		const err = await get(never.requester, url).catch((e) => e);
		expect(err).toBeInstanceOf(StationAddressError);
		expect(err.message).toMatch(why);
		expect(never.calls).toHaveLength(0);
	});

	it('refuses a header it may not send, or a value that would inject another header', async () => {
		await expect(get(never.requester, 'https://api.example.com/x', { Host: 'evil' })).rejects.toThrow(FeedFormatError);
		await expect(get(never.requester, 'https://api.example.com/x', { 'X-A': 'a\r\nX-Injected: 1' })).rejects.toThrow(/character a header can’t carry/);
		await expect(get(never.requester, 'https://api.example.com/x', { 'Bad Name': 'x' })).rejects.toThrow(/not a valid header name/);
		expect(never.calls).toHaveLength(0);
	});
});

describe('guardedLookup', () => {
	const resolveTo = (addrs: string[]) => (_h: string, _o: unknown, cb: (e: NodeJS.ErrnoException | null, a: { address: string; family: number }[]) => void) =>
		cb(null, addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
	const ask = (addrs: string[]) =>
		new Promise<{ err: unknown; addrs: unknown }>((resolve) => (guardedLookup(resolveTo(addrs)) as unknown as (h: string, o: object, cb: (e: unknown, a: unknown) => void) => void)('api.example.com', { all: true }, (err, a) => resolve({ err, addrs: a })));

	it('passes a name whose every address is public', async () => {
		expect((await ask(['93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c'])).err).toBeNull();
	});

	it.each([['10.0.0.5'], ['127.0.0.1'], ['169.254.169.254'], ['100.64.1.1'], ['::1'], ['fd00:ec2::254'], ['::ffff:127.0.0.1'], ['64:ff9b::7f00:1']])('refuses the whole name when one address is %s', async (bad) => {
		const { err } = await ask(['93.184.215.14', bad]);
		expect(err).toBeInstanceOf(StationAddressError);
	});

	it('is what the live client connects through: a private answer never reaches a socket', async () => {
		const http = stationHttp({ lookup: guardedLookup(resolveTo(['8.8.8.8', '192.168.1.10'])) });
		await expect(http.get({ url: 'https://api.example.com/x', headers: {} })).rejects.toThrow(STATION_FAILURES.private[0]);
	});
});

describe('stationHttp: answers', () => {
	it('returns the body and content type, sending our agent and no compression', async () => {
		const f = fake(() => res(200, { 'content-type': 'application/json' }, '{"a":1}'));
		expect(await get(f.requester, 'https://api.example.com/x?k=1', { authorization: `Bearer ${KEY}` })).toEqual({ text: '{"a":1}', contentType: 'application/json' });
		const h = f.calls[0]!.opts.headers as Record<string, string>;
		expect(h['accept-encoding']).toBe('identity');
		expect(h['user-agent']).toMatch(/^water-management-feeds\/1/);
		expect(h.authorization).toBe(`Bearer ${KEY}`);
	});

	it('follows a same-origin redirect with the key', async () => {
		const f = fake((u) => (u.pathname === '/a' ? res(302, { location: '/b' }) : res(200, {}, 'ok')));
		expect((await get(f.requester, 'https://api.example.com/a', { 'x-api-key': KEY })).text).toBe('ok');
		expect((f.calls[1]!.opts.headers as Record<string, string>)['x-api-key']).toBe(KEY);
	});

	it('refuses a redirect to another site, never sending the key there', async () => {
		const f = fake(() => res(301, { location: 'https://evil.example.net/steal' }));
		const err = await get(f.requester, `https://api.example.com/a?token=${KEY}`, { 'x-api-key': KEY }).catch((e) => e);
		expect(err).toBeInstanceOf(FeedFormatError);
		expect(err.message).toContain('https://evil.example.net');
		expect(err.message).not.toContain(KEY);
		expect(f.calls).toHaveLength(1);
	});

	it('refuses a same-origin redirect to a private address or http', async () => {
		const f = fake(() => res(302, { location: 'http://api.example.com/b' }));
		await expect(get(f.requester, 'https://api.example.com/a')).rejects.toThrow(FeedFormatError);
	});

	it(`stops after ${MAX_HOPS} redirects`, async () => {
		const f = fake(() => res(302, { location: '/loop' }));
		await expect(get(f.requester, 'https://api.example.com/loop')).rejects.toThrow(STATION_FAILURES.tooManyHops[0]);
		expect(f.calls).toHaveLength(MAX_HOPS + 1);
	});

	it.each([401, 403] as const)('HTTP %i is the key refused', async (status) => {
		const err = await get(fake(() => res(status, {}, '{"error":"bad key"}')).requester, 'https://api.example.com/x').catch((e) => e);
		expect(err).toBeInstanceOf(FeedKeyRefusedError);
		expect(err.status).toBe(status);
		expect(feedErrorMessage(err)).not.toContain('bad key');
	});

	it('HTTP 429 is throttled, 404 a format error naming no query, 500 unavailable', async () => {
		await expect(get(fake(() => res(429, { 'retry-after': '30' })).requester, 'https://api.example.com/x')).rejects.toBeInstanceOf(FeedThrottledError);
		const nf = await get(fake(() => res(404)).requester, `https://api.example.com/x?token=${KEY}`).catch((e) => e);
		expect(nf).toBeInstanceOf(FeedFormatError);
		expect(nf.message).not.toContain(KEY);
		await expect(get(fake(() => res(500, {}, 'Internal error at /srv/app')).requester, 'https://api.example.com/x')).rejects.toThrow(/^the station API answered HTTP 500$/);
	});

	it('refuses a compressed answer', async () => {
		await expect(get(fake(() => res(200, { 'content-encoding': 'gzip' }, 'xx')).requester, 'https://api.example.com/x')).rejects.toThrow(/compressed/);
	});

	it('refuses an answer over the cap, declared or counted while reading', async () => {
		await expect(get(fake(() => res(200, { 'content-length': '100' }, 'x')).requester, 'https://api.example.com/x', {}, { maxBytes: 10 })).rejects.toThrow(STATION_FAILURES.tooLarge[0]);
		const big = fake(() => res(200, {}, [Buffer.alloc(6, 97), Buffer.alloc(6, 97)]));
		await expect(get(big.requester, 'https://api.example.com/x', {}, { maxBytes: 10 })).rejects.toThrow(STATION_FAILURES.tooLarge[0]);
	});

	it('words a transport failure as ours, never the error’s own text (which may name the URL)', async () => {
		const err = await get(fake(() => Object.assign(new Error(`connect ECONNREFUSED https://api.example.com/x?token=${KEY}`), { code: 'ECONNREFUSED' })).requester, 'https://api.example.com/x').catch((e) => e);
		expect(err).toBeInstanceOf(FeedUnavailableError);
		expect(err.message).toBe(STATION_FAILURES.failed[0]);
	});
});

describe('safeUrl', () => {
	it('keeps scheme, host and path, never the query', () => {
		expect(safeUrl(new URL(`https://api.example.com/v1/rain?token=${KEY}`))).toBe('https://api.example.com/v1/rain');
	});
});
