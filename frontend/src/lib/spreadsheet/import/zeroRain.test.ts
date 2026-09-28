import { toEpochDay, zeroRainRuns } from '@water-management/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { isoAdd } from './testWorkbook';
import { zeroRainNote } from './zeroRain';

// Ported from scripts/wbt-import/test_rain_quality.py. The Python has its own
// copy of the rule (zero_rain_runs); the TypeScript importer uses the engine's
// zeroRainRuns, so these cases check that it flags what the Python flags and
// that the note reads the same.
const START = '2010-01-01';
const DAYS = 6 * 365;
const WINTER = [4, 5, 6, 7, 8, 9];
const SUMMER = [1, 2, 3, 10, 11, 12];

const monthOf = (i: number) => Number(isoAdd(START, i).slice(5, 7));

/** Synthetic rain: 8 mm every third day in the wet months, 2 mm every ninth day otherwise. */
function seasonal(wet: number[]): (number | null)[] {
	return Array.from({ length: DAYS }, (_, i) => (wet.includes(monthOf(i)) ? (i % 3 === 0 ? 8 : 0) : i % 9 === 0 ? 2 : 0));
}

/** Zero first..last inclusive, with 5 mm on the day either side. */
function gap(v: (number | null)[], first: string, last: string): void {
	const a = toEpochDay(first) - toEpochDay(START);
	const b = toEpochDay(last) - toEpochDay(START);
	for (let i = a; i <= b; i++) v[i] = 0;
	v[a - 1] = 5;
	v[b + 1] = 5;
}

const runs = (v: (number | null)[]) => {
	const r = zeroRainRuns({ startDate: START, values: v });
	return { wet: r.wetMonths, runs: r.runs.map((x) => [x.startDate, x.endDate, x.days]) };
};

describe('zero-rain runs (the Python importer cases)', () => {
	it('flags a wet-season run, not a longer dry-season one', () => {
		const v = seasonal(WINTER);
		gap(v, '2012-06-01', '2012-08-15');
		gap(v, '2013-11-01', '2014-02-28');
		expect(runs(v)).toEqual({ wet: WINTER, runs: [['2012-06-01', '2012-08-15', 76]] });
	});

	it('takes the wet season from the series itself', () => {
		const v = seasonal(SUMMER);
		gap(v, '2012-06-01', '2012-08-15');
		gap(v, '2012-12-01', '2013-02-14');
		expect(runs(v)).toEqual({ wet: SUMMER, runs: [['2012-12-01', '2013-02-14', 76]] });
	});

	it('counts only wet-season days toward 60', () => {
		let v = seasonal(WINTER);
		gap(v, '2012-03-01', '2012-05-29'); // 59 wet days
		expect(runs(v).runs).toEqual([]);
		v = seasonal(WINTER);
		gap(v, '2012-03-01', '2012-05-30'); // 60
		expect(runs(v).runs).toEqual([['2012-03-01', '2012-05-30', 91]]);
	});

	it('ends a run on a blank day', () => {
		const v = seasonal(WINTER);
		gap(v, '2012-06-01', '2012-08-15');
		v[toEpochDay('2012-07-10') - toEpochDay(START)] = null;
		expect(runs(v).runs).toEqual([]);
	});

	it('uses a plain 180-day rule on a short series', () => {
		const short = (n: number) => [3, ...new Array<number>(n).fill(0), ...new Array<number>(201).fill(3)];
		expect(runs(short(179))).toEqual({ wet: null, runs: [] });
		expect(runs(short(180))).toEqual({ wet: null, runs: [['2010-01-02', '2010-06-30', 180]] });
	});

	it('names the dates and how runs treat them in the note', () => {
		const v = seasonal(WINTER);
		gap(v, '2012-06-01', '2012-08-15');
		const note = zeroRainNote([{ kind: 'rain_catchment_mm', startDate: START, values: v }])!;
		expect(note).toContain('2012-06-01 to 2012-08-15 (76 days)');
		expect(note).toContain('months 4,5,6,7,8,9');
		// Engine ≥ 0.15.0 treats a flagged run as missing by default (CR-20); no re-export advice.
		expect(note).toContain('Runs treat them as missing');
		expect(note).toContain('Zero-rain runs');
		expect(note).not.toContain('re-export');
		// Negative controls: no gap, or only CHIRPS has the gap.
		expect(zeroRainNote([{ kind: 'rain_catchment_mm', startDate: START, values: seasonal(WINTER) }])).toBeNull();
		expect(zeroRainNote([{ kind: 'rain_chirps_mm', startDate: START, values: v }])).toBeNull();
	});

	describe('under a skewed time zone', () => {
		const tz = process.env.TZ;
		afterEach(() => {
			process.env.TZ = tz;
		});
		it('flags the same calendar dates', () => {
			const v = seasonal(WINTER);
			gap(v, '2012-06-01', '2012-08-15');
			for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
				process.env.TZ = zone;
				expect(zeroRainNote([{ kind: 'rain_catchment_mm', startDate: START, values: v }]), zone).toContain('2012-06-01 to 2012-08-15 (76 days)');
			}
		});
	});
});
