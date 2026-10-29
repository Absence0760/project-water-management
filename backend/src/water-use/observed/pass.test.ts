// The WaPOR pass (pass.ts, issue #623 step 4) against the synthetic WaPOR
// (fixtures.ts) through a recording client: what it reads (only the tiles
// under a unit's parcels), its pacing, the ETag re-check and re-read, a 403's
// stop and the pause after it, the deadline, a unit whose parcels change, and
// a refused file or unit read, marked until the file's ETag changes.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { FeedRefusedError, FeedThrottledError } from '../../feeds/errors.js';
import { fixtureTag } from '../../feeds/fixtures.js';
import type { FeedHttp } from '../../feeds/http.js';
import { openStore } from '../../mirror/store.js';
import { HEADER_READ_BYTES, openCog } from '../../raster/cog.js';
import { waporFixture, waporFixtureDekads, type WaporFixtureSpec } from './fixtures.js';
import { type EtFile, readEtFile, readStatus, type WantedUnit, writeWanted } from './handover.js';
import { readState, runWaporPass, STATE_KEY } from './pass.js';
import { WAPOR_ACCEPT, waporUrl } from './wapor.js';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function store() {
	const dir = mkdtempSync(join(tmpdir(), 'wm-et-pass-'));
	dirs.push(dir);
	return openStore(pathToFileURL(`${dir}/`).href);
}

const TODAY = '2026-10-29';
const FIRST = '2026-09-01';
/** A grid of 80 × 40 tiles (its tile tables 25 KB each, past the header read), data in 2 × 2 of them. */
const SPEC: WaporFixtureSpec = {
	grid: { originLon: 5, originLat: -15, widthDeg: 40, heightDeg: 20, pixelsPerDeg: 1024, tile: 512 },
	cover: [[21.0, -33.5, 22.0, -32.5]],
	schedule: { historyDekads: 4, lagDays: 3 },
	eta: { mean: 3.2, amplitude: 2.2, peakDayOfYear: 15, wavelengthDeg: [0.031, 0.047], spatial: 0.35 },
	cloud: { everyNthDekad: 0, bandPx: 24 }
};
const box = (w: number, s: number, size = 0.01): [number, number][] => [
	[w, s],
	[w + size, s],
	[w + size, s + size],
	[w, s + size],
	[w, s]
];
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
// Both inside the tile with its corner at 21° E, 33° S (tile row 36, column 32).
const unitA: WantedUnit = { unitKey: A, parcels: { type: 'MultiPolygon', coordinates: [[box(21.2, -33.3)], [box(21.23, -33.3)]] } };
const unitB: WantedUnit = { unitKey: B, parcels: { type: 'MultiPolygon', coordinates: [[box(21.4, -33.4, 0.02)]] } };

/** A client over a fixture (swappable, as FAO rewrites a file), recording every request. */
function client(spec: WaporFixtureSpec = SPEC) {
	const holder = { fx: waporFixture(() => TODAY, spec) };
	const calls: { url: string; start: number; end: number; conditional: boolean }[] = [];
	const http: FeedHttp = {
		range: async () => {
			throw new Error('untagged range');
		},
		text: async () => null,
		rangeTagged: async (url, start, end) => {
			calls.push({ url, start, end, conditional: false });
			const b = holder.fx.file(url);
			return b ? { bytes: b.subarray(start, end + 1), tag: fixtureTag(b) } : null;
		},
		rangeConditional: async (url, start, end, etag) => {
			calls.push({ url, start, end, conditional: true });
			const b = holder.fx.file(url);
			if (!b) return null;
			return fixtureTag(b) === etag ? { status: 'not-modified' } : { status: 'ok', bytes: b.subarray(start, end + 1), tag: fixtureTag(b) };
		}
	};
	return { holder, calls, http };
}

const wanted = (units: WantedUnit[], generatedAt = '2026-10-29T06:00:00.000Z') => ({ generatedAt, units });
const run = (s: ReturnType<typeof store>, http: FeedHttp, o: Partial<Parameters<typeof runWaporPass>[0]> = {}) =>
	runWaporPass({ store: s, http, today: TODAY, firstDekad: FIRST, intervalMs: 0, ...o });

