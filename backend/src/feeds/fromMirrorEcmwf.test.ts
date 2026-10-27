// The ECMWF forecast read from the copy (fromMirrorEcmwf.ts, ingest/ecmwf.ts;
// issue #604 R4-C), without a database: the 0.1° cell arithmetic, the issue
// rule (today's, else yesterday's), the weighted mean, the quantile mapping
// (the same rule as ingest/ecmwf_qm_fit.py apply) and its label, and the
// committed fixture read as today's issue.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { ecmwfFixtureMean } from '../../scripts/ecmwf-fixture.js';
import { MIRROR_FIXTURE_DIR } from '../../scripts/gen-mirror-fixture.js';
import { applyQm, ECMWF_DAYS, ECMWF_SIZE, ECMWF_STATS, ecmwfCell, EcmwfQm, openEcmwfIssue, readEcmwfIndex, writeEcmwfIndex, writeEcmwfIssue } from '../ingest/ecmwf.js';
import { MirrorOutsideRegionError } from '../mirror/grid.js';
import { MirrorNotReadyError } from '../mirror/readCells.js';
import { openStore } from '../mirror/store.js';
import type { GridConfig } from './config.js';
import { ECMWF_FIXTURE, ecmwfForecastFromMirror, type EcmwfReader, fixtureEcmwfReader, liveEcmwfReader, NOT_CALIBRATED } from './fromMirrorEcmwf.js';

const tmp: string[] = [];
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));
const freshStore = () => {
	const dir = mkdtempSync(join(tmpdir(), 'wm-ecmwf-'));
	tmp.push(dir);
	return openStore(pathToFileURL(`${dir}/`).href);
};

const QM: EcmwfQm = {
	v: 1,
	product: 'ecmwf',
	stat: 'mean',
	fittedAt: '2027-03-01T10:00:00Z',
	method: 'test',
	observed: { product: 'sat', fallback: 'prelim', scale: 1 },
	forecasts: { issues: 90, first: '2026-11-01', last: '2027-02-28' },
	groups: [{ id: 'D1-SON', region: { w: 10, s: -35.5, e: 41, n: -8 }, months: [9, 10, 11], samples: 5000, pairs: [[0, 0], [10, 6], [20, 14]] }]
};

describe('the 0.1° grid', () => {
	it('puts a 0.05° cell centre in the 0.1° cell holding it: row 0 the south-west, rows northwards', () => {
		expect(ECMWF_SIZE).toEqual({ rows: 275, cols: 310 });
		expect(ecmwfCell(-35.475, 10.025)).toEqual({ y: 0, x: 0 });
		expect(ecmwfCell(-35.425, 10.075)).toEqual({ y: 0, x: 0 });
		expect(ecmwfCell(-35.375, 10.125)).toEqual({ y: 1, x: 1 });
		expect(ecmwfCell(-8.025, 40.975)).toEqual({ y: 274, x: 309 });
		expect(() => ecmwfCell(-36.0, 20)).toThrow(MirrorOutsideRegionError);
		expect(() => ecmwfCell(-20, 41.025)).toThrow(MirrorOutsideRegionError);
	});
});

describe('applyQm (the rule ingest/ecmwf_qm_fit.py apply keeps; test_ecmwf_qm_fit.py has the same vectors)', () => {
	const pairs = [[0, 0], [10, 6], [20, 14]] as const;
	it('maps between, beyond and below the pairs, never below 0', () => {
		expect(applyQm(pairs, 15)).toBeCloseTo(10);
		expect(applyQm(pairs, 50)).toBeCloseTo(44);
		expect(applyQm([[2, 1], [4, 3]], 1)).toBeCloseTo(0.5);
		expect(applyQm([[0, 0.5], [4, 3]], 0)).toBeCloseTo(0.5);
		expect(applyQm([[0, 0], [1, 0]], 0.5)).toBe(0);
		expect(applyQm([], 7)).toBe(7);
		expect(applyQm([[1, 0], [2, 1]], -6)).toBe(0);
	});
	it('refuses a fit whose pairs don’t increase', () => {
		expect(EcmwfQm.safeParse(QM).success).toBe(true);
		expect(EcmwfQm.safeParse({ ...QM, groups: [{ ...QM.groups[0]!, pairs: [[0, 0], [10, 6], [5, 7]] }] }).success).toBe(false);
	});
});

/** A reader giving `day d, cell i` = base[i] + d, with the fit `qm`. */
const fakeReader =
	(base: number[], issued: string, qm: EcmwfQm | null = null): EcmwfReader =>
	async (cells, _today) => ({ issued, qm, values: Array.from({ length: ECMWF_DAYS }, (_, d) => cells.map((_, i) => base[i]! + d)) });

