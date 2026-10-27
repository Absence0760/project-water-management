import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { MIRROR_FIXTURE_DIR } from '../../scripts/gen-mirror-fixture.js';
import {
	era5lCoverage,
	era5lWrittenDays,
	finalsCoverage,
	imergCoverage,
	imergHeldDays,
	imergFileDay,
	imergVersions,
	type Manifest,
	manifestHash,
	MirrorManifestError,
	parseManifest,
	readManifest,
	writeManifest
} from './manifest.js';
import { openStore } from './store.js';

const dir = mkdtempSync(join(tmpdir(), 'mirror-manifest-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const sample = (): Manifest => ({
	product: 'rnl',
	revision: 2,
	region: { w: 10, s: -35.5, e: 41, n: -8 },
	grid: { origin: { lat: -35.475, lon: 10.025 }, step: 0.05 },
	years: { first: 1981, last: 2026 },
	finalThrough: '2024-06-30',
	prelimThrough: null,
	files: [
		{
			url: 'https://data.chc.ucsb.edu/products/CHIRPS/v3.0/daily/final/rnl/netcdf/byMonth/chirps-v3.0.2024.06.days_p05.nc',
			etag: '"abc-123"',
			lastModified: 'Tue, 05 Aug 2026 10:00:00 GMT',
			size: 362853441,
			valuesSha256: 'a'.repeat(64),
			revision: 2,
			fetchedAt: '2026-10-27T03:00:00.000Z'
		}
	],
	changes: [{ revision: 2, days: ['2024-06-01', '2024-06-30'], cellsChanged: 12, maxAbsDiff: 0.25 }]
});

const monthUrl = (y: number, m: number) => `https://data.chc.ucsb.edu/products/CHIRPS/v3.0/daily/final/rnl/netcdf/byMonth/chirps-v3.0.${y}.${String(m).padStart(2, '0')}.days_p05.nc`;

describe('finalsCoverage', () => {
	const files = (...ym: [number, number][]) => ym.map(([y, m]) => ({ url: monthUrl(y, m) }));
	it('runs from the first month through the contiguous months after it', () => {
		expect(finalsCoverage([])).toBeNull();
		expect(finalsCoverage([{ url: 'https://example.org/chirps-v3.0.prelim.2026.01.01.tif' }])).toBeNull();
		expect(finalsCoverage(files([2024, 2]))).toEqual({ from: '2024-02-01', through: '2024-02-29' });
		expect(finalsCoverage(files([2023, 2]))).toEqual({ from: '2023-02-01', through: '2023-02-28' });
		expect(finalsCoverage(files([2024, 1], [2023, 11], [2023, 12]))).toEqual({ from: '2023-11-01', through: '2024-01-31' });
		// A gap stops the run, however new the month after it.
		expect(finalsCoverage(files([2000, 1], [2000, 2], [2026, 9]))).toEqual({ from: '2000-01-01', through: '2000-02-29' });
	});
});

