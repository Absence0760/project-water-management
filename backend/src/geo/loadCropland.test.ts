// Pre-summarising a land-cover raster into cropland cells (loadCropland.ts)
// and the operator's command (scripts/import-land-cover.ts): GeoTIFFs built
// here byte by byte (tiled and striped, Deflate and none, predictor 2,
// no-data), each counted into the cells by hand; the refusals; the JSON
// form; the arguments; and the committed synthetic fixture.
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseLandCoverArgs, readLandCoverFiles, SYNTHETIC_LAND_COVER_FILE } from '../../scripts/import-land-cover.js';
import { croplandCellsFromTiff, croplandFromJson, gridFits, mergeCells, methodFor, readTiffInfo, WORLDCOVER_2021 } from './loadCropland.js';

interface TiffSpec {
	width: number;
	height: number;
	pixels: Uint8Array;
	west: number;
	north: number;
	pixel: number;
	tile?: number;
	/** Rows per strip, when not tiled. */
	strip?: number;
	compression?: 1 | 8;
	predictor?: 1 | 2;
	noData?: string;
	/** GeoKeys: the model type (2 geographic) and the datum (4326). */
	geoKeys?: [number, number];
	bits?: number;
}

/** A little-endian classic GeoTIFF of one 8-bit band. */
function tiff(s: TiffSpec): Buffer {
	const bw = s.tile ?? s.width;
	const bh = s.tile ?? s.strip ?? s.height;
	const blocks: Buffer[] = [];
	for (let by = 0; by < s.height; by += bh) {
		for (let bx = 0; bx < s.width; bx += bw) {
			const h = s.tile ? bh : Math.min(bh, s.height - by);
			const b = new Uint8Array(bw * h);
			for (let y = 0; y < h; y++) {
				for (let x = 0; x < bw; x++) {
					const v = by + y < s.height && bx + x < s.width ? s.pixels[(by + y) * s.width + bx + x]! : 0;
					b[y * bw + x] = v;
				}
				if (s.predictor === 2) for (let x = bw - 1; x > 0; x--) b[y * bw + x] = (b[y * bw + x]! - b[y * bw + x - 1]! + 256) & 255;
			}
			blocks.push(s.compression === 8 ? deflateSync(b) : Buffer.from(b));
		}
	}
	type Entry = { tag: number; type: number; values: number[] | string };
	const entries: Entry[] = [
		{ tag: 256, type: 4, values: [s.width] },
		{ tag: 257, type: 4, values: [s.height] },
		{ tag: 258, type: 3, values: [s.bits ?? 8] },
		{ tag: 259, type: 3, values: [s.compression ?? 1] },
		{ tag: 277, type: 3, values: [1] },
		{ tag: 317, type: 3, values: [s.predictor ?? 1] },
		{ tag: 339, type: 3, values: [1] },
		{ tag: 33550, type: 12, values: [s.pixel, s.pixel, 0] },
		{ tag: 33922, type: 12, values: [0, 0, 0, s.west, s.north, 0] }
	];
	if (s.tile) entries.push({ tag: 322, type: 3, values: [bw] }, { tag: 323, type: 3, values: [bh] });
	else entries.push({ tag: 278, type: 3, values: [bh] });
	const [modelType, datum] = s.geoKeys ?? [2, 4326];
	entries.push({ tag: 34735, type: 3, values: [1, 1, 0, 2, 1024, 0, 1, modelType, 2048, 0, 1, datum] });
	if (s.noData !== undefined) entries.push({ tag: 42113, type: 2, values: `${s.noData}\0` });
	// Offsets and counts last: their values are known once the layout is.
	const offTag = s.tile ? 324 : 273;
	const cntTag = s.tile ? 325 : 279;
	entries.push({ tag: offTag, type: 4, values: blocks.map(() => 0) }, { tag: cntTag, type: 4, values: blocks.map((b) => b.length) });
	entries.sort((a, b) => a.tag - b.tag);
	const size = (e: Entry) => (typeof e.values === 'string' ? e.values.length : e.values.length * (e.type === 12 ? 8 : e.type === 4 ? 4 : 2));
	const ifdAt = 8;
	const ifdLen = 2 + entries.length * 12 + 4;
	let extra = ifdAt + ifdLen;
	const extraAt = new Map<Entry, number>();
	for (const e of entries) if (size(e) > 4) (extraAt.set(e, extra), (extra += size(e)));
	let dataAt = extra;
	const offsets = blocks.map((b) => ((dataAt += b.length), dataAt - b.length));
	entries.find((e) => e.tag === offTag)!.values = offsets;
	const out = Buffer.alloc(dataAt);
	out.write('II', 0, 'latin1');
	out.writeUInt16LE(42, 2);
	out.writeUInt32LE(ifdAt, 4);
	out.writeUInt16LE(entries.length, ifdAt);
	entries.forEach((e, i) => {
		const at = ifdAt + 2 + i * 12;
		out.writeUInt16LE(e.tag, at);
		out.writeUInt16LE(e.type, at + 2);
		out.writeUInt32LE(typeof e.values === 'string' ? e.values.length : e.values.length, at + 4);
		const where = extraAt.get(e) ?? at + 8;
		if (extraAt.has(e)) out.writeUInt32LE(where, at + 8);
		if (typeof e.values === 'string') out.write(e.values, where, 'latin1');
		else
			e.values.forEach((v, k) => {
				if (e.type === 12) out.writeDoubleLE(v, where + k * 8);
				else if (e.type === 4) out.writeUInt32LE(v, where + k * 4);
				else out.writeUInt16LE(v, where + k * 2);
			});
	});
	let at = extra;
	for (const b of blocks) (b.copy(out, at), (at += b.length));
	return out;
}

