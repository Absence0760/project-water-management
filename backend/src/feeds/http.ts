// How a fetch reaches a source (FEED_SOURCE):
//
//   fixtures — the default, everywhere but production: synthetic files under
//              backend/fixtures/feeds/ (feeds/fixtures.ts). No network, so dev,
//              CI and e2e never touch the internet.
//   live     — HTTPS to the real sources. Set only on the production fetcher
//              Lambda (infra/feeds.tf), or by hand in a gitignored
//              backend/.env.development.local to try a source for real.
//
// Both implement FeedHttp. Every response is bounded (time and size), and an
// upstream body is never copied into an error: the messages are ours. An HTTP
// 429 or 503 is a FeedThrottledError, and the live client then leaves that
// host alone for its Retry-After (THROTTLE_*); an HTTP 403 is a
// FeedRefusedError, and the host is left alone for REFUSED_PAUSE_SECONDS.
// Both pauses hold across clients in one process.
//
// The live client is also polite by itself (PACE_*, hostPacer): per host, one
// request in flight per process and about one request start a second, as CHC
// asked (2026-10-27, issue #604). The fetcher Lambda's SQS trigger keeps it to
// one invocation per source host at a time (infra/feeds.tf), so that is also
// the total across our Lambdas. And the user agent names a contact
// (FEEDS_CONTACT) when one is set: required on the production fetcher.
import { FEEDS_CONTACT_RE } from '../config/production.js';
import { FeedRefusedError, FeedThrottledError, FeedUnavailableError } from './errors.js';
import { CHC_BASE } from './sources/chirps.js';
import { CPC_BASE } from './sources/cpc.js';
import { DWS_BASE } from './sources/dws.js';
import { DEAFRICA_SERVICES_BASE } from '../dams/observed/upstream.js';
import { S1_S3_BASE, S2_C1_S3_BASE, WOFS_STAC_SEARCH } from '../dams/observed/wofs/stac.js';
import { SSEBOP_BASE, WAPOR_BASE } from '../water-use/observed/upstream.js';

export interface FeedHttp {
	/** Bytes [start, end] (inclusive) of `url`; null for HTTP 404 (not published yet). */
	range(url: string, start: number, end: number): Promise<Uint8Array | null>;
	/** A whole text resource; null for HTTP 404. */
	text(url: string): Promise<string | null>;
	/**
	 * range, with the file's tag (fileTag): which version of the file the bytes
	 * are. The CHIRPS cell cache records it per final file, so a rewrite in
	 * place shows (docs/architecture.md § Data feeds → Re-checking finals).
	 * Optional: a source that has no versions needs none.
	 */
	rangeTagged?(url: string, start: number, end: number): Promise<{ bytes: Uint8Array; tag: string | null } | null>;
	/** The file's tag from a HEAD request, without its body; null for HTTP 404. */
	head?(url: string): Promise<{ tag: string | null } | null>;
	/**
	 * A whole text resource asked for only if its ETag is no longer `etag`
	 * (If-None-Match): `not-modified` for HTTP 304, null for HTTP 404. The
	 * ETag and Last-Modified are as fileTag keeps them (printable, capped), or
	 * null. Optional: the dam observations' Waterbodies pass uses it.
	 */
	textConditional?(url: string, etag: string | null): Promise<ConditionalText | null>;
}

export type ConditionalText = { status: 'not-modified' } | { status: 'ok'; text: string; etag: string | null; lastModified: string | null };

/** The longest file tag kept (chirps_file.tag, 210). */
export const FILE_TAG_MAX = 200;
/** A tag we keep: printable ASCII, no edge spaces (210_chirps_final_recheck.sql chirps_tag_ok). */
export const FILE_TAG_RE = /^[!-~](?:[ -~]*[!-~])?$/;

/**
 * Which version of a file a response is: its ETag (CHC's nginx sends
 * `"<mtime>-<size>"` in hex), else `lm:` and its Last-Modified, else null.
 * A header that isn't printable ASCII, or is longer than FILE_TAG_MAX, is no
 * tag: an upstream value is never stored unchecked.
 */
