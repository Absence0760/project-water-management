// A rainfall station's checked record (issue #553, docs/model.md §2.4i): the §2.4c/§2.4d checks a
// unit's own gauge gets, then the user's unreliable periods. Synthetic values only (public repo).
import { describe, expect, it } from 'vitest';
import { monthOfEpochDay, toEpochDay } from '../calendar';
import { mergeSettings } from '../prepare';
import { stationChirpsSeriesKey, stationSeriesKey, type DailySeries, type ModelInput, type ProjectSettings, type RainStationSettings } from '../project';
import { checkedStationRecord, stationChirpsSource } from './stationRecord';

const START = '2015-01-01';
const D0 = toEpochDay(START);
const DAYS = toEpochDay('2021-01-01') - D0; // six whole calendar years
const at = (iso: string) => toEpochDay(iso) - D0;
const monthOf = (i: number) => monthOfEpochDay(D0 + i);
// Summer rain (Oct–Mar wet), so §2.4c's wet half of the year is Oct–Mar.
const season = (i: number) => (monthOf(i) >= 4 && monthOf(i) <= 9 ? 0.3 : 1.5);
const rainOf = (k: number, phase = 0): (number | null)[] => Array.from({ length: DAYS }, (_, i) => season(i) * ((i + phase) % 13 === 0 ? 30 * k : (i + phase) % 4 === 0 ? 2 * k : 0));

const ZR_FROM = at('2016-11-01');
const ZR_TO = at('2017-02-28');
const withZeroRun = (v: (number | null)[]) => v.map((x, i) => (i >= ZR_FROM && i <= ZR_TO ? 0 : x));
// The flagged run is the whole stretch of zeros: the recorded dry days either side join it.
const ZR = (() => {
	const v = withZeroRun(rainOf(1));
	let a = ZR_FROM;
	let b = ZR_TO;
	while (v[a - 1] === 0) a--;
	while (v[b + 1] === 0) b++;
	return { from: a, to: b, days: b - a + 1 };
})();

// Five blank days 2017-05-10 … 14, then 60 mm on the 15th; the CHIRPS rains 15 mm on the 10th–13th, none on the 14th–16th.
const ACC_BLANK = [at('2017-05-10'), at('2017-05-14')] as const;
const ACC_READ = at('2017-05-15');
function withAccumulation(gauge: (number | null)[], chirps: (number | null)[]): void {
	for (let i = ACC_BLANK[0]; i <= ACC_BLANK[1]; i++) gauge[i] = null;
	gauge[ACC_READ] = 60;
	gauge[ACC_BLANK[0] - 1] = 0;
	for (let i = ACC_BLANK[0] - 1; i <= ACC_READ + 1; i++) chirps[i] = i <= ACC_BLANK[0] + 3 && i >= ACC_BLANK[0] ? 15 : 0;
}

const settingsWith = (rainStations: RainStationSettings | null = null, raw: Record<string, unknown> = {}): ProjectSettings => ({ ...mergeSettings(raw, []), rainStations });
const ser = (values: (number | null)[], startDate = START): DailySeries => ({ startDate, values });
const seriesOf = (m: Record<string, DailySeries>) => m as unknown as ModelInput['series'];