/**
 * A 6 × 4 raster of 0.001° pixels with its corner at (21, -33), counted into
 * 0.002° cells (2 × 2 pixels each, 3 × 2 cells):
 *     40 40 | 40 10 | 0  0       row -16501: cells (col 10500, 10501, 10502)
 *     40 40 | 10 10 | 0  0
 *     ------+-------+------
 *     10 10 | 40 30 | 40 0       row -16502
 *     10 10 | 30 30 | 0  0
 * Cells: 4/4, 1/4, none (all no-data); 0/4 (left out), 1/4, 1/1.
 */
const SIX_BY_FOUR = Uint8Array.from([40, 40, 40, 10, 0, 0, 40, 40, 10, 10, 0, 0, 10, 10, 40, 30, 40, 0, 10, 10, 30, 30, 0, 0]);
const EXPECTED = [
	{ row: -16502, col: 10501, fraction: 0.25 },
	{ row: -16502, col: 10502, fraction: 1 },
	{ row: -16501, col: 10500, fraction: 1 },
	{ row: -16501, col: 10501, fraction: 0.25 }
];
const base = { width: 6, height: 4, pixels: SIX_BY_FOUR, west: 21, north: -33, pixel: 0.001, noData: '0' };
const count = (buf: Buffer, cell = 0.002) => {
	const r = croplandCellsFromTiff(buf, cell, new Set([40]));
	if (typeof r === 'string') throw new Error(r);
	return mergeCells(r.cells);
};