export function fileTag(headers: Headers): string | null {
	const ok = (t: string) => (t.length <= FILE_TAG_MAX && FILE_TAG_RE.test(t) ? t : null);
	const etag = headers.get('etag')?.trim();
	if (etag) return ok(etag);
	const lm = headers.get('last-modified')?.trim();
	return lm ? ok(`lm:${lm}`) : null;
}

export const FEED_SOURCE_MODES = ['fixtures', 'live'] as const;
export type FeedSourceMode = (typeof FEED_SOURCE_MODES)[number];

export function feedSourceMode(value: string | undefined = process.env.FEED_SOURCE): FeedSourceMode {
	const v = value?.trim() || 'fixtures';
	if (!(FEED_SOURCE_MODES as readonly string[]).includes(v)) {
		throw new Error(`unknown FEED_SOURCE "${v}" (expected ${FEED_SOURCE_MODES.join(', ')})`);
	}
	return v as FeedSourceMode;
}

/** The HTTP client for the configured mode. */
export async function feedHttp(mode: FeedSourceMode = feedSourceMode()): Promise<FeedHttp> {
	if (mode === 'live') return liveHttp();
	const { fixtureHttp } = await import('./fixtures.js');
	// FEED_FIXTURE_REWRITE=1: serve chirps-rewrite.json's finals rewritten in place, to watch the re-check locally (run-locally.md).
	return fixtureHttp(undefined, { rewrite: process.env.FEED_FIXTURE_REWRITE === '1' });
}

const TIMEOUT_MS = 20_000;
/** A range read is a few tens of KB; a DWS page for 20 years is ~150 KB. */
const MAX_BYTES = 4 * 1024 * 1024;
const USER_AGENT_PRODUCT = 'water-management-feeds/1';
const USER_AGENT_URL = '+https://github.com/Absence0760/project-water-management';

/**
 * Our user agent: the product, the repo, and a contact address when one is
 * given (FEEDS_CONTACT). CHC asked for a contact in it (2026-10-27): the
 * distinctive agent is how they matched our blocks across the fetcher's
 * rotating addresses, and the address is who they write to before blocking.
 * A value that isn't an address (FEEDS_CONTACT_RE) is left out rather than
 * sent: it never reaches a header unchecked. Production refuses to start the
 * fetcher without a good one (config/production.ts).
 */
export function userAgent(contact: string | undefined = process.env.FEEDS_CONTACT): string {
	const c = contact?.trim();
	return c && FEEDS_CONTACT_RE.test(c) ? `${USER_AGENT_PRODUCT} (${USER_AGENT_URL}; ${c})` : `${USER_AGENT_PRODUCT} (${USER_AGENT_URL})`;
}

/**
 * The only hosts a live fetch may ask, over HTTPS on the default port: the
 * sources' own. The URLs are built from constants (a feed's config holds only
 * grid cells or a regex-checked station code), and the fetcher Lambda has
 * open internet egress, so this is what keeps a redirect, or a future code
 * path, from steering it at another host (docs/security.md § Data feeds).
 */
export const FEED_HOSTS: readonly string[] = [
	new URL(CHC_BASE).host,
	new URL(DWS_BASE).host,
	// Digital Earth Africa's public bucket: the Waterbodies series and the WOfS scenes (dams/observed, issue #604 R5).
	new URL(DEAFRICA_SERVICES_BASE).host,
	// Digital Earth Africa's STAC search: the WOfS scenes over a dam (dams/observed/wofs, issue #604 R5-C).
	new URL(WOFS_STAC_SEARCH).host,
	// Digital Earth Africa's Sentinel-2 L2A Collection 1 and Sentinel-1 RTC buckets (dams/observed, issue #624).
	new URL(S2_C1_S3_BASE).host,
	new URL(S1_S3_BASE).host,
	// NOAA CPC: the ONI and AAO climate indices (ingest/indices.ts, issue #620).
	new URL(CPC_BASE).host,
	// FAO's WaPOR v3 bucket on Google Cloud Storage: the dekadal actual ET (water-use/observed, issue #623). FEED_HOST_PATHS keeps it to that bucket.
	new URL(WAPOR_BASE).host,
	// USGS FEWS NET: SSEBop's dekadal actual ET, the fallback (issue #623). FEED_HOST_PATHS keeps it to that tree.
	new URL(SSEBOP_BASE).host
];

