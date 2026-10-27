// Pre-summarising SANLC into the orchard and vine grid (loadCropTypes.ts,
// cropTypeGrid.ts) and the operator's command (scripts/import-crop-types.ts):
// a current and an earlier edition built as GeoTIFFs here, counted into
// cells by hand (orchards, vines, new plantings, no-data in either); the
// refusals (rasters that don't line up); the JSON form written and read
// back; the arguments; the committed synthetic fixture; and one polygon's
// areas from cells (cropTypes.ts).
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCropTypeArgs, readCropTypeFiles, SYNTHETIC_CROP_TYPES_FILE, writeCropTypesJson } from '../../scripts/import-crop-types.js';
import { tiff } from '../__tests__/tiff.js';
import { cellAreaM2 } from './gridShares.js';
import { cropTypeJsonMeta, cropTypeMethodFor, cropTypesFromJson, cropTypesToJson, SANLC_2022 } from './cropTypeGrid.js';
import { cropTypesFromCells } from './cropTypes.js';
import type { Geometry } from './geojson.js';
import { cropTypeCellsFromTiff } from './loadCropTypes.js';

/**
 * Two 4 × 2 rasters of 0.001° pixels with their corner at (21, -33), counted
 * into 0.002° cells (2 × 2 pixels each, 2 cells side by side):
 *     now (2022)        then (2018)
 *     32 32 | 33  5     10 32 | 10  0
 *     33  0 | 33 33     10 10 | 33 10
 * with 0 as no-data; the counts are worked by hand beside the expectation.
 */
const NOW = Uint8Array.from([32, 32, 33, 5, 33, 0, 33, 33]);
const THEN = Uint8Array.from([10, 32, 10, 0, 10, 10, 33, 10]);
const base = { width: 4, height: 2, west: 21, north: -33, pixel: 0.001, noData: '0' };
const CLASSES = { orchard: [32], vine: [33] };

describe('counting a crop-type raster into cells', () => {
	it('counts orchards and vines over the pixels with data, and new plantings against the earlier edition', () => {
		const got = cropTypeCellsFromTiff(tiff({ ...base, pixels: NOW }), tiff({ ...base, pixels: THEN }), 0.002, CLASSES);
		if (typeof got === 'string') throw new Error(got);
		expect(got.pixels).toBe(8);
		// Cell 1: pixels 32 32 / 33 0 → 3 with data; orchards 2 (one new: 10 → 32), vine 1 (new: 10 → 33).
		// Cell 2: pixels 33 5 / 33 33 → 4 with data; vines 3: (2,0) was 10 (new), (2,1) was 33 (not), (3,1) was 10 (new).
		expect(got.cells).toEqual([
			{ row: -16501, col: 10500, orchard: 2 / 3, vine: 1 / 3, newOrchard: 1 / 3, newVine: 1 / 3 },
			{ row: -16501, col: 10501, orchard: 0, vine: 3 / 4, newOrchard: 0, newVine: 2 / 4 }
		]);
	});

	it('never counts a pixel as new where the earlier edition has no data', () => {
		const then = Uint8Array.from(THEN);
		then[0] = 0;
		then[4] = 0;
		const got = cropTypeCellsFromTiff(tiff({ ...base, pixels: NOW }), tiff({ ...base, pixels: then }), 0.002, CLASSES);
		if (typeof got === 'string') throw new Error(got);
		expect(got.cells[0]).toMatchObject({ newOrchard: 0, newVine: 0 });
	});

	it('without an earlier edition counts no new plantings, tiled and compressed alike', () => {
		for (const spec of [{}, { tile: 16, compression: 8 as const }, { strip: 1, predictor: 2 as const, compression: 8 as const }]) {
			const got = cropTypeCellsFromTiff(tiff({ ...base, ...spec, pixels: NOW }), null, 0.002, CLASSES);
			if (typeof got === 'string') throw new Error(got);
			expect(got.cells.map((c) => [c.orchard, c.vine, c.newOrchard, c.newVine])).toEqual([
				[2 / 3, 1 / 3, 0, 0],
				[0, 3 / 4, 0, 0]
			]);
		}
	});

	it('leaves out cells with neither, and cells outside --bbox', () => {
		const none = Uint8Array.from([10, 10, 33, 33, 10, 10, 33, 33]);
		const got = cropTypeCellsFromTiff(tiff({ ...base, pixels: none }), null, 0.002, CLASSES, { west: 21.002, south: -34, east: 22, north: -32 });
		if (typeof got === 'string') throw new Error(got);
		expect(got.cells.map((c) => c.col)).toEqual([10501]);
		const outside = cropTypeCellsFromTiff(tiff({ ...base, pixels: NOW }), null, 0.002, CLASSES, { west: 30, south: -34, east: 31, north: -32 });
		expect(typeof outside !== 'string' && outside.cells).toEqual([]);
	});

	it('refuses an earlier edition on other pixels, and a grid that doesn’t line up', () => {
		expect(cropTypeCellsFromTiff(tiff({ ...base, pixels: NOW }), tiff({ ...base, west: 21.001, pixels: THEN }), 0.002, CLASSES)).toMatch(/corner or pixel size differs/);
		expect(cropTypeCellsFromTiff(tiff({ ...base, pixels: NOW }), tiff({ ...base, width: 2, pixels: THEN.slice(0, 4) }), 0.002, CLASSES)).toMatch(/width \(2\) differs/);
		expect(cropTypeCellsFromTiff(tiff({ ...base, pixels: NOW }), tiff({ ...base, tile: 16, pixels: THEN }), 0.002, CLASSES)).toMatch(/blockW .* differs/);
		expect(cropTypeCellsFromTiff(tiff({ ...base, pixels: NOW }), Buffer.from('nope'), 0.002, CLASSES)).toMatch(/^the earlier edition: not a TIFF/);
		expect(cropTypeCellsFromTiff(tiff({ ...base, pixels: NOW }), null, 0.0015, CLASSES)).toMatch(/not a whole number/);
	});
});