describe('checkedStationRecord', () => {
	it('is null without a record for the station (no series, or an empty one)', () => {
		expect(checkedStationRecord(settingsWith(), seriesOf({}), 'S1')).toBeNull();
		expect(checkedStationRecord(settingsWith(), seriesOf({ [stationSeriesKey('S1')]: ser([]) }), 'S1')).toBeNull();
		// Another station's record isn't this one's.
		expect(checkedStationRecord(settingsWith(), seriesOf({ [stationSeriesKey('S2')]: ser(rainOf(1)) }), 'S1')).toBeNull();
	});

	it('positive control: a record with nothing suspect comes back as stored, nothing set aside, no warning', () => {
		const stored = rainOf(1);
		const r = checkedStationRecord(settingsWith(), seriesOf({ [stationSeriesKey('S1')]: ser(stored), [stationChirpsSeriesKey('S1')]: ser(rainOf(0.7)) }), 'S1')!;
		expect(r.record).toEqual({ startDate: START, values: stored });
		expect(r.setAside).toEqual({ checks: 0, unreliable: 0 });
		expect(r.warnings).toEqual([]);
	});

	it('a negative reading is a no-data code: blank, and not counted as set aside', () => {
		const stored = rainOf(1);
		stored[10] = -999;
		const r = checkedStationRecord(settingsWith(), seriesOf({ [stationSeriesKey('S1')]: ser(stored) }), 'S1')!;
		expect(r.record.values[10]).toBeNull();
		expect(r.setAside.checks).toBe(0);
	});

	it('a suspect zero run is set aside (§2.4c, the catchment’s settings) and counted under the checks', () => {
		const r = checkedStationRecord(settingsWith(), seriesOf({ [stationSeriesKey('S1')]: ser(withZeroRun(rainOf(1))) }), 'S1', { name: 'Hill' })!;
		// No CHIRPS anywhere, so the fill threshold keeps no day: the whole run is set aside.
		for (let i = ZR.from; i <= ZR.to; i++) expect(r.record.values[i]).toBeNull();
		expect(ZR.days).toBeGreaterThanOrEqual(120);
		expect(r.setAside).toEqual({ checks: ZR.days, unreliable: 0 });
		expect(r.warnings.some((w) => w.startsWith(`station: "Hill" is treated as missing on ${ZR.days} days of flagged zero runs`))).toBe(true);
		// Positive control: the readings either side are read.
		expect(r.record.values[ZR.from - 1]).toBe(rainOf(1)[ZR.from - 1]);
		expect(r.record.values[ZR.to + 1]).toBe(rainOf(1)[ZR.to + 1]);
		expect(rainOf(1)[ZR.from - 1]).toBeGreaterThan(0);
	});

	it('a multi-day accumulation is spread over its days against the station’s own CHIRPS cell (§2.4d), and left blank for the fit', () => {
		const gauge = rainOf(1);
		const cell = rainOf(0.7);
		withAccumulation(gauge, cell);
		// The catchment's CHIRPS rains 50 mm on the reading day, which would make the reading one day's rain:
		// the checks must read the station's cell, not it.
		const catchmentChirps = rainOf(0.7);
		catchmentChirps[ACC_READ] = 50;
		const series = seriesOf({ [stationSeriesKey('S1')]: ser(gauge), [stationChirpsSeriesKey('S1')]: ser(cell), rain_chirps_mm: ser(catchmentChirps) });
		const run = checkedStationRecord(settingsWith(), series, 'S1')!;
		expect(run.record.values.slice(ACC_BLANK[0], ACC_READ + 1).map((v) => Math.round(v! * 1e9) / 1e9)).toEqual([15, 15, 15, 15, 0, 0]);
		expect(run.warnings.some((w) => w.includes('1 multi-day accumulation spread over 6 days (60 mm)'))).toBe(true);
		// The reading day was spread, not set aside: its stored reading is replaced by a share (0), not blanked.
		expect(run.setAside.checks).toBe(0);
		const fit = checkedStationRecord(settingsWith(), series, 'S1', { fitExcludeAccumulations: true })!;
		expect(fit.record.values.slice(ACC_BLANK[0], ACC_READ + 1)).toEqual([null, null, null, null, null, null]);
		expect(fit.record.values[ACC_BLANK[0] - 1]).toBe(0);
		expect(fit.record.values[ACC_READ + 1]).toBe(gauge[ACC_READ + 1]);
		expect(fit.setAside.checks).toBe(1); // the 60 mm reading
		// Positive control: read against the catchment's CHIRPS (no cell), the reading is one day's rain, kept.
		const noCell = checkedStationRecord(settingsWith(), seriesOf({ [stationSeriesKey('S1')]: ser(gauge), rain_chirps_mm: ser(catchmentChirps) }), 'S1')!;
		expect(noCell.record.values[ACC_READ]).toBe(60);
	});

	it('the catchment gauge’s dated lists don’t apply to a station', () => {
		const stored = rainOf(1);
		const s = settingsWith(null, { zeroRainRuns: { ...mergeSettings({}, []).zeroRainRuns, missing: [{ start: '2015-01-01', end: '2015-12-31' }] } });
		const r = checkedStationRecord(s, seriesOf({ [stationSeriesKey('S1')]: ser(stored) }), 'S1')!;
		expect(r.record.values).toEqual(stored);
	});

	it('unreliable periods blank exactly their inclusive days, counted once; days without a reading aren’t counted', () => {
		const stored = rainOf(1).map((v) => v! + 1); // a reading every day, none of them a suspect zero
		stored[at('2018-03-05')] = null;
		const s = settingsWith({
			unreliable: {
				S1: [
					['2018-03-01', '2018-03-10'],
					['2018-03-08', '2018-03-12'], // overlaps the first: its days count once
					['2014-12-25', '2015-01-02'], // starts before the record
					['2020-12-30', '2021-02-01'] // ends after it
				],
				S2: [['2016-01-01', '2016-12-31']] // another station's
			}
		});
		const r = checkedStationRecord(s, seriesOf({ [stationSeriesKey('S1')]: ser(stored) }), 'S1', { name: 'Hill' })!;
		const blanked = new Set<number>();
		for (let i = at('2018-03-01'); i <= at('2018-03-12'); i++) blanked.add(i);
		for (let i = 0; i <= at('2015-01-02'); i++) blanked.add(i);
		for (let i = at('2020-12-30'); i < DAYS; i++) blanked.add(i);
		for (let i = 0; i < DAYS; i++) expect(r.record.values[i]).toBe(blanked.has(i) ? null : stored[i]);
		expect(r.record.values.length).toBe(DAYS);
		expect(r.setAside).toEqual({ checks: 0, unreliable: 12 - 1 + 2 + 2 });
		expect(r.warnings).toContain('station: "Hill" is treated as missing on 15 days the user marked unreliable. The stored series is unchanged.');
	});

	it('a day both a check and an unreliable period set aside counts under the checks only', () => {
		const s = settingsWith({ unreliable: { S1: [['2016-12-01', '2016-12-31']] } });
		const r = checkedStationRecord(s, seriesOf({ [stationSeriesKey('S1')]: ser(withZeroRun(rainOf(1))) }), 'S1')!;
		expect(r.setAside).toEqual({ checks: ZR.days, unreliable: 0 });
	});

	it('an unreliable period that isn’t two dates in order is ignored, with a warning', () => {
		const stored = rainOf(1);
		const s = settingsWith({ unreliable: { S1: [['2018-03-10', '2018-03-01'], ['2018-02-30', '2018-03-01'], ['nonsense'] as never] } });
		const r = checkedStationRecord(s, seriesOf({ [stationSeriesKey('S1')]: ser(stored) }), 'S1')!;
		expect(r.record.values).toEqual(stored);
		expect(r.setAside.unreliable).toBe(0);
		expect(r.warnings.filter((w) => w.includes('unreliable period that isn’t two dates in order'))).toHaveLength(3);
	});

	it('is deterministic', () => {
		const s = settingsWith({ unreliable: { S1: [['2018-03-01', '2018-03-10']] } });
		const x = seriesOf({ [stationSeriesKey('S1')]: ser(withZeroRun(rainOf(1))), [stationChirpsSeriesKey('S1')]: ser(rainOf(0.7)) });
		expect(checkedStationRecord(s, x, 'S1')).toEqual(checkedStationRecord(s, x, 'S1'));
	});
});

describe('stationChirpsSource', () => {
	const cell = ser(rainOf(0.7));
	const unit = ser(rainOf(0.5));
	it('the station’s own cell first, then the unit it stands in, else none', () => {
		const s = settingsWith({ sites: { S1: { unitId: 'U' } } });
		expect(stationChirpsSource(s, seriesOf({ [stationChirpsSeriesKey('S1')]: cell, 'rain_chirps_mm@U': unit }), 'S1')).toEqual({ at: 'cell', key: 'rain_chirps_station_mm#S1', series: cell });
		expect(stationChirpsSource(s, seriesOf({ 'rain_chirps_mm@U': unit }), 'S1')).toEqual({ at: 'unit', unitId: 'U', key: 'rain_chirps_mm@U', series: unit });
		expect(stationChirpsSource(s, seriesOf({}), 'S1')).toEqual({ at: 'unit', unitId: 'U', key: 'rain_chirps_mm@U', series: null });
		expect(stationChirpsSource(settingsWith(), seriesOf({ rain_chirps_mm: unit }), 'S1')).toEqual({ at: 'none' });
	});
});
