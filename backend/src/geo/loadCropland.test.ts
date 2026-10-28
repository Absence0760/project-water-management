// Pre-summarising a land-cover raster into cropland cells (loadCropland.ts)
// and the operator's command (scripts/import-land-cover.ts): GeoTIFFs built
// here byte by byte (tiled and striped, Deflate and none, predictor 2,
// no-data), each counted into the cells by hand; the refusals; the JSON
// form, written (--out, for a production load) and read back; the
// arguments; and the committed synthetic fixture.
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { tiff } from '../__tests__/tiff.js';
import { parseLandCoverArgs, readLandCoverFiles, SYNTHETIC_LAND_COVER_FILE } from '../../scripts/import-land-cover.js';
import { croplandCellsFromTiff, croplandFromJson, croplandToJson, gridFits, jsonDatasetMeta, MAX_BLOCK_PIXELS, mergeCells, methodFor, readTiffInfo, WORLDCOVER_2021 } from './loadCropland.js';

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

describe('the JSON form written for a production load (--out)', () => {
	it('reads back cell for cell, with the product it was written with', () => {
		for (const cellDeg of [0.0025, 0.005, 1 / 12]) {
			const at = (lat: number, lon: number) => ({ row: Math.floor(lat / cellDeg), col: Math.floor(lon / cellDeg) });
			const cells = mergeCells([
				{ ...at(-33.65, 21.3), fraction: 0.5 },
				{ ...at(-33.65, 21.31), fraction: 0.123456789 },
				{ ...at(-89.99, -179.99), fraction: 1 }
			]);
			const meta = { source: 'S', version: 'v', attribution: 'A', cellDeg, classes: [40, 41] };
			const got = croplandFromJson(JSON.parse(croplandToJson(meta, cells)));
			if (typeof got === 'string') throw new Error(got);
			expect(got.problems).toEqual([]);
			expect(got.cellDeg).toBe(cellDeg);
			expect(got.cells.map((c) => [c.row, c.col])).toEqual(cells.map((c) => [c.row, c.col]));
			expect(got.cells.map((c) => c.fraction)).toEqual(cells.map((c) => Number(c.fraction.toFixed(6))));
			expect(jsonDatasetMeta('D', got)).toEqual({ dataset: 'D', source: 'S', version: 'v', attribution: 'A', method: methodFor(cellDeg, [40, 41]), cellDeg, classes: [40, 41] });
		}
	});

	it('the flags win over the file’s own fields, and WorldCover fills what neither gives', () => {
		const got = { cellDeg: 0.0025, meta: { source: 'File' } };
		expect(jsonDatasetMeta('D', got, { source: 'Flag' }).source).toBe('Flag');
		expect(jsonDatasetMeta('D', got).source).toBe('File');
		expect(jsonDatasetMeta('D', { cellDeg: 0.0025, meta: {} })).toMatchObject({ version: WORLDCOVER_2021.version, attribution: WORLDCOVER_2021.attribution, classes: [40] });
	});

	it('--out takes a .json or .json.gz file, resolved from where the command was typed', () => {
		expect(parseLandCoverArgs(['a.tif', '--dataset', 'x', '--out', 'grid.json.gz'], { INIT_CWD: '/data' })).toMatchObject({ files: ['/data/a.tif'], out: '/data/grid.json.gz' });
		expect(parseLandCoverArgs(['a.tif', '--dataset', 'x', '--out', 'grid.csv'])).toMatch(/--out/);
		expect(parseLandCoverArgs(['a.tif', '--dataset', 'x'])).toMatchObject({ out: null });
	});
});

/** Set one inline SHORT or LONG value of the first IFD's tag (a little-endian classic TIFF). */
function setTag(buf: Buffer, tag: number, value: number) {
	const ifd = buf.readUInt32LE(4);
	const n = buf.readUInt16LE(ifd);
	for (let i = 0; i < n; i++) {
		const e = ifd + 2 + i * 12;
		if (buf.readUInt16LE(e) !== tag) continue;
		if (buf.readUInt16LE(e + 2) === 3) buf.writeUInt16LE(value, e + 8);
		else buf.writeUInt32LE(value, e + 8);
		return;
	}
	throw new Error(`no tag ${tag}`);
}

describe('hostile GeoTIFFs (round-4 hardening)', () => {
	it('stops a deflate bomb at its block’s pixels, as "doesn’t decompress"', () => {
		const base16 = tiff({ ...base, tile: 16, compression: 8 });
		// 256 MiB of zeros deflated (about 256 KB), appended and made the one tile's data.
		const bomb = deflateSync(Buffer.alloc(256 * 1024 * 1024));
		const file = Buffer.concat([base16, bomb]);
		setTag(file, 324, base16.length);
		setTag(file, 325, bomb.length);
		const t = performance.now();
		expect(croplandCellsFromTiff(file, 0.002, new Set([40]))).toMatch(/doesn't decompress/);
		expect(performance.now() - t).toBeLessThan(2_000);
	});

	it('refuses tiles or strips bigger than MAX_BLOCK_PIXELS before reading them', () => {
		const file = tiff({ ...base, tile: 16 });
		setTag(file, 322, 65_535);
		setTag(file, 323, 65_535);
		expect(65_535 * 65_535).toBeGreaterThan(MAX_BLOCK_PIXELS);
		expect(readTiffInfo(file)).toMatch(/at most \d+ pixels each/);
	});
});
