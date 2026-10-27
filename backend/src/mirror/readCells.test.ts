import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { toEpochDay } from '@water-management/engine/calendar';
import { inventedRain, MIRROR_FIXTURE, MIRROR_FIXTURE_DIR } from '../../scripts/gen-mirror-fixture.js';
import { cellCentre, encodeCellValue, type GridCell, productCell } from '../feeds/cellCache.js';
import { FeedFormatError } from '../feeds/errors.js';
import { CellsResult } from '../feeds/fetch.js';
import { fixtureHttp } from '../feeds/fixtures.js';
import { fetchChirpsCells } from '../feeds/sources/chirps.js';
import { ensureFinals, openFinals, readFinalsBlock, writeFinalsYear } from './arrays.js';
import { chcCellOf, MIRROR_REGION, mirrorCell, MirrorOutsideRegionError } from './grid.js';
import { imergFileDay, type Manifest, MirrorManifestError, readManifest, writeManifest } from './manifest.js';
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
		await writeManifest(store, { ...m, files: m.files.filter((f) => f.url.includes('.2024.')), years: { first: 2024, last: 2024 }, finalThrough: '2024-12-31' });
		await expect(readCells(store, 'rnl', [LAND_NW], { start: '2024-01-01', end: '2024-01-01' })).rejects.toThrow(FeedFormatError);
		await expect(readCells(store, 'rnl', [LAND_NW], { start: '2024-01-01', end: '2024-01-01' })).rejects.toThrow(/implausible rainfall of 3000/);
	});

	describe('a gap in the months copied', () => {
		// A copy of 2024 with January and March but not February (a partial backfill plus a newer month).
		const gapped = async (finalThrough: string, months: string[] = ['01', '03']) => {
			const store = fresh();
			const f = await ensureFinals(store, 'rnl', 2024);
			await writeFinalsYear(f, 2024, { y0: 309, x0: 300, h: 1, w: 1 }, new Float32Array(366).fill(4.5));
			const m = (await readManifest(fixture, 'rnl'))!;
			const files = months.map((mm) => m.files.find((x) => x.url.endsWith(`.2024.${mm}.days_p05.nc`))!);
			const doc: Manifest = { ...m, files, years: { first: 2024, last: 2024 }, finalThrough };
			// Written raw, so a manifest the validation refuses reaches the reader too.
			await store.set('/rnl/manifest.json', new TextEncoder().encode(JSON.stringify(doc)));
			return store;
		};

		it('reads the contiguous months as final and the missing month as not held, never final no-data', async () => {
			const store = await gapped('2024-01-31');
			const got = await readCells(store, 'rnl', [LAND_NW], { start: '2024-01-30', end: '2024-02-02' });
			expect(got.cells.read).toBe('ff--');
			expect(got.cells.values).toEqual([[4.5, 4.5, null, null].map((v) => (v === null ? null : encodeCellValue(v)))]);
			// March is copied, but past the gap: not final either.
			expect((await readCells(store, 'rnl', [LAND_NW], { start: '2024-03-01', end: '2024-03-01' })).cells.read).toBe('-');
		});

		it('refuses a manifest whose finalThrough runs over the gap', async () => {
			const store = await gapped('2024-03-31');
			await expect(readCells(store, 'rnl', [LAND_NW], { start: '2024-02-01', end: '2024-02-01' })).rejects.toThrow(MirrorManifestError);
			await expect(readCells(store, 'rnl', [LAND_NW], { start: '2024-02-01', end: '2024-02-01' })).rejects.toThrow(/finalThrough runs past/);
		});

		it('reads no day before the first month copied as final', async () => {
			const store = await gapped('2024-03-31', ['03']);
			const got = await readCells(store, 'rnl', [LAND_NW], { start: '2024-02-29', end: '2024-03-01' });
			expect(got.cells.read).toBe('-f');
			expect(got.cells.values).toEqual([[null, encodeCellValue(4.5)]]);
		});
	});
});

