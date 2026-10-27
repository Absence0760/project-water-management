import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIRROR_FIXTURE, MIRROR_FIXTURE_DIR } from '../../scripts/gen-mirror-fixture.js';
import { COPY_CACHE_MS, COPY_FAILURE_CACHE_MS, rainCopy, resetRainCopyCache, SAMPLE_COPY_MADE } from './rainCopy.js';

const dirs: string[] = [];
/** A copy of the committed sample copy's manifests in a temporary directory, as a MIRROR_URL. */
function copyOfManifests(): { dir: string; url: string } {
	const dir = mkdtempSync(join(tmpdir(), 'rain-copy-'));
	dirs.push(dir);
	for (const p of ['sat', 'rnl', 'prelim']) {
		mkdirSync(join(dir, p));
		cpSync(join(MIRROR_FIXTURE_DIR, p, 'manifest.json'), join(dir, p, 'manifest.json'));
	}
	return { dir, url: pathToFileURL(dir).href };
}

beforeEach(() => resetRainCopyCache());
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('rainCopy', () => {
	it('is null while CHIRPS is read from CHC itself', async () => {
		expect(await rainCopy({ CHIRPS_SOURCE: 'chc' })).toBeNull();
		// The live default until the cutover.
		expect(await rainCopy({ FEED_SOURCE: 'live' })).toBeNull();
	});

	it('the committed sample copy counts its lags to the day it was made, so it is on time, and says it is the sample', async () => {
		expect(SAMPLE_COPY_MADE).toBe(MIRROR_FIXTURE.today);
		expect(await rainCopy({}, new Date('2026-10-27T12:00:00Z'))).toEqual({
			readable: true,
			sample: true,
			asOf: SAMPLE_COPY_MADE,
			final: { sat: { through: MIRROR_FIXTURE.finalThrough, behind: false }, rnl: { through: MIRROR_FIXTURE.finalThrough, behind: false } },
			preliminary: { through: MIRROR_FIXTURE.prelimThrough, behind: false }
		});
	});

	it('a real copy counts to today (UTC): the same manifests are behind months later', async () => {
		const { url } = copyOfManifests();
		const copy = await rainCopy({ MIRROR_URL: url }, new Date('2026-10-27T23:30:00Z'));
		expect(copy).toMatchObject({ readable: true, sample: false, asOf: '2026-10-27', final: { sat: { behind: true } }, preliminary: { behind: true } });
		// Positive control: the day after the sample was made, the same copy is on time.
		resetRainCopyCache();
		expect(await rainCopy({ MIRROR_URL: url }, new Date('2026-02-10T00:00:00Z'))).toMatchObject({ final: { sat: { behind: false } }, preliminary: { behind: false } });
	});

	it('keeps the manifests a few minutes, then reads them again', async () => {
		const { dir, url } = copyOfManifests();
		const t0 = new Date('2026-02-10T00:00:00Z');
		expect(await rainCopy({ MIRROR_URL: url }, t0)).toMatchObject({ preliminary: { through: '2026-02-06' } });
		// The daily ingest moves the preliminary days on.
		const m = JSON.parse(readFileSync(join(MIRROR_FIXTURE_DIR, 'prelim', 'manifest.json'), 'utf8')) as { prelimThrough: string };
		m.prelimThrough = '2026-02-08';
		writeFileSync(join(dir, 'prelim', 'manifest.json'), JSON.stringify(m));
		expect(await rainCopy({ MIRROR_URL: url }, new Date(t0.getTime() + COPY_CACHE_MS - 1))).toMatchObject({ preliminary: { through: '2026-02-06' } });
		expect(await rainCopy({ MIRROR_URL: url }, new Date(t0.getTime() + COPY_CACHE_MS))).toMatchObject({ preliminary: { through: '2026-02-08' } });
	});

	it('an unreadable copy is readable: false, logged by its error’s class only, and asked again after a minute', async () => {
		const { dir, url } = copyOfManifests();
		writeFileSync(join(dir, 'sat', 'manifest.json'), '{"product": "sat", "secret-ish": "not a manifest"}');
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const t0 = new Date('2026-02-10T00:00:00Z');
		expect(await rainCopy({ MIRROR_URL: url }, t0)).toEqual({ readable: false });
		expect(log).toHaveBeenCalledTimes(1);
		const line = String(log.mock.calls[0]![0]);
		expect(JSON.parse(line)).toEqual({ event: 'rain_copy_unreadable', error: 'FeedFormatError' });
		expect(line).not.toContain('secret-ish');
		// Remembered for a minute: not read (or logged) again.
		expect(await rainCopy({ MIRROR_URL: url }, new Date(t0.getTime() + COPY_FAILURE_CACHE_MS - 1))).toEqual({ readable: false });
		expect(log).toHaveBeenCalledTimes(1);
		// Mended, it is read again after the minute.
		cpSync(join(MIRROR_FIXTURE_DIR, 'sat', 'manifest.json'), join(dir, 'sat', 'manifest.json'));
		expect(await rainCopy({ MIRROR_URL: url }, new Date(t0.getTime() + COPY_FAILURE_CACHE_MS))).toMatchObject({ readable: true });
	});
});