/**
 * Hosts shared with things that aren't our sources, and the only path
 * prefixes a live fetch may ask on them (each ends in `/`). Google Cloud
 * Storage serves every bucket from one host, so allowing the host alone
 * would let a redirect, or a later code path, read any public bucket. The
 * path is the URL's parsed one, dot segments (`..`, `%2e%2e`) already
 * resolved, so a path can't climb out of its prefix.
 */
export const FEED_HOST_PATHS: Readonly<Record<string, readonly string[]>> = {
	[new URL(WAPOR_BASE).hostname]: [new URL(WAPOR_BASE).pathname],
	[new URL(SSEBOP_BASE).hostname]: [new URL(SSEBOP_BASE).pathname]
};

/** Redirects followed per request, each checked against FEED_HOSTS. */
const MAX_REDIRECTS = 3;

const pathAllowed = (url: URL) => {
	const prefixes = Object.hasOwn(FEED_HOST_PATHS, url.hostname) ? FEED_HOST_PATHS[url.hostname] : undefined;
	return !prefixes || prefixes.some((p) => url.pathname.startsWith(p));
};

const allowed = (url: URL) =>
	url.protocol === 'https:' && url.port === '' && url.username === '' && url.password === '' && FEED_HOSTS.includes(url.hostname) && pathAllowed(url);

const transportError = (err: unknown) =>
	new FeedUnavailableError((err as Error).name === 'TimeoutError' ? 'the request timed out' : 'the request failed');

type Fetch = typeof fetch;

/** How long a host that answered HTTP 429 or 503 isn't asked again, when it gave no usable Retry-After. */
export const THROTTLE_DEFAULT_SECONDS = 60;
/** The longest such pause, whatever Retry-After asks: past it the scheduler's own backoff (15 min, doubling) takes over. */
export const THROTTLE_MAX_SECONDS = 15 * 60;

/**
 * How long a host that answered HTTP 403 isn't asked again: an hour. A 403
 * names no Retry-After, and from CHC it is a ban on this environment's
 * outbound address for the volume it asked (2026-10-25: a fresh fetcher
 * environment's first fetch or two worked, then every later one was
 * refused), which doesn't lift in the minute a 429's default waits. An hour
 * covers most of a warm Lambda environment's life, so the environment that
 * was refused stops asking for good, while a new environment, with its own
 * address, isn't held back by it. Past it the scheduler's refused backoff
 * (2 h, doubling, 242_feed_refused_backoff.sql) has the feed waiting longer
 * still. Kept apart from THROTTLE_*: a refusal is not a request to slow down.
 */
export const REFUSED_PAUSE_SECONDS = 60 * 60;

/** A Retry-After header in seconds from `now`: delta-seconds or an HTTP date; null when absent or unreadable. */
export function retryAfterSeconds(value: string | null, now = Date.now()): number | null {
	const v = value?.trim();
	if (!v) return null;
	if (/^\d{1,9}$/.test(v)) return Number(v);
	// An HTTP date names its day and month (Date.parse would read "-5" as a year).
	const at = /^[A-Za-z]{3}, /.test(v) ? Date.parse(v) : NaN;
	return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : null;
}

/** Per host, the pause a 429, 503 or 403 started: until when (epoch ms) a live fetch doesn't ask it. */
export type ThrottleState = Map<string, { until: number; status: 429 | 503 | 403 }>;
/**
 * Shared by every client in one process, so a warm fetcher Lambda remembers a
 * throttled or refusing host across invocations: the fetches queued behind
 * the one that met the 429 or 403 fail at once instead of each asking again (docs/architecture.md
 * § Data feeds → Throttling).
 */