describe('the manifest', () => {
	it('round-trips through the store', async () => {
		const store = openStore(pathToFileURL(dir).href);
		expect(await readManifest(store, 'rnl')).toBeNull();
		await writeManifest(store, sample());
		expect(await readManifest(store, 'rnl')).toEqual(sample());
	});

	it('refuses each kind of bad manifest, naming the field', () => {
		const bad: [string, (m: Manifest) => unknown, RegExp][] = [
			['an unknown product', (m) => ({ ...m, product: 'gefs/latest' }), /product/],
			['revision 0', (m) => ({ ...m, revision: 0 }), /revision/],
			['a missing field', (m) => ({ ...m, finalThrough: undefined }), /finalThrough/],
			['an extra field', (m) => ({ ...m, extra: 1 }), /extra|Unrecognized/i],
			['a bad date', (m) => ({ ...m, finalThrough: '2026-02-30' }), /finalThrough/],
			['another step', (m) => ({ ...m, grid: { ...m.grid, step: 0.1 } }), /grid\.step/],
			['an origin off the region', (m) => ({ ...m, grid: { ...m.grid, origin: { lat: -35.5, lon: 10 } } }), /south-west cell/],
			['an upside-down region', (m) => ({ ...m, region: { ...m.region, s: -5 } }), /region/],
			['a file from a later revision', (m) => ({ ...m, files: [{ ...m.files[0]!, revision: 3 }] }), /later revision/],
			['a bad hash', (m) => ({ ...m, files: [{ ...m.files[0]!, valuesSha256: 'A'.repeat(64) }] }), /valuesSha256/],
			['a local fetchedAt', (m) => ({ ...m, files: [{ ...m.files[0]!, fetchedAt: '2026-10-27T03:00:00+02:00' }] }), /fetchedAt/],
			['a file twice', (m) => ({ ...m, files: [m.files[0]!, m.files[0]!] }), /twice/],
			['days backwards', (m) => ({ ...m, changes: [{ ...m.changes[0]!, days: ['2024-06-30', '2024-06-01'] }] }), /days/],
			['a negative diff', (m) => ({ ...m, changes: [{ ...m.changes[0]!, maxAbsDiff: -1 }] }), /maxAbsDiff/],
			['rnl prelim days', (m) => ({ ...m, prelimThrough: '2026-10-01' }), /rnl has no preliminary/],
			['finalThrough outside years', (m) => ({ ...m, finalThrough: '1975-01-01' }), /outside years/],
			['finals in a daily product', (m) => ({ ...m, product: 'prelim' }), /prelim holds no final days/],
			['finalThrough past the files', (m) => ({ ...m, finalThrough: '2024-07-01' }), /runs past the months the files hold contiguously \(through 2024-06-30\)/],
			['finalThrough over a gap', (m) => ({ ...m, files: [m.files[0]!, { ...m.files[0]!, url: monthUrl(2024, 8) }], finalThrough: '2024-08-31' }), /runs past.*through 2024-06-30/],
			['finalThrough with no files', (m) => ({ ...m, files: [] }), /runs past.*through none/],
			['a finals file naming no month', (m) => ({ ...m, files: [{ ...m.files[0]!, url: 'https://example.org/chirps.nc' }] }), /names no month/]
		];
		for (const [what, change, msg] of bad) {
			expect(() => parseManifest(change(sample())), what).toThrow(MirrorManifestError);
			expect(() => parseManifest(change(sample())), what).toThrow(msg);
		}
		// Positive control: the sample itself, a finalThrough short of the run's end or with a later month after a gap, and a daily product's shape.
		expect(() => parseManifest(sample())).not.toThrow();
		expect(() => parseManifest({ ...sample(), finalThrough: '2024-06-10' })).not.toThrow();
		expect(() => parseManifest({ ...sample(), files: [sample().files[0]!, { ...sample().files[0]!, url: monthUrl(2024, 8) }] })).not.toThrow();
		expect(() => parseManifest({ ...sample(), files: [], finalThrough: null })).not.toThrow();
		expect(() => parseManifest({ ...sample(), product: 'gefs/2026-10-27', finalThrough: null, prelimThrough: '2026-10-27', changes: [] })).not.toThrow();
	});

	it('refuses a manifest stored under another product, or not JSON', async () => {
		const store = openStore(pathToFileURL(dir).href);
		await store.set('/sat/manifest.json', new TextEncoder().encode(JSON.stringify(sample())));
		await expect(readManifest(store, 'sat')).rejects.toThrow(/at sat names product rnl/);
		await store.set('/prelim/manifest.json', new TextEncoder().encode('{'));
		await expect(readManifest(store, 'prelim')).rejects.toThrow(/not valid JSON/);
	});

	it('refuses to write an invalid manifest', async () => {
		const store = openStore(pathToFileURL(dir).href);
		await expect(writeManifest(store, { ...sample(), revision: -1 })).rejects.toThrow(MirrorManifestError);
	});
});

describe('manifestHash (valuesSha256)', () => {
	it('hashes float32 little-endian bytes in order, every NaN as 0x7FC00000', () => {
		const day = Float32Array.of(1.5, Number.NaN, 0, -0);
		new Uint32Array(day.buffer)[1] = 0xffc12345; // a NaN with sign and payload
		const bytes = Buffer.alloc(16);
		bytes.writeFloatLE(1.5, 0);
		bytes.writeUInt32LE(0x7fc00000, 4);
		bytes.writeFloatLE(0, 8);
		bytes.writeUInt32LE(0x80000000, 12);
		expect(manifestHash([day])).toBe(createHash('sha256').update(bytes).digest('hex'));
		// The days are concatenated: two days hash as one buffer of both.
		expect(manifestHash([day.subarray(0, 2), day.subarray(2)])).toBe(manifestHash([day]));
		// It never changes its input.
		expect(new Uint32Array(day.buffer)[1]).toBe(0xffc12345);
	});
});

