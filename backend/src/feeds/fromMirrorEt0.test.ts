// Reference evapotranspiration read from the copy (fromMirrorEt0.ts; issue
// #604 R5-E), without a database: the 0.1° cell arithmetic, which product a
// day comes from (AgERA5 where its copy holds the day, NASA POWER after),
// the weighted mean over the cells with a value, the refusals, and the
// committed fixture read shifted to today.
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { afterAll, describe, expect, it } from 'vitest';
import { et0FixtureValue, ET0_FIXTURE_HOLDS } from '../../scripts/et0-fixture.js';
import { MIRROR_FIXTURE_DIR } from '../../scripts/gen-mirror-fixture.js';
import { MirrorOutsideRegionError } from '../mirror/grid.js';
import { MirrorNotReadyError } from '../mirror/readCells.js';
import { openStore } from '../mirror/store.js';
import type { GridConfig } from './config.js';
import { ET0_FIXTURE, et0Cell, et0FromMirror, type Et0Reader, fixtureEt0Reader, liveEt0Reader } from './fromMirrorEt0.js';

const tmp: string[] = [];
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));
const fixtureStore = () => openStore(pathToFileURL(MIRROR_FIXTURE_DIR).href);
const emptyStore = () => {
	const dir = mkdtempSync(join(tmpdir(), 'wm-et0-'));
	tmp.push(dir);
	return openStore(pathToFileURL(`${dir}/`).href);
};

const { y0, x0 } = ET0_FIXTURE.block;
/** The 0.05° cell centre in the south-west quarter of the fixture block's 0.1° cell (y0 + i, x0 + j). */
const cellAt = (i: number, j: number, weight = 1) => ({ lat: -35.5 + (y0 + i) * 0.1 + 0.025, lon: 10 + (x0 + j) * 0.1 + 0.025, weight });
const round2 = (v: number) => Math.round(v * 100) / 100;

describe('et0Cell', () => {
	it('puts a point in the 0.1° cell holding it, south-west first, and refuses one outside the region', () => {
		expect(et0Cell(-35.475, 10.025)).toEqual({ y: 0, x: 0 });
		expect(et0Cell(-35.375, 10.125)).toEqual({ y: 1, x: 1 });
		expect(et0Cell(-8.025, 40.975)).toEqual({ y: 274, x: 309 });
		expect(() => et0Cell(-36, 20)).toThrow(MirrorOutsideRegionError);
	});
});

describe('the live copy (the committed fixture, read as it stood)', () => {
	const reader = liveEt0Reader(fixtureStore());
	const config: GridConfig = { cells: [cellAt(1, 2)] };

	it('takes AgERA5 where its copy holds the day and NASA POWER after it, and leaves out days neither holds', async () => {
		const r = await et0FromMirror(config, { start: '2025-12-30', end: '2026-02-08' }, reader);
		expect(r.startDate).toBe('2025-12-30');
		// AgERA5 through 2025-12-31, then POWER through its prelimThrough (2026-02-06); 07 and 08 held by neither, so not sent.
		expect(r.values.length).toBe(toEpochDay(ET0_FIXTURE_HOLDS.power.through) - toEpochDay('2025-12-30') + 1);
		expect(r.values[0]).toBe(round2(et0FixtureValue('2025-12-30', 1, 2, 'agera5')));
		expect(r.values[1]).toBe(round2(et0FixtureValue('2025-12-31', 1, 2, 'agera5')));
		expect(r.values[2]).toBe(round2(et0FixtureValue('2026-01-01', 1, 2, 'power')));
		expect(r.meta).toEqual({ days: r.values.length, agera5Days: 2, powerDays: r.values.length - 2, agera5Through: '2025-12-31' });
	});

	it('averages the 0.1° cells by the feed cells’ weights', async () => {
		const r = await et0FromMirror({ cells: [cellAt(0, 0, 1), cellAt(3, 3, 3)] }, { start: '2025-06-01', end: '2025-06-01' }, reader);
		const v = (et0FixtureValue('2025-06-01', 0, 0, 'agera5') + 3 * et0FixtureValue('2025-06-01', 3, 3, 'agera5')) / 4;
		expect(r.values).toEqual([round2(v)]);
	});

	it('a window before either copy holds anything answers no days, not zeros', async () => {
		const r = await et0FromMirror(config, { start: '2024-01-01', end: '2024-01-31' }, reader);
		expect(r).toMatchObject({ startDate: null, values: [], meta: { days: 0, agera5Days: 0, powerDays: 0 } });
	});

	it('refuses a cell outside the region', async () => {
		await expect(et0FromMirror({ cells: [{ lat: -40, lon: 20, weight: 1 }] }, { start: '2025-06-01', end: '2025-06-01' }, reader)).rejects.toThrow(MirrorOutsideRegionError);
	});
});