describe('the JSON form', () => {
	it('round-trips through the --out form', () => {
		const meta = cropTypeJsonMeta('SANLC-2022', { cellDeg: 0.0025, meta: { baselineVersion: '2018' } });
		expect(meta).toMatchObject({ source: SANLC_2022.source, version: '2022', baselineVersion: '2018', orchardClasses: [32], vineClasses: [33] });
		const cells = [{ row: -13472, col: 8524, orchard: 0.25, vine: 0.5, newOrchard: 0.125, newVine: 0 }];
		const back = cropTypesFromJson(JSON.parse(cropTypesToJson(meta, cells)));
		if (typeof back === 'string') throw new Error(back);
		expect(back.cells).toEqual(cells);
		expect(back.problems).toEqual([]);
		expect(back.meta).toMatchObject({ version: '2022', baselineVersion: '2018', orchardClasses: [32], vineClasses: [33] });
	});

	it('skips a cell that isn’t one, with the reason', () => {
		const got = cropTypesFromJson({ cellDeg: 0.005, cells: [[21, -33, 0, 0], [21, -33, 0.6, 0.6], [21, -33, 0.1, 0.1, 0.2], [21, -33, 0.1], [21, -33, 0.5, 0.25, 0.1]] });
		if (typeof got === 'string') throw new Error(got);
		expect(got.cells).toEqual([{ row: -6600, col: 4200, orchard: 0.5, vine: 0.25, newOrchard: 0.1, newVine: 0 }]);
		expect(got.problems.map((p) => p.replace(/: .*/, ''))).toEqual(['cell 1', 'cell 2', 'cell 3', 'cell 4']);
		expect(cropTypesFromJson({ cells: [] })).toMatch(/cellDeg/);
	});

	it('cites the classes and the baseline edition in the method', () => {
		expect(cropTypeMethodFor(0.0025, [32], [33], '2018')).toMatch(/class 32 \(permanent orchards\) and in class 33 \(permanent vines\).*in the 2018 edition/);
		expect(cropTypeMethodFor(0.0025, [32], [33, 34], null)).not.toMatch(/new plantings/);
	});
});

