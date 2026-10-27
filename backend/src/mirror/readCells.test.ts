import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { MIRROR_FIXTURE, MIRROR_FIXTURE_DIR } from '../../scripts/gen-mirror-fixture.js';
import { cellCentre, encodeCellValue, type GridCell } from '../feeds/cellCache.js';
import { FeedFormatError } from '../feeds/errors.js';
import { CellsResult } from '../feeds/fetch.js';
import { fixtureHttp } from '../feeds/fixtures.js';
import { fetchChirpsCells } from '../feeds/sources/chirps.js';
import { ensureFinals, openFinals, readFinalsBlock, writeFinalsYear } from './arrays.js';
import { chcCellOf, MirrorOutsideRegionError } from './grid.js';
import { readManifest, writeManifest } from './manifest.js';
import { MirrorNotReadyError, readCells } from './readCells.js';
import { openStore } from './store.js';

const fixture = openStore(pathToFileURL(MIRROR_FIXTURE_DIR).href);
const tmp: string[] = [];
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));

// Cells of the fixture grid's written chunk: its north-west cell, a corner of the
// chunk, and its sea cell (row 5, col 7 of chirps-sample.json's grid).
const LAND_NW = chcCellOf({ y: 309, x: 300 });
const LAND_SE = chcCellOf({ y: 300, x: 307 });
const SEA = chcCellOf({ y: 304, x: 307 });
const CELLS: GridCell[] = [LAND_NW, LAND_SE, SEA];

/** What the fetcher answers today, from the synthetic files the fixture copy was made from. */
async function fromFiles(product: 'sat' | 'rnl', cells: GridCell[], start: string, plan: string) {
	const r = await fetchChirpsCells(fixtureHttp(() => MIRROR_FIXTURE.today), cells.map(cellCentre), start, plan, product, { today: MIRROR_FIXTURE.today });
	return { read: r.read, values: r.values.map((row) => row.map(encodeCellValue)) };
}

describe('readCells from the committed fixture copy', () => {
	it('gives rnl across two years bit for bit as the files do, in CellsResult’s shape', async () => {
		const got = await readCells(fixture, 'rnl', CELLS, { start: '2023-12-30', end: '2024-01-02' });
		expect(got.cells.read).toBe('ffff');
		expect(got.cells.cells).toEqual(CELLS.map((c) => [c.row, c.col]));
		expect({ read: got.cells.read, values: got.cells.values }).toEqual(await fromFiles('rnl', CELLS, '2023-12-30', '0000'));
		// The sea is no data (-1) on every day read; land is a value.
		expect(got.cells.values[2]).toEqual([-1, -1, -1, -1]);
		expect(got.cells.values[0]!.every((v) => v !== null && v >= 0)).toBe(true);
		expect(got.revision).toEqual({ final: 1, prelim: null });
		// The answer passes the fetcher's own schema.
		expect(CellsResult.safeParse({ ok: true, cells: got.cells, meta: {} }).success).toBe(true);
	});

	it('reads sat finals, then the preliminary days, then nothing past the copy', async () => {
		const window = { start: '2025-12-29', end: '2026-02-08' };
		const got = await readCells(fixture, 'sat', CELLS, window);
		const files = await fromFiles('sat', CELLS, window.start, '0'.repeat(42));
		expect(got.cells.read).toBe(`fff${'p'.repeat(37)}--`);
		expect({ read: got.cells.read, values: got.cells.values }).toEqual(files);
		expect(got.revision).toEqual({ final: 1, prelim: 1 });
	});

	it('follows the plan: a skipped day is unread, a final-only day never reads the preliminary copy', async () => {
		const got = await readCells(fixture, 'sat', [LAND_NW], { start: '2025-12-30', end: '2026-01-02' }, { plan: '1020' });
		expect(got.cells.read).toBe('-f-p');
		expect(got.cells.values[0]!.map((v) => v === null)).toEqual([true, false, true, false]);
		expect({ read: got.cells.read, values: got.cells.values }).toEqual(await fromFiles('sat', [LAND_NW], '2025-12-30', '1020'));
	});

	it('reads a cell in an unwritten chunk as no data on a final day', async () => {
		const far = chcCellOf({ y: 10, x: 10 });
		const got = await readCells(fixture, 'rnl', [far, LAND_NW], { start: '2024-03-01', end: '2024-03-02' });
		expect(got.cells.values).toEqual([[-1, -1], [expect.any(Number), expect.any(Number)]]);
		expect(got.cells.values[1]!.every((v) => (v as number) >= 0)).toBe(true);
	});

	it('leaves index 365 NaN in a year with no 29 February', async () => {
		const f = (await openFinals(fixture, 'rnl'))!;
		const block = { y0: 309, x0: 300, h: 1, w: 1 };
		const y2023 = await readFinalsBlock(f, 2023, 364, 365, block);
		expect(Number.isNaN(y2023.values[0])).toBe(false);
		expect(y2023.values[1]).toBeNaN();
		const y2024 = await readFinalsBlock(f, 2024, 365, 365, block);
		expect(Number.isNaN(y2024.values[0])).toBe(false);
	});

	it('refuses a cell outside the region before reading anything', async () => {
		const outside = { row: 1200, col: 3600 }; // 0° N, 0° E
		await expect(readCells(fixture, 'rnl', [LAND_NW, outside], { start: '2024-01-01', end: '2024-01-02' })).rejects.toThrow(MirrorOutsideRegionError);
		await expect(readCells(openStore('file:///nonexistent-mirror-dir'), 'rnl', [outside], { start: '2024-01-01', end: '2024-01-01' })).rejects.toThrow(
			/outside the region the rain data copy holds/
		);
	});

	it('refuses a plan of the wrong length', async () => {
		await expect(readCells(fixture, 'rnl', [LAND_NW], { start: '2024-01-01', end: '2024-01-02' }, { plan: '0' })).rejects.toThrow(RangeError);
	});
});

describe('readCells from other copies', () => {
	const fresh = () => {
		const dir = mkdtempSync(join(tmpdir(), 'mirror-read-'));
		tmp.push(dir);
		return openStore(pathToFileURL(dir).href);
	};

	it('is unavailable (not a format error) while the copy has no such product', async () => {
		await expect(readCells(fresh(), 'rnl', [LAND_NW], { start: '2024-01-01', end: '2024-01-01' })).rejects.toThrow(MirrorNotReadyError);
	});

	it('refuses an implausible value, as a read from the files does', async () => {
		const store = fresh();
		const f = await ensureFinals(store, 'rnl', 2024);
		const block = { y0: 309, x0: 300, h: 1, w: 1 };
		await writeFinalsYear(f, 2024, block, new Float32Array(366).fill(3000));
		const m = (await readManifest(fixture, 'rnl'))!;
		await writeManifest(store, { ...m, files: [], years: { first: 2024, last: 2024 }, finalThrough: '2024-12-31' });
		await expect(readCells(store, 'rnl', [LAND_NW], { start: '2024-01-01', end: '2024-01-01' })).rejects.toThrow(FeedFormatError);
		await expect(readCells(store, 'rnl', [LAND_NW], { start: '2024-01-01', end: '2024-01-01' })).rejects.toThrow(/implausible rainfall of 3000/);
	});
});
