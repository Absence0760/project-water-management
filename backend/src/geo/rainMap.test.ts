// The MAP grid's parsing (geo/rainMap.ts, no database): an ESRI ASCII grid's
// header (corner and centre forms), its NODATA cells, a box, and the refusals
// (a projected grid, a short or long row, too many rows, a MAP no rain gauge
// would read); the fixture's JSON form; and the range of cells a box meets.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseMapGridArgs, SYNTHETIC_MAP_GRID_FILE } from '../../scripts/import-map-grid.js';
import { cellRange, rainMapFromAscii, rainMapFromJson } from './rainMap.js';

/** A 3 × 2 grid of 0.5° cells, south-west corner (20, −34), one NODATA cell. */
const ascii = (head: string[] = ['xllcorner 20', 'yllcorner -34']) => ['ncols 3', 'nrows 2', ...head, 'cellsize 0.5', 'NODATA_value -9999', '100 200 -9999', '400 500 600'];
const centres = (g: Awaited<ReturnType<typeof rainMapFromAscii>>) =>
	g.cells.map((c) => [g.originLon + (c.col + 0.5) * g.cellDeg, g.originLat + (c.row + 0.5) * g.cellDeg, c.mapMm]);

describe('rainMapFromAscii', () => {
	it('reads every cell with a value by its centre, rows north to south, NODATA left out', async () => {
		const g = await rainMapFromAscii(ascii(), null);
		expect(g.cellDeg).toBe(0.5);
		expect(centres(g)).toEqual([
			[20.25, -33.25, 100],
			[20.75, -33.25, 200],
			[20.25, -33.75, 400],
			[20.75, -33.75, 500],
			[21.25, -33.75, 600]
		]);
	});

	it('takes the centre form of the header, and gives the same grid', async () => {
		const g = await rainMapFromAscii(ascii(['xllcenter 20.25', 'yllcenter -33.75']), null);
		expect(centres(g)).toEqual(centres(await rainMapFromAscii(ascii(), null)));
	});

	it('keeps only the cells whose centres lie in the box', async () => {
		const g = await rainMapFromAscii(ascii(), { w: 20.5, s: -34, e: 21.5, n: -33.5 });
		expect(centres(g)).toEqual([
			[20.75, -33.75, 500],
			[21.25, -33.75, 600]
		]);
	});

	it('streams lines from an async source', async () => {
		async function* lines() {
			yield* ascii();
		}
		expect((await rainMapFromAscii(lines(), null)).cells).toHaveLength(5);
	});

	it('refuses a projected grid, a short row, a missing or extra row, and a MAP no gauge would read', async () => {
		await expect(rainMapFromAscii(['ncols 2', 'nrows 1', 'xllcorner 250000', 'yllcorner 6200000', 'cellsize 100', '1 2'], null)).rejects.toThrow(/WGS84 degrees/);
		await expect(rainMapFromAscii(['ncols 2', 'nrows 1', 'xllcorner 250', 'yllcorner -34', 'cellsize 0.5', '1 2'], null)).rejects.toThrow(/WGS84 degrees/);
		await expect(rainMapFromAscii(['ncols 3', 'nrows 1', 'xllcorner 20', 'yllcorner -34', 'cellsize 0.5', '1 2'], null)).rejects.toThrow(/row 1 has 2 values, not 3/);
		await expect(rainMapFromAscii(ascii().slice(0, -1), null)).rejects.toThrow(/1 rows, not 2/);
		await expect(rainMapFromAscii([...ascii(), '1 2 3'], null)).rejects.toThrow(/more than its 2 rows/);
		await expect(rainMapFromAscii(['ncols 1', 'nrows 1', 'xllcorner 20', 'yllcorner -34', 'cellsize 0.5', '25000'], null)).rejects.toThrow(/not a mean annual precipitation/);
		await expect(rainMapFromAscii(['1 2 3'], null)).rejects.toThrow(/no ncols and nrows/);
		await expect(rainMapFromAscii(['ncols x'], null)).rejects.toThrow(/ncols is not a number/);
		await expect(rainMapFromAscii([], null)).rejects.toThrow(/no ESRI ASCII grid header/);
	});
});

describe('rainMapFromJson', () => {
	it('reads the committed synthetic grid: 0.01° cells over region Z, with its own source line', () => {
		const got = rainMapFromJson(JSON.parse(readFileSync(SYNTHETIC_MAP_GRID_FILE, 'utf8')));
		if (typeof got === 'string') throw new Error(got);
		expect(got.grid.cellDeg).toBe(0.01);
		expect(got.grid.cells).toHaveLength(1575);
		expect(got.meta.source).toMatch(/never real data/);
		for (const c of got.grid.cells) expect(c.mapMm).toBeGreaterThanOrEqual(300);
	});

	it('refuses a file with no cell size, no cells, a bad cell or one off the first cell’s grid', () => {
		expect(rainMapFromJson({ cells: [[21, -33, 500]] })).toMatch(/cellDeg/);
		expect(rainMapFromJson({ cellDeg: 0.1, cells: [] })).toMatch(/no "cells"/);
		expect(rainMapFromJson({ cellDeg: 0.1, cells: [[21.05, -33.05, 500], [21.15, -33.05, -1]] })).toMatch(/cell 2: not a MAP/);
		expect(rainMapFromJson({ cellDeg: 0.1, cells: [[21.05, -33.05, 500], [21.1, -33.05, 400]] })).toMatch(/cell 2: its centre isn't on/);
	});
});

describe('cellRange', () => {
	it('counts the cells a box meets, from the grid alone', () => {
		expect(cellRange({ cellDeg: 0.25, originLon: 0, originLat: 0 }, { w: 21.25, s: -33.75, e: 21.75, n: -33.25 })).toEqual({ r0: -135, r1: -134, c0: 85, c1: 86, most: 4 });
		expect(cellRange({ cellDeg: 0.01, originLon: 0, originLat: 0 }, { w: 21, s: -34, e: 21.8, n: -33.2 }).most).toBe(6400);
	});
});

describe('parseMapGridArgs', () => {
	it('loads the synthetic grid with no argument, and wants a label and a source for a real one', () => {
		expect(parseMapGridArgs([])).toMatchObject({ file: SYNTHETIC_MAP_GRID_FILE, dataset: 'synthetic', bbox: null });
		expect(parseMapGridArgs(['grid.asc'])).toMatch(/--dataset/);
		expect(parseMapGridArgs(['grid.asc', '--dataset', 'Lynch-2004'])).toMatch(/--source/);
		expect(parseMapGridArgs(['grid.tif', '--dataset', 'x'])).toMatch(/ESRI ASCII/);
		expect(parseMapGridArgs(['grid.asc', '--dataset', 'x', '--source', 's', '--bbox', '19,-33,18,-32'])).toMatch(/--bbox/);
		expect(parseMapGridArgs(['grid.asc', '--wat'])).toMatch(/unknown option --wat/);
		expect(parseMapGridArgs(['grid.asc', '--dataset', 'Lynch-2004', '--source', 'Lynch (2004)', '--bbox', '19,-33,19.5,-32.5'], { INIT_CWD: '/tmp' })).toEqual({
			file: '/tmp/grid.asc',
			dataset: 'Lynch-2004',
			source: 'Lynch (2004)',
			version: null,
			attribution: null,
			bbox: { w: 19, s: -33, e: 19.5, n: -32.5 }
		});
	});
});
