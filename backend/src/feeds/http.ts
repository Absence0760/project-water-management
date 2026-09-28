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
// upstream body is never copied into an error: the messages are ours.
import { FeedUnavailableError } from './errors.js';
import { CHC_BASE } from './sources/chirps.js';
import { DWS_BASE } from './sources/dws.js';

export interface FeedHttp {
	/** Bytes [start, end] (inclusive) of `url`; null for HTTP 404 (not published yet). */
	range(url: string, start: number, end: number): Promise<Uint8Array | null>;
	/** A whole text resource; null for HTTP 404. */
	text(url: string): Promise<string | null>;
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
	return fixtureHttp();
}

const TIMEOUT_MS = 20_000;
/** A range read is a few tens of KB; a DWS page for 20 years is ~150 KB. */
const MAX_BYTES = 4 * 1024 * 1024;
const USER_AGENT = 'water-management-feeds/1 (+https://github.com/Absence0760/project-water-management)';

/**
 * The only hosts a live fetch may ask, over HTTPS on the default port: the
 * sources' own. The URLs are built from constants (a feed's config holds only
 * grid cells or a regex-checked station code), and the fetcher Lambda has
 * open internet egress, so this is what keeps a redirect, or a future code
 * path, from steering it at another host (docs/security.md § Data feeds).
 */
export const FEED_HOSTS: readonly string[] = [new URL(CHC_BASE).host, new URL(DWS_BASE).host];
/** Redirects followed per request, each checked against FEED_HOSTS. */
const MAX_REDIRECTS = 3;

const allowed = (url: URL) => url.protocol === 'https:' && url.port === '' && url.username === '' && url.password === '' && FEED_HOSTS.includes(url.hostname);

const transportError = (err: unknown) =>
	new FeedUnavailableError((err as Error).name === 'TimeoutError' ? 'the request timed out' : 'the request failed');

type Fetch = typeof fetch;

export function liveHttp(fetchFn: Fetch = (...a) => fetch(...a)): FeedHttp {
	const get = async (url: string, headers: Record<string, string>): Promise<{ bytes: Uint8Array; whole: boolean } | null> => {
		let target = new URL(url);
		if (!allowed(target)) throw new FeedUnavailableError('the request was refused (not a known source host)');
		// One deadline for the whole exchange: every hop and the body.
		const signal = AbortSignal.timeout(TIMEOUT_MS);
		let res: Response;
		for (let hop = 0; ; hop++) {
			try {
				// Redirects are followed here, not by fetch, so each target is checked.
				res = await fetchFn(target.href, { headers: { 'user-agent': USER_AGENT, ...headers }, signal, redirect: 'manual' });
			} catch (err) {
				throw transportError(err);
			}
			if (res.status < 300 || res.status > 399 || res.status === 304) break;
			await res.body?.cancel();
			if (hop === MAX_REDIRECTS) throw new FeedUnavailableError('the source redirected too many times');
			const location = res.headers.get('location');
			const next = location ? URL.parse(location, target.href) : null;
			if (!next || !allowed(next)) throw new FeedUnavailableError('the source redirected somewhere it may not');
			target = next;
		}
		if (res.status === 404 || res.status === 416) {
			await res.body?.cancel();
			return null;
		}
		if (res.status !== 200 && res.status !== 206) {
			await res.body?.cancel();
			throw new FeedUnavailableError(`HTTP ${res.status}`);
		}
		const declared = Number(res.headers.get('content-length'));
		if (declared > MAX_BYTES) {
			await res.body?.cancel();
			throw new FeedUnavailableError('the response is larger than expected');
		}
		// Read with a cap: a server that ignores Range would otherwise send a whole grid.
		const reader = res.body?.getReader();
		if (!reader) return { bytes: new Uint8Array(0), whole: res.status === 200 };
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
		return { bytes: out, whole: res.status === 200 };
	};
	return {
		range: async (url, start, end) => {
			const got = await get(url, { range: `bytes=${start}-${end}` });
			// A 200 is the whole resource (a server that ignores Range, under the cap): cut the range out.
			return got && (got.whole ? got.bytes.subarray(start, end + 1) : got.bytes);
		},
		text: async (url) => {
			const got = await get(url, { accept: 'text/html, text/plain;q=0.9' });
			return got === null ? null : new TextDecoder().decode(got.bytes);
		}
	};
}
