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
import { parseEvaporationArgs, readEvaporationFiles, reduceDpet, SYNTHETIC_EVAPORATION_FILE, writeEvaporationJson } from '../../scripts/import-evaporation.js';
import { climatology, dpetYear, evaporationFromJson, originOf, readDpetYear, SOUTH_AFRICA_BBOX, toWaterYear, yearTotalsFromJson, type YearTotals } from './loadEvaporation.js';

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
});

describe('the fixture form and the command', () => {
	it('evaporationFromJson refuses an S-pan dataset, a missing kind and bad cells', () => {
		expect(evaporationFromJson({ kind: 'span' })).toMatch(/S-pan dataset can’t be loaded/);
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
