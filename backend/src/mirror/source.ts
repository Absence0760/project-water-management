// Which CHIRPS source a process reads, and where our copy lives (issue #604
// Round 2). CHIRPS_SOURCE=chc keeps today's path (per-feed reads of CHC's
// files, through the fetcher in production); mirror reads our own copy
// (MIRROR_URL). Until the cutover (R3-C) the default follows FEED_SOURCE:
// production's `live` stays on chc, and dev, CI and e2e (`fixtures`) read the
// committed synthetic copy, backend/fixtures/mirror/.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openStore, type MirrorStore } from './store.js';

export const CHIRPS_SOURCES = ['chc', 'mirror'] as const;
export type ChirpsSource = (typeof CHIRPS_SOURCES)[number];

type Env = Record<string, string | undefined>;

/** CHIRPS_SOURCE, or its default: chc when FEED_SOURCE is live, else mirror. */
export function chirpsSource(env: Env = process.env): ChirpsSource {
	const v = env.CHIRPS_SOURCE?.trim();
	if (!v) return env.FEED_SOURCE?.trim() === 'live' ? 'chc' : 'mirror';
	if (!(CHIRPS_SOURCES as readonly string[]).includes(v)) {
		throw new Error(`unknown CHIRPS_SOURCE "${v}" (expected ${CHIRPS_SOURCES.join(', ')})`);
	}
	return v as ChirpsSource;
}

/** The committed synthetic copy, as a file:// URL. */
export const fixtureMirrorUrl = () => pathToFileURL(fileURLToPath(new URL('../../fixtures/mirror/', import.meta.url))).href;

/**
 * MIRROR_URL, or the committed synthetic copy when this isn't a live process.
 * A live process with no MIRROR_URL is refused: it must never read the fixtures.
 */
export function mirrorUrl(env: Env = process.env): string {
	const v = env.MIRROR_URL?.trim();
	if (v) return v;
	if (env.FEED_SOURCE?.trim() === 'live') throw new Error('MIRROR_URL is not set (a live process never reads the synthetic copy)');
	return fixtureMirrorUrl();
}

const stores = new Map<string, MirrorStore>();

/** The store mirrorUrl() names, one per URL per process. */
export function mirrorStore(env: Env = process.env): MirrorStore {
	const url = mirrorUrl(env);
	let s = stores.get(url);
	if (!s) stores.set(url, (s = openStore(url)));
	return s;
}