describe('the command', () => {
	it('loads the committed synthetic grid with no argument', () => {
		const args = parseCropTypeArgs([]);
		if (typeof args === 'string') throw new Error(args);
		expect(args).toMatchObject({ file: SYNTHETIC_CROP_TYPES_FILE, dataset: 'synthetic' });
		const read = readCropTypeFiles(args);
		if (typeof read === 'string') throw new Error(read);
		expect(read.cells).toHaveLength(524);
		expect(read.problems).toEqual([]);
		expect(read.meta).toMatchObject({ version: 'synthetic 2022', baselineVersion: 'synthetic 2018', cellDeg: 0.005 });
		expect(readFileSync(SYNTHETIC_CROP_TYPES_FILE, 'utf8')).toMatch(/SYNTHETIC test data, invented/);
	});

	it('reads its options, resolving paths from where it was typed', () => {
		const env = { INIT_CWD: '/work' };
		const args = parseCropTypeArgs(['now.tif', '--dataset', 'SANLC-2022', '--baseline', 'then.tif', '--baseline-version', '2018', '--orchard-classes', '32,40', '--bbox', '18,-34.5,20,-33'], env);
		expect(args).toMatchObject({ file: '/work/now.tif', baseline: '/work/then.tif', baselineVersion: '2018', orchardClasses: [32, 40], vineClasses: [33], bbox: { west: 18, south: -34.5, east: 20, north: -33 } });
	});

	it('refuses what it can’t use', () => {
		const bad = (argv: string[]) => parseCropTypeArgs(argv, { INIT_CWD: '/w' });
		expect(bad(['a.tif'])).toMatch(/--dataset/);
		expect(bad(['a.tif', '--dataset', 'synthetic'])).toMatch(/committed fixture/);
		expect(bad(['a.tif', 'b.tif', '--dataset', 'x'])).toMatch(/one raster/);
		expect(bad(['a.tif', '--dataset', 'x', '--baseline', 'b.tif'])).toMatch(/together/);
		expect(bad(['a.tif', '--dataset', 'x', '--baseline', 'b.json', '--baseline-version', '2018'])).toMatch(/GeoTIFF/);
		expect(bad(['a.tif', '--dataset', 'x', '--orchard-classes', '32', '--vine-classes', '32'])).toMatch(/not both/);
		expect(bad(['a.shp', '--dataset', 'x'])).toMatch(/GeoTIFF/);
		expect(bad(['a.tif', '--dataset', 'x', '--out', 'x.csv'])).toMatch(/--out/);
		expect(bad(['a.tif', '--dataset', 'x', '--classes', '32'])).toMatch(/unknown option --classes/);
	});

	it('writes the summary instead of loading it with --out', () => {
		const dir = mkdtempSync(join(tmpdir(), 'crop-types-'));
		const args = parseCropTypeArgs([SYNTHETIC_CROP_TYPES_FILE, '--dataset', 'copy', '--out', join(dir, 'grid.json')]);
		if (typeof args === 'string' || !args.out) throw new Error(String(args));
		expect(writeCropTypesJson({ ...args, out: args.out })).toEqual({ written: 524, problems: [] });
		const back = cropTypesFromJson(JSON.parse(readFileSync(args.out, 'utf8')));
		expect(typeof back !== 'string' && back.cells.length).toBe(524);
	});
});

describe('one polygon’s areas from cells', () => {
	it('weights each cell’s shares by the part of it inside the polygon', () => {
		// The south-west half of one 0.01° cell (row -3400, col 2100), as a triangle.
		const g: Geometry = { type: 'Polygon', coordinates: [[[21, -34], [21.01, -34], [21, -33.99], [21, -34]]] };
		const cells = new Map([['-3400:2100', [0.4, 0.2, 0.1, 0] as [number, number, number, number]]]);
		const got = cropTypesFromCells(g, 0.01, cells);
		if ('problem' in got) throw new Error(got.problem);
		const half = cellAreaM2(21, -34, 0.01) / 2;
		expect(got.orchardM2 / half).toBeCloseTo(0.4, 4);
		expect(got.vineM2 / half).toBeCloseTo(0.2, 4);
		expect(got.newOrchardM2 / half).toBeCloseTo(0.1, 4);
		expect(got.newVineM2).toBe(0);
	});
});