describe('ecmwfForecastFromMirror', () => {
	// Two 0.05° cells in one 0.1° cell, and one in the next: the mean weights each listed cell.
	const config: GridConfig = { cells: [{ lat: -20.025, lon: 25.025, weight: 1 }, { lat: -20.075, lon: 25.075, weight: 1 }, { lat: -20.025, lon: 25.125, weight: 2 }] };

	it('the weighted mean of the cells’ 0.1° cells, 15 days from the issue date, not yet calibrated without a fit', async () => {
		const r = await ecmwfForecastFromMirror(config, '2026-10-27', fakeReader([2, 8], '2026-10-27'));
		expect(r.startDate).toBe('2026-10-27');
		expect(r.values).toHaveLength(15);
		// (2·1 + 2·1 + 8·2) / 4 = 5 on day 0, one more each day.
		expect(r.values[0]).toBe(5);
		expect(r.values[14]).toBe(19);
		expect(r.meta).toEqual({ days: 15, issued: '2026-10-27', model: 'ECMWF ENS mean', calibration: NOT_CALIBRATED });
	});

	it('maps each day through the fit for the place and the day’s month, and names the fit', async () => {
		const r = await ecmwfForecastFromMirror(config, '2026-10-27', fakeReader([2, 8], '2026-10-27', QM));
		expect(r.values[0]).toBe(3); // 5 mm → 3 mm
		expect(r.values[10]).toBe(10); // 15 mm → 10 mm
		expect(r.meta.calibration).toBe('quantile-mapped 2027-03-01T10:00:00Z');
		// Positive control for the season: a fit for other months leaves the values and the label alone.
		const djf = { ...QM, groups: [{ ...QM.groups[0]!, months: [12, 1, 2] }] };
		const r2 = await ecmwfForecastFromMirror(config, '2026-10-27', fakeReader([2, 8], '2026-10-27', djf));
		expect(r2.values[0]).toBe(5);
		expect(r2.meta.calibration).toBe(NOT_CALIBRATED);
	});

	it('refuses a cell outside the region before anything is read', async () => {
		let read = false;
		const spy: EcmwfReader = async (c, t) => ((read = true), fakeReader([1], t)(c, t));
		await expect(ecmwfForecastFromMirror({ cells: [{ lat: -40.025, lon: 20.025, weight: 1 }] }, '2026-10-27', spy)).rejects.toThrow(MirrorOutsideRegionError);
		expect(read).toBe(false);
	});
});

describe('liveEcmwfReader', () => {
	const block = { y0: 150, x0: 150, h: 2, w: 2 };
	const values = (k: number) => Float32Array.from({ length: ECMWF_STATS.length * ECMWF_DAYS * 4 }, (_, i) => k + (i % 60) / 10);

	it('reads today’s issue, else yesterday’s, else waits', async () => {
		const store = freshStore();
		const cells = [{ y: 150, x: 150 }, { y: 151, x: 151 }];
		await expect(liveEcmwfReader(store)(cells, '2026-10-27')).rejects.toThrow(MirrorNotReadyError);
		await writeEcmwfIssue(store, '2026-10-26', block, values(1));
		await writeEcmwfIndex(store, { issues: ['2026-10-26'], archived: [] });
		const y = await liveEcmwfReader(store)(cells, '2026-10-27');
		expect(y.issued).toBe('2026-10-26');
		expect(y.qm).toBeNull();
		// The mean is stat 0: (day d, cell i) at offset d·4 + (row·2 + col).
		expect(y.values[0]![0]).toBe(1);
		expect(y.values[0]![1]).toBeCloseTo(1.3, 5);
		expect(y.values[1]![0]).toBeCloseTo(1.4, 5);
		await writeEcmwfIssue(store, '2026-10-27', block, values(5));
		await writeEcmwfIndex(store, { issues: ['2026-10-27', '2026-10-26'], archived: [] });
		expect((await liveEcmwfReader(store)(cells, '2026-10-27')).issued).toBe('2026-10-27');
		// Two days on, neither is today's nor yesterday's.
		await expect(liveEcmwfReader(store)(cells, '2026-10-29')).rejects.toThrow(MirrorNotReadyError);
	});

	it('an archived issue is never read, and a listed issue the copy doesn’t hold is not ready', async () => {
		const store = freshStore();
		await writeEcmwfIndex(store, { issues: [], archived: ['2026-10-27'] });
		await expect(liveEcmwfReader(store)([{ y: 150, x: 150 }], '2026-10-27')).rejects.toThrow(MirrorNotReadyError);
		await writeEcmwfIndex(store, { issues: ['2026-10-27'], archived: [] });
		await expect(liveEcmwfReader(store)([{ y: 150, x: 150 }], '2026-10-27')).rejects.toThrow(/doesn't hold it/);
	});
});

describe('the committed fixture (backend/fixtures/mirror/ecmwf)', () => {
	const store = openStore(pathToFileURL(MIRROR_FIXTURE_DIR).href);

	it('holds one issue in the layout the Python job writes', async () => {
		expect(await readEcmwfIndex(store)).toEqual({ issues: [ECMWF_FIXTURE.issue], archived: [] });
		const arr = await openEcmwfIssue(store, ECMWF_FIXTURE.issue);
		expect(arr?.shape).toEqual([4, 15, 275, 310]);
	});

	it('reads as today’s issue anywhere in the region, each cell from the block by its place modulo 4', async () => {
		const { y0, x0 } = ECMWF_FIXTURE.block;
		const cells = [{ y: y0 + 1, x: x0 + 2 }, { y: y0 + 1 + 4 * 20, x: x0 + 2 - 4 * 30 }];
		const r = await fixtureEcmwfReader(store)(cells, '2026-10-27');
		expect(r.issued).toBe('2026-10-27');
		for (let d = 0; d < ECMWF_DAYS; d++) {
			expect(r.values[d]![0]).toBeCloseTo(ecmwfFixtureMean(d, 1, 2), 5);
			expect(r.values[d]![1]).toBe(r.values[d]![0]);
		}
	});
});
