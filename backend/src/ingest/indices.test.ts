// The indices pass (issue #620, ingest/indices.ts): CPC's ONI and AAO into a
// local copy from the synthetic files (FEED_SOURCE=fixtures), revisions only
// on a change, what it refuses, how it stops on a 403, and the reader the
// outlook uses. No network.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLIMATE_INDEX_IDS } from '@water-management/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { FeedRefusedError } from '../feeds/errors.js';
import { fixtureHttp } from '../feeds/fixtures.js';
import type { FeedHttp } from '../feeds/http.js';
import { aaoFixtureValue, AAO_URL, ONI_URL, oniFixtureText, oniFixtureValue } from '../feeds/sources/cpc.js';
import { MirrorManifestError } from '../mirror/manifest.js';
import { openStore, type MirrorStore } from '../mirror/store.js';
import { indexKey, INDEX_IDS, INDICES_MANIFEST_KEY, indicesLagMetricLine, readClimateIndices, readIndicesManifest, runIndicesIngest } from './indices.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
function freshStore(): MirrorStore {
	const d = mkdtempSync(join(tmpdir(), 'wm-indices-'));
	dirs.push(d);
	return openStore(pathToFileURL(`${d}/`).href);
}
const run = (store: MirrorStore, today: string, http: FeedHttp = fixtureHttp(() => today), nowIso = `${today}T06:00:00.000Z`) =>
	runIndicesIngest({ store, http, today, nowIso, intervalMs: 0 });

describe('runIndicesIngest', () => {
	it('lists the engine’s indices', () => {
		expect(INDEX_IDS).toEqual(CLIMATE_INDEX_IDS);
	});

	it('copies both indices with a manifest, then only moves a revision when the values change', async () => {
		const store = freshStore();
		const first = await run(store, '2026-10-28');
		expect(first).toMatchObject({ changed: ['oni', 'aao'], unchanged: [], through: { oni: '2026-08', aao: '2026-09' }, stopped: 'done', requests: 2, error: null });
		// The older of the two (ONI's August) ends 31 August: 58 days before 28 October.
		expect(first.lagDays).toBe(58);
		const m1 = (await readIndicesManifest(store))!;
		expect(m1.indices.oni).toMatchObject({ url: ONI_URL, firstMonth: '1950-01', through: '2026-08', revision: 1, fetchedAt: '2026-10-28T06:00:00.000Z' });
		expect(m1.indices.aao).toMatchObject({ url: AAO_URL, firstMonth: '1979-01', through: '2026-09', revision: 1 });

		const held = await readClimateIndices(store);
		expect(held.series.map((s) => s.id)).toEqual(['oni', 'aao']);
		expect(held.series[0]!.values.at(-1)).toBe(oniFixtureValue(2026, 8));
		expect(held.series[1]!.values.at(-1)).toBe(aaoFixtureValue(2026, 9));
		expect(held.entries.oni).toEqual(m1.indices.oni);

		// Next day, nothing new: no revision, only when it was fetched.
		const second = await run(store, '2026-10-29');
		expect(second).toMatchObject({ changed: [], unchanged: ['oni', 'aao'], stopped: 'done' });
		const m2 = (await readIndicesManifest(store))!;
		expect(m2.indices.oni).toEqual({ ...m1.indices.oni, fetchedAt: '2026-10-29T06:00:00.000Z' });

		// A month on, both have a new month.
		const third = await run(store, '2026-11-03');
		expect(third).toMatchObject({ changed: ['oni', 'aao'], through: { oni: '2026-09', aao: '2026-10' } });
		const m3 = (await readIndicesManifest(store))!;
		expect(m3.indices.oni).toMatchObject({ revision: 2, changedAt: '2026-11-03T06:00:00.000Z' });
	});

	it('refuses a file that ends before what the copy holds, keeping the copy’s, and still copies the other', async () => {
		const store = freshStore();
		await run(store, '2026-10-28');
		const real = fixtureHttp(() => '2026-10-28');
		const shorter: FeedHttp = { ...real, text: async (url) => (url === ONI_URL ? oniFixtureText('2026-06-15') : real.text(url)) };
		const r = await run(store, '2026-10-29', shorter);
		expect(r.stopped).toBe('error');
		expect((r.error as Error).message).toBe('the ONI file now ends at 2026-04, before the 2026-08 the copy holds');
		expect(r.unchanged).toEqual(['aao']);
		expect((await readIndicesManifest(store))!.indices.oni).toMatchObject({ through: '2026-08', revision: 1 });
	});

	it('stops at a 403 with no request after it, and writes nothing', async () => {
		const store = freshStore();
		const refuse = async () => {
			throw new FeedRefusedError();
		};
		const r = await run(store, '2026-10-28', { range: refuse, text: refuse });
		expect(r).toMatchObject({ changed: [], unchanged: [], stopped: 'error', requests: 1, lagDays: null });
		expect(r.error).toBeInstanceOf(FeedRefusedError);
		expect(await store.get(INDICES_MANIFEST_KEY)).toBeUndefined();
	});

	it('reports a changed page as a format error and copies the other', async () => {
		const store = freshStore();
		const real = fixtureHttp(() => '2026-10-28');
		const r = await run(store, '2026-10-28', { ...real, text: async (url) => (url === ONI_URL ? '<html>moved</html>' : real.text(url)) });
		expect(r).toMatchObject({ changed: ['aao'], stopped: 'error', lagDays: null });
		expect((r.error as Error).name).toBe('FeedFormatError');
	});

	it('pages its lag as MirrorLagDays{Product=indices}', () => {
		expect(JSON.parse(indicesLagMetricLine(31, 0))).toMatchObject({ Product: 'indices', MirrorLagDays: 31 });
	});
});

describe('readClimateIndices', () => {
	it('holds nothing in a copy without the manifest', async () => {
		expect(await readClimateIndices(freshStore())).toEqual({ series: [], entries: {} });
	});

	it('refuses a file that doesn’t match its manifest entry', async () => {
		const store = freshStore();
		await run(store, '2026-10-28');
		const held = await readClimateIndices(store);
		const tampered = { ...held.series[1]!, values: held.series[1]!.values.map((v, i) => (i === 0 ? 0 : v)) };
		await store.set(indexKey('aao'), new TextEncoder().encode(JSON.stringify(tampered)));
		await expect(readClimateIndices(store)).rejects.toThrow(MirrorManifestError);
		await expect(readClimateIndices(store)).rejects.toThrow('the data copy’s indices/aao.json doesn’t match its manifest');
	});
});
