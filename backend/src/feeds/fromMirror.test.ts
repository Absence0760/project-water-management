// Fixtures mode of the worker's read from our copy of CHIRPS (fromMirror.ts):
// the committed copy, fixed at 2026-02-09, re-dated to "today" as the fixture
// files are (fixtures.ts), must give a feed's cells what the files give them,
// bit for bit, final or preliminary or unpublished, wherever in the files'
// cover the cell is. No database.
import { pathToFileURL } from 'node:url';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { describe, expect, it } from 'vitest';
import { MIRROR_FIXTURE_DIR } from '../../scripts/gen-mirror-fixture.js';
import { MirrorOutsideRegionError } from '../mirror/grid.js';
import { openStore } from '../mirror/store.js';
import { cellCentre, chcCell, encodeCellValue, type GridCell } from './cellCache.js';
import { FIXTURE_CELL, fixtureHttp } from './fixtures.js';
import { fixtureKind, fixtureSourceCell, mirrorReader } from './fromMirror.js';
import { fetchChirpsCells } from './sources/chirps.js';

const store = openStore(pathToFileURL(MIRROR_FIXTURE_DIR).href);
const add = (iso: string, n: number) => fromEpochDay(toEpochDay(iso) + n);

const home = chcCell(FIXTURE_CELL().lat, FIXTURE_CELL().lon);
// The fixture grid's sea cell (row 5, column 7 of chirps-sample.json's 8 × 6 grid, north-west corner 25.0° E, 20.0° S).
const SEA = chcCell(-20.275, 25.375);
// Cover cells far from the grid (they repeat it, with no sea): the far south-west, and a repeat of the sea cell.
const SOUTH_WEST = chcCell(-33.7, 21.3);
const SEA_REPEAT = chcCell(-20.275 - 0.3 * 20, 25.375 - 0.4 * 3);
// Outside the files' cover but inside the copy's region: the files refuse the point, the copy has no data there.
const OUTSIDE_COVER = chcCell(-30, 15);
const CELLS: GridCell[] = [home, SEA, SOUTH_WEST, SEA_REPEAT];

/** What the fixture files give these cells on `today`: the fetcher's read, encoded as the copy's reader answers. */
async function fromFiles(product: 'sat' | 'rnl', cells: GridCell[], start: string, plan: string, today: string) {
	const r = await fetchChirpsCells(fixtureHttp(() => today), cells.map(cellCentre), start, plan, product, { today });
	return { read: r.read, values: r.values.map((row) => row.map(encodeCellValue)) };
}

describe('fixtures mode: the committed copy re-dated to today', () => {
	it('fixtureSourceCell: a grid cell and a cell outside the cover are themselves, a cover cell is a land repeat south of the grid', () => {
		expect(fixtureSourceCell(home)).toEqual(home);
		expect(fixtureSourceCell(SEA)).toEqual(SEA);
		expect(fixtureSourceCell(OUTSIDE_COVER)).toEqual(OUTSIDE_COVER);
		const g0 = chcCell(-20.025, 25.025);
		const sw = fixtureSourceCell(SOUTH_WEST);
		expect(sw.row - g0.row).toBeGreaterThanOrEqual(6);
		expect(sw.row - g0.row).toBeLessThan(12);
		expect(sw.col - g0.col).toBeGreaterThanOrEqual(0);
		expect(sw.col - g0.col).toBeLessThan(8);
		// The sea cell's repeat is land, read one grid's height south of the sea cell.
		expect(fixtureSourceCell(SEA_REPEAT)).toEqual({ row: SEA.row + 6, col: SEA.col });
	});

	it('fixtureKind follows the files’ lags: final 40 days back, preliminary (sat) to 3 days back, nothing before a product starts', () => {
		const t = '2026-10-27';
		expect(fixtureKind('sat', add(t, -40), t)).toBe('f');
		expect(fixtureKind('sat', add(t, -39), t)).toBe('p');
		expect(fixtureKind('sat', add(t, -3), t)).toBe('p');
		expect(fixtureKind('sat', add(t, -2), t)).toBe('-');
		expect(fixtureKind('rnl', add(t, -39), t)).toBe('-');
		expect(fixtureKind('sat', '1997-12-31', t)).toBe('-');
		expect(fixtureKind('rnl', '1981-01-01', t)).toBe('f');
	});

	// Every residue of the 14-day pattern for today, so every alignment of the copy's dates is read.
	it.each(Array.from({ length: 14 }, (_, i) => add('2026-10-20', i)))('sat on %s: the last 60 days, final then preliminary then unpublished, as the files give them', async (today) => {
		const start = add(today, -60);
		const plan = '0'.repeat(60);
		const got = await mirrorReader('sat', today, store)(CELLS, { start, end: add(today, -1) }, plan);
		const files = await fromFiles('sat', CELLS, start, plan, today);
		expect(got.read).toBe(`${'f'.repeat(21)}${'p'.repeat(37)}--`);
		expect(got).toEqual(files);
	});

	it('rnl across a new year long ago, and sat with a plan that skips days and reads others final-only', async () => {
		const today = '2026-10-27';
		const rnl = await mirrorReader('rnl', today, store)(CELLS, { start: '1999-11-15', end: add('1999-11-15', 119) }, '0'.repeat(120));
		expect(rnl.read).toBe('f'.repeat(120));
		expect(rnl).toEqual(await fromFiles('rnl', CELLS, '1999-11-15', '0'.repeat(120), today));
		const start = add(today, -45);
		const plan = `${'1'.repeat(5)}${'0'.repeat(5)}${'2'.repeat(30)}${'0'.repeat(4)}`;
		const sat = await mirrorReader('sat', today, store)(CELLS, { start, end: add(start, plan.length - 1) }, plan);
		// Today−40 is final and today−39… preliminary; the final-only days hold none; today−2 isn't out.
		expect(sat.read).toBe(`${'-'.repeat(5)}fpppp${'-'.repeat(30)}ppp-`);
		expect(sat).toEqual(await fromFiles('sat', CELLS, start, plan, today));
	});

	it('reads a cell outside the files’ cover as no data, as a sea cell (the files refuse the point; either way the feed has no data there)', async () => {
		const got = await mirrorReader('rnl', '2026-10-27', store)([OUTSIDE_COVER, home], { start: '2024-03-01', end: '2024-03-02' }, '00');
		expect(got.read).toBe('ff');
		expect(got.values[0]).toEqual([-1, -1]);
		expect(got.values[1]!.every((v) => v !== null && v >= 0)).toBe(true);
	});

	it('refuses a cell outside the copy’s region before reading anything, naming the region', async () => {
		const read = mirrorReader('sat', '2026-10-27', store)([chcCell(-5, 30)], { start: '2026-01-01', end: '2026-01-02' }, '00');
		await expect(read).rejects.toBeInstanceOf(MirrorOutsideRegionError);
		await expect(read).rejects.toThrow('outside the region the rain data copy holds (10–41° E, 8–35.5° S)');
	});
});