describe('manifests per product (issue #604 R4-B; ingest/manifest.py holds the same rules)', () => {
	const tenth = { origin: { lat: -35.45, lon: 10.05 }, step: 0.1 };
	const imergUrl = (day: string, v = 'V07B') =>
		`https://gpm1.gesdisc.eosdis.nasa.gov/data/GPM_L3/GPM_3IMERGDL.07/${day.slice(0, 4)}/${day.slice(5, 7)}/3B-DAY-L.MS.MRG.3IMERG.${day.replaceAll('-', '')}-S000000-E235959.${v}.nc4`;
	const file = sample().files[0]!;
	const era5lUrl = (month: string) => `cds://reanalysis-era5-land/total_precipitation/${month}`;
	const era5l = (months = ['2024-06'], finalThrough: string | null = '2024-06-29'): Manifest => ({
		...sample(),
		product: 'era5l',
		grid: tenth,
		finalThrough,
		files: months.map((m) => ({ ...file, url: era5lUrl(m), etag: null, lastModified: null })),
		changes: []
	});
	const imerg = (days: string[], prelimThrough: string | null): Manifest => ({
		...sample(),
		product: 'imerg_late',
		grid: tenth,
		years: { first: 2024, last: 2024 },
		finalThrough: null,
		prelimThrough,
		files: days.map((d) => ({ ...file, url: imergUrl(d), version: 'V07' })),
		changes: []
	});
	const problem = (m: unknown) => {
		try {
			parseManifest(m);
			return null;
		} catch (e) {
			return (e as Error).message;
		}
	};

	it('takes each product on its own grid step, and refuses another', () => {
		expect(problem(era5l())).toBeNull();
		expect(problem({ ...era5l(), grid: { origin: { lat: -35.475, lon: 10.025 }, step: 0.05 } })).toMatch(/grid\.step must be 0.1° for era5l/);
		expect(problem({ ...sample(), grid: tenth })).toMatch(/grid\.step must be 0.05° for rnl/);
		// The origin follows the step: 0.1 with the 0.05° origin is refused too.
		expect(problem({ ...era5l(), grid: { origin: { lat: -35.475, lon: 10.025 }, step: 0.1 } })).toMatch(/grid origin/);
		expect(problem({ ...era5l(), product: 'era5' })).toMatch(/product/);
	});

	it('era5l holds finals only: no preliminary days, no month in its file names, no version', () => {
		expect(problem({ ...era5l(), prelimThrough: '2024-07-01' })).toMatch(/era5l has no preliminary days/);
		expect(problem({ ...era5l(), files: [{ ...era5l().files[0]!, version: 'V07' }] })).toMatch(/era5l's files carry no version/);
	});

	it('era5l: each file a CDS month request with no ETag or Last-Modified, finalThrough within the contiguous days the requests hold', () => {
		// Month M's request holds the last day of M−1 through the second-last day of M; the record starts on 1950-01-01.
		const month = (y: number, m: number) => y * 12 + m - 1;
		expect(era5lWrittenDays(month(2024, 3))).toEqual({ from: '2024-02-29', through: '2024-03-30' });
		expect(era5lWrittenDays(month(2025, 1))).toEqual({ from: '2024-12-31', through: '2025-01-30' });
		expect(era5lWrittenDays(month(1950, 1))).toEqual({ from: '1950-01-01', through: '1950-01-30' });
		const gap = era5l(['2024-01', '2024-02', '2024-04'], '2024-02-28');
		expect(era5lCoverage(gap.files)).toEqual({ from: '2023-12-31', through: '2024-02-28' });
		expect(problem(gap)).toBeNull();
		// The day month 03 would hold, and the end of the month past the gap.
		for (const past of ['2024-02-29', '2024-04-29']) expect(problem({ ...gap, finalThrough: past }), past).toMatch(/finalThrough runs past the days the files hold contiguously \(through 2024-02-28\)/);
		expect(problem(era5l([], '2024-06-01'))).toMatch(/through none/);
		for (const url of ['cds:reanalysis-era5-land/2024-06', 'cds://reanalysis-era5-land/2m_temperature/2024-06', `${era5lUrl('2024-13')}`, `${era5lUrl('2024-06')}.nc`, 'https://example.org/2024-06']) {
			const bad = era5l();
			bad.files[0]!.url = url;
			expect(problem(bad), url).toMatch(/not a month request/);
		}
		for (const k of ['etag', 'lastModified'] as const) {
			const bad = era5l();
			bad.files[0]![k] = '"x"';
			expect(problem(bad), k).toMatch(/the CDS gives neither/);
		}
	});

	it('imerg_late: a file a day naming its day, its version optional, prelimThrough no later than the newest file (a gap is fine)', () => {
		expect(problem(imerg(['2024-06-01', '2024-06-02', '2024-06-04'], '2024-06-02'))).toBeNull();
		// Each day stands on its own: prelimThrough past the gap, to the newest file, is what the ingest writes.
		expect(problem(imerg(['2024-06-01', '2024-06-02', '2024-06-04'], '2024-06-04'))).toBeNull();
		expect(problem(imerg(['2024-06-01', '2024-06-02', '2024-06-04'], '2024-06-05'))).toMatch(/prelimThrough runs past the newest day the files hold \(2024-06-04\)/);
		expect(problem(imerg([], '2024-06-01'))).toMatch(/\(none\)/);
		// The version is optional, but must be one when present: the collection's, with no minor letter.
		const noVersion = imerg(['2024-06-01'], '2024-06-01');
		delete noVersion.files[0]!.version;
		expect(problem(noVersion)).toBeNull();
		for (const v of ['7', 'V07B', 'v07']) {
			const bad = imerg(['2024-06-01'], '2024-06-01');
			bad.files[0]!.version = v;
			expect(problem(bad), v).toMatch(/IMERG version/);
		}
		const noDay = imerg(['2024-06-01'], null);
		noDay.files[0]!.url = 'https://example.org/imerg.nc4';
		expect(problem(noDay)).toMatch(/names no day/);
		// IMERG Late is never final.
		expect(problem({ ...imerg(['2024-06-01'], null), finalThrough: '2024-06-01' })).toMatch(/imerg_late holds no final days/);
		// Nothing held yet (or every day dropped): years null, as the ingest writes it.
		expect(problem({ ...imerg([], null), years: { first: null, last: null } })).toBeNull();
		expect(problem({ ...imerg([], '2024-06-01'), years: { first: null, last: null } })).toMatch(/outside years/);
		expect(problem({ ...imerg([], null), years: { first: 2024, last: null } })).toMatch(/years/);
	});

	it('reads each day’s IMERG version, and the days the files hold', () => {
		const m = imerg(['2024-06-02', '2024-06-01'], null);
		m.files[1]!.version = 'V08';
		expect(imergFileDay(imergUrl('2024-02-29'))).toBe('2024-02-29');
		expect(imergFileDay(imergUrl('2023-02-29'))).toBeNull();
		expect(imergCoverage(m.files)).toEqual({ from: '2024-06-01', through: '2024-06-02' });
		// Each day stands on its own: a gap is not held, the days after it still are, and coverage runs to the newest.
		const gapped = imerg(['2024-06-01', '2024-06-04'], '2024-06-04');
		expect([...imergHeldDays(gapped.files)].sort()).toEqual(['2024-06-01', '2024-06-04']);
		expect(imergCoverage(gapped.files)).toEqual({ from: '2024-06-01', through: '2024-06-04' });
		expect(Object.fromEntries(imergVersions(m))).toEqual({ '2024-06-01': 'V08', '2024-06-02': 'V07' });
	});

	it('the committed fixture copy’s 0.1° manifests are valid', async () => {
		const fixture = openStore(pathToFileURL(MIRROR_FIXTURE_DIR).href);
		const e = await readManifest(fixture, 'era5l');
		expect(e).toMatchObject({ grid: tenth, finalThrough: '2025-12-30', prelimThrough: null });
		expect(era5lCoverage(e!.files)).toEqual({ from: '2023-12-31', through: '2025-12-30' });
		const i = await readManifest(fixture, 'imerg_late');
		expect(i).toMatchObject({ grid: tenth, finalThrough: null, prelimThrough: '2026-02-08' });
		expect(imergVersions(i!).get('2026-02-08')).toBe('V08');
		expect(imergVersions(i!).get('2026-01-25')).toBe('V07');
	});
});
