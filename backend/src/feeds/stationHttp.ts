// The HTTP client of a station API feed (issue #784): the one feed path that
// asks a URL a person typed, not one of FEED_HOSTS. The fetcher Lambda has
// open internet egress, so this is what keeps a typed URL (or a redirect, or a
// DNS answer) from reaching anything but a public HTTPS server:
//
// - https only, port 443, no user:password in the URL;
// - the address checked where it is connected to: a hostname resolves through
//   guardedLookup, which refuses the whole name when any address it has is
//   loopback, private, link-local (the Lambda runtime and metadata APIs),
//   CGNAT, multicast, reserved or documentation space, or an IPv6 form that
//   carries an IPv4 address inside (NAT64, 6to4, Teredo, IPv4-compatible);
//   Node connects only to the addresses that lookup returned, so a name that
//   answers differently a second time (DNS rebinding) gains nothing. An IP
//   literal never reaches a lookup, so it is checked before the request;
// - redirects followed by hand, at most MAX_HOPS, and only within the URL's
//   own origin: one to another site fails with a message naming that site, so
//   the key is never sent anywhere the owner didn't type;
// - a total deadline, a size cap counted while reading, no compression, and
//   the person's own header names and values validated before they are sent.
//
// Error messages are ours. They never quote a body, the URL's query (it may
// hold the key) or the key itself (docs/security.md § Data feeds).
//
// The research behind it (OWASP SSRF case 2, the IANA special-purpose
// registries, Node 24's lookup and BlockList behaviour): issue #784.
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import { FeedFormatError, FeedKeyRefusedError, FeedThrottledError, FeedUnavailableError } from './errors.js';
import { assertLiveFeedRequestsAllowed, retryAfterSeconds, userAgent } from './http.js';
import { addressAllowed, headerProblem, urlProblem } from './stationUrl.js';

export { addressAllowed, headerProblem, MAX_HEADERS, urlProblem } from './stationUrl.js';

export const STATION_TIMEOUT_MS = 30_000;
/** A year of 5-minute readings as CSV is ~4 MB. */
export const STATION_MAX_BYTES = 8 * 1024 * 1024;
export const MAX_HOPS = 3;

export class StationAddressError extends FeedUnavailableError {}

type Lookup = (host: string, opts: { all: true; verbatim: true }, cb: (err: NodeJS.ErrnoException | null, addrs: LookupAddress[]) => void) => void;

/** A lookup for https.request that resolves `host` and refuses it whole when any of its addresses isn't allowed. */
export function guardedLookup(resolve: Lookup = dnsLookup as unknown as Lookup): LookupFunction {
	return ((host: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
		resolve(host, { all: true, verbatim: true }, (err, addrs) => {
			if (err) return cb(new StationAddressError('the station API’s host name did not resolve'), opts.all ? [] : undefined);
			if (!addrs.length || addrs.some((a) => !addressAllowed(a.address))) {
				return cb(new StationAddressError('the station API’s host resolves to a private or reserved address, which a feed may not ask'), opts.all ? [] : undefined);
			}
			if (opts.all) cb(null, addrs);
			else cb(null, addrs[0]!.address, addrs[0]!.family);
		});
	}) as unknown as LookupFunction;
}

export interface StationRequest {
	url: string;
	/** Header name → value, every one checked by headerProblem (the key's own header among them). */
	headers: Record<string, string>;
}

export interface StationResponse {
	text: string;
	contentType: string | null;
}

export interface StationHttp {
	get(req: StationRequest): Promise<StationResponse>;
}

/** The URL a message may name: scheme, host and path, never the query (it may carry the key). */
export const safeUrl = (u: URL) => `${u.origin}${u.pathname.length > 80 ? `${u.pathname.slice(0, 79)}…` : u.pathname}`;

type Requester = (url: URL, opts: RequestOptions, signal: AbortSignal) => Promise<IncomingMessage>;

const nodeRequester =
	(lookup: LookupFunction): Requester =>
	(url, opts, signal) =>
		new Promise((resolve, reject) => {
			const req = httpsRequest(url, { ...opts, lookup, agent: false, signal }, resolve);
			req.on('error', reject);
			req.end();
		});

