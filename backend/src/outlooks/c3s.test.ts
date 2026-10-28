// The bridge from the copy's C3S seasonal forecasts to the engine (issue #620
// step 7, outlooks/c3s.ts, docs/model.md §2.15d § The backend bridge): the
// release dates against the ingest's, the init an outlook may use, the 1°
// cells a polygon covers, whole calendar months, and the engine's inputs read
// from the committed synthetic copy (scripts/c3s-fixture.ts), checked against
// the fixture's own invented values by hand.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { C3S_FIXTURE, c3sFixtureValue } from '../../scripts/c3s-fixture.js';
import { MIRROR_FIXTURE_DIR } from '../../scripts/gen-mirror-fixture.js';
import type { Geometry } from '../geo/geojson.js';
import { MirrorFormatError } from '../mirror/arrays.js';
import { openStore } from '../mirror/store.js';
import { C3S_LEAD_DAYS, C3S_RELEASE_DAY, C3S_RELEASE_DAY_OTHERS, c3sIssuedOn, monthlyTotals, pickC3sInit, readC3sInputs, seasonalCells, type ForecastArea } from './c3s.js';

const square = (lon: number, lat: number, half: number): Extract<Geometry, { type: 'Polygon' }> => ({
	type: 'Polygon',
	coordinates: [[[lon - half, lat - half], [lon + half, lat - half], [lon + half, lat + half], [lon - half, lat + half], [lon - half, lat - half]]]
});

describe('the release dates', () => {
	it('are the ingest’s: ECMWF on the 6th, the other centres on the 10th (ingest/c3srequest.py)', () => {
		const py = readFileSync(new URL('../../../ingest/c3srequest.py', import.meta.url), 'utf8');
		expect(/^RELEASE_DAY = \{"ecmwf": (\d+)\}$/m.exec(py)?.[1]).toBe(String(C3S_RELEASE_DAY.ecmwf));
		expect(/^RELEASE_DAY_OTHERS = (\d+)$/m.exec(py)?.[1]).toBe(String(C3S_RELEASE_DAY_OTHERS));
		expect(/^LEAD_DAYS = (\d+)$/m.exec(py)?.[1]).toBe(String(C3S_LEAD_DAYS));
		expect(c3sIssuedOn('ecmwf-51', '2018-10')).toBe('2018-10-06');
		expect(c3sIssuedOn('ukmo-604', '2018-10')).toBe('2018-10-10');
		expect(c3sIssuedOn('meteo_france-9', '2019-01')).toBe('2019-01-10');
	});
});

describe('pickC3sInit: only forecasts issued on or before the decision date', () => {
	const index = { inits: { '2018-10': ['ecmwf-51', 'ukmo-604'], '2018-09': ['ecmwf-51', 'ukmo-604'] } };
	it('skips an init none of whose systems is issued yet, and an init after the decision date', () => {
		expect(pickC3sInit(index, '2018-10-01')).toEqual({
			init: '2018-09',
			issued: [
				{ system: 'ecmwf-51', issuedOn: '2018-09-06' },
				{ system: 'ukmo-604', issuedOn: '2018-09-10' }
			],
			notIssued: []
		});
		expect(pickC3sInit(index, '2018-10-05')!.init).toBe('2018-09');
	});
	it('takes the newest init with a system issued, and names the systems not issued yet', () => {
		// On the 6th ECMWF's October forecast is out; the Met Office's comes on the 10th.
		expect(pickC3sInit(index, '2018-10-06')).toEqual({ init: '2018-10', issued: [{ system: 'ecmwf-51', issuedOn: '2018-10-06' }], notIssued: [{ system: 'ukmo-604', issuedOn: '2018-10-10' }] });
		expect(pickC3sInit(index, '2018-10-10')!.issued.map((s) => s.system)).toEqual(['ecmwf-51', 'ukmo-604']);
		expect(pickC3sInit(index, '2019-03-01')!.init).toBe('2018-10');
	});
	it('is null when nothing is issued by the decision date', () => {
		expect(pickC3sInit(index, '2018-09-05')).toBeNull();
		expect(pickC3sInit({ inits: {} }, '2018-10-01')).toBeNull();
	});
});

