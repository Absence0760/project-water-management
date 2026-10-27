// Writes the committed synthetic rain data copy (backend/fixtures/mirror/,
// issue #604): the mirror's Zarr arrays and manifests, read from the same
// synthetic CHIRPS GeoTIFFs FEED_SOURCE=fixtures serves (src/feeds/fixtures.ts,
// fixtures/feeds/chirps-sample.json) through the same TIFF reader, so a feed
// read from the copy gets the values a feed read from the files gets, bit for
// bit. Invented values only: no real place or measurement.
//
// Fixed in time, unlike the file fixture (which re-dates itself to today): the
// copy is as the files stood on MIRROR_FIXTURE.today, so finals through
// 2025-12-31 (2023–2025, one leap year) and preliminary sat days through
// 2026-02-06, and the CHIRPS-GEFS issues of 2026-02-08 and 2026-02-09
// (`gefs/<issue>` and `gefs/index.json`). Two 0.1° products too (issue #604
// R4-B), with invented values of their own (no file fixture stands behind
// them): `era5l` (finals layout, 2024-01-01 to 2025-12-30, one file per CDS
// month request as ingest/era5land.py writes them: month M holds the last day
// of M−1 through the second-last day of M, so the first file lacks
// 2023-12-31 and finalThrough is the second-last day of 2025-12) and `imerg_late`
// (daily layout, 2026-01-25 to 2026-02-08 through prelimThrough, a file a
// day, each V07 but the last two V08), each over the 0.1° cells holding the fixture grid and its
// band, every other chunk unwritten; and one ECMWF ENS issue (scripts/ecmwf-fixture.ts, `ecmwf/<issue>`, `ecmwf/index.json`). Only the chunks holding the fixture's 8 × 6 grid and the band
// of the same size just south of it are written, each with the cells the
// files cover; every other chunk is unwritten (NaN), which costs nothing. The
// band holds one land copy of every cell of the grid's repeating pattern
// (the files repeat it, with no sea, over their whole cover), so a feed read
// in fixtures mode anywhere in the cover reads its value from there
// (src/feeds/fromMirror.ts fixtureSourceCell). src/mirror/fixture.test.ts regenerates it into a
// temporary directory and compares it with this one by content (the gzip
// bytes depend on the zlib), so it fails until you re-run this after changing
// the fixture files, the layout or this script.
//
//   pnpm gen:mirror-fixture   (pnpm -C backend gen:mirror-fixture)
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { cellCentre, chcCell, productCell } from '../src/feeds/cellCache.js';
import { FIXTURE_DIR, fixtureHttp, fixtureTag } from '../src/feeds/fixtures.js';
import { CHC_BASE, chirpsFinalFileUrl, chirpsPrelimUrl, GEFS_DAYS, gefsUrl, gridValues } from '../src/feeds/sources/chirps.js';
import { gefsProduct, writeGefsIndex } from '../src/ingest/gefs.js';
import { writeEcmwfFixture } from './ecmwf-fixture.js';
import { type Block, DAILY_CHUNK, ensureDaily, ensureFinals, FINALS_CHUNK, writeDailyDays, writeFinalsYear } from '../src/mirror/arrays.js';
import { chcCellOf, dateOfDoy, gridOf, isLeapYear, MIRROR_REGION, mirrorCell, PRODUCT_GRIDS, regionSize } from '../src/mirror/grid.js';
import { type Manifest, manifestHash, writeManifest } from '../src/mirror/manifest.js';
import { openStore, type MirrorStore } from '../src/mirror/store.js';

export const MIRROR_FIXTURE_DIR = fileURLToPath(new URL('../fixtures/mirror/', import.meta.url));

