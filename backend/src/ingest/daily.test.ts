import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { MIRROR_FIXTURE, MIRROR_FIXTURE_DIR } from '../../scripts/gen-mirror-fixture.js';
import { cellCentre, chcCell } from '../feeds/cellCache.js';
import { FeedFormatError, FeedRefusedError } from '../feeds/errors.js';
import { fixtureHttp } from '../feeds/fixtures.js';
import type { FeedHttp } from '../feeds/http.js';
import { chirpsPrelimUrl, gridValues } from '../feeds/sources/chirps.js';
import { writeGrid } from '../feeds/sources/tiff-write.js';
import { openDaily, readDailyBlock } from '../mirror/arrays.js';
import { chcCellOf, dayIndex, gridOf, MIRROR_REGION, mirrorCell, regionSize } from '../mirror/grid.js';
import { type Manifest, manifestHash, readManifest, writeManifest } from '../mirror/manifest.js';
import { openStore, type MirrorStore } from '../mirror/store.js';
import {
	contiguousThrough,
	DAILY_MAX_FILES,
	dailyMirrorUrl,
	lagMetricLine,
	MIRROR_LAG_METRIC,
	MIRROR_METRIC_NAMESPACE,
	pacedHttp,
	prelimDayOf,
	readRegionDay,
	regionPlacement,
	runDailyIngest
} from './daily.js';

const tmp: string[] = [];
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));

function freshStore(): { dir: string; store: MirrorStore } {
	const dir = mkdtempSync(join(tmpdir(), 'wm-daily-'));
	tmp.push(dir);
	return { dir, store: openStore(pathToFileURL(`${dir}/`).href) };
}

// A synthetic preliminary file: a 4 × 3 grid from 25.00° E, 20.00° S (inside the region), each day its own values.
const GRID = { width: 4, height: 3, originLon: 25, originLat: -20, scale: 0.05 };
/** Row r (north to south), column c of `day`'s file. */
const valueOf = (day: string, r: number, c: number) => Math.fround(Number(day.slice(8, 10)) + r * 0.25 + c * 0.01);
const fileOf = (day: string, over?: (values: Float32Array) => void) => {
	const values = new Float32Array(GRID.width * GRID.height);
	for (let r = 0; r < GRID.height; r++) for (let c = 0; c < GRID.width; c++) values[r * GRID.width + c] = valueOf(day, r, c);
	over?.(values);
	return writeGrid({ ...GRID, values });
};

type Served = Uint8Array | 'refused';
/** A FeedHttp over files by day (absent = 404), logging each request's URL. */
function filesHttp(files: Map<string, Served>) {
	const log: string[] = [];
	const serve = (url: string) => {
		log.push(url);
		const day = prelimDayOf(url);
		const f = day ? files.get(day) : undefined;
		if (f === 'refused') throw new FeedRefusedError();
		return f ?? null;
	};
	const http: FeedHttp = {
		range: async (url, s, e) => serve(url)?.subarray(s, e + 1) ?? null,
		rangeTagged: async (url, s, e) => {
			const f = serve(url);
			return f ? { bytes: f.subarray(s, e + 1), tag: `"t-${prelimDayOf(url)}"` } : null;
		},
		text: async () => null
	};
	return { http, log };
}

const days = (from: string, to: string) => {
	const out: string[] = [];
	for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
	return out;
};
const published = (from: string, to: string) => new Map<string, Served>(days(from, to).map((d) => [d, fileOf(d)]));

