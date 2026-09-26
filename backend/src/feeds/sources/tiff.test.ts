import { describe, expect, it } from 'vitest';
import { FeedFormatError } from '../errors.js';
import { lzwDecode, openGrid, pixelOf, readPoints, type RangeRead } from './tiff.js';
import { lzwEncode, writeGrid, type GridSpec } from './tiff-write.js';

/** A RangeRead over bytes in memory, counting reads. */
function reader(bytes: Uint8Array | null) {
	const r = {
		reads: 0,
		read: (async (start: number, end: number) => {
			r.reads++;
			return bytes ? bytes.subarray(start, end + 1) : null;
		}) as RangeRead
	};
	return r;
}

// A 0.05° grid like the fixture's: 8 x 6 cells from (25.00 E, 20.00 S).
const spec = (over: Partial<GridSpec> = {}): GridSpec => {
	const width = 8;
	const height = 6;
	const values = Array.from({ length: width * height }, (_, i) => Math.floor(i / width) * 10 + (i % width) + 0.5);
	return { width, height, originLon: 25, originLat: -20, scale: 0.05, values, ...over };
};

describe('TIFF LZW', () => {
	it('round-trips short, repetitive and long random data (past the 9→10→11→12-bit steps and a table reset)', () => {
		let seed = 7;
		const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) >> 8) & 0xff;
		const cases = [
			new Uint8Array(0),
			Uint8Array.of(42),
			new Uint8Array(5000).fill(0),
			Uint8Array.from({ length: 3000 }, (_, i) => i % 7),
			Uint8Array.from({ length: 40_000 }, rnd)
		];
		for (const data of cases) expect(lzwDecode(lzwEncode(data), data.length)).toEqual(data);
	});

	it('decodes a known TIFF 6.0 sequence (Clear, literals, a KwKwK code, End)', () => {
		// "ABABABA": Clear, A, B, 258 (AB), 260 (ABA, the code being defined), End; 9-bit codes.
		const codes = [256, 65, 66, 258, 260, 257];
		let bits = '';
		for (const c of codes) bits += c.toString(2).padStart(9, '0');
		bits = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
		const bytes = Uint8Array.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
		expect(new TextDecoder().decode(lzwDecode(bytes, 7))).toBe('ABABABA');
	});

	it('refuses a code that is not in the table yet', () => {
		const bits = [256, 65, 300].map((c) => c.toString(2).padStart(9, '0')).join('').padEnd(32, '0');
		const bytes = Uint8Array.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
		expect(() => lzwDecode(bytes, 10)).toThrow(FeedFormatError);
	});

	it('stops at the expected length, and returns short when the input runs out', () => {
		const data = Uint8Array.from({ length: 100 }, (_, i) => i);
		expect(lzwDecode(lzwEncode(data), 40)).toEqual(data.subarray(0, 40));
		expect(lzwDecode(lzwEncode(data).subarray(0, 20), 100).length).toBeLessThan(100);
	});
});

