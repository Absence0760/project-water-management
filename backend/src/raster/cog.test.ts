import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { FeedFormatError } from '../feeds/errors.js';
import { bboxWindow, decodeTile, isNodata, isUtmEpsg, openCog, parseNodata, readWindow, type CogAccept, type RangeRead, type Samples } from './cog.js';
import { writeCog, type CogSpec } from './cogWrite.js';

/** A RangeRead over bytes, recording each request. */
function reader(bytes: Uint8Array | null) {
	const calls: [number, number][] = [];
	const read: RangeRead = async (start, end) => {
		calls.push([start, end]);
		return bytes ? bytes.subarray(start, end + 1) : null;
	};
	return { read, calls };
}

/** A deterministic pattern with every byte value, so the predictor's wrap-around is exercised. */
function pattern(width: number, height: number): Uint8Array {
	const v = new Uint8Array(width * height);
	for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) v[r * width + c] = (r * 37 + c * 11 + ((r * c) % 7)) & 0xff;
	return v;
}

const BASE: Omit<CogSpec, 'values'> = { width: 70, height: 50, epsg: 32634, originX: 297_885, originY: -3_713_985, tile: 32 };
const spec = (over: Partial<CogSpec> = {}): CogSpec => ({ ...BASE, values: pattern(over.width ?? BASE.width, over.height ?? BASE.height), ...over });

async function roundTrip(s: CogSpec) {
	const { read } = reader(writeCog(s));
	const cog = (await openCog(read))!;
	const all = await readWindow(read, cog, { col0: 0, row0: 0, col1: s.width - 1, row1: s.height - 1 });
	return { cog, all };
}

describe('openCog / readWindow', () => {
	it('round-trips the WOfS layout: deflate, predictor 2, edge tiles padded', async () => {
		const s = spec();
		const { cog, all } = await roundTrip(s);
		expect(cog).toMatchObject({
			width: 70,
			height: 50,
			tileWidth: 32,
			tilesAcross: 3,
			tilesDown: 2,
			compression: 8,
			predictor: 2,
			epsg: 32634,
			originX: 297_885,
			originY: -3_713_985,
			pixelSizeX: 30,
			pixelSizeY: 30,
			nodata: 1,
			littleEndian: true
		});
		expect(all).toEqual(s.values);
	});

	it.each([
		['no compression', { compression: 1 as const }],
		['no predictor', { predictor: 1 as const }],
		['big-endian', { bigEndian: true }],
		['512-pixel tiles', { tile: 512 }],
		['a south-zone code', { epsg: 32734, originY: 6_286_015 }]
	])('reads %s', async (_label, over) => {
		const s = spec(over);
		const { cog, all } = await roundTrip(s);
		expect(all).toEqual(s.values);
		expect(cog.epsg).toBe(s.epsg);
		expect(cog.originY).toBe(s.originY);
	});

	it('reads PixelIsPoint as the corner half a pixel north-west of the tiepoint', async () => {
		const { cog } = await roundTrip(spec({ pixelIsPoint: true }));
		expect(cog.originX).toBe(297_885);
		expect(cog.originY).toBe(-3_713_985);
	});

	it('reads only the tiles a window touches, a tile row as one range', async () => {
		const s = spec({ width: 160, height: 96 }); // 5 × 3 tiles of 32
		const bytes = writeCog(s);
		const { read, calls } = reader(bytes);
		const cog = (await openCog(read))!;
		const headerCalls = calls.length;
		// Columns 40–100 (tiles 1–3), rows 33–40 (tile row 1).
		const win = await readWindow(read, cog, { col0: 40, row0: 33, col1: 100, row1: 40 });
		for (let r = 33; r <= 40; r++) for (let c = 40; c <= 100; c++) expect(win[(r - 33) * 61 + (c - 40)]).toBe(s.values[r * 160 + c]);
		// One request: tiles 6, 7 and 8 sit back to back.
		expect(calls.length - headerCalls).toBe(1);
		const [start, end] = calls.at(-1)!;
		const t6 = await cog.tile(6);
		const t8 = await cog.tile(8);
		expect(start).toBe(t6.offset);
		expect(end).toBe(t8.offset + t8.bytes - 1);
	});

	it('reads an empty (sparse) tile as no-data', async () => {
		const s = spec({ sparse: [1] });
		const { all } = await roundTrip(s);
		for (let r = 0; r < 32; r++) {
			for (let c = 0; c < 70; c++) {
				expect(all[r * 70 + c]).toBe(c >= 32 && c < 64 ? 1 : s.values[r * 70 + c]);
			}
		}
	});

	it('answers null for a missing scene', async () => {
		expect(await openCog(reader(null).read)).toBeNull();
	});

	it('refuses a window outside the scene', async () => {
		const { read } = reader(writeCog(spec()));
		const cog = (await openCog(read))!;
		await expect(readWindow(read, cog, { col0: 0, row0: 0, col1: 70, row1: 1 })).rejects.toThrow(RangeError);
		await expect(readWindow(read, cog, { col0: 5, row0: 0, col1: 4, row1: 1 })).rejects.toThrow(RangeError);
	});
});