describe('the refusals', () => {
	it('a copy holding neither product is not ready, not a failure', async () => {
		await expect(et0FromMirror({ cells: [cellAt(0, 0)] }, { start: '2025-06-01', end: '2025-06-01' }, liveEt0Reader(emptyStore()))).rejects.toThrow(MirrorNotReadyError);
	});

	it('a value past 30 mm a day is a corrupt copy; a cell with no value (the sea) is left out', async () => {
		const at = (agera5: number[]): Et0Reader => async () => ({ agera5: [agera5], power: [[Number.NaN, Number.NaN]], agera5Through: '2025-06-01' });
		const config: GridConfig = { cells: [cellAt(0, 0), cellAt(0, 1)] };
		await expect(et0FromMirror(config, { start: '2025-06-01', end: '2025-06-01' }, at([31, 4]))).rejects.toThrow(/implausible reference evapotranspiration of 31 mm/);
		expect((await et0FromMirror(config, { start: '2025-06-01', end: '2025-06-01' }, at([Number.NaN, 4]))).values).toEqual([4]);
	});

	it('the fixture copy can be written to: a live copy without POWER still answers from AgERA5', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'wm-et0-copy-'));
		tmp.push(dir);
		cpSync(MIRROR_FIXTURE_DIR, dir, { recursive: true });
		rmSync(join(dir, 'power_et0'), { recursive: true });
		const r = await et0FromMirror({ cells: [cellAt(2, 1)] }, { start: '2025-12-31', end: '2026-01-02' }, liveEt0Reader(openStore(pathToFileURL(`${dir}/`).href)));
		expect(r).toMatchObject({ startDate: '2025-12-31', values: [round2(et0FixtureValue('2025-12-31', 2, 1, 'agera5'))], meta: { agera5Days: 1, powerDays: 0 } });
	});
});

describe('fixtures mode', () => {
	it('reads every day shifted by today − the fixture’s day, and any cell from the block by its position modulo 4', async () => {
		const today = '2027-03-15';
		const shift = toEpochDay(today) - toEpochDay(ET0_FIXTURE.today);
		const yesterday = fromEpochDay(toEpochDay(today) - 1);
		// A cell four 0.1° cells east of the block's (1, 2) reads (1, 2).
		const far = { lat: cellAt(1, 2).lat, lon: cellAt(1, 2).lon + 0.4, weight: 1 };
		const r = await et0FromMirror({ cells: [far] }, { start: fromEpochDay(toEpochDay(yesterday) - 60), end: yesterday }, fixtureEt0Reader(fixtureStore(), today));
		const fixtureDay = (d: string) => fromEpochDay(toEpochDay(d) - shift);
		expect(r.meta.agera5Through).toBe(fromEpochDay(toEpochDay(ET0_FIXTURE_HOLDS.agera5.finalThrough) + shift));
		expect(r.values[0]).toBe(round2(et0FixtureValue(fixtureDay(r.startDate!), 1, 2, 'agera5')));
		// The newest days are POWER's, as in production.
		expect(r.meta.powerDays).toBeGreaterThan(0);
		expect(r.values.at(-1)).toBe(round2(et0FixtureValue(ET0_FIXTURE_HOLDS.power.through, 1, 2, 'power')));
	});
});