/** Read a response's body with the size cap and the deadline (the signal), as text. */
async function readCapped(res: IncomingMessage, max: number): Promise<string> {
	const declared = Number(res.headers['content-length']);
	if (declared > max) {
		res.destroy();
		throw new FeedUnavailableError('the station API’s answer is larger than a feed reads (8 MB): ask for fewer days a request');
	}
	const parts: Buffer[] = [];
	let total = 0;
	try {
		for await (const chunk of res) {
			total += (chunk as Buffer).length;
			if (total > max) {
				res.destroy();
				throw new FeedUnavailableError('the station API’s answer is larger than a feed reads (8 MB): ask for fewer days a request');
			}
			parts.push(chunk as Buffer);
		}
	} catch (err) {
		if (err instanceof FeedUnavailableError) throw err;
		throw new FeedUnavailableError((err as Error).name === 'AbortError' ? 'the station API didn’t answer in time' : 'the station API’s answer was cut off');
	}
	return Buffer.concat(parts).toString('utf8');
}

/**
 * The live client. `requester` and `lookup` are injectable for tests; production passes neither. Each call is
 * one exchange (at most MAX_HOPS redirects, all same-origin) under one deadline.
 */
export function stationHttp(opts: { requester?: Requester; lookup?: LookupFunction; contact?: string; maxBytes?: number; timeoutMs?: number } = {}): StationHttp {
	assertLiveFeedRequestsAllowed();
	const requester = opts.requester ?? nodeRequester(opts.lookup ?? guardedLookup());
	const agent = userAgent(opts.contact);
	const max = opts.maxBytes ?? STATION_MAX_BYTES;
	return {
		async get(req) {
			for (const [n, v] of Object.entries(req.headers)) {
				const p = headerProblem(n, v);
				if (p) throw new FeedFormatError(p);
			}
			const parsed = URL.parse(req.url);
			if (!parsed) throw new FeedFormatError('the station API’s URL is not a valid URL');
			let target: URL = parsed;
			const origin = target.origin;
			const signal = AbortSignal.timeout(opts.timeoutMs ?? STATION_TIMEOUT_MS);
			for (let hop = 0; ; hop++) {
				const problem = urlProblem(target);
				if (problem) throw new StationAddressError(problem);
				let res: IncomingMessage;
				try {
					res = await requester(target, { method: 'GET', headers: { ...req.headers, 'user-agent': agent, 'accept-encoding': 'identity', accept: 'application/json, text/csv, text/plain;q=0.9, */*;q=0.5' } }, signal);
				} catch (err) {
					if (err instanceof FeedUnavailableError) throw err;
					const cause = (err as { cause?: unknown }).cause;
					if (cause instanceof FeedUnavailableError) throw cause;
					throw new FeedUnavailableError((err as Error).name === 'AbortError' ? 'the station API didn’t answer in time' : 'the request to the station API failed');
				}
				const status = res.statusCode ?? 0;
				if (status >= 300 && status <= 399 && status !== 304) {
					res.resume();
					const next: URL | null = res.headers.location ? URL.parse(res.headers.location, target.href) : null;
					if (!next) throw new FeedUnavailableError(`the station API redirected (HTTP ${status}) without saying where`);
					if (next.origin !== origin) {
						throw new FeedFormatError(`the URL redirects to another site (${next.origin}): save that site’s URL instead, if you trust it with the key`);
					}
					if (hop === MAX_HOPS) throw new FeedUnavailableError('the station API redirected too many times');
					target = next;
					continue;
				}
				if (status === 401 || status === 403) {
					res.resume();
					throw new FeedKeyRefusedError(status);
				}
				if (status === 404) {
					res.resume();
					throw new FeedFormatError(`the station API answered HTTP 404 at ${safeUrl(target)}: check the URL and the station`);
				}
				if (status === 429 || status === 503) {
					res.resume();
					const h = res.headers['retry-after'];
					throw new FeedThrottledError(status, retryAfterSeconds(Array.isArray(h) ? h[0]! : (h ?? null)));
				}
				if (status !== 200) {
					res.resume();
					throw new FeedUnavailableError(`the station API answered HTTP ${status}`);
				}
				const encoding = res.headers['content-encoding'];
				if (encoding && encoding !== 'identity') {
					res.destroy();
					throw new FeedFormatError(`the station API sent a compressed answer (${String(encoding).slice(0, 20)}) though asked not to`);
				}
				const text = await readCapped(res, max);
				const ct = res.headers['content-type'];
				return { text, contentType: typeof ct === 'string' ? ct.slice(0, 100) : null };
			}
		}
	};
}