describe('refusals', () => {
	const refuses = async (bytes: Uint8Array, message: RegExp, accept?: CogAccept) => {
		const { read } = reader(bytes);
		const err = await (async () => {
			const cog = await openCog(read, accept);
			await readWindow(read, cog!, { col0: 0, row0: 0, col1: 69, row1: 49 });
		})().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(FeedFormatError);
		expect((err as Error).message).toMatch(message);
	};

	it('refuses a BigTIFF header with another offset size', async () => {
		const b = writeCog(spec({ bigTiff: true }));
		new DataView(b.buffer).setUint16(4, 4, true);
		await refuses(b, /BigTIFF header/);
	});
	it('refuses a file that is not a TIFF', async () => {
		await refuses(new TextEncoder().encode('<html>not found</html>'), /not a TIFF/);
	});
	it('refuses a striped file', async () => {
		await refuses(writeCog(spec({ override: { 322: null, 323: null, 273: [4, [8]] } })), /striped/);
	});
	it.each([
		['12-bit samples', { 258: [3, [12]] }, /not uint8, int16, uint16 or float32/],
		['signed 8-bit samples', { 339: [3, [2]] }, /not uint8, int16, uint16 or float32/],
		['64-bit float samples', { 258: [3, [64]], 339: [3, [3]] }, /not uint8, int16, uint16 or float32/],
		['two bands', { 277: [3, [2]] }, /more than one band/],
		['JPEG', { 259: [3, [7]] }, /compression 7/],
		['predictor 4', { 317: [3, [4]] }, /predictor 4/],
		['the float predictor on integers', { 317: [3, [3]] }, /floating-point predictor on integer/],
		['a reversed fill order', { 266: [3, [2]] }, /fill order/],
		['a rotation matrix', { 34264: [12, [30, 0, 0, 0, 0, -30, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]] }, /transformation matrix/],
		['no pixel scale', { 33550: null }, /georeferencing/],
		['no GeoKeys', { 34735: null }, /coordinate system/],
		['odd tile sides', { 322: [3, [30]] }, /implausible tiles/],
		['a short tile table', { 325: [4, [1, 2]] }, /tile table/],
		['a GDAL scale', { 42112: [2, [...new TextEncoder().encode('<GDALMetadata><Item name="SCALE" sample="0" role="scale">0.5</Item></GDALMetadata>\0')]] }, /scale or offset/]
	] as const)('refuses %s', async (_l, override, message) => {
		await refuses(writeCog(spec({ override: override as CogSpec['override'] })), message);
	});
	it.each([
		['another geographic CRS', { 1024: 2, 2048: 4269 }, /geographic coordinate system is not WGS 84 \(EPSG 4269/],
		['a geographic CRS with no code', { 1024: 2 }, /EPSG unset/],
		['an unknown model type', { 1024: 3 }, /neither in projected nor in geographic/],
		['another projected CRS', { 3072: 2048 }, /not WGS 84 \/ UTM/],
		['feet', { 3076: 9002 }, /not metres/],
		['no projected CRS', { 3072: null }, /EPSG unset/]
	] as const)('refuses %s', async (_l, geoKeys, message) => {
		await refuses(writeCog(spec({ geoKeys })), message);
	});
	it('refuses a tile that inflates past its size, or not at all, or is short', async () => {
		const cog = { tileWidth: 16, tileHeight: 16, compression: 8 as const, predictor: 1 as const, sampleType: 'uint8' as const, littleEndian: true };
		expect(() => decodeTile(cog, deflateSync(new Uint8Array(16 * 16 * 4)))).toThrow(/inflates past/);
		expect(() => decodeTile(cog, Uint8Array.of(1, 2, 3))).toThrow(/does not inflate/);
		expect(() => decodeTile(cog, deflateSync(new Uint8Array(10)))).toThrow(/truncated/);
	});
	it('refuses a file cut inside a tile', async () => {
		const b = writeCog(spec());
		await refuses(b.subarray(0, b.length - 10), /ends inside a tile/);
	});
});

describe('refusals a caller asks for (CogAccept)', () => {
	const read = async (bytes: Uint8Array, accept: CogAccept) => openCog(reader(bytes).read, accept).catch((e: unknown) => e);
	const WOFS: CogAccept = { sampleTypes: ['uint8'], crs: ['utm'] };

	it('refuses another sample type than the caller reads', async () => {
		const err = await read(writeCog(spec({ values: typed('int16', 70, 50) })), WOFS);
		expect(err).toBeInstanceOf(FeedFormatError);
		expect((err as Error).message).toMatch(/samples are int16, not uint8/);
	});
	it('refuses a geographic scene to a UTM caller, and a UTM one to a geographic caller', async () => {
		const err = await read(writeCog(geoSpec({ values: typed('uint8', 70, 50), nodata: '1' })), WOFS);
		expect((err as Error).message).toMatch(/geographic coordinates, not projected/);
		const err2 = await read(writeCog(spec()), { crs: ['geographic'] });
		expect((err2 as Error).message).toMatch(/projected coordinates, not geographic/);
	});
	it('reads a GDAL scale and offset only when the caller accepts them', async () => {
		const bytes = writeCog(spec({ values: typed('int16', 70, 50), scaleOffset: { scale: 0.1, offset: 0 } }));
		expect(((await read(bytes, {})) as Error).message).toMatch(/scale or offset/);
		expect(await read(bytes, { scaleOffset: true })).toMatchObject({ scale: 0.1, offset: 0 });
		// No scale given: identity, whatever the caller accepts.
		expect(await read(writeCog(spec()), { scaleOffset: true })).toMatchObject({ scale: 1, offset: 0 });
	});
	it('refuses a GDAL scale that is not a number, even when accepted', async () => {
		const bytes = writeCog(spec({ scaleOffset: { scale: Number.NaN, offset: 0 } }));
		expect(((await read(bytes, { scaleOffset: true })) as Error).message).toMatch(/not a number/);
	});
	it('refuses the horizontal predictor on floats, and old-style LZW', async () => {
		const f = await read(writeCog(spec({ values: typed('float32', 70, 50), predictor: 1, override: { 317: [3, [2]] } })), {});
		expect((f as Error).message).toMatch(/horizontal predictor on float/);
		const cog = { tileWidth: 16, tileHeight: 16, compression: 5 as const, predictor: 1 as const, sampleType: 'uint8' as const, littleEndian: true };
		expect(() => decodeTile(cog, Uint8Array.of(0, 1, 2, 3))).toThrow(/old-style LZW/);
		expect(() => decodeTile(cog, Uint8Array.of(0xff, 0xff, 0xff))).toThrow(FeedFormatError);
	});
	it('refuses a geographic grid of implausible degrees, and radians', async () => {
		expect(((await read(writeCog(geoSpec({ originY: 120 })), {})) as Error).message).toMatch(/georeferencing/);
		expect(((await read(writeCog(geoSpec({ geoKeys: { 2054: 9101 } })), {})) as Error).message).toMatch(/not degrees/);
	});
});

/** Deterministic samples of a type, covering its range (negatives, the top of uint16, float fractions, NaN). */
function typed(type: 'int16' | 'uint16' | 'float32' | 'uint8', width: number, height: number): Samples {
	const n = width * height;
	switch (type) {
		case 'uint8':
			return pattern(width, height);
		case 'int16':
			return Int16Array.from({ length: n }, (_, i) => ((i * 2654435761) % 65536) - 32768);
		case 'uint16':
			return Uint16Array.from({ length: n }, (_, i) => (i * 40503 + (i >> 3)) % 65536);
		case 'float32':
			return Float32Array.from({ length: n }, (_, i) => (i % 97 === 0 ? Number.NaN : Math.sin(i) * 10 ** ((i % 9) - 4)));
	}
}

/** A geographic scene like WaPOR's: 1/1024°, its corner at 18.5° E, 33.5° S. */
const geoSpec = (over: Partial<CogSpec>): CogSpec => ({
	width: 70,
	height: 50,
	epsg: 4326,
	originX: 18.5,
	originY: -33.5,
	pixelSize: 1 / 1024,
	tile: 32,
	values: typed('int16', 70, 50),
	nodata: '-9999',
	...over
});

describe('the forms the WaPOR and Sentinel passes read (#623, #624)', () => {
	const types = ['uint8', 'int16', 'uint16', 'float32'] as const;
	const compressions = [1, 5, 8] as const;
	const cases = types.flatMap((type) => compressions.flatMap((compression) => [false, true].flatMap((bigTiff) => [false, true].map((bigEndian) => ({ type, compression, bigTiff, bigEndian })))));

	it.each(cases)('round-trips $type, compression $compression, BigTIFF $bigTiff, big-endian $bigEndian', async ({ type, compression, bigTiff, bigEndian }) => {
		const s = spec({ values: typed(type, 70, 50), compression, bigTiff, bigEndian });
		const { cog, all } = await roundTrip(s);
		expect(cog).toMatchObject({ sampleType: type, compression, bigTiff, littleEndian: !bigEndian, predictor: type === 'float32' ? 3 : 2 });
		expect(all).toBeInstanceOf(s.values.constructor);
		expect(Array.from(all)).toEqual(Array.from(s.values));
	});

	it.each([1, 2] as const)('round-trips 16-bit and float samples with predictor %s', async (predictor) => {
		for (const type of ['int16', 'uint16'] as const) {
			const s = spec({ values: typed(type, 70, 50), predictor, compression: 5 });
			expect(Array.from((await roundTrip(s)).all)).toEqual(Array.from(s.values));
		}
		if (predictor === 1) {
			const f = spec({ values: typed('float32', 70, 50), predictor, compression: 8 });
			expect(Array.from((await roundTrip(f)).all)).toEqual(Array.from(f.values));
		}
	});

	it('round-trips LZW on the WOfS layout, 512-pixel tiles', async () => {
		const s = spec({ compression: 5, tile: 512 });
		const { cog, all } = await roundTrip(s);
		expect(cog.compression).toBe(5);
		expect(all).toEqual(s.values);
	});

	it('reads an EPSG:4326 grid: its corner and pixel size in degrees', async () => {
		const s = geoSpec({ bigTiff: true, compression: 5 });
		const { cog, all } = await roundTrip(s);
		expect(cog).toMatchObject({ crs: 'geographic', epsg: 4326, originX: 18.5, originY: -33.5, pixelSizeX: 1 / 1024, pixelSizeY: 1 / 1024, nodata: -9999, sampleType: 'int16' });
		expect(Array.from(all)).toEqual(Array.from(s.values));
		const point = await roundTrip(geoSpec({ pixelIsPoint: true }));
		expect(point.cog.originX).toBeCloseTo(18.5, 12);
		expect(point.cog.originY).toBeCloseTo(-33.5, 12);
	});

	it('takes a UTM scene as crs utm', async () => {
		const { cog } = await roundTrip(spec());
		expect(cog).toMatchObject({ crs: 'utm', epsg: 32634, bigTiff: false, sampleType: 'uint8', scale: 1, offset: 0 });
	});

	it('fills an empty tile with the no-data value of the type (NaN for a float "nan")', async () => {
		const i = await roundTrip(geoSpec({ sparse: [1] }));
		expect(i.all[40]).toBe(-9999);
		expect(isNodata(i.cog, i.all[40]!)).toBe(true);
		const f = await roundTrip(spec({ values: typed('float32', 70, 50), nodata: 'nan', sparse: [1] }));
		expect(Number.isNaN(f.cog.nodata)).toBe(true);
		expect(Number.isNaN(f.all[40]!)).toBe(true);
		expect(isNodata(f.cog, Number.NaN)).toBe(true);
		expect(isNodata(f.cog, 0)).toBe(false);
	});

	it('parses GDAL_NODATA for the sample type, and drops one out of its range', () => {
		expect(parseNodata('-9999', 'int16')).toBe(-9999);
		expect(parseNodata('-9999', 'uint16')).toBeNull();
		expect(parseNodata('70000', 'uint16')).toBeNull();
		expect(parseNodata('0', 'uint16')).toBe(0);
		expect(parseNodata('1.5', 'int16')).toBeNull();
		expect(parseNodata('256', 'uint8')).toBeNull();
		expect(parseNodata('-0.1', 'float32')).toBe(Math.fround(-0.1));
		expect(parseNodata('NaN', 'float32')).toBeNaN();
		expect(parseNodata('', 'float32')).toBeNull();
		expect(parseNodata('inf', 'float32')).toBeNull();
	});

	it('reads only the slice of the tile tables for the window’s tile rows, never the whole table', async () => {
		// 40 × 20 tiles of 16, BigTIFF (8-byte entries), the tables past the first read.
		const s = spec({ width: 640, height: 320, tile: 16, bigTiff: true, compression: 5, tableGap: 32 * 1024 });
		const bytes = writeCog(s);
		const { read, calls } = reader(bytes);
		const cog = (await openCog(read))!;
		expect(calls).toHaveLength(1);
		// Columns 40–100 (tiles 2–6), rows 20–40 (tile rows 1–2): entries 42 … 86, 45 of them, of each table.
		const win = await readWindow(read, cog, { col0: 40, row0: 20, col1: 100, row1: 40 });
		for (let r = 20; r <= 40; r++) for (let c = 40; c <= 100; c++) expect(win[(r - 20) * 61 + (c - 40)]).toBe(s.values[r * 640 + c]);
		const [offs, counts, ...tiles] = calls.slice(1);
		// The whole tables would be 800 entries each.
		expect(offs![1] - offs![0] + 1).toBe(45 * 8);
		expect(counts![1] - counts![0] + 1).toBe(45 * 8);
		// Then the tiles: within the first and last tile the window touches (the two rows are close enough to be one range).
		const t42 = await cog.tile(42);
		const t86 = await cog.tile(86);
		expect(tiles.length).toBeGreaterThanOrEqual(1);
		expect(tiles.every(([a, b]) => a >= t42.offset && b <= t86.offset + t86.bytes - 1)).toBe(true);
	});
});

describe('bboxWindow', () => {
	const grid = { crs: 'geographic' as const, width: 1024, height: 512, originX: 18, originY: -33, pixelSizeX: 1 / 1024, pixelSizeY: 1 / 1024 };

	it('gives the pixels a lon/lat box touches', () => {
		// 18.25–18.5 E, 33.25–33.125 S: columns 256–511, rows 128–255.
		expect(bboxWindow(grid, { west: 18.25, east: 18.5, north: -33.125, south: -33.25 })).toEqual({ col0: 256, col1: 511, row0: 128, row1: 255 });
		// A box inside one pixel is that pixel.
		expect(bboxWindow(grid, { west: 18.0001, east: 18.0002, north: -33.0001, south: -33.0002 })).toEqual({ col0: 0, col1: 0, row0: 0, row1: 0 });
	});
	it('clips to the image, and is null off it', () => {
		expect(bboxWindow(grid, { west: 17, east: 18.001, north: -32, south: -33.001 })).toEqual({ col0: 0, col1: 1, row0: 0, row1: 1 });
		expect(bboxWindow(grid, { west: 20, east: 21, north: -33, south: -34 })).toBeNull();
		expect(bboxWindow(grid, { west: 18, east: 19, north: -30, south: -32 })).toBeNull();
	});
	it('refuses a UTM grid and a box that is not one', () => {
		expect(() => bboxWindow({ ...grid, crs: 'utm' }, { west: 18, east: 19, north: -33, south: -34 })).toThrow(RangeError);
		expect(() => bboxWindow(grid, { west: 19, east: 18, north: -33, south: -34 })).toThrow(RangeError);
		expect(() => bboxWindow(grid, { west: Number.NaN, east: 18, north: -33, south: -34 })).toThrow(RangeError);
	});
	it('agrees with the scene a geographic COG opens as', async () => {
		const { read } = reader(writeCog(geoSpec({})));
		const cog = (await openCog(read))!;
		const win = bboxWindow(cog, { west: 18.5 + 10 / 1024, east: 18.5 + 20 / 1024, north: -33.5 - 5 / 1024, south: -33.5 - 9 / 1024 })!;
		expect(win).toEqual({ col0: 10, col1: 19, row0: 5, row1: 8 });
		const got = await readWindow(read, cog, win);
		const want = geoSpec({}).values;
		expect(got[0]).toBe(want[5 * 70 + 10]);
	});
});

describe('isUtmEpsg', () => {
	it('accepts the WGS 84 UTM codes only', () => {
		expect([32601, 32634, 32660, 32701, 32735, 32760].every(isUtmEpsg)).toBe(true);
		expect([32600, 32661, 32700, 32761, 4326, 3857, 2048].some(isUtmEpsg)).toBe(false);
	});
});

describe('writeCog from tiles (a continental grid that is mostly empty)', () => {
	it('writes only the tiles given, every other one empty, and reads back as the same grid', async () => {
		// 8 × 4 tiles of 16; only tile 9 (row 1, column 1) holds data.
		const tileValues = (i: number) => (i === 9 ? Int16Array.from({ length: 256 }, (_, k) => k - 100) : null);
		const bytes = writeCog({ width: 128, height: 64, sampleType: 'int16', tileValues, epsg: 4326, originX: 20, originY: -30, pixelSize: 1 / 1024, tile: 16, compression: 5, nodata: '-9999', bigTiff: true });
		const { read } = reader(bytes);
		const cog = (await openCog(read, { sampleTypes: ['int16'], crs: ['geographic'] }))!;
		expect(cog).toMatchObject({ bigTiff: true, compression: 5, tilesAcross: 8, tilesDown: 4, nodata: -9999 });
		expect(await cog.tile(0)).toEqual({ offset: 0, bytes: 0 });
		const got = await readWindow(read, cog, { col0: 15, row0: 15, col1: 17, row1: 16 });
		// Row 15 is the first tile row's (empty); on row 16, column 15 is tile 8's (empty) and 16–17 tile 9's first samples.
		expect(Array.from(got)).toEqual([-9999, -9999, -9999, -9999, -100, -99]);
		expect(() => writeCog({ width: 16, height: 16, sampleType: 'int16', tileValues: () => new Int16Array(4), epsg: 4326, originX: 0, originY: 0, tile: 16 })).toThrow(RangeError);
	});

	it('writes a width past 65 535 as a LONG, which reads back', async () => {
		const bytes = writeCog({ width: 70_000, height: 16, sampleType: 'int16', tileValues: () => null, epsg: 4326, originX: -30, originY: 40, pixelSize: 1 / 1024, tile: 512, nodata: '-9999', bigTiff: true });
		const cog = (await openCog(reader(bytes).read, { sampleTypes: ['int16'], crs: ['geographic'] }))!;
		expect(cog).toMatchObject({ width: 70_000, height: 16, tilesAcross: 137 });
	});
});
