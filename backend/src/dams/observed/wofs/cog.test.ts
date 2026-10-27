import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { FeedFormatError } from '../../../feeds/errors.js';
import { decodeTile, isUtmEpsg, openCog, readWindow, type RangeRead } from './cog.js';
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
	const refuses = async (bytes: Uint8Array, message: RegExp) => {
		const { read } = reader(bytes);
		const err = await (async () => {
			const cog = await openCog(read);
			await readWindow(read, cog!, { col0: 0, row0: 0, col1: 69, row1: 49 });
		})().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(FeedFormatError);
		expect((err as Error).message).toMatch(message);
	};

	it('refuses BigTIFF', async () => {
		const b = writeCog(spec());
		new DataView(b.buffer).setUint16(2, 43, true);
		await refuses(b, /BigTIFF/);
	});
	it('refuses a file that is not a TIFF', async () => {
		await refuses(new TextEncoder().encode('<html>not found</html>'), /not a TIFF/);
	});
	it('refuses a striped file', async () => {
		await refuses(writeCog(spec({ override: { 322: null, 323: null, 273: [4, [8]] } })), /striped/);
	});
	it.each([
		['16-bit samples', { 258: [3, [16]] }, /8-bit unsigned/],
		['signed samples', { 339: [3, [2]] }, /8-bit unsigned/],
		['two bands', { 277: [3, [2]] }, /more than one band/],
		['LZW', { 259: [3, [5]] }, /compression 5/],
		['the float predictor', { 317: [3, [3]] }, /predictor 3/],
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
		['a geographic CRS', { 1024: 2 }, /not in projected/],
		['another projected CRS', { 3072: 2048 }, /not WGS 84 \/ UTM/],
		['feet', { 3076: 9002 }, /not metres/],
		['no projected CRS', { 3072: null }, /EPSG unset/]
	] as const)('refuses %s', async (_l, geoKeys, message) => {
		await refuses(writeCog(spec({ geoKeys })), message);
	});
	it('refuses a tile that inflates past its size, or not at all, or is short', async () => {
		const cog = { tileWidth: 16, tileHeight: 16, compression: 8 as const, predictor: 1 as const };
		expect(() => decodeTile(cog, deflateSync(new Uint8Array(16 * 16 * 4)))).toThrow(/inflates past/);
		expect(() => decodeTile(cog, Uint8Array.of(1, 2, 3))).toThrow(/does not inflate/);
		expect(() => decodeTile(cog, deflateSync(new Uint8Array(10)))).toThrow(/truncated/);
	});
	it('refuses a file cut inside a tile', async () => {
		const b = writeCog(spec());
		await refuses(b.subarray(0, b.length - 10), /ends inside a tile/);
	});
});

describe('isUtmEpsg', () => {
	it('accepts the WGS 84 UTM codes only', () => {
		expect([32601, 32634, 32660, 32701, 32735, 32760].every(isUtmEpsg)).toBe(true);
		expect([32600, 32661, 32700, 32761, 4326, 3857, 2048].some(isUtmEpsg)).toBe(false);
	});
});