/** A sat manifest whose finals run through the end of `throughMonth` (YYYY-MM), from January of its year. */
async function satFinalsThrough(store: MirrorStore, throughMonth: string) {
	const year = Number(throughMonth.slice(0, 4));
	const last = Number(throughMonth.slice(5, 7));
	const files = Array.from({ length: last }, (_, i) => ({
		url: `https://data.chc.ucsb.edu/products/CHIRPS/v3.0/daily/final/sat/netcdf/byMonth/chirps-v3.0.${year}.${String(i + 1).padStart(2, '0')}.days_p05.nc`,
		etag: null,
		lastModified: null,
		size: null,
		valuesSha256: '0'.repeat(64),
		revision: 1,
		fetchedAt: '2026-01-01T00:00:00Z'
	}));
	const end = new Date(Date.UTC(year, last, 0)).toISOString().slice(0, 10);
	const m: Manifest = {
		product: 'sat',
		revision: 1,
		region: { ...MIRROR_REGION },
		grid: gridOf(MIRROR_REGION),
		years: { first: year, last: year },
		finalThrough: end,
		prelimThrough: null,
		files,
		changes: []
	};
	await writeManifest(store, m);
}

/** The copy's prelim value at a point on `day`. */
async function copied(store: MirrorStore, day: string, lat: number, lon: number): Promise<number> {
	const arr = (await openDaily(store, 'prelim'))!;
	const { y, x } = mirrorCell(chcCell(lat, lon));
	const i = dayIndex(arr.firstDay, day);
	return (await readDailyBlock(arr, i, i, { y0: y, x0: x, h: 1, w: 1 })).values[0]!;
}

const run = (store: MirrorStore, http: FeedHttp, today: string, over: Partial<Parameters<typeof runDailyIngest>[0]> = {}) =>
	runDailyIngest({ store, http, today, intervalMs: 0, ...over });