/** The day the copy was made, and what it holds. */
export const MIRROR_FIXTURE = {
	today: '2026-02-09',
	years: { first: 2023, last: 2025 },
	finalThrough: '2025-12-31',
	prelimFirst: '2026-01-01',
	prelimThrough: '2026-02-06',
	/** CHIRPS-GEFS issues held, newest first: two, so their 32 days hold every place of the 17-day pattern (fromMirrorGefs.ts). */
	gefsIssues: ['2026-02-09', '2026-02-08'],
	/** ERA5-Land: finals from 2024 (a leap year) through 2025-12-30, the last day month 2025-12's request holds. */
	era5l: { years: { first: 2024, last: 2025 }, finalThrough: '2025-12-30' },
	/** IMERG Late: about 14 hours behind, so through the day before yesterday on MIRROR_FIXTURE.today; V08 from v08From. */
	imerg: { first: '2026-01-25', through: '2026-02-08', v08From: '2026-02-07' }
} as const;

interface SampleFixture {
	grid: { originLon: number; originLat: number; scale: number; width: number; height: number };
	cover: { originLon: number; originLat: number; width: number; height: number };
}

/** The mirror cells (inclusive ranges) of a box given by its north-west corner and size in cells. */
function boxCells(b: { originLon: number; originLat: number; width: number; height: number }, step: number) {
	// The north-west cell's centre, then the south-east's.
	const nw = mirrorCell(chcCell(b.originLat - step / 2, b.originLon + step / 2));
	const se = mirrorCell(chcCell(b.originLat - (b.height - 0.5) * step, b.originLon + (b.width - 0.5) * step));
	return { y0: se.y, y1: nw.y, x0: nw.x, x1: se.x };
}

/** The cells of the chunks (chunk shape ch × cw) holding `grid` that `cover` covers: one block per chunk. */
function blocks(grid: ReturnType<typeof boxCells>, cover: ReturnType<typeof boxCells>, ch: number, cw: number): Block[] {
	const out: Block[] = [];
	for (let cy = Math.floor(grid.y0 / ch); cy <= Math.floor(grid.y1 / ch); cy++) {
		for (let cx = Math.floor(grid.x0 / cw); cx <= Math.floor(grid.x1 / cw); cx++) {
			const y0 = Math.max(cy * ch, cover.y0);
			const y1 = Math.min(cy * ch + ch - 1, cover.y1);
			const x0 = Math.max(cx * cw, cover.x0);
			const x1 = Math.min(cx * cw + cw - 1, cover.x1);
			if (y0 <= y1 && x0 <= x1) out.push({ y0, x0, h: y1 - y0 + 1, w: x1 - x0 + 1 });
		}
	}
	return out;
}

/** Each cell of a block, in (y, x) C order, as the point the fixture's files are read at. */
const blockPoints = (b: Block) => {
	const pts: { lat: number; lon: number }[] = [];
	for (let y = b.y0; y < b.y0 + b.h; y++) for (let x = b.x0; x < b.x0 + b.w; x++) pts.push(cellCentre(chcCellOf({ y, x })));
	return pts;
};

/** One day of the region (on the grid of `step`), NaN where the copy holds nothing: what valuesSha256 hashes. */
function regionDay(parts: { block: Block; values: Float32Array }[], step = 0.05): Float32Array {
	const { rows, cols } = regionSize(MIRROR_REGION, step);
	const day = new Float32Array(rows * cols).fill(Number.NaN);
	for (const { block, values } of parts) for (let j = 0; j < block.h; j++) day.set(values.subarray(j * block.w, (j + 1) * block.w), (block.y0 + j) * cols + block.x0);
	return day;
}

const fetchedAt = `${MIRROR_FIXTURE.today}T00:00:00Z`;
const days = (from: string, to: string) => Array.from({ length: toEpochDay(to) - toEpochDay(from) + 1 }, (_, i) => fromEpochDay(toEpochDay(from) + i));
const byMonthUrl = (product: 'rnl' | 'sat', month: string) =>
	`${CHC_BASE}/CHIRPS/v3.0/daily/final/${product}/netcdf/byMonth/chirps-v3.0.${month.replace('-', '.')}.days_p05.nc`;
/** A synthetic ETag, as fixtures.ts tags its files: a hash of what the "file" holds. */
const etagOf = (sha: string) => fixtureTag(new TextEncoder().encode(sha));