const THROTTLED: ThrottleState = new Map();

/**
 * Whether this process may ask CHC or DWS: only the fetcher Lambda in
 * production (lambda-fetcher.ts calls allowLiveFeedRequests at init). The API
 * and the worker carry FEED_SOURCE=live too (it names the cell cache they read,
 * cellCacheStore.ts), and the worker's bundle holds the inline fetch path local
 * dev uses (jobs/handlers/feed-fetch.ts), so neither the setting nor the
 * bundle's modules can keep them from a live request: this does, on Lambda,
 * whatever FEED_FETCHER, CHIRPS_SOURCE and DWS_SOURCE say. A fetch that would
 * reach it fails loudly instead of quietly asking an upstream from an address
 * we never told it about (issue #604 R3-C; docs/security.md § Data feeds).
 * Off Lambda (dev, CI, a hand-run script) live requests stay allowed.
 */
let liveRequestsAllowed = false;

/** The fetcher Lambda's entry point, once at init: this process is the one that asks the upstreams. */
export function allowLiveFeedRequests(): void {
	liveRequestsAllowed = true;
}

/** A live feed request outside the fetcher Lambda (assertLiveFeedRequestsAllowed): a configuration bug, never the source's doing. */
export class LiveFeedRequestRefusedError extends Error {
	constructor() {
		super('refusing a live feed request outside the fetcher Lambda: the API and the worker never ask CHC or DWS (feeds/http.ts)');
		this.name = 'LiveFeedRequestRefusedError';
	}
}

/** Throw unless this process may make a live feed request (above). */
export function assertLiveFeedRequestsAllowed(env: Record<string, string | undefined> = process.env): void {
	if (env.AWS_LAMBDA_FUNCTION_NAME && !liveRequestsAllowed) throw new LiveFeedRequestRefusedError();
}

/**
 * The least time between the starts of two requests to one host, and the most
 * random time added to it: 1 s plus 0–0.5 s, so about one request a second.
 * CHC's reply (2026-10-27, issue #604): their bot protection blocks an
 * address for hours above about 2 requests a second sustained (each repeat
 * block longer), they answer HTTP 429 past 20 open connections, and they ask
 * for about 1 request a second in total, one file at a time; their download
 * guide asks for 0.5 s plus up to 0.5 s of jitter between requests
 * (https://github.com/chc-ucsb/chc-data-download#downloading-politely). We
 * keep their total rather than their guide's per-client floor, since the
 * guide is for one client and we are one per source host. The old fetcher
 * read 6 at a time, about 3.6 requests a second, and was blocked.
 */
export const PACE_MIN_SPACING_MS = 1000;
export const PACE_JITTER_MS = 500;

/** Takes a host's one request slot, waiting for the one before to finish and the spacing to pass; resolves to its release. */
export interface Pacer {
	acquire(host: string): Promise<() => void>;
}

/**
 * Per host: at most one request in flight, and each start at least
 * `spacingMs` plus up to `jitterMs` (random) after the one before it. A
 * request to another host waits for nothing here. Waiters are served in
 * order. The clock, the sleep and the randomness are injectable for tests.
 */