describe('the WaPOR pass', () => {
	it('reads every served dekad for each unit, the header once a dekad and then only the tiles under the unit’s parcels', async () => {
		const s = store();
		await writeWanted(s, wanted([unitA, unitB]));
		const { http, calls } = client();
		const r = await run(s, http);
		const served = waporFixtureDekads(SPEC, TODAY);
		expect(served).toEqual(['2026-09-11', '2026-09-21', '2026-10-01', '2026-10-11']);
		expect(r).toMatchObject({ stopped: 'done', filesRead: 4, failures: [], unobservable: 0, error: null });
		expect(r.written.sort()).toEqual([A, B]);
		const a = (await readEtFile(s, 'wapor', A))!;
		expect(a.rows.map((x) => x.dekad)).toEqual(served);
		expect(a).toMatchObject({ mask: 'parcel', version: 'WAPOR-3', parcelsAt: '2026-10-29T06:00:00.000Z' });
		for (const row of a.rows) {
			expect(row.validShare).toBe(1);
			expect(row.etaMmDay).toBeGreaterThan(0);
			expect(row.areaM2).toBeGreaterThan(150_000);
			expect(row.etag).toMatch(/^"fx-/);
		}

		// What was asked of each file: one header read, then per unit the tables' slices and the one tile under it.
		const full = client().holder.fx.file(waporUrl('2026-10-11'))!;
		const cog = (await openCog(async (s0, e0) => full.subarray(s0, e0 + 1), WAPOR_ACCEPT))!;
		expect(cog).toMatchObject({ bigTiff: true, compression: 5, sampleType: 'int16', nodata: -9999, scale: 0.1 });
		const tile = await cog.tile(36 * cog.tilesAcross + 32);
		const others = await Promise.all([33, 1 * cog.tilesAcross].map((d) => cog.tile(36 * cog.tilesAcross + 32 + d)));
		const forFile = calls.filter((c) => c.url === waporUrl('2026-10-11'));
		expect(forFile[0]).toMatchObject({ start: 0, end: HEADER_READ_BYTES - 1 });
		for (const c of forFile.slice(1)) {
			const inTile = c.start >= tile.offset && c.end < tile.offset + tile.bytes;
			// A table slice: one tile row's entries at most, never the 25 KB table.
			const slice = c.end < tile.offset && c.end - c.start + 1 <= 8 * cog.tilesAcross;
			expect(inTile || slice, `${c.start}–${c.end}`).toBe(true);
			for (const o of others) expect(c.start >= o.offset && c.start < o.offset + o.bytes).toBe(false);
		}
		// 2 units × (2 table slices + 1 tile) + the header.
		expect(forFile).toHaveLength(7);
		// The dekad not served (2026-09-01, ended over 30 days ago) is noted missing; today's isn't asked (not ended).
		expect((await readState(s))!.files['2026-09-01']).toEqual({ missing: true, checkedOn: TODAY });
		expect(calls.some((c) => c.url === waporUrl('2026-10-21'))).toBe(false);
		const status = (await readStatus(s, 'wapor'))!;
		expect(status).toMatchObject({ stopped: false, perKey: { [A]: { newest: '2026-10-11' }, [B]: { newest: '2026-10-11' } } });
		expect(r.recencyDays).toBe(18);
	});

	it('asks nothing on the next run, then re-checks each file’s ETag after the re-check days: a 304 costs one request, a rewritten file re-reads every unit’s row', async () => {
		const s = store();
		await writeWanted(s, wanted([unitA]));
		const c = client();
		await run(s, c.http);
		c.calls.length = 0;
		expect(await run(s, c.http)).toMatchObject({ requests: 0, written: [], stopped: 'done' });

		// 30 days on (the same served dekads): one conditional request each, all not modified.
		const later = '2026-11-28';
		const before = (await readEtFile(s, 'wapor', A))!;
		const same = await run(s, c.http, { today: later });
		expect(c.calls.filter((x) => x.conditional)).toHaveLength(4);
		expect(same).toMatchObject({ notModified: 4, filesChanged: 0, written: [] });

		// FAO rewrites the files (other values, so another ETag): every row read again, with the new tag.
		c.holder.fx = waporFixture(() => TODAY, { ...SPEC, eta: { ...SPEC.eta, mean: 4.0 } });
		const rewritten = await run(s, c.http, { today: '2026-12-28' });
		expect(rewritten).toMatchObject({ filesChanged: 4, written: [A] });
		const after = (await readEtFile(s, 'wapor', A))!;
		for (const [i, row] of after.rows.entries()) {
			expect(row.etag).not.toBe(before.rows[i]!.etag);
			expect(row.etaMmDay).toBeGreaterThan(before.rows[i]!.etaMmDay);
		}
		expect(Date.parse(after.fetchedAt)).toBeGreaterThanOrEqual(Date.parse(before.fetchedAt));
	});

	it('abandons a dekad whose file changes while it is read, keeping nothing from it', async () => {
		const s = store();
		await writeWanted(s, wanted([unitA]));
		const c = client();
		const rewritten = waporFixture(() => TODAY, { ...SPEC, eta: { ...SPEC.eta, mean: 5 } });
		let n = 0;
		const http: FeedHttp = {
			...c.http,
			// After the first header read, every response is from the rewritten file.
			rangeTagged: async (url, start, end) => {
				const b = (n++ === 0 ? c.holder.fx : rewritten).file(url);
				return b ? { bytes: b.subarray(start, end + 1), tag: fixtureTag(b) } : null;
			}
		};
		const r = await run(s, http);
		expect(r.changedMidRead).toBe(1);
		const rows = (await readEtFile(s, 'wapor', A))!.rows;
		// The first file read (the newest) was abandoned; the rest came whole from the rewritten files.
		expect(rows.map((x) => x.dekad)).toEqual(['2026-09-11', '2026-09-21', '2026-10-01']);
		expect((await readState(s))!.files['2026-10-11']).toBeUndefined();
	});

	it('asks at most once a second', async () => {
		const s = store();
		await writeWanted(s, wanted([unitA, unitB]));
		let t = 1_000_000;
		const starts: number[] = [];
		const c = client();
		const http: FeedHttp = {
			...c.http,
			rangeTagged: async (...a) => {
				starts.push(t);
				t += 120; // each response takes a while
				return c.http.rangeTagged!(...a);
			}
		};
		const r = await run(s, http, { intervalMs: 1000, now: () => t, sleep: async (ms) => void (t += ms) });
		expect(r.requests).toBe(starts.length);
		for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(1000);
	});

	it('stops at the deadline, and the next run goes on below where it stopped', async () => {
		const s = store();
		await writeWanted(s, wanted([unitA]));
		let t = 0;
		const c = client();
		const opts = { intervalMs: 1000, now: () => t, sleep: async (ms: number) => void (t += ms) };
		const first = await run(s, c.http, { ...opts, deadline: 6500 });
		expect(first.stopped).toBe('deadline');
		const partial = (await readEtFile(s, 'wapor', A))!.rows.map((x) => x.dekad);
		expect(partial.length).toBeGreaterThan(0);
		expect(partial.length).toBeLessThan(4);
		// The newest first.
		expect(partial.at(-1)).toBe('2026-10-11');
		const second = await run(s, c.http, opts);
		expect(second.stopped).toBe('done');
		expect((await readEtFile(s, 'wapor', A))!.rows).toHaveLength(4);
	});

	it('stops on an HTTP 403, says so, and asks nothing for a day', async () => {
		const s = store();
		await writeWanted(s, wanted([unitA]));
		let asked = 0;
		const refuse = async () => {
			asked++;
			throw new FeedRefusedError();
		};
		let t = Date.parse(`${TODAY}T08:00:00Z`);
		const http: FeedHttp = { range: refuse, text: refuse, rangeTagged: refuse, rangeConditional: refuse };
		const r = await run(s, http, { now: () => t });
		expect(r).toMatchObject({ stopped: 'refused' });
		expect(r.error).toBeInstanceOf(FeedRefusedError);
		expect(asked).toBe(1);
		expect(await readStatus(s, 'wapor')).toMatchObject({ stopped: true, reason: 'refused', perKey: { [A]: { error: 'refused' } } });
		t += 23 * 3600_000;
		expect(await run(s, client().http, { now: () => t })).toMatchObject({ stopped: 'paused', requests: 0 });
		expect(asked).toBe(1);
		t += 2 * 3600_000;
		expect(await run(s, client().http, { now: () => t })).toMatchObject({ stopped: 'done' });
	});

	it('pauses for a throttle’s Retry-After when it is longer than a day', async () => {
		const s = store();
		await writeWanted(s, wanted([unitA]));
		const slow = async () => {
			throw new FeedThrottledError(429, 2 * 86_400);
		};
		let t = Date.parse(`${TODAY}T08:00:00Z`);
		const r = await run(s, { range: slow, text: slow, rangeTagged: slow }, { now: () => t });
		expect(r.stopped).toBe('throttled');
		expect(await readStatus(s, 'wapor')).toMatchObject({ stopped: true, reason: 'throttled', retryAfterSeconds: 172_800 });
		t += 30 * 3600_000;
		expect(await run(s, client().http, { now: () => t })).toMatchObject({ stopped: 'paused', requests: 0 });
	});

	it('starts a unit again when its parcels change, relabels its file when only the list changed, and notes one it can’t observe', async () => {
		const s = store();
		await writeWanted(s, wanted([unitA]));
		const c = client();
		await run(s, c.http);
		const first = (await readEtFile(s, 'wapor', A))!;
		// The same parcels in a newer list (they changed and changed back): the file is rewritten with the new parcelsAt, nothing asked.
		await writeWanted(s, wanted([unitA], '2026-10-29T07:00:00.000Z'));
		c.calls.length = 0;
		const relabel = await run(s, c.http);
		expect(relabel).toMatchObject({ written: [A], requests: 0 });
		expect((await readEtFile(s, 'wapor', A))!).toMatchObject({ parcelsAt: '2026-10-29T07:00:00.000Z', rows: first.rows });
		// Redrawn: read again from scratch over the new parcels.
		const moved: WantedUnit = { ...unitA, parcels: { type: 'MultiPolygon', coordinates: [[box(21.3, -33.1, 0.03)]] } };
		await writeWanted(s, wanted([moved], '2026-10-29T08:00:00.000Z'));
		await run(s, c.http);
		const redrawn: EtFile = (await readEtFile(s, 'wapor', A))!;
		expect(redrawn.rows).toHaveLength(4);
		expect(redrawn.rows[0]!.areaM2).not.toBe(first.rows[0]!.areaM2);
		// A parcel smaller than a pixel's centre spacing: noted, and not read again.
		const tiny: WantedUnit = { unitKey: B, parcels: { type: 'MultiPolygon', coordinates: [[box(21.40001, -33.40001, 0.00002)]] } };
		await writeWanted(s, wanted([moved, tiny], '2026-10-29T09:00:00.000Z'));
		const r = await run(s, c.http);
		expect(r.unobservable).toBe(1);
		expect(await readStatus(s, 'wapor')).toMatchObject({ perKey: { [B]: { error: 'no_pixels' } } });
		expect((await readState(s))!.units[B]).toMatchObject({ unobservable: 'no_pixels' });
		c.calls.length = 0;
		expect(await run(s, c.http)).toMatchObject({ requests: 0 });
	});

	it('averages over the cropland when the worker hands it over, labelled', async () => {
		const s = store();
		// Cropland in one 0.0025° cell at the parcel's south-west corner, half of it.
		const row = Math.floor((-33.3 + 0.001) / 0.0025);
		const col = Math.floor((21.2 + 0.001) / 0.0025);
		await writeWanted(s, wanted([{ ...unitA, cropland: { dataset: 'synthetic', cellDeg: 0.0025, cells: [[row, col, 0.5]] } }]));
		await run(s, client().http);
		const f = (await readEtFile(s, 'wapor', A))!;
		expect(f.mask).toBe('cropland');
		// About half of a 0.0025° cell (~232 × 278 m at 33° S).
		expect(f.rows[0]!.areaM2).toBeGreaterThan(10_000);
		expect(f.rows[0]!.areaM2).toBeLessThan(60_000);
	});

	/** A client whose `dekad` file is served as `swap` makes it (garbage, a truncated tile), with the tag of what it serves. */
	function serving(c: ReturnType<typeof client>, dekad: string, swap: (file: Uint8Array, start: number, end: number) => { bytes: Uint8Array; tag: string }) {
		const url = waporUrl(dekad);
		const on = { swapped: true };
		const http: FeedHttp = {
			...c.http,
			rangeTagged: async (u, start, end) => {
				const b = c.holder.fx.file(u);
				if (u !== url || !b || !on.swapped) return c.http.rangeTagged!(u, start, end);
				c.calls.push({ url: u, start, end, conditional: false });
				return swap(b, start, end);
			},
			rangeConditional: async (u, start, end, etag) => {
				const b = c.holder.fx.file(u);
				if (u !== url || !b || !on.swapped) return c.http.rangeConditional!(u, start, end, etag);
				c.calls.push({ url: u, start, end, conditional: true });
				const got = swap(b, start, end);
				return got.tag === etag ? { status: 'not-modified' } : { status: 'ok', ...got };
			}
		};
		return { http, on };
	}
	const DEKAD = '2026-10-01';

	it('marks a file the reader refuses with its ETag, asks nothing for it until the re-check, and reads it once the file changes', async () => {
		const s = store();
		await writeWanted(s, wanted([unitA]));
		const c = client();
		// FAO serves something that isn't a TIFF for one dekad (zeros, the length of the real file).
		const garbage = new Uint8Array(c.holder.fx.file(waporUrl(DEKAD))!.length);
		const tag = fixtureTag(garbage);
		const { http, on } = serving(c, DEKAD, (_b, start, end) => ({ bytes: garbage.subarray(start, end + 1), tag }));
		const first = await run(s, http);
		expect(first.failures.map((f) => `${f.dekad} ${f.code}`)).toEqual([`${DEKAD} format`]);
		expect((await readState(s))!.files[DEKAD]).toEqual({ etag: tag, refused: true, checkedOn: TODAY });
		expect((await readEtFile(s, 'wapor', A))!.rows.map((x) => x.dekad)).not.toContain(DEKAD);
		expect((await readStatus(s, 'wapor'))!.perKey[A]).toMatchObject({ error: 'format' });

		// The next run (the hourly schedule) asks nothing, for that file or any other, and the error stands.
		c.calls.length = 0;
		expect(await run(s, http)).toMatchObject({ requests: 0, failures: [], refusedHeld: 1 });
		expect((await readStatus(s, 'wapor'))!.perKey[A]).toMatchObject({ error: 'format' });

		// At the re-check: one conditional request for it, a 304, and the mark stands.
		const recheck = '2026-11-28';
		c.calls.length = 0;
		expect(await run(s, http, { today: recheck })).toMatchObject({ failures: [], refusedHeld: 1 });
		expect(c.calls.filter((x) => x.url === waporUrl(DEKAD))).toEqual([expect.objectContaining({ conditional: true, start: 0 })]);
		expect((await readState(s))!.files[DEKAD]).toEqual({ etag: tag, refused: true, checkedOn: recheck });

		// FAO replaces the file (a new ETag): the mark is cleared and the unit read.
		on.swapped = false;
		const fixed = await run(s, http, { today: '2026-12-28' });
		expect(fixed.failures).toEqual([]);
		expect((await readEtFile(s, 'wapor', A))!.rows.map((x) => x.dekad)).toContain(DEKAD);
		const f = (await readState(s))!.files[DEKAD]!;
		expect(f.refused).toBeUndefined();
		expect(f.etag).not.toBe(tag);
		expect((await readStatus(s, 'wapor'))!.perKey[A]!.error).toBeUndefined();
	});

	it('marks one unit’s refused read with the file’s ETag, reads the others, and reads it again when the file changes or the unit is redrawn', async () => {
		const s = store();
		// C is one tile east of A (tile column 33), so a bad tile under A leaves C readable.
		const C = '00000000-0000-4000-8000-00000000000c';
		const unitC: WantedUnit = { unitKey: C, parcels: { type: 'MultiPolygon', coordinates: [[box(21.6, -33.3)]] } };
		await writeWanted(s, wanted([unitA, unitC]));
		const c = client();
		const full = c.holder.fx.file(waporUrl(DEKAD))!;
		const cog = (await openCog(async (s0, e0) => full.subarray(s0, e0 + 1), WAPOR_ACCEPT))!;
		const tileA = await cog.tile(36 * cog.tilesAcross + 32);
		// A's tile comes back one byte long: the reader refuses it ("ends inside a tile"); everything else is served whole.
		const { http, on } = serving(c, DEKAD, (b, start, end) => ({
			bytes: start >= tileA.offset && start < tileA.offset + tileA.bytes ? b.subarray(start, start + 1) : b.subarray(start, end + 1),
			tag: fixtureTag(b)
		}));
		const first = await run(s, http);
		expect(first.failures.map((f) => `${f.unitKey} ${f.dekad} ${f.code}`)).toEqual([`${A} ${DEKAD} format`]);
		const state = (await readState(s))!.files[DEKAD]!;
		expect(state).toEqual({ etag: fixtureTag(full), refusedUnits: [A], checkedOn: TODAY });
		expect((await readEtFile(s, 'wapor', C))!.rows.map((x) => x.dekad)).toContain(DEKAD);
		expect((await readEtFile(s, 'wapor', A))!.rows.map((x) => x.dekad)).not.toContain(DEKAD);

		// Next run: nothing asked; A keeps its error, C has none.
		expect(await run(s, http)).toMatchObject({ requests: 0, refusedHeld: 1 });
		const status = (await readStatus(s, 'wapor'))!;
		expect(status.perKey[A]).toMatchObject({ error: 'format' });
		expect(status.perKey[C]!.error).toBeUndefined();

		// A redrawn (its parcels changed): its mark goes and it is read again from scratch; the file still refuses it.
		const movedA: WantedUnit = { ...unitA, parcels: { type: 'MultiPolygon', coordinates: [[box(21.21, -33.31)]] } };
		await writeWanted(s, wanted([movedA, unitC], '2026-10-29T07:00:00.000Z'));
		c.calls.length = 0;
		const redrawn = await run(s, http);
		expect(redrawn.failures.map((f) => `${f.unitKey} ${f.dekad}`)).toEqual([`${A} ${DEKAD}`]);
		expect(c.calls.some((x) => x.url === waporUrl(DEKAD))).toBe(true);
		expect((await readState(s))!.files[DEKAD]).toMatchObject({ refusedUnits: [A] });

		// FAO rewrites the files (a new ETag on each): A is read for the dekad, and the mark is gone.
		on.swapped = false;
		c.holder.fx = waporFixture(() => TODAY, { ...SPEC, eta: { ...SPEC.eta, mean: 4.0 } });
		const rewritten = await run(s, http, { today: '2026-11-28' });
		expect(rewritten.failures).toEqual([]);
		expect((await readEtFile(s, 'wapor', A))!.rows.map((x) => x.dekad)).toContain(DEKAD);
		expect((await readState(s))!.files[DEKAD]!.refusedUnits).toBeUndefined();
		expect((await readStatus(s, 'wapor'))!.perKey[A]!.error).toBeUndefined();
	});

	it('does nothing without a wanted list, and keeps no state for a file it couldn’t read', async () => {
		const s = store();
		expect(await run(s, client().http)).toMatchObject({ stopped: 'no_list', requests: 0 });
		expect(await s.get(STATE_KEY)).toBeUndefined();
	});
});