/** Write the fixture copy into `dir` (emptied first). */
export async function buildMirrorFixture(dir: string): Promise<void> {
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const store: MirrorStore = openStore(new URL(`file://${dir.endsWith('/') ? dir : `${dir}/`}`).href);
	const sample = JSON.parse(readFileSync(`${FIXTURE_DIR}chirps-sample.json`, 'utf8')) as SampleFixture;
	const step = sample.grid.scale;
	// The grid and the band of its size south of it (fixtureSourceCell reads a cover cell's value there).
	const grid = boxCells({ ...sample.grid, height: sample.grid.height * 2 }, step);
	const cover = boxCells(sample.cover, step);
	const http = fixtureHttp(() => MIRROR_FIXTURE.today);
	const read = async (url: string, pts: { lat: number; lon: number }[]) => {
		const v = await gridValues(http, url, pts);
		if (!v) throw new Error(`the fixture serves no ${url} on ${MIRROR_FIXTURE.today}`);
		return v;
	};
	const base = { revision: 1, region: { ...MIRROR_REGION }, grid: gridOf(MIRROR_REGION), changes: [] };

	// Finals: rnl and sat, a year chunk per block.
	const finalBlocks = blocks(grid, cover, FINALS_CHUNK[2], FINALS_CHUNK[3]);
	for (const product of ['rnl', 'sat'] as const) {
		const arr = await ensureFinals(store, product, MIRROR_FIXTURE.years.last);
		const perDay = new Map<string, { block: Block; values: Float32Array }[]>();
		for (let year = MIRROR_FIXTURE.years.first; year <= MIRROR_FIXTURE.years.last; year++) {
			for (const block of finalBlocks) {
				const pts = blockPoints(block);
				const n = block.h * block.w;
				const values = new Float32Array(366 * n).fill(Number.NaN);
				for (let doy = 0; doy < 366; doy++) {
					const day = dateOfDoy(year, doy);
					if (day === null || day > MIRROR_FIXTURE.finalThrough) continue;
					const v = await read(chirpsFinalFileUrl(product, day), pts);
					v.forEach((x, i) => (values[doy * n + i] = x ?? Number.NaN));
					const list = perDay.get(day) ?? perDay.set(day, []).get(day)!;
					list.push({ block, values: values.subarray(doy * n, (doy + 1) * n) });
				}
				await writeFinalsYear(arr, year, block, values);
			}
		}
		const months = [...new Set([...perDay.keys()].map((d) => d.slice(0, 7)))].sort();
		const files = months.map((month) => {
			const sha = manifestHash(
				[...perDay.keys()]
					.filter((d) => d.startsWith(month))
					.sort()
					.map((d) => regionDay(perDay.get(d)!))
			);
			return { url: byMonthUrl(product, month), etag: etagOf(sha), lastModified: null, size: null, valuesSha256: sha, revision: 1, fetchedAt };
		});
		const m: Manifest = { ...base, product, years: { ...MIRROR_FIXTURE.years }, finalThrough: MIRROR_FIXTURE.finalThrough, prelimThrough: null, files };
		await writeManifest(store, m);
	}

	// Preliminary sat days: the daily layout, a day chunk per block.
	const dailyBlocks = blocks(grid, cover, DAILY_CHUNK[1], DAILY_CHUNK[2]);
	const prelimDays = days(MIRROR_FIXTURE.prelimFirst, MIRROR_FIXTURE.prelimThrough);
	const prelim = await ensureDaily(store, 'prelim', MIRROR_FIXTURE.prelimFirst, prelimDays.length);
	const files: Manifest['files'] = [];
	for (const [d, day] of prelimDays.entries()) {
		const parts: { block: Block; values: Float32Array }[] = [];
		for (const block of dailyBlocks) {
			const v = await read(chirpsPrelimUrl(day), blockPoints(block));
			const values = Float32Array.from(v, (x) => x ?? Number.NaN);
			await writeDailyDays(prelim, d, block, values);
			parts.push({ block, values });
		}
		const sha = manifestHash([regionDay(parts)]);
		files.push({ url: chirpsPrelimUrl(day), etag: etagOf(sha), lastModified: null, size: null, valuesSha256: sha, revision: 1, fetchedAt });
	}
	const year = Number(MIRROR_FIXTURE.prelimFirst.slice(0, 4));
	await writeManifest(store, {
		...base,
		product: 'prelim',
		years: { first: year, last: Number(MIRROR_FIXTURE.prelimThrough.slice(0, 4)) },
		finalThrough: null,
		prelimThrough: MIRROR_FIXTURE.prelimThrough,
		files
	});

	// CHIRPS-GEFS issues (the daily layout, as ingest/gefs.ts writes them), from the GEFS files on the same grid and cover.
	const gefsSample = JSON.parse(readFileSync(`${FIXTURE_DIR}gefs-sample.json`, 'utf8')) as SampleFixture;
	if (JSON.stringify([gefsSample.grid.originLat, gefsSample.grid.originLon, gefsSample.grid.width, gefsSample.grid.height, gefsSample.cover]) !==
		JSON.stringify([sample.grid.originLat, sample.grid.originLon, sample.grid.width, sample.grid.height, sample.cover])) {
		throw new Error('gefs-sample.json and chirps-sample.json must share their grid and cover (fromMirror.ts fixtureSourceCell reads both)');
	}
	for (const issue of MIRROR_FIXTURE.gefsIssues) {
		const product = gefsProduct(issue);
		const arr = await ensureDaily(store, product, issue, GEFS_DAYS);
		const gefsFiles: Manifest['files'] = [];
		for (const [d, day] of days(issue, fromEpochDay(toEpochDay(issue) + GEFS_DAYS - 1)).entries()) {
			const parts: { block: Block; values: Float32Array }[] = [];
			for (const block of dailyBlocks) {
				const v = await read(gefsUrl(issue, day), blockPoints(block));
				const values = Float32Array.from(v, (x) => x ?? Number.NaN);
				await writeDailyDays(arr, d, block, values);
				parts.push({ block, values });
			}
			const sha = manifestHash([regionDay(parts)]);
			gefsFiles.push({ url: gefsUrl(issue, day), etag: etagOf(sha), lastModified: null, size: null, valuesSha256: sha, revision: 1, fetchedAt });
		}
		await writeManifest(store, {
			...base,
			product,
			years: { first: Number(issue.slice(0, 4)), last: Number(fromEpochDay(toEpochDay(issue) + GEFS_DAYS - 1).slice(0, 4)) },
			finalThrough: null,
			prelimThrough: null,
			files: gefsFiles
		});
	}
	await writeGefsIndex(store, MIRROR_FIXTURE.gefsIssues);

	await buildTenthProducts(store, sample);
	// ECMWF ENS (issue #604 R4-C): one invented issue, scripts/ecmwf-fixture.ts.
	await writeEcmwfFixture(store);
}

