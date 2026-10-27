import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
	ensureDaily,
	ensureFinals,
	MirrorFormatError,
	openDaily,
	openFinals,
	readDailyBlock,
	readFinalsBlock,
	writeDailyDays,
	writeFinalsYear
} from './arrays.js';
import { openStore } from './store.js';

const dirs: string[] = [];
const fresh = () => {
	const dir = mkdtempSync(join(tmpdir(), 'mirror-arrays-'));
	dirs.push(dir);
	return { dir, store: openStore(pathToFileURL(dir).href) };
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const bits = (f: Float32Array) => Array.from(new Uint32Array(f.buffer, f.byteOffset, f.length));

describe('the finals layout', () => {
	it('is created with the D2 metadata exactly', async () => {
		const { dir, store } = fresh();
		await ensureFinals(store, 'rnl', 2024);
		const meta = JSON.parse(readFileSync(join(dir, 'rnl/zarr.json'), 'utf8'));
		expect(meta).toEqual({
			zarr_format: 3,
			node_type: 'array',
			shape: [44, 366, 550, 620],
			data_type: 'float32',
			chunk_grid: { name: 'regular', configuration: { chunk_shape: [1, 366, 20, 20] } },
			chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
			codecs: [
				{ name: 'bytes', configuration: { endian: 'little' } },
				{ name: 'gzip', configuration: { level: 6 } }
			],
			fill_value: 'NaN',
			dimension_names: ['year', 'doy', 'lat', 'lon'],
			attributes: { firstYear: 1981, region: { w: 10, s: -35.5, e: 41, n: -8 }, grid: { origin: { lat: -35.475, lon: 10.025 }, step: 0.05 } }
		});
		// The root group exists: Zarr v3 has no implicit groups.
		expect(JSON.parse(readFileSync(join(dir, 'zarr.json'), 'utf8'))).toMatchObject({ zarr_format: 3, node_type: 'group' });
	});

	it('reads back what it wrote, bit for bit, across a chunk edge', async () => {
		const { store } = fresh();
		const f = await ensureFinals(store, 'sat', 2024);
		const block = { y0: 18, x0: 38, h: 4, w: 4 }; // spans chunks (0, 1)–(1, 2)
		const values = new Float32Array(366 * 16).map((_, i) => Math.fround(i / 7 + 0.1));
		// Values whose bits are easy to lose: a subnormal, the largest float32, a NaN payload.
		values[0] = 1e-45;
		values[1] = 3.4028234663852886e38;
		new Uint32Array(values.buffer)[2] = 0x7fc00001;
		await writeFinalsYear(f, 2024, block, values);
		const got = await readFinalsBlock(f, 2024, 0, 365, block);
		const want = bits(values);
		want[2] = bits(got.values)[2]!; // any NaN is NaN: the reader doesn't promise the payload
		expect(Number.isNaN(got.values[2])).toBe(true);
		expect(bits(got.values)).toEqual(want);
		// A sub-window of days and cells reads the same bits.
		const part = await readFinalsBlock(f, 2024, 100, 101, { y0: 19, x0: 39, h: 2, w: 1 });
		expect(bits(part.values)).toEqual(bits(Float32Array.of(values[100 * 16 + 5]!, values[100 * 16 + 9]!, values[101 * 16 + 5]!, values[101 * 16 + 9]!)));
	});

	it('reads an unwritten chunk, and a year outside the array, as NaN', async () => {
		const { store } = fresh();
		const f = await ensureFinals(store, 'rnl', 2024);
		await writeFinalsYear(f, 2024, { y0: 0, x0: 0, h: 1, w: 1 }, new Float32Array(366).fill(1));
		for (const [year, block] of [
			[2024, { y0: 300, x0: 300, h: 2, w: 2 }],
			[2023, { y0: 0, x0: 0, h: 1, w: 1 }],
			[1970, { y0: 0, x0: 0, h: 1, w: 1 }],
			[2030, { y0: 0, x0: 0, h: 1, w: 1 }]
		] as const) {
			const got = await readFinalsBlock(f, year, 0, 365, block);
			expect(got.values.every(Number.isNaN), `${year}`).toBe(true);
		}
		// Positive control: the written cell reads its value.
		expect((await readFinalsBlock(f, 2024, 0, 0, { y0: 0, x0: 0, h: 1, w: 1 })).values[0]).toBe(1);
	});

	it('grows the year axis without moving a chunk, and refuses a year past it', async () => {
		const { store } = fresh();
		let f = await ensureFinals(store, 'rnl', 2023);
		await writeFinalsYear(f, 2023, { y0: 0, x0: 0, h: 1, w: 1 }, new Float32Array(366).fill(2).fill(Number.NaN, 365));
		await expect(writeFinalsYear(f, 2024, { y0: 0, x0: 0, h: 1, w: 1 }, new Float32Array(366))).rejects.toThrow(RangeError);
		f = await ensureFinals(store, 'rnl', 2025);
		expect(f.arr.shape[0]).toBe(45);
		expect((await readFinalsBlock(f, 2023, 5, 5, { y0: 0, x0: 0, h: 1, w: 1 })).values[0]).toBe(2);
		// Ensuring an earlier year never shrinks it.
		expect((await ensureFinals(store, 'rnl', 2000)).arr.shape[0]).toBe(45);
	});

	it('keeps day-of-year index 365 NaN in a year with no 29 February', async () => {
		const { store } = fresh();
		const f = await ensureFinals(store, 'rnl', 2024);
		const one = { y0: 0, x0: 0, h: 1, w: 1 };
		await expect(writeFinalsYear(f, 2023, one, new Float32Array(366).fill(1))).rejects.toThrow(/2023 has no 29 February/);
		await writeFinalsYear(f, 2023, one, new Float32Array(366).fill(1).fill(Number.NaN, 365));
		const got = await readFinalsBlock(f, 2023, 364, 365, one);
		expect(got.values[0]).toBe(1);
		expect(got.values[1]).toBeNaN();
		// A leap year keeps its 31 December at 365.
		await writeFinalsYear(f, 2024, one, new Float32Array(366).fill(3));
		expect((await readFinalsBlock(f, 2024, 365, 365, one)).values[0]).toBe(3);
	});

	it('refuses an array that isn’t laid out as D2 says', async () => {
		const { dir, store } = fresh();
		await ensureFinals(store, 'rnl', 2024);
		const p = join(dir, 'rnl/zarr.json');
		const meta = JSON.parse(readFileSync(p, 'utf8'));
		meta.chunk_grid.configuration.chunk_shape = [1, 366, 10, 10];
		await store.set('/rnl/zarr.json', new TextEncoder().encode(JSON.stringify(meta)));
		await expect(openFinals(store, 'rnl')).rejects.toThrow(MirrorFormatError);
		expect(await openFinals(store, 'sat')).toBeNull();
	});
});

describe('the daily layout', () => {
	it('is created with the D2 metadata, under its parent group', async () => {
		const { dir, store } = fresh();
		await ensureDaily(store, 'gefs/2026-01-05', '2026-01-05', 16);
		const meta = JSON.parse(readFileSync(join(dir, 'gefs/2026-01-05/zarr.json'), 'utf8'));
		expect(meta).toMatchObject({
			shape: [16, 550, 620],
			data_type: 'float32',
			chunk_grid: { configuration: { chunk_shape: [1, 110, 124] } },
			fill_value: 'NaN',
			dimension_names: ['day', 'lat', 'lon'],
			attributes: { firstDay: '2026-01-05', region: { w: 10, s: -35.5, e: 41, n: -8 }, grid: { origin: { lat: -35.475, lon: 10.025 }, step: 0.05 } }
		});
		expect(JSON.parse(readFileSync(join(dir, 'gefs/zarr.json'), 'utf8'))).toMatchObject({ node_type: 'group' });
	});

	it('reads back what it wrote, bit for bit; unwritten days and days outside the array read NaN', async () => {
		const { store } = fresh();
		const d = await ensureDaily(store, 'prelim', '2026-01-01', 10);
		const block = { y0: 108, x0: 122, h: 4, w: 4 }; // across the (110, 124) chunk edges
		const values = new Float32Array(3 * 16).map((_, i) => Math.fround(i * 0.37));
		await writeDailyDays(d, 2, block, values);
		const got = await readDailyBlock(d, 1, 12, block);
		expect(got.values.subarray(0, 16).every(Number.isNaN)).toBe(true);
		expect(bits(got.values.subarray(16, 64))).toEqual(bits(values));
		expect(got.values.subarray(64).every(Number.isNaN)).toBe(true);
		expect((await readDailyBlock(d, -3, -1, block)).values.every(Number.isNaN)).toBe(true);
	});

	it('refuses to reopen an array from another first day', async () => {
		const { store } = fresh();
		await ensureDaily(store, 'prelim', '2026-01-01', 10);
		await expect(ensureDaily(store, 'prelim', '2026-01-02', 10)).rejects.toThrow(MirrorFormatError);
		expect((await ensureDaily(store, 'prelim', '2026-01-01', 20)).arr.shape[0]).toBe(20);
		expect((await openDaily(store, 'prelim'))!.firstDay).toBe('2026-01-01');
	});
});

describe('the 0.1° products’ layouts (issue #604 R4-B)', () => {
	it('makes era5l a finals array on the 0.1° grid from 1950, and imerg_late a daily one chunked (1, 55, 62)', async () => {
		const { dir, store } = fresh();
		const f = await ensureFinals(store, 'era5l', 2025);
		expect(f.firstYear).toBe(1950);
		expect(f.grid).toEqual({ origin: { lat: -35.45, lon: 10.05 }, step: 0.1 });
		const fm = JSON.parse(readFileSync(join(dir, 'era5l/zarr.json'), 'utf8'));
		expect(fm.shape).toEqual([76, 366, 275, 310]);
		expect(fm.chunk_grid.configuration.chunk_shape).toEqual([1, 366, 20, 20]);
		const d = await ensureDaily(store, 'imerg_late', '2026-01-01', 3);
		expect(d.grid.step).toBe(0.1);
		const dm = JSON.parse(readFileSync(join(dir, 'imerg_late/zarr.json'), 'utf8'));
		expect(dm.shape).toEqual([3, 275, 310]);
		expect(dm.chunk_grid.configuration.chunk_shape).toEqual([1, 55, 62]);
		// Written and read back on its own grid, the corner cells too.
		const block = { y0: 274, x0: 309, h: 1, w: 1 };
		await writeDailyDays(d, 2, block, Float32Array.of(1.5));
		expect(Array.from((await readDailyBlock(d, 2, 2, block)).values)).toEqual([1.5]);
		await expect(writeDailyDays(d, 0, { y0: 275, x0: 0, h: 1, w: 1 }, Float32Array.of(1))).rejects.toThrow(RangeError);
	});

	it('refuses an array of one product laid out on another’s grid', async () => {
		const { dir, store } = fresh();
		// A 0.05° daily array where imerg_late's should be: its grid, chunks and shape are CHC's.
		await ensureDaily(store, 'prelim', '2026-01-01', 2);
		const src = readFileSync(join(dir, 'prelim/zarr.json'), 'utf8');
		await store.set('/imerg_late/zarr.json', new TextEncoder().encode(src));
		await expect(openDaily(store, 'imerg_late')).rejects.toThrow(MirrorFormatError);
		// Positive control: the same array as prelim opens.
		expect(await openDaily(store, 'prelim')).not.toBeNull();
	});
});