describe('croplandCellsFromTiff', () => {
	it('counts each cell’s cropland pixels over its pixels with data: tiled with Deflate, striped and uncompressed, predictor 2', () => {
		expect(count(tiff({ ...base, tile: 16, compression: 8 }))).toEqual(EXPECTED);
		expect(count(tiff({ ...base, strip: 3 }))).toEqual(EXPECTED);
		expect(count(tiff({ ...base, tile: 16, compression: 8, predictor: 2 }))).toEqual(EXPECTED);
	});

	it('reads the georeference and the no-data value', () => {
		const info = readTiffInfo(tiff({ ...base, tile: 16 }));
		expect(info).toMatchObject({ width: 6, height: 4, blockW: 16, blockH: 16, west: 21, north: -33, pixelW: 0.001, noData: 0, compression: 1 });
	});

	it('without a no-data value counts every pixel: a no-data 0 then dilutes the share', () => {
		const cells = count(tiff({ ...base, noData: undefined, tile: 16 }));
		expect(cells.find((c) => c.row === -16502 && c.col === 10502)!.fraction).toBe(0.25);
	});

	it('keeps only the cells whose centre is inside the bbox', () => {
		const r = croplandCellsFromTiff(tiff({ ...base, tile: 16 }), 0.002, new Set([40]), { west: 21, south: -33.002, east: 21.004, north: -33 });
		expect(typeof r === 'string' ? r : r.cells.map((c) => [c.row, c.col])).toEqual([
			[-16501, 10500],
			[-16501, 10501]
		]);
	});

	it('refuses a grid that doesn’t line up, and rasters it can’t read', () => {
		expect(croplandCellsFromTiff(tiff({ ...base, tile: 16 }), 0.0015, new Set([40]))).toMatch(/not a whole number of the raster's 0.001° pixels/);
		expect(croplandCellsFromTiff(tiff({ ...base, west: 21.0005, tile: 16 }), 0.002, new Set([40]))).toMatch(/corner .* is not on the 0.002° grid/);
		expect(readTiffInfo(tiff({ ...base, tile: 16, bits: 16 }))).toMatch(/16-bit/);
		expect(readTiffInfo(tiff({ ...base, tile: 16, geoKeys: [1, 4326] }))).toMatch(/not in geographic coordinates/);
		expect(readTiffInfo(tiff({ ...base, tile: 16, geoKeys: [2, 4148] }))).toMatch(/EPSG:4148, not WGS84/);
		expect(readTiffInfo(Buffer.from('not a tiff at all'))).toBe('not a TIFF file');
		const big = Buffer.alloc(16);
		big.write('II', 0, 'latin1');
		big.writeUInt16LE(43, 2);
		expect(readTiffInfo(big)).toMatch(/BigTIFF/);
		expect(gridFits({ west: 21, north: -33, pixelW: 1 / 12000, pixelH: 1 / 12000 }, 0.0025)).toBeNull();
	});
});

describe('croplandFromJson', () => {
	it('places each cell by its centre and reads the product’s own description', () => {
		const r = croplandFromJson({ cellDeg: 0.005, source: ' A  source ', version: 'v1', classes: [40], cells: [[21.3025, -33.6775, 0.5], [21.3, -33.6, 0], ['x']] });
		if (typeof r === 'string') throw new Error(r);
		expect(r.cells).toEqual([{ row: -6736, col: 4260, fraction: 0.5 }]);
		expect(r.meta).toEqual({ source: 'A source', version: 'v1', attribution: undefined, classes: [40] });
		expect(r.problems).toEqual(['cell 2: the fraction 0 is not above 0 and at most 1', 'cell 3: not [lon, lat, fraction]']);
		expect(croplandFromJson({ cells: [] })).toMatch(/cellDeg/);
	});
});

describe('the command', () => {
	it('loads the committed synthetic grid with no argument, as dataset "synthetic", with its own description', () => {
		const args = parseLandCoverArgs([]);
		if (typeof args === 'string') throw new Error(args);
		expect(args).toMatchObject({ files: [SYNTHETIC_LAND_COVER_FILE], dataset: 'synthetic' });
		const read = readLandCoverFiles(args);
		if (typeof read === 'string') throw new Error(read);
		expect(read.meta).toMatchObject({ dataset: 'synthetic', cellDeg: 0.005, classes: [40], version: 'synthetic 1', source: expect.stringMatching(/^SYNTHETIC/) });
		expect(read.meta.method).toBe(methodFor(0.005, [40]));
		expect(read.problems).toEqual([]);
		const [cells] = [...read.parts];
		expect(cells!.length).toBeGreaterThan(1000);
		// The tests' block: 21.30–21.35° E, 33.65–33.70° S, every cell 0.5.
		expect(cells!.filter((c) => c.col >= 4260 && c.col < 4270 && c.row >= -6740 && c.row < -6730).every((c) => c.fraction === 0.5)).toBe(true);
	});

	it('takes tiles with a label, WorldCover’s description by default, and checks its options', () => {
		const args = parseLandCoverArgs(['a.tif', 'b.tif', '--dataset', 'WorldCover-2021-v200', '--bbox', '16,-35,33,-22'], { INIT_CWD: '/data' });
		expect(args).toMatchObject({ files: ['/data/a.tif', '/data/b.tif'], cellDeg: 0.0025, classes: [40], bbox: { west: 16, south: -35, east: 33, north: -22 } });
		const read = readLandCoverFiles(args as Exclude<typeof args, string>);
		expect(typeof read === 'string' ? read : read.meta).toMatchObject({ source: WORLDCOVER_2021.source, version: '2021 v200', attribution: WORLDCOVER_2021.attribution });
		expect(parseLandCoverArgs(['a.tif'])).toMatch(/--dataset/);
		expect(parseLandCoverArgs(['a.tif', '--dataset', 'synthetic'])).toMatch(/committed fixture/);
		expect(parseLandCoverArgs(['a.png', '--dataset', 'x'])).toMatch(/GeoTIFF/);
		expect(parseLandCoverArgs(['a.tif', '--dataset', 'x', '--cell', '1'])).toMatch(/--cell/);
		expect(parseLandCoverArgs(['a.tif', '--dataset', 'x', '--classes', '40,300'])).toMatch(/--classes/);
		expect(parseLandCoverArgs(['a.tif', '--dataset', 'x', '--bbox', '1,2,0,3'])).toMatch(/--bbox/);
		expect(parseLandCoverArgs(['a.tif', '--dataset', 'x', '--frobnicate'])).toMatch(/unknown option/);
		expect(readLandCoverFiles({ ...(args as Exclude<typeof args, string>), files: ['/x/a.tif', SYNTHETIC_LAND_COVER_FILE] })).toMatch(/not both/);
	});
});