describe('readCells of the 0.1° products (issue #604 R4-B)', () => {
	// Two 0.1° cells of the fixture's written block (the fixture grid's north-west 0.05° cell's, and the one south-east
	// of it), and one in an unwritten chunk.
	const NW = productCell('era5l', -20.025, 25.025);
	const SE = { row: NW.row + 1, col: NW.col + 1 };
	const FAR = chcCellOf({ y: 5, x: 5 }, MIRROR_REGION, 0.1);
	const at = (c: GridCell) => mirrorCell(c, MIRROR_REGION, 0.1);
	const expected = (c: GridCell, day: string, salt: number) => encodeCellValue(inventedRain(at(c).y, at(c).x, toEpochDay(day), salt));

	it('reads era5l finals across a leap year’s end on the 0.1° grid, nothing past finalThrough', async () => {
		const got = await readCells(fixture, 'era5l', [NW, SE, FAR], { start: '2024-12-30', end: '2026-01-01' }, {});
		expect(got.cells.product).toBe('era5l');
		// finalThrough is 2025-12-30, the last day month 2025-12's request holds (2025-12-31 comes with 2026-01's).
		expect(got.cells.read).toBe(`${'f'.repeat(366)}--`);
		for (const [i, day] of ['2024-12-30', '2024-12-31', '2025-01-01'].entries()) {
			expect(got.cells.values[0]![i]).toBe(expected(NW, day, 1));
			expect(got.cells.values[1]![i]).toBe(expected(SE, day, 1));
		}
		// An unwritten chunk is no data; past finalThrough nothing is read.
		expect(got.cells.values[2]![0]).toBe(-1);
		expect(got.cells.values[0]!.at(-1)).toBeNull();
		expect(got.versions).toBeUndefined();
		expect(got.revision).toEqual({ final: 1, prelim: null });
		// 29 February 2024 is a day; the year axis starts in 1950, so 1950 reads (unwritten: no data).
		expect((await readCells(fixture, 'era5l', [NW], { start: '2024-02-29', end: '2024-02-29' })).cells.values[0]).toEqual([expected(NW, '2024-02-29', 1)]);
	});

	it('reads no era5l day before the first month request the manifest holds, though its year is within years', async () => {
		// The copy without its first two months: it holds from 2024-02-29 (month 2024-03's first day).
		const m = (await readManifest(fixture, 'era5l'))!;
		const later = { ...m, files: m.files.filter((f) => !/\/2024-0[12]$/.test(f.url)) };
		const bytes = new TextEncoder().encode(JSON.stringify(later));
		const store = { get: (k: string) => (k === '/era5l/manifest.json' ? Promise.resolve(bytes) : fixture.get(k as never)), set: fixture.set.bind(fixture) } as typeof fixture;
		const got = await readCells(store, 'era5l', [NW], { start: '2024-02-27', end: '2024-03-01' });
		expect(got.cells.read).toBe('--ff');
		expect(got.cells.values[0]).toEqual([null, null, expected(NW, '2024-02-29', 1), expected(NW, '2024-03-01', 1)]);
	});

	it('reads imerg_late’s daily days with their versions, nothing before its first day or past finalThrough', async () => {
		const got = await readCells(fixture, 'imerg_late', [NW, SE], { start: '2026-01-24', end: '2026-02-09' });
		expect(got.cells.read).toBe(`-${'f'.repeat(15)}-`);
		expect(got.cells.values[0]![1]).toBe(expected(NW, '2026-01-25', 2));
		expect(got.cells.values[1]![15]).toBe(expected(SE, '2026-02-08', 2));
		expect(got.versions).toEqual([null, ...Array<string>(13).fill('V07'), 'V08', 'V08', null]);
		// A skipped day is unread, as for CHIRPS.
		expect((await readCells(fixture, 'imerg_late', [NW], { start: '2026-02-07', end: '2026-02-08' }, { plan: '10' })).cells.read).toBe('-f');
	});

	it('reads an imerg_late day with no file as not held, and the days after it as usual (each day stands on its own)', async () => {
		// The fixture copy, with one day more than 10 days before prelimThrough (out of the search's look-back) gone from
		// the manifest: CMR never listed it, so no later run fills it.
		const dir = mkdtempSync(join(tmpdir(), 'mirror-read-'));
		tmp.push(dir);
		cpSync(MIRROR_FIXTURE_DIR, dir, { recursive: true });
		const store = openStore(pathToFileURL(dir).href);
		const m = (await readManifest(store, 'imerg_late'))!;
		const gap = '2026-01-26';
		expect(toEpochDay(m.prelimThrough!) - toEpochDay(gap)).toBeGreaterThan(10);
		await writeManifest(store, { ...m, files: m.files.filter((f) => imergFileDay(f.url) !== gap) });
		const got = await readCells(store, 'imerg_late', [NW], { start: '2026-01-25', end: '2026-02-08' });
		expect(got.cells.read).toBe(`f-${'f'.repeat(13)}`);
		expect(got.cells.values[0]![1]).toBeNull();
		expect(got.cells.values[0]![2]).toBe(expected(NW, '2026-01-27', 2));
		expect(got.cells.values[0]![14]).toBe(expected(NW, '2026-02-08', 2));
		expect(got.versions![1]).toBeNull();
	});

	it('refuses a 0.1° cell outside the region, and is not ready while the copy has no such product', async () => {
		await expect(readCells(fixture, 'era5l', [{ row: 600, col: 1800 }], { start: '2025-01-01', end: '2025-01-01' })).rejects.toThrow(MirrorOutsideRegionError);
		const dir = mkdtempSync(join(tmpdir(), 'mirror-read-'));
		tmp.push(dir);
		await expect(readCells(openStore(pathToFileURL(dir).href), 'imerg_late', [NW], { start: '2025-01-01', end: '2025-01-01' })).rejects.toThrow(MirrorNotReadyError);
	});
});