describe('seasonalCells: the 1° cells a polygon covers', () => {
	it('weighs the one cell a small square lies in by its share × cos(latitude)', () => {
		const got = seasonalCells(square(21.3, -33.7, 0.1));
		if ('problem' in got) throw new Error(got.problem);
		expect(got.cells).toHaveLength(1);
		const c = got.cells[0]!;
		// Centred at 34° S, 21° E: row 2 (36° S is 0), column 11 (10° E is 0).
		expect(c).toMatchObject({ y: 2, x: 11, lat: -34, lon: 21 });
		expect(c.share).toBeCloseTo(0.04, 9);
		expect(c.weight).toBeCloseTo(0.04 * Math.cos((34 * Math.PI) / 180), 9);
	});
	it('splits a square across a cell edge by area, and subtracts a hole', () => {
		const got = seasonalCells(square(21.5, -33.5, 0.2));
		if ('problem' in got) throw new Error(got.problem);
		// Four quarters, each 0.01 deg² of its cell.
		expect(got.cells.map((c) => [c.lat, c.lon, c.share])).toEqual([
			[-34, 21, 0.04],
			[-34, 22, 0.04],
			[-33, 21, 0.04],
			[-33, 22, 0.04]
		]);
		const holed: Geometry = { type: 'Polygon', coordinates: [square(21.3, -33.7, 0.2).coordinates[0]!, square(21.3, -33.7, 0.1).coordinates[0]!] };
		const h = seasonalCells(holed);
		if ('problem' in h) throw new Error(h.problem);
		expect(h.cells[0]!.share).toBeCloseTo(0.16 - 0.04, 9);
	});
	it('refuses a point, a polygon outside the copy’s region, and one with no area', () => {
		expect(seasonalCells({ type: 'Point', coordinates: [21, -34] })).toEqual({ problem: 'the catchment boundary is not a polygon' });
		expect(seasonalCells(square(5, -34, 0.2))).toMatchObject({ problem: expect.stringContaining('outside the region') });
		expect(seasonalCells(square(21, -40, 0.2))).toMatchObject({ problem: expect.stringContaining('outside the region') });
		expect(seasonalCells({ type: 'Polygon', coordinates: [[[21, -34], [21.1, -34], [21.2, -34], [21, -34]]] })).toEqual({ problem: 'the catchment boundary has no area' });
	});
});

describe('monthlyTotals: whole calendar months from the init month', () => {
	it('counts each month’s own days (a leap February is 29) and stops at the lead axis’ end', () => {
		const ones = new Array(C3S_LEAD_DAYS).fill(1);
		// Feb 29 + Mar–Aug = 213 days; September would need 243.
		expect(monthlyTotals(ones, '2016-02-01')).toEqual([29, 31, 30, 31, 30, 31, 31]);
		expect(monthlyTotals(ones, '2017-02-01')).toEqual([28, 31, 30, 31, 30, 31, 31]);
		expect(monthlyTotals(ones, '2018-09-01')).toEqual([30, 31, 30, 31, 31, 28, 31]);
	});
	it('stops at the first month with a day that isn’t a number ≥ 0', () => {
		const v = new Array(C3S_LEAD_DAYS).fill(2);
		v[40] = Number.NaN;
		expect(monthlyTotals(v, '2018-09-01')).toEqual([60]);
		v[40] = -0.5;
		expect(monthlyTotals(v, '2018-09-01')).toEqual([60]);
		expect(monthlyTotals([Number.NaN, ...v.slice(1)], '2018-09-01')).toEqual([]);
	});
});