export function hostPacer(
	opts: { now?: () => number; sleep?: (ms: number) => Promise<void>; random?: () => number; spacingMs?: number; jitterMs?: number } = {}
): Pacer {
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const random = opts.random ?? Math.random;
	const spacing = opts.spacingMs ?? PACE_MIN_SPACING_MS;
	const jitter = opts.jitterMs ?? PACE_JITTER_MS;
	/** Per host, the promise the next request waits on: the last one's release. */
	const tails = new Map<string, Promise<void>>();
	/** Per host, when its last request started. */
	const lastStart = new Map<string, number>();
	return {
		async acquire(host) {
			const before = tails.get(host) ?? Promise.resolve();
			let release!: () => void;
			const mine = new Promise<void>((resolve) => (release = resolve));
			const tail = before.then(() => mine);
			tails.set(host, tail);
			await before;
			try {
				const last = lastStart.get(host);
				if (last !== undefined) {
					const wait = last + spacing + random() * jitter - now();
					if (wait > 0) await sleep(wait);
				}
			} catch (err) {
				release();
				throw err;
			}
			lastStart.set(host, now());
			let done = false;
			return () => {
				if (done) return;
				done = true;
				release();
				// The last in line leaves nothing behind (the start time stays: the spacing holds across idle gaps).
				if (tails.get(host) === tail) tails.delete(host);
			};
		}
	};
}

/** Shared by every live client in one process, like THROTTLED: a warm fetcher Lambda keeps its pace across invocations. */
const PACER: Pacer = hostPacer();

