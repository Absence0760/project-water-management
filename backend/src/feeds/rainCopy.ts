// Our CHIRPS copy's state for the data feeds panel (issue #604 Round 2,
// docs/architecture.md § Data feeds): the three manifests' last days, read
// through the process's mirror store and judged by health.ts rainCopyStatus.
// Null when the process reads CHC itself (CHIRPS_SOURCE=chc): then nothing
// changes.
//
// The manifests are cached per copy for a few minutes, so listing a
// project's feeds doesn't read S3 each time (they change once a day at
// most). A copy that can't be read (S3 refuses, a manifest is invalid) is
// `readable: false`, logged once per cache period by its error's class only
// (logging/safeError.ts), and remembered for a minute so a failing copy
// isn't asked again on every list.
//
// The committed sample copy (backend/fixtures/mirror/, the default off a live
// process) is fixed at the day it was made, SAMPLE_COPY_MADE: its lags count
// to that day, so dev and e2e show it on time, as the re-dated file fixtures
// show their feeds healthy, and the panel says it is the sample copy.
import { readManifest } from '../mirror/manifest.js';
import { chirpsSource, fixtureMirrorUrl, mirrorStore, mirrorUrl } from '../mirror/source.js';
import { logEvent } from '../logging/logEvent.js';
import { safeError } from '../logging/safeError.js';
import { utcToday } from './fetch.js';
import { type CopyDays, type RainCopy, rainCopyStatus } from './health.js';

type Env = Record<string, string | undefined>;

/** The day the committed sample copy was made (backend/scripts/gen-mirror-fixture.ts MIRROR_FIXTURE.today; rainCopy.test.ts checks they agree). */
export const SAMPLE_COPY_MADE = '2026-02-09';

/** How long read manifests are kept, and how long a failed read is. */
export const COPY_CACHE_MS = 5 * 60_000;
export const COPY_FAILURE_CACHE_MS = 60_000;

let cache: { url: string; until: number; days: Promise<CopyDays | null> } | null = null;

/** Forget the cached manifests (tests). */
export function resetRainCopyCache(): void {
	cache = null;
}

async function readDays(env: Env): Promise<CopyDays> {
	const store = mirrorStore(env);
	const [sat, rnl, prelim] = await Promise.all([readManifest(store, 'sat'), readManifest(store, 'rnl'), readManifest(store, 'prelim')]);
	return { sat, rnl, prelim };
}

/** The copy's manifests' days, cached; null when they couldn't be read. */
function copyDays(url: string, env: Env, now: number): Promise<CopyDays | null> {
	if (cache && cache.url === url && now < cache.until) return cache.days;
	const entry: { url: string; until: number; days: Promise<CopyDays | null> } = { url, until: now + COPY_CACHE_MS, days: Promise.resolve(null) };
	entry.days = readDays(env).catch((err: unknown) => {
		logEvent('error', { event: 'rain_copy_unreadable', ...safeError(err) });
		entry.until = now + COPY_FAILURE_CACHE_MS;
		return null;
	});
	cache = entry;
	return entry.days;
}

/** Our CHIRPS copy's state as of `now`, or null when this process reads CHC itself. */
export async function rainCopy(env: Env = process.env, now = new Date()): Promise<RainCopy | null> {
	if (chirpsSource(env) !== 'mirror') return null;
	const url = mirrorUrl(env);
	const days = await copyDays(url, env, now.getTime());
	if (!days) return { readable: false };
	const sample = url === fixtureMirrorUrl();
	return rainCopyStatus(days, sample ? SAMPLE_COPY_MADE : utcToday(now), sample);
}
