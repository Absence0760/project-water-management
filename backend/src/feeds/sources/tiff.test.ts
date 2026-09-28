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
		expect(pixelOf(grid, -20.1, 25.41)).toBeNull();
		expect(pixelOf(grid, -20.31, 25.1)).toBeNull();
		await expect(readPoints(r.read, grid, [{ lat: -21, lon: 25.1 }])).rejects.toThrow(/outside the grid/);
		// Not a number is nowhere, not pixel (NaN, NaN).
		expect(pixelOf(grid, Number.NaN, 25.1)).toBeNull();
		expect(pixelOf(grid, -20.1, Number.NaN)).toBeNull();
		await expect(readPoints(r.read, grid, [{ lat: Number.NaN, lon: 25.1 }])).rejects.toThrow(/outside the grid/);
	});

	it('puts a point on the grid’s own east or south edge in the edge pixel, as there is none beyond it', async () => {
		const r = reader(writeGrid(spec()));
		const grid = (await openGrid(r.read))!;
		expect(pixelOf(grid, -20.1, 25.4)).toEqual({ row: 2, col: 7 });
		expect(pixelOf(grid, -20.3, 25.1)).toEqual({ row: 5, col: 2 });
		expect(await readPoints(r.read, grid, [{ lat: -20.3, lon: 25.4 }])).toEqual([57.5]);
		// The CHC grid: config accepts latitudes -60…60 and longitudes -180…180 (feeds/config.ts), so all four corners read.
		const chc = { width: 7200, height: 2400, originLon: -180, originLat: 60, scaleLon: 0.05, scaleLat: 0.05 };
		expect(pixelOf(chc, 60, -180)).toEqual({ row: 0, col: 0 });
		expect(pixelOf(chc, -60, 180)).toEqual({ row: 2399, col: 7199 });
		expect(pixelOf(chc, 60, 180)).toEqual({ row: 0, col: 7199 });
		expect(pixelOf(chc, -60, -180)).toEqual({ row: 2399, col: 0 });
		expect(pixelOf(chc, -60.001, 0)).toBeNull();
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

	it('matches a GDAL_NODATA the float32 samples cannot hold exactly (0.1 is stored as 0.100000001…)', async () => {
		const values = spec().values.slice() as number[];
		values[0] = 0.1;
		const r = reader(writeGrid(spec({ values, nodata: '0.1' })));
		const grid = (await openGrid(r.read))!;
		expect(await readPoints(r.read, grid, [{ lat: -20.01, lon: 25.01 }, { lat: -20.01, lon: 25.06 }])).toEqual([null, 1.5]);
	});

	describe('GDAL scale / offset (GDAL_METADATA): a sample that means something else is refused, not read raw', () => {
		const meta = (items: string) => {
			const xml = `<GDALMetadata>${items}</GDALMetadata>\0`;
			return { 42112: [2, [...new TextEncoder().encode(xml)]] as [number, number[]] };
		};
		it('reads a grid whose metadata has no scale / offset, or the identity', async () => {
			for (const items of ['<Item name="units">mm</Item>', '<Item name="SCALE" sample="0" role="scale">1</Item><Item name="OFFSET" sample="0" role="offset">0</Item>']) {
				const r = reader(writeGrid(spec({ override: meta(items) })));
				const grid = (await openGrid(r.read))!;
				expect(await readPoints(r.read, grid, [{ lat: -20.12, lon: 25.17 }])).toEqual([23.5]);
			}
		});
		it.each([
			['a scale', '<Item name="SCALE" sample="0" role="scale">0.1</Item>'],
			['an offset', '<Item name="OFFSET" sample="0" role="offset">-5</Item>'],
			['an unreadable scale', '<Item name="SCALE" sample="0" role="scale">x</Item>']
		])('refuses %s', async (_, items) => {
			await expect(openGrid(reader(writeGrid(spec({ override: meta(items) }))).read)).rejects.toThrow(/scale or offset/);
		});
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

	describe('the GeoKey directory (GeoTIFF 1.0 § 2.4, § 6.3)', () => {
		// [version 1, revision 1.0, key count], then [key, location 0 (inline), count 1, value] per key.
		const geoKeys = (keys: Record<number, number>) => {
			const ids = Object.keys(keys).map(Number);
			return [1, 1, 0, ids.length, ...ids.flatMap((k) => [k, 0, 1, keys[k]!])];
		};
		const CHC = { 1024: 2, 1025: 1, 2048: 4326, 2054: 9102 };

		it('PixelIsPoint: the tiepoint names a pixel centre, so the grid starts half a pixel west / north of it', async () => {
			const r = reader(
				writeGrid(spec({ override: { 33922: [12, [0, 0, 0, 25.025, -20.025, 0]], 34735: [3, geoKeys({ ...CHC, 1025: 2 })] } }))
			);
			const grid = (await openGrid(r.read))!;
			expect(grid.originLon).toBeCloseTo(25, 12);
			expect(grid.originLat).toBeCloseTo(-20, 12);
			expect(await readPoints(r.read, grid, [{ lat: -20.12, lon: 25.17 }])).toEqual([23.5]);
		});

		it('a tiepoint at another raster position than (0, 0) still places pixel (0, 0)', async () => {
			// Raster (2, 1) is at 25.10 E, 20.05 S, so the grid's corner is at 25.00 E, 20.00 S.
			const r = reader(writeGrid(spec({ override: { 33922: [12, [2, 1, 0, 25.1, -20.05, 0]] } })));
			const grid = (await openGrid(r.read))!;
			expect(grid.originLon).toBeCloseTo(25, 12);
			expect(grid.originLat).toBeCloseTo(-20, 12);
			expect(await readPoints(r.read, grid, [{ lat: -20.12, lon: 25.17 }])).toEqual([23.5]);
		});

		it('PixelIsArea, or no raster type (the GeoTIFF default), reads the tiepoint as the corner', async () => {
			for (const keys of [CHC, { 1024: 2, 2048: 4326 }]) {
				const grid = (await openGrid(reader(writeGrid(spec({ override: { 34735: [3, geoKeys(keys)] } }))).read))!;
				expect([grid.originLon, grid.originLat]).toEqual([25, -20]);
			}
		});

		const refused: [string, Record<number, [number, number[]] | null>, RegExp][] = [
			['no GeoKey directory', { 34735: null }, /coordinate system/],
			['a projected CRS (UTM metres read as degrees)', { 34735: [3, geoKeys({ 1024: 1, 1025: 1, 3072: 32735 })] }, /not in geographic/],
			['a geographic CRS other than WGS 84', { 34735: [3, geoKeys({ ...CHC, 2048: 4807 })] }, /WGS 84/],
			['angles in grads', { 34735: [3, geoKeys({ ...CHC, 2054: 9105 })] }, /degrees/],
			['an unknown raster type', { 34735: [3, geoKeys({ ...CHC, 1025: 7 })] }, /raster type/],
			['a truncated directory', { 34735: [3, [1, 1, 0, 4, 1024, 0, 1, 2]] }, /GeoKey directory/]
		];
		it.each(refused)('refuses %s', async (_, override, message) => {
			await expect(openGrid(reader(writeGrid(spec({ override }))).read)).rejects.toThrow(message);
		});
	});

	it('reads a strip table that lies past the first 64 KB image-directory read, with reads of its own', async () => {
		// 20 000 one-pixel rows: the 80 KB offsets array runs past the IFD block, the byte counts wholly after it.
		const height = 20_000;
		const bytes = writeGrid({ width: 1, height, originLon: 25, originLat: -20, scale: 0.05, values: Array.from({ length: height }, (_, i) => i % 1000) });
		const r = reader(bytes);
		const grid = (await openGrid(r.read))!;
		expect(grid.height).toBe(height);
		const at = (row: number) => ({ lat: -20 - (row + 0.5) * 0.05, lon: 25.025 });
		expect(await readPoints(r.read, grid, [at(0), at(12_345), at(height - 1)])).toEqual([0, 345, 999]);
		// A byte-count read that comes back short is refused, not read as a zero-length strip.
		const dv = new DataView(bytes.buffer, bytes.byteOffset);
		const ifd = dv.getUint32(4, true);
		const entry = Array.from({ length: dv.getUint16(ifd, true) }, (_, i) => ifd + 2 + i * 12).find((p) => dv.getUint16(p, true) === 279)!;
		const countsAt = dv.getUint32(entry + 8, true);
		expect(countsAt).toBeGreaterThan(ifd + 64 * 1024);
		const short: RangeRead = async (start, end) => bytes.subarray(start, start >= countsAt && start < countsAt + height * 4 ? start + 1 : end + 1);
		const g2 = (await openGrid(short))!;
		await expect(readPoints(short, g2, [at(height - 1)])).rejects.toThrow(/ends inside its image directory/);
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
			// FillOrder 2 reverses the bits of every byte, which LZW would then misread.
			['a reversed bit fill order', writeGrid(spec({ override: { 266: [3, [2]] } })), /fill order/],
			['no georeferencing', writeGrid(spec({ override: { 33922: null } })), /georeferencing/],
			// A header claiming 100 000-pixel rows: refused before the decode buffer is allocated.
			['a strip that would decode too large', writeGrid(spec({ override: { 256: [4, [100_000]], 278: [3, [6]] } })), /decode to an implausible size/],
			['a short strip table',writeGrid(spec({ override: { 273: [4, [8, 9]] } })), /strip table/],
			// Upper bounds on what a hostile header can make the reader request or allocate
			// (docs/security.md § Outbound fetches). Each is checked before the read it bounds.
			['no pixels across', writeGrid(spec({ override: { 256: [3, [0]] } })), /implausible dimensions/],
			['a grid wider than 100 000 pixels', writeGrid(spec({ override: { 256: [4, [100_001]] } })), /implausible dimensions/],
			['a grid taller than 100 000 pixels', writeGrid(spec({ override: { 257: [4, [100_001]] } })), /implausible dimensions/],
			['a strip over 8 MB', writeGrid(spec({ override: { 279: [4, Array(6).fill(8 * 1024 * 1024 + 1)] } })), /strip of the grid has an implausible size/],
			['GDAL metadata over 1 MB', writeGrid(spec({ override: { 42112: [2, Array(1024 * 1024 + 1).fill(0x20)] } })), /GDAL metadata is implausibly large/],
			[
				'a GeoKey directory over 4096 entries',
				writeGrid(spec({ override: { 34735: [3, [1, 1, 0, 4, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326, 2054, 0, 1, 9102, ...Array(4097 - 20).fill(0)]] } })),
				/does not say its coordinate system/
			],
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