export function liveHttp(
	fetchFn: Fetch = (...a) => fetch(...a),
	throttle: ThrottleState = THROTTLED,
	pacer: Pacer = PACER,
	contact: string | undefined = process.env.FEEDS_CONTACT
): FeedHttp {
	assertLiveFeedRequestsAllowed();
	const agent = userAgent(contact);
	const paused = (host: string) => {
		const p = throttle.get(host);
		if (!p) return;
		const left = p.until - Date.now();
		if (left > 0) throw p.status === 403 ? new FeedRefusedError() : new FeedThrottledError(p.status, Math.ceil(left / 1000));
		throttle.delete(host);
	};
	const get = async (
		url: string,
		headers: Record<string, string>,
		method: 'GET' | 'HEAD' = 'GET'
	): Promise<{ bytes: Uint8Array; whole: boolean; tag: string | null; headers: Headers } | 'not-modified' | null> => {
		let target = new URL(url);
		if (!allowed(target)) throw new FeedUnavailableError('the request was refused (not a known source host)');
		// Each hop takes its host's slot (pacer) and holds it until its response is done with, the body included.
		let release = await pacer.acquire(target.host);
		try {
			return await exchange(target, headers, method, (next) => {
				release();
				return pacer.acquire(next.host).then((r) => {
					release = r;
				});
			});
		} finally {
			release();
		}
	};
	const exchange = async (
		first: URL,
		headers: Record<string, string>,
		method: 'GET' | 'HEAD',
		hopTo: (next: URL) => Promise<void>
	): Promise<{ bytes: Uint8Array; whole: boolean; tag: string | null; headers: Headers } | 'not-modified' | null> => {
		let target = first;
		// One deadline for the whole exchange: every hop and the body (from when it holds its first slot, not while it queues).
		const signal = AbortSignal.timeout(TIMEOUT_MS);
		let res: Response;
		for (let hop = 0; ; hop++) {
			// After the slot: a 429 or 403 the request before met pauses this one too.
			paused(target.host);
			try {
				// Redirects are followed here, not by fetch, so each target is checked.
				res = await fetchFn(target.href, { method, headers: { 'user-agent': agent, ...headers }, signal, redirect: 'manual' });
			} catch (err) {
				throw transportError(err);
			}
			if (res.status < 300 || res.status > 399 || res.status === 304) break;
			await res.body?.cancel();
			if (hop === MAX_REDIRECTS) throw new FeedUnavailableError('the source redirected too many times');
			const location = res.headers.get('location');
			const next = location ? URL.parse(location, target.href) : null;
			if (!next || !allowed(next)) throw new FeedUnavailableError('the source redirected somewhere it may not');
			await hopTo(next);
			target = next;
		}
		if (res.status === 304 && headers['if-none-match']) {
			await res.body?.cancel();
			return 'not-modified';
		}
		if (res.status === 404 || res.status === 416) {
			await res.body?.cancel();
			return null;
		}
		if (res.status === 429 || res.status === 503) {
			await res.body?.cancel();
			const after = retryAfterSeconds(res.headers.get('retry-after'));
			const pause = Math.min(THROTTLE_MAX_SECONDS, after ?? THROTTLE_DEFAULT_SECONDS);
			if (pause > 0) throttle.set(target.host, { until: Date.now() + pause * 1000, status: res.status });
			throw new FeedThrottledError(res.status, after);
		}
		if (res.status === 403) {
			await res.body?.cancel();
			throttle.set(target.host, { until: Date.now() + REFUSED_PAUSE_SECONDS * 1000, status: 403 });
			throw new FeedRefusedError();
		}
		if (res.status !== 200 && res.status !== 206) {
			await res.body?.cancel();
			throw new FeedUnavailableError(`HTTP ${res.status}`);
		}
		const tag = fileTag(res.headers);
		// A HEAD has no body: its content-length is the file's, not a response to read.
		if (method === 'HEAD') {
			await res.body?.cancel();
			return { bytes: new Uint8Array(0), whole: true, tag, headers: res.headers };
		}
		const declared = Number(res.headers.get('content-length'));
		if (declared > MAX_BYTES) {
			await res.body?.cancel();
			throw new FeedUnavailableError('the response is larger than expected');
		}
		// Read with a cap: a server that ignores Range would otherwise send a whole grid.
		const reader = res.body?.getReader();
		if (!reader) return { bytes: new Uint8Array(0), whole: res.status === 200, tag, headers: res.headers };
		const parts: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			let chunk: Awaited<ReturnType<typeof reader.read>>;
			try {
				chunk = await reader.read();
			} catch (err) {
				// The deadline (or a reset) can land mid-body, too.
				throw transportError(err);
			}
			const { done, value } = chunk;
			if (done) break;
			total += value.length;
			if (total > MAX_BYTES) {
				await reader.cancel();
				throw new FeedUnavailableError('the response is larger than expected');
			}
			parts.push(value);
		}
		const out = new Uint8Array(total);
		let o = 0;
		for (const p of parts) {
			out.set(p, o);
			o += p.length;
		}
		return { bytes: out, whole: res.status === 200, tag, headers: res.headers };
	};
	/** A plain request: never conditional, so never 'not-modified'. */
	const plain = async (url: string, headers: Record<string, string>, method: 'GET' | 'HEAD' = 'GET') => {
		const got = await get(url, headers, method);
		return got === 'not-modified' ? null : got;
	};
	/** A header kept only as fileTag keeps a tag: printable ASCII, at most FILE_TAG_MAX. */
	const kept = (v: string | null) => {
		const t = v?.trim();
		return t && t.length <= FILE_TAG_MAX && FILE_TAG_RE.test(t) ? t : null;
	};
	const rangeTagged = async (url: string, start: number, end: number) => {
		const got = await plain(url, { range: `bytes=${start}-${end}` });
		// A 200 is the whole resource (a server that ignores Range, under the cap): cut the range out.
		return got && { bytes: got.whole ? got.bytes.subarray(start, end + 1) : got.bytes, tag: got.tag };
	};
	return {
		range: async (url, start, end) => (await rangeTagged(url, start, end))?.bytes ?? null,
		rangeTagged,
		head: async (url) => {
			const got = await plain(url, {}, 'HEAD');
			return got && { tag: got.tag };
		},
		text: async (url) => {
			const got = await plain(url, { accept: 'text/html, text/plain;q=0.9' });
			return got === null ? null : new TextDecoder().decode(got.bytes);
		},
		textConditional: async (url, etag) => {
			const got = await get(url, { accept: 'text/csv, text/plain;q=0.9', ...(etag ? { 'if-none-match': etag } : {}) });
			if (got === null) return null;
			if (got === 'not-modified') return { status: 'not-modified' };
			return { status: 'ok', text: new TextDecoder().decode(got.bytes), etag: kept(got.headers.get('etag')), lastModified: kept(got.headers.get('last-modified')) };
		}
	};
}
