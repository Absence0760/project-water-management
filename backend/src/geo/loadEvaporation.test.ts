// Pre-summarising a daily evaporation product into monthly means
// (loadEvaporation.ts) and the operator's command
// (scripts/import-evaporation.ts): dPET-shaped NetCDF-4 files built here with
// h5wasm (float with a fill value, and int16 packed with scale_factor and
// add_offset), each month summed by hand; a leap year; the box; the years
// averaged into water-year means; the refusals; the fixture form; the
// arguments; and the committed synthetic fixture.
import h5wasm from 'h5wasm/node';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEvaporationArgs, readEvaporationFiles, reduceDpet, SYNTHETIC_APAN_ASC_FILES, SYNTHETIC_SPAN_ASC_FILES, SYNTHETIC_EVAPORATION_FILE, writeEvaporationJson } from '../../scripts/import-evaporation.js';
import { monthlyFromAsciiGrids, ATLAS_APAN, ATLAS_SPAN, atlasApanMethodFor, atlasSpanMethodFor, monthlyGridsMethodFor, climatology, dpetYear, evaporationFromJson, originOf, sameOrigin, readDpetYear, SOUTH_AFRICA_BBOX, toWaterYear, yearTotalsFromJson, type YearTotals } from './loadEvaporation.js';

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
let dir: string;

interface NcSpec {
	year: number;
	lats: number[];
	lons: number[];
	/** The day's value at (day of year, lat index, lon index), mm/day. */
	value: (day: number, y: number, x: number) => number;
	/** Packed as int16 with this scale (and add_offset 0.5), instead of float32. */
	packed?: number;
	fill?: number;
	name?: string;
}

/** A dPET-shaped file: pet (time, latitude, longitude) and the two axes. */
async function nc(s: NcSpec): Promise<string> {
	await h5wasm.ready;
	const days = s.year % 4 === 0 ? 366 : 365;
	const path = join(dir, s.name ?? `${s.year}_daily_pet.nc`);
	const n = days * s.lats.length * s.lons.length;
	const raw = s.packed ? new Int16Array(n) : new Float32Array(n);
	for (let d = 0; d < days; d++)
		for (let y = 0; y < s.lats.length; y++)
			for (let x = 0; x < s.lons.length; x++) {
				const v = s.value(d, y, x);
				raw[(d * s.lats.length + y) * s.lons.length + x] = s.packed && v !== s.fill ? Math.round((v - 0.5) / s.packed) : v;
			}
	const f = new h5wasm.File(path, 'w');
	f.create_dataset({ name: 'latitude', data: new Float32Array(s.lats) });
	f.create_dataset({ name: 'longitude', data: new Float32Array(s.lons) });
	f.create_dataset({ name: 'pet', data: raw, shape: [days, s.lats.length, s.lons.length], dtype: s.packed ? '<h' : '<f', chunks: [31, s.lats.length, s.lons.length], compression: 4 });
	const pet = f.get('pet') as unknown as { create_attribute: (name: string, data: unknown, shape?: number[] | null, dtype?: string | null) => void };
	if (s.fill !== undefined) pet.create_attribute('_FillValue', s.fill, null, s.packed ? '<h' : '<f');
	if (s.packed) {
		pet.create_attribute('scale_factor', s.packed, null, '<f');
		pet.create_attribute('add_offset', 0.5, null, '<f');
	}
	f.close();
	return path;
}