describe('the daily ingest of preliminary sat days', () => {
	it('copies the new days after the finals, in order, about 3 requests each, and stops at the first day not published', async () => {
		const { store } = freshStore();
		await satFinalsThrough(store, '2026-01');
		const { http, log } = filesHttp(published('2026-02-01', '2026-02-07'));
		const r = await run(store, http, '2026-02-10');
		expect(r).toMatchObject({ copied: days('2026-02-01', '2026-02-07'), dropped: [], prelimThrough: '2026-02-07', finalThrough: '2026-01-31', lagDays: 3, stopped: 'not_published', error: null });
		// Header, image directory, one range over the rows; then the next day's header (404).
		expect(r.requests).toBe(7 * 3 + 1);
		expect(log.at(-1)).toBe(chirpsPrelimUrl('2026-02-08'));
		const m = (await readManifest(store, 'prelim'))!;
		expect(m).toMatchObject({ product: 'prelim', revision: 1, finalThrough: null, prelimThrough: '2026-02-07', years: { first: 2026, last: 2026 } });
		expect(m.files.map((f) => f.url)).toEqual(days('2026-02-01', '2026-02-07').map(chirpsPrelimUrl));
		expect(m.files[0]).toMatchObject({ etag: '"t-2026-02-01"', lastModified: null, size: null, revision: 1 });
		// The values: the file's, cell for cell.
		expect(await copied(store, '2026-02-03', -20.025, 25.025)).toBe(valueOf('2026-02-03', 0, 0));
		expect(await copied(store, '2026-02-03', -20.125, 25.175)).toBe(valueOf('2026-02-03', 2, 3));
		expect(Number.isNaN(await copied(store, '2026-02-03', -20.175, 25.025))).toBe(true); // south of the file: NaN
		expect((await openDaily(store, 'prelim'))!.firstDay).toBe('2026-02-01');
	});

	it('copies only new days on the next run: a day with nothing new costs one request', async () => {
		const { store } = freshStore();
		await satFinalsThrough(store, '2026-01');
		const files = published('2026-02-01', '2026-02-03');
		const { http, log } = filesHttp(files);
		await run(store, http, '2026-02-10');
		log.length = 0;
		const again = await run(store, http, '2026-02-10');
		expect(again).toMatchObject({ copied: [], requests: 1, prelimThrough: '2026-02-03', stopped: 'not_published' });
		expect(log).toEqual([chirpsPrelimUrl('2026-02-04')]);
		files.set('2026-02-04', fileOf('2026-02-04'));
		log.length = 0;
		const next = await run(store, http, '2026-02-10');
		expect(next).toMatchObject({ copied: ['2026-02-04'], prelimThrough: '2026-02-04' });
		expect(log.filter((u) => u !== chirpsPrelimUrl('2026-02-05')).every((u) => u === chirpsPrelimUrl('2026-02-04'))).toBe(true);
	});

	it('stops at an HTTP 403 with no request after it, keeping the days copied before it', async () => {
		const { store } = freshStore();
		await satFinalsThrough(store, '2026-01');
		const files = published('2026-02-01', '2026-02-06');
		files.set('2026-02-03', 'refused');
		const { http, log } = filesHttp(files);
		const r = await run(store, http, '2026-02-10');
		expect(r.stopped).toBe('error');
		expect(r.error).toBeInstanceOf(FeedRefusedError);
		expect(r.copied).toEqual(['2026-02-01', '2026-02-02']);
		expect(log.at(-1)).toBe(chirpsPrelimUrl('2026-02-03'));
		expect(log.filter((u) => u === chirpsPrelimUrl('2026-02-03'))).toHaveLength(1);
		expect((await readManifest(store, 'prelim'))!.prelimThrough).toBe('2026-02-02');
		expect(r.lagDays).toBe(8);
	});

	it('refuses a day with an implausible value (0–2000 mm) and writes nothing for it', async () => {
		const { store } = freshStore();
		await satFinalsThrough(store, '2026-01');
		const files = published('2026-02-01', '2026-02-01');
		files.set('2026-02-02', fileOf('2026-02-02', (v) => (v[5] = 2500)));
		const r = await run(store, filesHttp(files).http, '2026-02-10');
		expect(r.error).toBeInstanceOf(FeedFormatError);
		expect(String((r.error as Error).message)).toMatch(/implausible rainfall of 2500/);
		expect(r.copied).toEqual(['2026-02-01']);
		expect((await readManifest(store, 'prelim'))!.files).toHaveLength(1);
	});

	it('never moves prelimThrough past a missing day, and moves it on once the day is copied', async () => {
		const { store } = freshStore();
		await satFinalsThrough(store, '2026-01');
		await run(store, filesHttp(published('2026-02-01', '2026-02-04')).http, '2026-02-10');
		// Take 02-03 out of the manifest: the copy now holds 01, 02 and 04.
		const m = (await readManifest(store, 'prelim'))!;
		await writeManifest(store, { ...m, files: m.files.filter((f) => !f.url.includes('2026.02.03')) });
		const files = published('2026-02-01', '2026-02-04');
		files.delete('2026-02-03');
		const { http, log } = filesHttp(files);
		const gap = await run(store, http, '2026-02-10');
		expect(gap).toMatchObject({ copied: [], prelimThrough: '2026-02-02', stopped: 'not_published' });
		expect(log).toEqual([chirpsPrelimUrl('2026-02-03')]);
		expect((await readManifest(store, 'prelim'))!.prelimThrough).toBe('2026-02-02');
		files.set('2026-02-03', fileOf('2026-02-03'));
		const filled = await run(store, http, '2026-02-10');
		// 02-04 is held already: only 02-03 is read, then 02-05 (404).
		expect(filled).toMatchObject({ copied: ['2026-02-03'], prelimThrough: '2026-02-04' });
		expect(log.slice(1).filter((u) => u.includes('2026.02.04'))).toEqual([]);
	});

	it('drops the preliminary days the finals now hold, deleting their chunks, and never reads or copies a final day again', async () => {
		const { dir, store } = freshStore();
		await satFinalsThrough(store, '2026-01');
		await run(store, filesHttp(published('2026-02-01', '2026-02-07')).http, '2026-02-10');
		expect(existsSync(join(dir, 'prelim/c/0/2/2'))).toBe(true);
		// February's finals land; preliminary March days are out.
		await satFinalsThrough(store, '2026-02');
		const { http, log } = filesHttp(new Map([...published('2026-02-01', '2026-02-28'), ...published('2026-03-01', '2026-03-03')]));
		const r = await run(store, http, '2026-03-06');
		expect(r.dropped).toEqual(days('2026-02-01', '2026-02-07'));
		expect(r.copied).toEqual(days('2026-03-01', '2026-03-03'));
		expect(r).toMatchObject({ prelimThrough: '2026-03-03', finalThrough: '2026-02-28', lagDays: 3 });
		expect(log.some((u) => u.includes('.2026.02.'))).toBe(false);
		const m = (await readManifest(store, 'prelim'))!;
		expect(m.files.map((f) => prelimDayOf(f.url))).toEqual(days('2026-03-01', '2026-03-03'));
		// The array keeps its first day; February's day chunks are gone, March's written at their own indices.
		const arr = (await openDaily(store, 'prelim'))!;
		expect(arr.firstDay).toBe('2026-02-01');
		for (let i = 0; i < 7; i++) expect(existsSync(join(dir, `prelim/c/${i}/2/2`))).toBe(false);
		expect(await copied(store, '2026-03-02', -20.025, 25.025)).toBe(valueOf('2026-03-02', 0, 0));
	});

	it('writes the region in the copy’s row order (row 0 the southernmost): bit for bit what the committed fixture copy holds', async () => {
		const { store } = freshStore();
		const http = fixtureHttp(() => MIRROR_FIXTURE.today);
		// No finals here: the copy starts lookbackDays before today; the fixture publishes preliminary days to today − 3.
		const r = await run(store, http, MIRROR_FIXTURE.today, { lookbackDays: 5 });
		expect(r).toMatchObject({ copied: ['2026-02-04', '2026-02-05', '2026-02-06'], prelimThrough: MIRROR_FIXTURE.prelimThrough, finalThrough: null });
		const committed = (await openDaily(openStore(pathToFileURL(MIRROR_FIXTURE_DIR).href), 'prelim'))!;
		const mine = (await openDaily(store, 'prelim'))!;
		// The fixture grid's north-west and south-east cells, and its sea cell (a NaN in both).
		const block = { y0: 300, x0: 300, h: 10, w: 8 };
		for (const day of r.copied) {
			const a = await readDailyBlock(committed, dayIndex(committed.firstDay, day), dayIndex(committed.firstDay, day), block);
			const b = await readDailyBlock(mine, dayIndex(mine.firstDay, day), dayIndex(mine.firstDay, day), block);
			expect(new Uint32Array(b.values.buffer)).toEqual(new Uint32Array(a.values.buffer));
		}
		// And against the file itself at points across the cover, its northern and southern edges included.
		const day = '2026-02-05';
		const pts = [{ y: 309, x: 220 }, { y: 30, x: 307 }, { y: 150, x: 299 }].map((c) => cellCentre(chcCellOf(c)));
		const fromFile = (await gridValues(http, chirpsPrelimUrl(day), pts))!;
		for (const [i, p] of pts.entries()) expect(await copied(store, day, p.lat, p.lon)).toBe(fromFile[i]);
		// Outside the file's cover: NaN.
		expect(Number.isNaN(await copied(store, day, -15, 30))).toBe(true);
		// The manifest's hash is of the whole region's day, as written.
		const { rows, cols } = regionSize(MIRROR_REGION);
		const whole = await readDailyBlock(mine, dayIndex(mine.firstDay, day), dayIndex(mine.firstDay, day), { y0: 0, x0: 0, h: rows, w: cols });
		const m = (await readManifest(store, 'prelim'))!;
		expect(m.files.find((f) => f.url === chirpsPrelimUrl(day))!.valuesSha256).toBe(manifestHash([whole.values]));
	});

	it('caps the days copied per run, and starts no day past the deadline', async () => {
		const { store } = freshStore();
		await satFinalsThrough(store, '2026-01');
		const { http } = filesHttp(published('2026-02-01', '2026-02-28'));
		const capped = await run(store, http, '2026-03-01', { maxFiles: 2 });
		expect(capped).toMatchObject({ copied: ['2026-02-01', '2026-02-02'], stopped: 'max_files' });
		const late = await run(store, http, '2026-03-01', { deadline: 0 });
		expect(late).toMatchObject({ copied: [], stopped: 'deadline', requests: 0, prelimThrough: '2026-02-02' });
		expect(DAILY_MAX_FILES).toBeGreaterThan(0);
	});

	it('writes no manifest when there is nothing to copy yet', async () => {
		const { store } = freshStore();
		const r = await run(store, filesHttp(new Map()).http, '2026-02-10');
		expect(r).toMatchObject({ copied: [], prelimThrough: null, lagDays: null, requests: 1 });
		expect(await readManifest(store, 'prelim')).toBeNull();
	});
});