/**
 * An invented daily rain value (mm) for mirror cell (y, x) on epoch day `e`:
 * dry about one day in three, else up to about 25 mm, varying cell to cell
 * and day to day; `salt` makes each product's values its own.
 */
export function inventedRain(y: number, x: number, e: number, salt: number): number {
	const k = (e * 7 + y * 13 + x * 29 + salt * 31) % 37;
	return k < 12 ? 0 : Math.fround(((k - 11) * (3 + ((y + x + salt) % 5))) / 5);
}

/** The 0.1° products: era5l (finals) and imerg_late (daily) over the 0.1° cells holding the fixture grid and its band. */
async function buildTenthProducts(store: MirrorStore, sample: SampleFixture): Promise<void> {
	const step = 0.1;
	const half = sample.grid.scale / 2;
	// The fixture grid's north-west 0.05° cell, and the south-east one of the band south of it, as 0.1° mirror cells.
	const nw = mirrorCell(productCell('era5l', sample.grid.originLat - half, sample.grid.originLon + half), MIRROR_REGION, step);
	const se = mirrorCell(
		productCell('era5l', sample.grid.originLat - (2 * sample.grid.height - 0.5) * sample.grid.scale, sample.grid.originLon + (sample.grid.width - 0.5) * sample.grid.scale),
		MIRROR_REGION,
		step
	);
	const block: Block = { y0: se.y, x0: nw.x, h: nw.y - se.y + 1, w: se.x - nw.x + 1 };
	const n = block.h * block.w;
	const base = { revision: 1, region: { ...MIRROR_REGION }, grid: gridOf(MIRROR_REGION, step), changes: [] };
	const dayValues = (day: string, salt: number) => {
		const out = new Float32Array(n);
		for (let j = 0; j < block.h; j++) for (let i = 0; i < block.w; i++) out[j * block.w + i] = inventedRain(block.y0 + j, block.x0 + i, toEpochDay(day), salt);
		return out;
	};

	// era5l: a year chunk per year, one file per CDS month request: a day's total is the next day's 00 UTC step, so it is in the request of the month of the day after it.
	const e = MIRROR_FIXTURE.era5l;
	const era5l = await ensureFinals(store, 'era5l', e.years.last, { firstYear: PRODUCT_GRIDS.era5l.firstYear });
	const monthDays = new Map<string, Float32Array[]>();
	for (let year = e.years.first; year <= e.years.last; year++) {
		const values = new Float32Array(366 * n).fill(Number.NaN);
		for (let doy = 0; doy < (isLeapYear(year) ? 366 : 365); doy++) {
			const day = dateOfDoy(year, doy)!;
			if (day > e.finalThrough) continue;
			const v = dayValues(day, 1);
			values.set(v, doy * n);
			const month = fromEpochDay(toEpochDay(day) + 1).slice(0, 7);
			const list = monthDays.get(month) ?? monthDays.set(month, []).get(month)!;
			list.push(regionDay([{ block, values: v }], step));
		}
		await writeFinalsYear(era5l, year, block, values);
	}
	const era5lFiles = [...monthDays.keys()].sort().map((month) => {
		const sha = manifestHash(monthDays.get(month)!);
		return { url: `cds://reanalysis-era5-land/total_precipitation/${month}`, etag: null, lastModified: null, size: null, valuesSha256: sha, revision: 1, fetchedAt };
	});
	await writeManifest(store, { ...base, product: 'era5l', years: { ...e.years }, finalThrough: e.finalThrough, prelimThrough: null, files: era5lFiles });

	// imerg_late: a day at a time, one file a day with its version.
	const im = MIRROR_FIXTURE.imerg;
	const imDays = days(im.first, im.through);
	const imerg = await ensureDaily(store, 'imerg_late', im.first, imDays.length);
	const imergFiles: Manifest['files'] = [];
	for (const [d, day] of imDays.entries()) {
		const v = dayValues(day, 2);
		await writeDailyDays(imerg, d, block, v);
		const sha = manifestHash([regionDay([{ block, values: v }], step)]);
		const version = day >= im.v08From ? 'V08' : 'V07';
		// The granule's own version carries a minor letter (V07B); the manifest's `version` is the collection's.
		const url = `https://gpm1.gesdisc.eosdis.nasa.gov/opendap/GPM_L3/GPM_3IMERGDL.${version.slice(1)}/${day.slice(0, 4)}/${day.slice(5, 7)}/3B-DAY-L.MS.MRG.3IMERG.${day.replaceAll('-', '')}-S000000-E235959.${version}B.nc4`;
		imergFiles.push({ url, etag: etagOf(sha), lastModified: null, size: null, valuesSha256: sha, revision: 1, fetchedAt, version });
	}
	await writeManifest(store, {
		...base,
		product: 'imerg_late',
		years: { first: Number(im.first.slice(0, 4)), last: Number(im.through.slice(0, 4)) },
		finalThrough: null,
		prelimThrough: im.through,
		files: imergFiles
	});
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	await buildMirrorFixture(MIRROR_FIXTURE_DIR);
	console.log(`wrote ${MIRROR_FIXTURE_DIR}`);
}