describe('openGrid + readPoints', () => {
	it('reads the grid geometry and the pixels at points, with range reads only (header, IFD, one strip per row)', async () => {
		const r = reader(writeGrid(spec()));
		const grid = (await openGrid(r.read))!;
		expect(grid).toMatchObject({ width: 8, height: 6, rowsPerStrip: 1, compression: 5, originLon: 25, originLat: -20, scaleLon: 0.05, scaleLat: 0.05 });
		const reads = r.reads;
		// Row 0 col 0; row 2 col 3; row 5 col 7 (the far corner).
		const v = await readPoints(r.read, grid, [
			{ lat: -20.01, lon: 25.01 },
			{ lat: -20.12, lon: 25.17 },
			{ lat: -20.29, lon: 25.39 },
			{ lat: -20.02, lon: 25.04 }
		]);
		expect(v).toEqual([0.5, 23.5, 57.5, 0.5]);
		// One read per distinct row (0, 2, 5): the strip table came with the IFD block. No whole-file read.
		expect(r.reads - reads).toBe(3);
		expect(reads).toBe(2); // the header, then the IFD with its arrays
	});

	it('snaps a float32-rounded pixel scale (0.05000000074505806) so far columns land in the right pixel', async () => {
		const width = 7200;
		const g = { width, height: 1, originLon: -180, originLat: 60, scaleLon: Number((0.05000000074505806).toPrecision(7)), scaleLat: 0.05 };
		// 37.0 E is column 4340 exactly; the unsnapped scale would put it in 4339.
		expect(pixelOf(g, 59.99, 37.0)).toEqual({ row: 0, col: 4340 });
		const r = reader(writeGrid({ ...spec(), width: 20, height: 1, originLon: -180, originLat: 60, values: new Array(20).fill(1) }));
		expect((await openGrid(r.read))!.scaleLon).toBe(0.05);
	});

	it('puts a point on a pixel edge in the pixel east / south of it, and refuses one outside the grid', async () => {
		const r = reader(writeGrid(spec()));
		const grid = (await openGrid(r.read))!;
		expect(pixelOf(grid, -20.05, 25.05)).toEqual({ row: 1, col: 1 });
		expect(pixelOf(grid, -19.99, 25.1)).toBeNull();
		expect(pixelOf(grid, -20.1, 25.4)).toBeNull();
		await expect(readPoints(r.read, grid, [{ lat: -21, lon: 25.1 }])).rejects.toThrow(/outside the grid/);
	});

	it('reads -9999, NaN and the GDAL_NODATA value as no data', async () => {
		const values = spec().values.slice() as number[];
		values[0] = -9999;
		values[1] = NaN;
		values[2] = 12.25;
		const r = reader(writeGrid(spec({ values, nodata: '12.25' })));
		const grid = (await openGrid(r.read))!;
		expect(grid.nodata).toBe(12.25);
		expect(await readPoints(r.read, grid, [0, 1, 2, 3].map((c) => ({ lat: -20.01, lon: 25.01 + c * 0.05 })))).toEqual([null, null, null, 3.5]);
	});

	it('reads an uncompressed grid too', async () => {
		const r = reader(writeGrid(spec({ compression: 1 })));
		const grid = (await openGrid(r.read))!;
		expect(await readPoints(r.read, grid, [{ lat: -20.12, lon: 25.17 }])).toEqual([23.5]);
	});

	it('reads a big-endian ("MM") grid in its own byte order, samples included', async () => {
		for (const compression of [1, 5] as const) {
			const r = reader(writeGrid(spec({ bigEndian: true, compression })));
			const grid = (await openGrid(r.read))!;
			expect(grid).toMatchObject({ width: 8, height: 6, originLon: 25, originLat: -20, littleEndian: false });
			expect(await readPoints(r.read, grid, [{ lat: -20.12, lon: 25.17 }, { lat: -20.29, lon: 25.39 }])).toEqual([23.5, 57.5]);
		}
	});

	it('reads several rows per strip, including a shorter last strip', async () => {
		// 6 rows in strips of 4: rows 0–3, then 4–5.
		const r = reader(writeGrid(spec({ rowsPerStrip: 4 })));
		const grid = (await openGrid(r.read))!;
		expect(grid.rowsPerStrip).toBe(4);
		const reads = r.reads;
		const v = await readPoints(r.read, grid, [
			{ lat: -20.01, lon: 25.01 }, // row 0, col 0
			{ lat: -20.17, lon: 25.37 }, // row 3, col 7: the end of strip 0
			{ lat: -20.21, lon: 25.01 }, // row 4, col 0: the start of strip 1
			{ lat: -20.29, lon: 25.39 } // row 5, col 7: the last pixel
		]);
		expect(v).toEqual([0.5, 37.5, 40.5, 57.5]);
		expect(r.reads - reads).toBe(2); // one read per strip, not per row
	});

	it('returns null for a file that is not published (404)', async () => {
		expect(await openGrid(reader(null).read)).toBeNull();
	});

	describe('refuses what it does not understand, with a FeedFormatError', () => {
		const good = writeGrid(spec());
		const cases: [string, Uint8Array, RegExp][] = [
			['an HTML error page', new TextEncoder().encode('<html><body>Service unavailable</body></html>'), /not a TIFF/],
			['a file shorter than a header', Uint8Array.of(0x49, 0x49, 42), /shorter than a TIFF header/],
			['BigTIFF', Uint8Array.of(0x49, 0x49, 43, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), /BigTIFF/],
			['a tiled grid', writeGrid(spec({ override: { 322: [3, [256]] } })), /tiled/],
			['a predictor', writeGrid(spec({ override: { 317: [3, [3]] } })), /predictor/],
			['16-bit integers', writeGrid(spec({ override: { 258: [3, [16]], 339: [3, [1]] } })), /32-bit floating point/],
			['several bands', writeGrid(spec({ override: { 277: [3, [3]] } })), /more than one band/],
			['another compression', writeGrid(spec({ override: { 259: [3, [8]] } })), /compression 8/],
			['no georeferencing', writeGrid(spec({ override: { 33922: null } })), /georeferencing/],
			// A header claiming 100 000-pixel rows: refused before the decode buffer is allocated.
			['a strip that would decode too large', writeGrid(spec({ override: { 256: [4, [100_000]], 278: [3, [6]] } })), /decode to an implausible size/],
			['a short strip table',writeGrid(spec({ override: { 273: [4, [8, 9]] } })), /strip table/],
			['an IFD past the end of the file', good.subarray(0, 60), /ends before its image directory|truncated/]
		];
		it.each(cases)('%s', async (_, bytes, message) => {
			const r = reader(bytes);
			const open = async () => {
				const g = await openGrid(r.read);
				await readPoints(r.read, g!, [{ lat: -20.12, lon: 25.17 }]);
			};
			await expect(open()).rejects.toThrow(FeedFormatError);
			await expect(open()).rejects.toThrow(message);
		});

		it('a strip cut short, or corrupt', async () => {
			const g = (await openGrid(reader(good).read))!;
			const { offset, bytes } = await g.strip(2);
			const cut = good.slice();
			// The strip table still says `bytes`, but the file ends early.
			const truncated = cut.subarray(0, offset + Math.floor(bytes / 2));
			await expect(readPoints(reader(truncated).read, g, [{ lat: -20.12, lon: 25.17 }])).rejects.toThrow(/ends inside a strip/);
			const corrupt = good.slice();
			corrupt.fill(0xff, offset, offset + bytes);
			await expect(readPoints(reader(corrupt).read, g, [{ lat: -20.12, lon: 25.17 }])).rejects.toThrow(FeedFormatError);
		});
	});
});