describe('the daily ingest’s parts', () => {
	it('paces requests at least intervalMs apart', async () => {
		let t = 0;
		const starts: number[] = [];
		const inner: FeedHttp = { range: async () => (starts.push(t), new Uint8Array(1)), text: async () => null };
		const { http, counter } = pacedHttp(inner, 1000, () => t, async (ms) => void (t += ms));
		for (let i = 0; i < 3; i++) {
			await http.range('u', 0, 0);
			t += 200; // the request took 200 ms
		}
		expect(starts).toEqual([0, 1000, 2000]);
		expect(counter.requests).toBe(3);
	});

	it('places the region on the file in whole cells, and refuses another grid or a misaligned one', () => {
		expect(regionPlacement({ originLat: 60, originLon: -180, scaleLat: 0.05, scaleLon: 0.05 })).toEqual({ northRow: 1360, westCol: 3800 });
		expect(() => regionPlacement({ originLat: 60, originLon: -180, scaleLat: 0.1, scaleLon: 0.1 })).toThrow(/0.05° CHIRPS grid/);
		expect(() => regionPlacement({ originLat: 60.02, originLon: -180, scaleLat: 0.05, scaleLon: 0.05 })).toThrow(/not aligned/);
	});

	it('refuses a file that does not reach the region', async () => {
		const far = writeGrid({ width: 2, height: 2, originLon: -100, originLat: 40, scale: 0.05, values: [1, 2, 3, 4] });
		const http: FeedHttp = { range: async (_u, s, e) => far.subarray(s, e + 1), text: async () => null };
		await expect(readRegionDay(http, chirpsPrelimUrl('2026-02-01'))).rejects.toThrow(/does not cover the region/);
	});

	it('contiguousThrough ends at the first missing day', () => {
		const held = new Set(['2026-02-01', '2026-02-02', '2026-02-04']);
		expect(contiguousThrough(held, '2026-02-01')).toBe('2026-02-02');
		expect(contiguousThrough(held, '2026-02-03')).toBeNull();
		expect(contiguousThrough(held, '2026-02-04')).toBe('2026-02-04');
	});

	it('publishes MirrorLagDays for Product=prelim as an embedded metric', () => {
		const line = JSON.parse(lagMetricLine(4, 1000));
		expect(line).toEqual({
			_aws: { Timestamp: 1000, CloudWatchMetrics: [{ Namespace: MIRROR_METRIC_NAMESPACE, Dimensions: [['Product']], Metrics: [{ Name: MIRROR_LAG_METRIC, Unit: 'None' }] }] },
			Product: 'prelim',
			MirrorLagDays: 4
		});
		expect(MIRROR_METRIC_NAMESPACE).toBe('water-management/Mirror');
	});

	it('writes only the copy MIRROR_URL names, never the committed fixture', () => {
		expect(() => dailyMirrorUrl({})).toThrow(/MIRROR_URL is not set/);
		expect(() => dailyMirrorUrl({ MIRROR_URL: pathToFileURL(MIRROR_FIXTURE_DIR).href })).toThrow(/committed synthetic copy/);
		expect(dailyMirrorUrl({ MIRROR_URL: 's3://water-management-mirror-000000000000' })).toBe('s3://water-management-mirror-000000000000');
	});
});