/** The fixture's catchment-average month totals for a start on `first`, by hand: the one cell (block row 1, column 1). */
function expectedMonths(system: string, year: number, member: number, first: string): number[] {
	const daily = Array.from({ length: C3S_LEAD_DAYS }, (_, d) => Math.fround(c3sFixtureValue(system, year, member, d, 1, 1)));
	return monthlyTotals(daily, first);
}

describe('readC3sInputs on the committed synthetic copy', () => {
	const store = openStore(pathToFileURL(MIRROR_FIXTURE_DIR).href);
	const got = seasonalCells(square(21.3, -33.7, 0.1));
	if ('problem' in got) throw new Error(got.problem);
	const area: ForecastArea = { source: 'boundary', cells: got.cells, units: [], notes: [] };
	const dirs: string[] = [];
	afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

	it('reads the 2018-09 init for a decision on 1 October: both systems, every member’s whole months, and their September hindcasts', async () => {
		const r = await readC3sInputs(store, area, '2018-10-01');
		expect(r.source).toMatchObject({
			init: '2018-09',
			issued: [
				{ system: 'ecmwf-51', issuedOn: '2018-09-06' },
				{ system: 'ukmo-604', issuedOn: '2018-09-10' }
			],
			notIssued: [],
			centres: ['European Centre for Medium-Range Weather Forecasts (ECMWF)', 'Met Office'],
			fetchedAt: C3S_FIXTURE.fetchedAt,
			notes: []
		});
		expect(r.forecasts.map((f) => [f.system, f.init, f.members.length])).toEqual([
			['ecmwf-51', '2018-09', 3],
			['ukmo-604', '2018-09', 2]
		]);
		// September 2018 to March 2019: seven whole months in 215 days.
		for (const f of r.forecasts) {
			f.members.forEach((m, j) => {
				expect(m.monthlyMm).toHaveLength(7);
				const want = expectedMonths(f.system, 2018, j, '2018-09-01');
				m.monthlyMm.forEach((v, k) => expect(v).toBeCloseTo(want[k]!, 4));
			});
		}
		expect(r.hindcasts.map((h) => [h.system, h.initMonth, h.years.length, h.years[0]!.year, h.years.at(-1)!.year])).toEqual([
			['ecmwf-51', 9, 24, 1993, 2016],
			['ukmo-604', 9, 24, 1993, 2016]
		]);
		const y2000 = r.hindcasts[1]!.years.find((y) => y.year === 2000)!;
		expect(y2000.members).toHaveLength(2);
		const want = expectedMonths('ukmo-604', 2000, 1, '2000-09-01');
		y2000.members[1]!.monthlyMm.forEach((v, k) => expect(v).toBeCloseTo(want[k]!, 4));
		expect(r.source.hindcasts).toEqual([
			{ system: 'ecmwf-51', initMonth: 9, years: C3S_FIXTURE.hindcastYears, members: 3 },
			{ system: 'ukmo-604', initMonth: 9, years: C3S_FIXTURE.hindcastYears, members: 2 }
		]);
		expect(r.area).toEqual({ source: 'boundary', cells: 1, units: [], notes: [] });
	});

	it('takes ECMWF’s 2018-10 init alone from the 6th, and averages two cells by their weights', async () => {
		const r = await readC3sInputs(store, area, '2018-10-06');
		expect(r.source.init).toBe('2018-10');
		expect(r.forecasts.map((f) => f.system)).toEqual(['ecmwf-51']);
		expect(r.hindcasts.map((h) => [h.system, h.initMonth])).toEqual([['ecmwf-51', 10]]);

		const two = seasonalCells({ type: 'MultiPolygon', coordinates: [square(21.3, -33.7, 0.1).coordinates, square(22.3, -33.7, 0.2).coordinates] });
		if ('problem' in two) throw new Error(two.problem);
		const r2 = await readC3sInputs(store, { ...area, cells: two.cells }, '2018-10-01');
		const [a, b] = two.cells;
		const daily = Array.from({ length: C3S_LEAD_DAYS }, (_, d) => (a!.weight * Math.fround(c3sFixtureValue('ecmwf-51', 2018, 0, d, 1, 1)) + b!.weight * Math.fround(c3sFixtureValue('ecmwf-51', 2018, 0, d, 1, 2))) / (a!.weight + b!.weight));
		const want = monthlyTotals(daily, '2018-09-01');
		r2.forecasts[0]!.members[0]!.monthlyMm.forEach((v, k) => expect(v).toBeCloseTo(want[k]!, 4));
	});

	it('reads each unit’s own monthly means beside the catchment’s, under per-unit rain', async () => {
		const unit = seasonalCells(square(22.3, -33.7, 0.2));
		if ('problem' in unit) throw new Error(unit.problem);
		const r = await readC3sInputs(store, { ...area, units: [{ nodeId: 'u1', name: 'Upper', cells: unit.cells }] }, '2018-10-01');
		expect(r.area.units).toHaveLength(1);
		const u = r.area.units[0]!;
		expect(u).toMatchObject({ nodeId: 'u1', name: 'Upper', cells: 1 });
		expect(u.systems.map((s) => s.system)).toEqual(['ecmwf-51', 'ukmo-604']);
		const mean = (k: number) => [0, 1, 2].reduce((acc, m) => acc + monthlyTotals(Array.from({ length: C3S_LEAD_DAYS }, (_, d) => Math.fround(c3sFixtureValue('ecmwf-51', 2018, m, d, 1, 2))), '2018-09-01')[k]!, 0) / 3;
		u.systems[0]!.meanMonthlyMm.forEach((v, k) => expect(v).toBeCloseTo(mean(k), 2));
	});

	it('gives no forecast before any init is issued, or with no copy of them; passes a system without a hindcast with a note', async () => {
		expect((await readC3sInputs(store, area, '2018-09-05')).forecasts).toEqual([]);
		const empty = mkdtempSync(join(tmpdir(), 'c3s-empty-'));
		dirs.push(empty);
		const none = await readC3sInputs(openStore(pathToFileURL(`${empty}/`).href), area, '2018-10-01');
		expect(none).toMatchObject({ forecasts: [], hindcasts: [], source: { init: null } });

		// The copy without its hindcasts: the forecasts are read, no hindcast is, and the engine will be off (noHindcast).
		const copy = mkdtempSync(join(tmpdir(), 'c3s-nohc-'));
		dirs.push(copy);
		cpSync(join(MIRROR_FIXTURE_DIR, 'c3s'), join(copy, 'c3s'), { recursive: true });
		cpSync(join(MIRROR_FIXTURE_DIR, 'zarr.json'), join(copy, 'zarr.json'));
		const idx = JSON.parse(readFileSync(join(copy, 'c3s/index.json'), 'utf8'));
		idx.hindcasts = {};
		writeFileSync(join(copy, 'c3s/index.json'), JSON.stringify(idx));
		const r = await readC3sInputs(openStore(pathToFileURL(`${copy}/`).href), area, '2018-10-01');
		expect(r.forecasts).toHaveLength(2);
		expect(r.hindcasts).toEqual([]);
		expect(r.source.notes).toEqual(['ecmwf-51: the copy holds no hindcast for its 09 init', 'ukmo-604: the copy holds no hindcast for its 09 init']);

		// An index naming a hindcast the copy doesn't hold is a copy laid out wrong: the job fails rather than guess.
		idx.hindcasts = { 'ecmwf-51': ['09'] };
		writeFileSync(join(copy, 'c3s/index.json'), JSON.stringify(idx));
		await expect(readC3sInputs(openStore(pathToFileURL(`${copy}/`).href), area, '2018-10-01')).rejects.toBeInstanceOf(MirrorFormatError);
	});
});