/** The calendar month of day `d` (0-based) of `year`. */
function monthOf(year: number, d: number): number {
	let left = d;
	for (let m = 0; m < 12; m++) {
		const n = m === 1 && year % 4 === 0 ? 29 : MONTH_DAYS[m]!;
		if (left < n) return m;
		left -= n;
	}
	throw new Error('past the year');
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'wm-evap-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const LATS = [-33.5, -33.6, -33.7];
const LONS = [21.2, 21.3, 21.4, 21.5];

describe('readDpetYear', () => {
	it('sums each cell’s days into calendar-month totals inside the box, leaving out a cell with a missing day', async () => {
		// mm/day: (month + 1) + 0.25 × lon index; one missing day at (−33.7, 21.4) in March.
		const path = await nc({
			year: 2021,
			lats: LATS,
			lons: LONS,
			fill: -9999,
			value: (d, y, x) => (y === 2 && x === 2 && d === 70 ? -9999 : monthOf(2021, d) + 1 + 0.25 * x)
		});
		// The box keeps columns 21.3–21.5 and rows −33.6, −33.7.
		const got = await readDpetYear(path, { west: 21.25, south: -33.75, east: 21.55, north: -33.55 });
		expect(got).toMatchObject({ product: 'dPET', year: 2021, cellDeg: 0.1 });
		expect(got.cells.map(([lon, lat]) => [lon, lat])).toEqual([
			[21.3, -33.6],
			[21.4, -33.6],
			[21.5, -33.6],
			[21.3, -33.7],
			[21.5, -33.7]
		]);
		const [lon, , totals] = got.cells[0]!;
		expect(lon).toBe(21.3);
		expect(totals).toEqual(MONTH_DAYS.map((n, m) => Math.round((m + 1 + 0.25) * n * 100) / 100));
	});

	it('unpacks int16 with scale_factor and add_offset, and counts 29 days in a leap February', async () => {
		const path = await nc({ year: 2020, lats: LATS, lons: LONS, packed: 0.01, value: () => 3.5 });
		const got = await readDpetYear(path, { west: 21.15, south: -33.75, east: 21.55, north: -33.45 });
		expect(got.cells).toHaveLength(12);
		const feb = got.cells[0]![2][1]!;
		expect(feb).toBeCloseTo(3.5 * 29, 6);
		expect(got.cells[0]![2][0]).toBeCloseTo(3.5 * 31, 6);
	});

	it('refuses a file not named for its year, a wrong shape, and a box with no cell', async () => {
		const unnamed = await nc({ year: 2021, lats: LATS, lons: LONS, value: () => 1, name: 'pet.nc' });
		await expect(readDpetYear(unnamed, SOUTH_AFRICA_BBOX)).rejects.toThrow(/name the file <year>_daily_pet.nc/);
		// A 2021 file named 2020 (a leap year): 365 days, not 366.
		const misnamed = await nc({ year: 2021, lats: LATS, lons: LONS, value: () => 1, name: '2020_daily_pet.nc' });
		await expect(readDpetYear(misnamed, SOUTH_AFRICA_BBOX)).rejects.toThrow(/pet is 365 × 3 × 4, not 366 days/);
		const path = await nc({ year: 2019, lats: LATS, lons: LONS, value: () => 1 });
		await expect(readDpetYear(path, { west: 0, south: 0, east: 1, north: 1 })).rejects.toThrow(/no cell centre lies inside the box/);
	});

	it('dpetYear reads the year from the dataset’s file name', () => {
		expect(dpetYear('/data/1991_daily_pet.nc')).toBe(1991);
		expect(dpetYear('2020_hourly_pet.nc')).toBeNull();
		expect(dpetYear('x2020_daily_pet.nc')).toBeNull();
	});
});

describe('climatology', () => {
	const year = (y: number, cells: YearTotals['cells']): YearTotals => ({ product: 'dPET', year: y, cellDeg: 0.1, cells });
	const cal = (v: number) => Array.from({ length: 12 }, (_, m) => v + m);

	it('averages each calendar month over the years into water-year order, keeping only cells every year has', () => {
		const c = climatology([
			year(2001, [
				[21.3, -33.7, cal(10)],
				[21.4, -33.7, cal(5)]
			]),
			year(2000, [[21.3, -33.7, cal(20)]])
		]);
		if (typeof c === 'string') throw new Error(c);
		expect(c).toMatchObject({ cellDeg: 0.1, firstYear: 2000, lastYear: 2001, partial: 1 });
		expect(c.originLon).toBeCloseTo(0.05, 9);
		expect(c.originLat).toBeCloseTo(0.05, 9);
		expect(c.cells).toEqual([{ row: -338, col: 212, monthlyMm: toWaterYear(cal(15)) }]);
		// Oct first.
		expect(c.cells[0]!.monthlyMm[0]).toBe(15 + 9);
	});

	it('refuses a repeated year, a gap, or no years', () => {
		expect(climatology([])).toBe('no years to average');
		expect(climatology([year(2000, [[21.3, -33.7, cal(1)]]), year(2000, [[21.3, -33.7, cal(1)]])])).toBe('2000 is given twice');
		expect(climatology([year(2000, [[21.3, -33.7, cal(1)]]), year(2002, [[21.3, -33.7, cal(1)]])])).toMatch(/skip from 2000 to 2002/);
	});

	it('yearTotalsFromJson reads back what --reduce writes, and refuses anything else', () => {
		expect(yearTotalsFromJson({ product: 'dPET', year: 2000, cellDeg: 0.1, cells: [] })).toEqual({ product: 'dPET', year: 2000, cellDeg: 0.1, cells: [] });
		expect(yearTotalsFromJson({ kind: 'et0' })).toMatch(/not a year of dPET totals/);
	});

	it('originOf puts a whole-tenth centre’s corner half a cell off, and a corner-aligned grid at 0', () => {
		expect(originOf(20.5, 0.1)).toBeCloseTo(0.05, 9);
		expect(originOf(-34.5, 0.1)).toBeCloseTo(0.05, 9);
		expect(originOf(20.55, 0.1)).toBe(0);
	});

	it('originOf counts an origin within 1e-6° under a whole cell as 0, so a 1′ grid on whole tenths and its rounded centres agree', () => {
		const cell = 0.016666666667;
		// 21.3 is 1278 cells of 0.016666666667° less 4e-8: the corner sits just under a whole cell.
		expect(originOf(21.3 + cell / 2, cell)).toBe(0);
		expect(originOf(Math.round((21.3 + cell / 2) * 1e6) / 1e6, cell)).toBe(0);
		expect(sameOrigin(cell - 5e-7, 2e-7, cell)).toBe(true);
		expect(sameOrigin(0.005, 0.0051, cell)).toBe(false);
	});
});

describe('the fixture form and the command', () => {
	it('evaporationFromJson reads an S-pan dataset as kind span (a cross-check only), and refuses a missing kind and bad cells', () => {
		const span = evaporationFromJson({ kind: 'span', cellDeg: 0.1, firstYear: 1950, lastYear: 1999, cells: [[21.25, -33.75, Array.from({ length: 12 }, () => 100)]] });
		if (typeof span === 'string') throw new Error(span);
		expect(span.kind).toBe('span');
		expect(evaporationFromJson({ kind: 'mm' })).toMatch(/"span" \(Symons pan, shown as a cross-check only\)/);
		// Only an A-pan grid carries a PenPan model.
		expect(evaporationFromJson({ kind: 'span', cellDeg: 0.1, firstYear: 1950, lastYear: 1999, model: { name: 'penpan' }, cells: [[21.25, -33.75, Array.from({ length: 12 }, () => 100)]] })).toMatch(/only an A-pan grid/);
		expect(evaporationFromJson({ cellDeg: 0.1 })).toMatch(/no "kind"/);
		const got = evaporationFromJson({
			kind: 'apan',
			cellDeg: 0.1,
			firstYear: 2000,
			lastYear: 2009,
			cells: [
				[21.3, -33.7, cal12(100)],
				[21.4, -33.7, [1, 2]],
				[21.35, -33.7, cal12(100)],
				[21.5, -33.7, cal12(-1)]
			]
		});
		if (typeof got === 'string') throw new Error(got);
		expect(got.kind).toBe('apan');
		expect(got.climatology.cells).toEqual([{ row: -338, col: 212, monthlyMm: cal12(100) }]);
		expect(got.problems).toEqual(['cell 2: not 12 monthly values of 0–1000 mm', "cell 3: its centre isn't on the first cell's 0.1° grid", 'cell 4: not 12 monthly values of 0–1000 mm']);
	});

	it('parses the arguments: the fixture by default, --reduce, a load, and the refusals', () => {
		const env = { INIT_CWD: '/work' } as NodeJS.ProcessEnv;
		expect(parseEvaporationArgs([], env)).toMatchObject({ mode: 'load', files: [SYNTHETIC_EVAPORATION_FILE], dataset: 'synthetic', bbox: SOUTH_AFRICA_BBOX });
		expect(parseEvaporationArgs(['--reduce', 'out', '1991_daily_pet.nc', '--bbox', '20,-34,22,-32'], env)).toEqual({
			mode: 'reduce',
			out: '/work/out',
			files: ['/work/1991_daily_pet.nc'],
			bbox: { west: 20, south: -34, east: 22, north: -32 }
		});
		expect(parseEvaporationArgs(['a.json', 'b.nc', '--dataset', 'dPET-1991-2020', '--version', 'v3'], env)).toMatchObject({
			mode: 'load',
			files: ['/work/a.json', '/work/b.nc'],
			dataset: 'dPET-1991-2020',
			version: 'v3'
		});
		expect(parseEvaporationArgs(['a.nc'], env)).toMatch(/--dataset/);
		expect(parseEvaporationArgs(['a.nc', '--dataset', 'synthetic'], env)).toMatch(/committed fixture's label/);
		expect(parseEvaporationArgs(['a.tif', '--dataset', 'x'], env)).toMatch(/give dPET files/);
		expect(parseEvaporationArgs(['--reduce', 'out', 'a.json'], env)).toMatch(/--reduce takes dPET files/);
		expect(parseEvaporationArgs(['--bbox', '1,2', 'a.nc', '--dataset', 'x'], env)).toMatch(/--bbox takes/);
		expect(parseEvaporationArgs(['--nope'], env)).toBe('unknown option --nope');
		expect(parseEvaporationArgs(['a.json', '--dataset', 'x', '--out', 'grid.json.gz'], env)).toMatchObject({ mode: 'load', out: '/work/grid.json.gz' });
		expect(parseEvaporationArgs(['a.json', '--dataset', 'x'], env)).toMatchObject({ out: null });
		expect(parseEvaporationArgs(['a.json', '--dataset', 'x', '--out', 'grid.csv'], env)).toMatch(/--out takes a \.json or \.json\.gz file/);
	});

	it('reduces two dPET years to totals and loads them as reference ET averaged over both', async () => {
		const a = await nc({ year: 2017, lats: LATS, lons: LONS, value: () => 2 });
		const b = await nc({ year: 2018, lats: LATS, lons: LONS, value: () => 4 });
		const box = { west: 21.25, south: -33.65, east: 21.35, north: -33.55 };
		const written = await reduceDpet({ mode: 'reduce', out: join(dir, 'reduced'), files: [a, b], bbox: box });
		expect(written.map((f) => f.split('/').at(-1))).toEqual(['2017.dpet-monthly.json', '2018.dpet-monthly.json']);
		const read = await readEvaporationFiles({ mode: 'load', files: written, dataset: 'dPET-2017-2018', bbox: box, source: null, version: null, attribution: null });
		expect(read.meta).toMatchObject({ dataset: 'dPET-2017-2018', kind: 'et0', source: expect.stringMatching(/^dPET, the daily files of hPET/), version: 'hPET v3 (University of Bristol data.bris)' });
		expect(read.meta.method).toMatch(/averaged over 2017–2018/);
		expect(read.climatology.cells).toEqual([{ row: -337, col: 212, monthlyMm: toWaterYear(MONTH_DAYS.map((n) => 3 * n)) }]);
		// The .nc files read directly give the same.
		const direct = await readEvaporationFiles({ mode: 'load', files: [a, b], dataset: 'x', bbox: box, source: null, version: null, attribution: null });
		expect(direct.climatology.cells).toEqual(read.climatology.cells);
	});

	it('--out writes the averaged years as the fixture form, which reads back to the same grid, source and years', async () => {
		const a = await nc({ year: 2019, lats: LATS, lons: LONS, value: () => 2 });
		const b = await nc({ year: 2020, lats: LATS, lons: LONS, value: () => 4 });
		const box = { west: 21.15, south: -33.75, east: 21.45, north: -33.45 };
		const args = { mode: 'load' as const, files: [a, b], dataset: 'dPET-2019-2020', bbox: box, source: null, version: null, attribution: null };
		const direct = await readEvaporationFiles(args);
		expect(direct.climatology.cells.length).toBeGreaterThan(1);
		const out = join(dir, 'grid.json.gz');
		expect(await writeEvaporationJson({ ...args, out })).toEqual({ written: direct.climatology.cells.length, problems: [] });
		const doc = JSON.parse(gunzipSync(readFileSync(out)).toString('utf8'));
		expect(doc).toMatchObject({ kind: 'et0', cellDeg: 0.1, firstYear: 2019, lastYear: 2020, source: direct.meta.source, version: direct.meta.version, attribution: direct.meta.attribution });
		const back = evaporationFromJson(doc);
		if (typeof back === 'string') throw new Error(back);
		expect(back.problems).toEqual([]);
		expect(back.climatology).toEqual(direct.climatology);
		// A box with no cell is refused and writes no file.
		const away = { ...args, bbox: { west: 30, south: -25, east: 30.3, north: -24.7 } };
		await expect(writeEvaporationJson({ ...away, out: join(dir, 'none.json') })).rejects.toThrow(/no cell centre lies inside the box/);
		expect(existsSync(join(dir, 'none.json'))).toBe(false);
		expect(evaporationFromJson({ kind: 'et0', cellDeg: 0.1, firstYear: 1991, lastYear: 2020, cells: [null] })).toMatch(/first cell/);
	});

	it('the committed synthetic fixture loads whole: 429 cells of reference ET, the base row in the four test cells', async () => {
		const args = parseEvaporationArgs([]);
		if (typeof args === 'string' || args.mode !== 'load') throw new Error(String(args));
		const read = await readEvaporationFiles(args);
		expect(read.problems).toEqual([]);
		expect(read.meta).toMatchObject({ dataset: 'synthetic', kind: 'et0', version: 'synthetic 1' });
		expect(read.climatology).toMatchObject({ cellDeg: 0.1, firstYear: 1991, lastYear: 2020 });
		expect(read.climatology.cells).toHaveLength(429);
		const doc = JSON.parse(readFileSync(SYNTHETIC_EVAPORATION_FILE, 'utf8'));
		expect(doc.source).toMatch(/^SYNTHETIC/);
		const base = [120, 150, 175, 180, 150, 130, 90, 65, 50, 55, 75, 95];
		for (const [r, c] of [
			[-338, 212],
			[-338, 213],
			[-337, 212],
			[-337, 213]
		])
			expect(read.climatology.cells.find((x) => x.row === r && x.col === c)?.monthlyMm).toEqual(base);
	});
});

function cal12(v: number) {
	return Array.from({ length: 12 }, () => v);
}

describe('12 monthly A-pan grids as ESRI ASCII (--apan-asc; the WRC Atlas’s A-pan equivalent)', () => {
	const BASE = [250, 210, 180, 120, 80, 55, 60, 85, 120, 170, 210, 245];
	const head = (x = '21.3', y = '-33.7') => ['ncols 2', 'nrows 1', `xllcorner ${x}`, `yllcorner ${y}`, 'cellsize 0.016666666667', 'NODATA_value -9999'];
	const months = (row: (m: number) => string, h = head) => BASE.map((_, m) => ({ name: `m${m + 1}.asc`, lines: [...h(), row(m)] }));

	it('keeps the cells with a value in every month, in water-year order, on the 1′ grid', async () => {
		const c = await monthlyFromAsciiGrids(
			months((m) => `${BASE[m]} ${m === 6 ? -9999 : BASE[m]! + 1}`),
			SOUTH_AFRICA_BBOX,
			1950,
			1999
		);
		expect(c).toMatchObject({ cellDeg: 0.016666666667, firstYear: 1950, lastYear: 1999, partial: 1 });
		expect(c.cells).toEqual([{ row: expect.any(Number), col: expect.any(Number), monthlyMm: toWaterYear(BASE) }]);
		// The cell's centre is where the header puts it.
		const lon = c.originLon + (c.cells[0]!.col + 0.5) * c.cellDeg;
		const lat = c.originLat + (c.cells[0]!.row + 0.5) * c.cellDeg;
		expect(lon).toBeCloseTo(21.3 + 0.016666666667 / 2, 9);
		expect(lat).toBeCloseTo(-33.7 + 0.016666666667 / 2, 9);
	});

	it('cuts to the box, and treats a negative value as none', async () => {
		const box = { west: 21.31, south: -33.7, east: 21.34, north: -33.68 };
		const c = await monthlyFromAsciiGrids(months((m) => `${BASE[m]} ${BASE[m]}`), box, 1950, 1999);
		expect(c.cells).toHaveLength(1);
		expect(c.originLon + (c.cells[0]!.col + 0.5) * c.cellDeg).toBeCloseTo(21.325, 6);
		expect((await monthlyFromAsciiGrids(months((m) => `${m === 3 ? -1 : BASE[m]} 9`), SOUTH_AFRICA_BBOX, 1950, 1999)).cells).toHaveLength(1);
	});

	it('refuses a grid in another unit, grids that disagree, the wrong count and a projected grid, naming the file', async () => {
		await expect(monthlyFromAsciiGrids(months((m) => `${BASE[m]! * 10} 1`), SOUTH_AFRICA_BBOX, 1950, 1999)).rejects.toThrow(/^m1\.asc: row 1, column 1: 2500 is not a monthly A-pan total of 0–1000 mm/);
		const shifted = BASE.map((_, m) => ({ name: `m${m + 1}.asc`, lines: [...head(m === 4 ? '21.35' : '21.3'), '1 1'] }));
		await expect(monthlyFromAsciiGrids(shifted, SOUTH_AFRICA_BBOX, 1950, 1999)).rejects.toThrow(/^m5\.asc: not on the same grid as m1\.asc/);
		await expect(monthlyFromAsciiGrids(months(() => '1 1').slice(0, 11), SOUTH_AFRICA_BBOX, 1950, 1999)).rejects.toThrow(/give 12 monthly grids/);
		const projected = months(() => '1 1', () => ['ncols 2', 'nrows 1', 'xllcorner -50000', 'yllcorner -3700000', 'cellsize 1000']);
		await expect(monthlyFromAsciiGrids(projected, SOUTH_AFRICA_BBOX, 1950, 1999)).rejects.toThrow(/WGS84 degrees/);
	});

	it('parses --apan-asc: 12 .asc files in order, --years, and the Atlas label’s recorded lines', () => {
		const env = { INIT_CWD: '/work' } as NodeJS.ProcessEnv;
		const files = BASE.map((_, i) => `apan${i + 1}.asc`);
		expect(parseEvaporationArgs(['--apan-asc', ...files, '--dataset', 'Atlas-Apan-2007', '--years', '1950-1999', '--out', 'a.json.gz'], env)).toMatchObject({
			mode: 'load',
			files: files.map((f) => `/work/${f}`),
			dataset: 'Atlas-Apan-2007',
			monthlyAsc: { kind: 'apan', first: 1950, last: 1999 },
			out: '/work/a.json.gz'
		});
		expect(parseEvaporationArgs(['--apan-asc', ...files.slice(1), '--dataset', 'x', '--years', '1950-1999'], env)).toMatch(/12 ESRI ASCII grids/);
		// --years is optional (issue #755): the WRC Atlas states no period, so none is stored.
		expect(parseEvaporationArgs(['--apan-asc', ...files, '--dataset', 'Atlas-Apan-2007'], env)).toMatchObject({
			dataset: 'Atlas-Apan-2007',
			monthlyAsc: { kind: 'apan', first: null, last: null }
		});
		// Given, it is still checked.
		expect(parseEvaporationArgs(['--apan-asc', ...files, '--dataset', 'Atlas-Apan-2007', '--years', '1999-1950'], env)).toMatch(/--years takes <first>-<last>.*leave it out when the source states none/);
		expect(parseEvaporationArgs(['--apan-asc', ...files, '--dataset', 'Atlas-Apan-2007', '--years', '1850-1999'], env)).toMatch(/--years takes <first>-<last> \(1900–2200\)/);
		expect(parseEvaporationArgs(['--apan-asc', ...files, '--dataset', 'Atlas-Apan-2007', '--years', '1950'], env)).toMatch(/--years takes/);
		expect(parseEvaporationArgs(['--apan-asc', ...files, '--dataset', 'Atlas-Apan-2007', '--years'], env)).toMatch(/--years takes/);
		expect(parseEvaporationArgs(['--apan-asc', ...files, '--dataset', 'Atlas-Apan-2007', '--years', '1950-1999', '--source', 'x'], env)).toMatch(/give no --source/);
		// Another source's monthly grids name their own lines.
		expect(parseEvaporationArgs(['--apan-asc', ...files, '--dataset', 'Other', '--years', '1950-1999'], env)).toMatch(/names its source and attribution/);
		expect(parseEvaporationArgs(['--apan-asc', ...files, '--dataset', 'Other', '--years', '1950-1999', '--source', 's', '--attribution', 'a'], env)).toMatchObject({ dataset: 'Other' });
		expect(parseEvaporationArgs(['a.nc', '--dataset', 'x', '--years', '1950-1999'], env)).toMatch(/--years goes with --apan-asc/);
	});

	it('the synthetic grids load as the Atlas’s modelled A-pan, and --out writes what reads back the same', async () => {
		const args = parseEvaporationArgs(['--apan-asc', ...SYNTHETIC_APAN_ASC_FILES, '--dataset', ATLAS_APAN.dataset, '--years', '1950-1999']);
		if (typeof args === 'string' || args.mode !== 'load') throw new Error(String(args));
		const read = await readEvaporationFiles(args);
		// 12 cells: one has no value in any month (the sea), one none in July only.
		expect(read.climatology.cells).toHaveLength(10);
		expect(read.problems).toEqual(['1 cells left out: not every month has them']);
		expect(read.meta).toMatchObject({ kind: 'apan', source: ATLAS_APAN.source, version: ATLAS_APAN.version, attribution: ATLAS_APAN.attribution });
		expect(read.meta.method).toMatch(/^Modelled, not measured: the WRC Atlas’s A-pan equivalent/);
		expect(read.meta.method).toMatch(/1950–1999/);
		const out = join(dir, 'atlas-apan.json.gz');
		expect(await writeEvaporationJson({ ...args, out })).toMatchObject({ written: 10 });
		const back = evaporationFromJson(JSON.parse(gunzipSync(readFileSync(out)).toString('utf8')));
		if (typeof back === 'string') throw new Error(back);
		expect(back.kind).toBe('apan');
		expect(back.problems).toEqual([]);
		expect(back.climatology.cells).toEqual(read.climatology.cells);
		expect(back.meta).toMatchObject({ source: ATLAS_APAN.source, attribution: ATLAS_APAN.attribution });
	});

	it('without --years the Atlas grid stores no period, says so in its method, and --out writes null years that read back (issue #755)', async () => {
		const args = parseEvaporationArgs(['--apan-asc', ...SYNTHETIC_APAN_ASC_FILES, '--dataset', ATLAS_APAN.dataset]);
		if (typeof args === 'string' || args.mode !== 'load') throw new Error(String(args));
		const read = await readEvaporationFiles(args);
		expect(read.climatology).toMatchObject({ firstYear: null, lastYear: null });
		expect(read.climatology.cells).toHaveLength(10);
		expect(read.meta.method).toMatch(/^Modelled, not measured: the WRC Atlas’s A-pan equivalent/);
		expect(read.meta.method).toContain('(the Atlas states no period for its means: unchanged from the 1997 Atlas, Schulze 1997)');
		expect(read.meta.method).not.toMatch(/null|NaN|operator recorded/);
		expect(read.meta.method.length).toBeLessThanOrEqual(1000);
		const out = join(dir, 'atlas-apan-no-period.json.gz');
		await writeEvaporationJson({ ...args, out });
		const doc = JSON.parse(gunzipSync(readFileSync(out)).toString('utf8'));
		expect(doc).toMatchObject({ kind: 'apan', firstYear: null, lastYear: null });
		const back = evaporationFromJson(doc);
		if (typeof back === 'string') throw new Error(back);
		expect(back.climatology).toMatchObject({ firstYear: null, lastYear: null });
		expect(back.climatology.cells).toEqual(read.climatology.cells);
		// Loaded locally from that file under the Atlas label, it keeps the Atlas's method, not the daily-summing one.
		const again = await readEvaporationFiles({ mode: 'load', files: [out], dataset: ATLAS_APAN.dataset, bbox: SOUTH_AFRICA_BBOX, source: null, version: null, attribution: null });
		expect(again.meta.method).toBe(read.meta.method);
		// Another source's grids without a period: the generic method says none was stated.
		const other = await readEvaporationFiles({ mode: 'load', files: [out], dataset: 'Other', bbox: SOUTH_AFRICA_BBOX, source: null, version: null, attribution: null });
		expect(other.meta.method).toMatch(/^12 monthly A-pan grids .* each cell's monthly means as given \(the source states no period for them\)\./);
	});

	it('the method texts with and without a period', () => {
		expect(atlasApanMethodFor(0.0167, 1950, 1999)).toContain('(the period 1950–1999 as the operator recorded it)');
		expect(atlasApanMethodFor(0.0167, null, null)).toContain('(the Atlas states no period for its means: unchanged from the 1997 Atlas, Schulze 1997)');
		expect(atlasSpanMethodFor(0.0167, 1950, 1999)).toContain('(the period 1950–1999 as the operator recorded it)');
		expect(atlasSpanMethodFor(0.0167, null, null)).toContain('(the grids state no period for their means)');
		expect(monthlyGridsMethodFor(0.0167, 1950, 1999)).toContain("each cell's monthly means for 1950–1999, as the source states them.");
		expect(monthlyGridsMethodFor(0.0167, null, null, 'span')).toContain("each cell's monthly means as given (the source states no period for them).");
		for (const m of [atlasApanMethodFor(0.0167, null, null), atlasSpanMethodFor(0.0167, null, null), monthlyGridsMethodFor(0.0167, null, null)]) {
			expect(m).not.toMatch(/null|NaN/);
			expect(m.length).toBeLessThanOrEqual(1000);
		}
	});

	it('a grid JSON may leave its period out only for an A-pan or S-pan grid of means as given', () => {
		const cells = [[21.25, -33.75, Array.from({ length: 12 }, () => 100)]];
		for (const kind of ['apan', 'span']) {
			for (const doc of [{ kind, cellDeg: 0.1, cells }, { kind, cellDeg: 0.1, firstYear: null, lastYear: null, cells }]) {
				const got = evaporationFromJson(doc);
				if (typeof got === 'string') throw new Error(got);
				expect(got.climatology).toMatchObject({ firstYear: null, lastYear: null });
			}
		}
		// Reference ET's years come from its files, and a PenPan grid states its own.
		expect(evaporationFromJson({ kind: 'et0', cellDeg: 0.1, cells })).toMatch(/no "firstYear" ≤ "lastYear"/);
		expect(evaporationFromJson({ kind: 'et0', cellDeg: 0.1, firstYear: null, lastYear: null, cells })).toMatch(/no "firstYear" ≤ "lastYear"/);
		const model = { name: 'penpan', groundAlbedo: 0.23, screen: 1, inputs: 'NASA POWER' };
		expect(evaporationFromJson({ kind: 'apan', cellDeg: 0.1, model, cells })).toMatch(/no "firstYear" ≤ "lastYear"/);
		// Both or neither.
		expect(evaporationFromJson({ kind: 'apan', cellDeg: 0.1, firstYear: 1950, cells })).toMatch(/give both, or .* neither/);
		expect(evaporationFromJson({ kind: 'apan', cellDeg: 0.1, firstYear: null, lastYear: 1999, cells })).toMatch(/give both, or .* neither/);
		expect(evaporationFromJson({ kind: 'apan', cellDeg: 0.1, firstYear: 1999, lastYear: 1950, cells })).toMatch(/no "firstYear" ≤ "lastYear"/);
	});

	it('refuses one year of a period without the other', async () => {
		await expect(monthlyFromAsciiGrids(months(() => '1 1'), SOUTH_AFRICA_BBOX, 1950, null)).rejects.toThrow(/both years of the period, or neither/);
	});
});

describe('12 monthly S-pan grids as ESRI ASCII (--span-asc; issue #738, a cross-check only)', () => {
	const files = Array.from({ length: 12 }, (_, i) => `span${i + 1}.asc`);
	const env = { INIT_CWD: '/work' } as NodeJS.ProcessEnv;

	it('parses --span-asc like --apan-asc, keeping each Atlas label to its own kind', () => {
		expect(parseEvaporationArgs(['--span-asc', ...files, '--dataset', 'Atlas-Span-2007', '--years', '1950-1999'], env)).toMatchObject({
			dataset: 'Atlas-Span-2007',
			monthlyAsc: { kind: 'span', first: 1950, last: 1999 }
		});
		expect(parseEvaporationArgs(['--span-asc', ...files, '--dataset', 'Atlas-Apan-2007', '--years', '1950-1999'], env)).toMatch(/the WRC Atlas's A-pan label: load S-pan grids under another label/);
		expect(parseEvaporationArgs(['--apan-asc', ...files, '--dataset', 'Atlas-Span-2007', '--years', '1950-1999'], env)).toMatch(/the WRC Atlas's S-pan label: load A-pan grids under another label/);
		expect(parseEvaporationArgs(['--span-asc', '--apan-asc', ...files, '--dataset', 'x', '--years', '1950-1999'], env)).toMatch(/not both/);
		expect(parseEvaporationArgs(['--span-asc', ...files, '--dataset', 'Other', '--years', '1950-1999'], env)).toMatch(/an S-pan grid other than the WRC Atlas’s names its source and attribution/);
		expect(parseEvaporationArgs(['--span-asc', ...files, '--dataset', 'Atlas-Span-2007', '--years', '1950-1999', '--attribution', 'a'], env)).toMatch(/give no --source/);
		expect(parseEvaporationArgs(['--span-asc', ...files, '--dataset', 'Atlas-Span-2007'], env)).toMatchObject({ monthlyAsc: { kind: 'span', first: null, last: null } });
	});

	it('the synthetic grids load as kind span with the Atlas’s S-pan lines, never as A-pan, and --out reads back the same', async () => {
		const args = parseEvaporationArgs(['--span-asc', ...SYNTHETIC_SPAN_ASC_FILES, '--dataset', ATLAS_SPAN.dataset, '--years', '1950-1999']);
		if (typeof args === 'string' || args.mode !== 'load') throw new Error(String(args));
		const read = await readEvaporationFiles(args);
		expect(read.climatology.cells).toHaveLength(10);
		expect(read.meta).toMatchObject({ kind: 'span', source: ATLAS_SPAN.source, version: ATLAS_SPAN.version, attribution: ATLAS_SPAN.attribution });
		expect(read.meta.method).toMatch(/Shown as a cross-check against the saved A-pan only: S-pan is never converted to A-pan here/);
		// The values are the grids' own: the first cell's October is October's S-pan as given (196 + 0 − 2 × 0), not converted.
		expect(read.climatology.cells.map((c) => c.monthlyMm[0])).toContain(136);
		const out = join(dir, 'atlas-span.json.gz');
		expect(await writeEvaporationJson({ ...args, out })).toMatchObject({ written: 10 });
		const back = evaporationFromJson(JSON.parse(gunzipSync(readFileSync(out)).toString('utf8')));
		if (typeof back === 'string') throw new Error(back);
		expect(back.kind).toBe('span');
		expect(back.climatology.cells).toEqual(read.climatology.cells);
	});

	it('names S-pan in the unit refusal', async () => {
		const BASE = [200, 168, 144, 96, 64, 44, 48, 68, 96, 136, 168, 196];
		const months = BASE.map((v, m) => ({ name: `m${m + 1}.asc`, lines: ['ncols 1', 'nrows 1', 'xllcorner 21.3', 'yllcorner -33.7', 'cellsize 0.016666666667', String(v * 10)] }));
		await expect(monthlyFromAsciiGrids(months, SOUTH_AFRICA_BBOX, 1950, 1999, 'S-pan')).rejects.toThrow(/2000 is not a monthly S-pan total/);
	});
});
