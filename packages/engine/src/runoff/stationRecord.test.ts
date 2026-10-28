// A rainfall station's checked record (issue #553, docs/model.md §2.4i): the §2.4c/§2.4d checks a
// unit's own gauge gets, then the user's unreliable periods. Synthetic values only (public repo).
import { describe, expect, it } from 'vitest';
import { fromEpochDay, monthOfEpochDay, toEpochDay } from '../calendar';
import { checkedCatchmentRainRecord, mergeSettings } from '../prepare';
import { stationChirpsSeriesKey, stationSeriesKey, type DailySeries, type ModelInput, type ProjectSettings, type RainStationSettings } from '../project';
import { fitStationPairing } from './stationPairing';
import { checkedStationRecord, stationChirpsSource } from './stationRecord';
import { Rng } from '../random';

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

function settingsWith(rainStations: RainStationSettings | null = null, raw: Record<string, unknown> = {}): ProjectSettings {
	const warnings: string[] = [];
	const s = { ...mergeSettings(raw, warnings), rainStations };
	expect(warnings).toEqual([]); // every listed period was taken
	return s;
}
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
		// Beside it, the record as the forcing reads it (the pairing's complete years count on it); none without the option.
		expect(fit.forcing).toEqual(run.record);
		expect(run.forcing).toBeUndefined();
		// Positive control: read against the catchment's CHIRPS (no cell), the reading is one day's rain, kept.
		const noCell = checkedStationRecord(settingsWith(), seriesOf({ [stationSeriesKey('S1')]: ser(gauge), rain_chirps_mm: ser(catchmentChirps) }), 'S1')!;
		expect(noCell.record.values[ACC_READ]).toBe(60);
	});

	it('the catchment gauge’s dated lists don’t apply to a station', () => {
		const stored = rainOf(1);
		const s = settingsWith(null, { zeroRainRuns: { ...mergeSettings({}, []).zeroRainRuns, missing: [{ start: '2015-01-01', end: '2015-12-31', reason: 'invented' }] } });
		expect(s.zeroRainRuns.missing).toHaveLength(1); // the list is really there
		const r = checkedStationRecord(s, seriesOf({ [stationSeriesKey('S1')]: ser(stored) }), 'S1')!;
		expect(r.record.values).toEqual(stored);
	});

	it('unreliable periods blank exactly their inclusive days, counted once; days without a reading aren’t counted', () => {
		const stored: (number | null)[] = rainOf(1).map((v) => v! + 1); // a reading every day, none of them a suspect zero
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

describe('the station that is the catchment’s rain gauge (isCatchmentGauge)', () => {
	const KEEP_DRY = { start: '2016-11-01', end: '2017-02-28', reason: 'invented' };
	const MISSING = { start: '2018-03-01', end: '2018-03-10', reason: 'invented' };
	const zr = () => settingsWith(null, { zeroRainRuns: { ...mergeSettings({}, []).zeroRainRuns, keepDry: [KEEP_DRY], missing: [MISSING] } });
	const stored = () => withZeroRun(rainOf(1).map((v, i) => (i >= ZR_FROM && i <= ZR_TO ? v : v! + 1)));
	const inputs = () => seriesOf({ [stationSeriesKey('S1')]: ser(stored()), rain_chirps_mm: ser(rainOf(0.7)) });

	it('its dated keep-dry and missing lists apply, exactly as the catchment gauge’s own checks', () => {
		const s = zr();
		const r = checkedStationRecord(s, inputs(), 'S1', { isCatchmentGauge: true })!;
		// Kept dry: the zero run is read as recorded (0), not set aside.
		for (let i = ZR_FROM; i <= ZR_TO; i++) expect(r.record.values[i]).toBe(0);
		// Missing: the listed days are blank.
		for (let i = at(MISSING.start); i <= at(MISSING.end); i++) expect(r.record.values[i]).toBeNull();
		expect(r.setAside.checks).toBe(10);
		// The same as the catchment gauge's checked record on the same series.
		const catchment = checkedCatchmentRainRecord({ ...s, chirpsQuantileMap: null }, seriesOf({ rain_catchment_mm: ser(stored()), rain_chirps_mm: ser(rainOf(0.7)) }))!;
		expect(r.record).toEqual({ startDate: catchment.startDate, values: catchment.values.map((v) => (v !== null && v >= 0 ? v : null)) });
	});

	it('a station that isn’t the gauge doesn’t take them (positive control for the above)', () => {
		const r = checkedStationRecord(zr(), inputs(), 'S1')!;
		expect(r.record.values[ZR_FROM + 30]).toBeNull(); // the zero run is set aside, not kept dry
		for (let i = at(MISSING.start); i <= at(MISSING.end); i++) expect(r.record.values[i]).toBe(stored()[i]);
	});

	it('its rain-source periods are written in, over the span the catchment gauge’s record reads', () => {
		const s = settingsWith(null, { rainSource: [{ start: '2020-12-01', end: '2021-01-31', series: 'rain_catchment_alt_mm', factors: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], provenance: { source: 'invented', method: 'invented', fittedFrom: '2010-01-01', fittedTo: '2010-12-31' }, reason: 'invented' }] });
		const alt = ser(Array.from({ length: 400 }, () => 7), '2020-06-01');
		const x = seriesOf({ [stationSeriesKey('S1')]: ser(rainOf(1)), rain_catchment_alt_mm: alt });
		const r = checkedStationRecord(s, x, 'S1', { isCatchmentGauge: true })!;
		const catchment = checkedCatchmentRainRecord(s, seriesOf({ rain_catchment_mm: ser(rainOf(1)), rain_catchment_alt_mm: alt }))!;
		expect(r.record.startDate).toBe(START);
		expect(r.record.values.length).toBe(DAYS + 31); // to 2021-01-31
		expect(r.record.values).toEqual(catchment.values);
		expect(r.record.values[at('2020-12-15')]).toBeCloseTo(7, 9);
		expect(r.record.values[DAYS + 10]).toBeCloseTo(7, 9);
		// Not a gauge: the period is the catchment gauge's, not this station's.
		const plain = checkedStationRecord(s, x, 'S1')!;
		expect(plain.record.values.length).toBe(DAYS);
		expect(plain.record.values[at('2020-12-15')]).toBe(rainOf(1)[at('2020-12-15')]);
	});

	it('the pairing fit reads the same record as the forcing', () => {
		const s = zr();
		const x = seriesOf({ ...(inputs() as Record<string, DailySeries>), [stationChirpsSeriesKey('S1')]: ser(rainOf(0.7).map((v) => v! + 0.1)) });
		const forcing = checkedStationRecord(s, x, 'S1', { isCatchmentGauge: true })!;
		const fitRec = checkedStationRecord(s, x, 'S1', { isCatchmentGauge: true, fitExcludeAccumulations: true })!;
		expect(fitRec.record).toEqual(forcing.record); // no accumulations here, so the two agree day by day
		const stations = { S1: { name: 'Gauge', mapMm: 600, mapSource: 'invented', lat: null, lon: null, isCatchmentGauge: true } };
		const fit = fitStationPairing({ settings: s, series: x, stations, stationId: 'S1', area: { id: 'U', name: 'U', chirps: (x as Record<string, DailySeries>)[stationChirpsSeriesKey('S1')], ratio: 1 } }, []);
		expect(fit.refused).toBeNull();
		const march = forcing.record.values.filter((v, i) => v !== null && monthOf(i) === 3).length;
		expect(fit.months[2]!.sharedDays).toBe(march);
		// Not the gauge: the missing list doesn't apply, so March keeps its 10 days, in the forcing's record and the
		// fit's alike (the fit is refused here, its set-aside zero run breaking two years, but still counts its days).
		const plain = fitStationPairing({ settings: s, series: x, stations: { S1: { ...stations.S1, isCatchmentGauge: false } }, stationId: 'S1', area: { id: 'U', name: 'U', chirps: (x as Record<string, DailySeries>)[stationChirpsSeriesKey('S1')], ratio: 1 } }, []);
		const plainForcing = checkedStationRecord(s, x, 'S1')!;
		expect(plain.refused).toMatch(/4 complete calendar years/);
		expect(plainForcing.record.values.filter((v, i) => v !== null && monthOf(i) === 3).length).toBe(march + 10);
		expect(plain.days).toBe(plainForcing.record.values.filter((v) => v !== null).length);
		expect(fit.days).toBe(forcing.record.values.filter((v) => v !== null).length);
	});
});

describe('the forcing’s record holds every day the fit’s record holds (RS6, model.md §2.4i)', () => {
	// The pairing counts its complete years on `forcing` and fits its factors on `record` (stationPairing.ts), which
	// is sound only if `forcing` reads every day `record` does, with the same value: the fit's record is the forcing's
	// with the accumulation windows left out, and the user's unreliable periods blank both. Random stations from a
	// seeded generator (a failure names its seed): multi-day accumulations, outages past the 7 blank days a window may
	// hold, gaps, unreliable periods (one always across a window §2.4d may spread), either accumulation mode, gauge or not.
	const SEEDS = 60;
	const iso = (i: number) => fromEpochDay(D0 + i);
	// The engine exports no days-in-year helper (stationPairing.ts keeps its own, unexported); this is the same
	// definition, read through the engine's calendar.
	const daysInYear = (y: number) => toEpochDay(`${y + 1}-01-01`) - toEpochDay(`${y}-01-01`);
	const completeYears = (a: (number | null)[], b: (number | null)[]) => {
		const per = new Map<number, number>();
		for (let i = 0; i < DAYS; i++) {
			if (a[i] == null || b[i] == null) continue;
			const y = Number(iso(i).slice(0, 4));
			per.set(y, (per.get(y) ?? 0) + 1);
		}
		return [...per].filter(([y, n]) => n === daysInYear(y)).length;
	};

	function station(seed: number) {
		const rng = new Rng(seed);
		const gauge: (number | null)[] = rainOf(rng.float(0.6, 1.6), rng.int(0, 12)).map((v) => v! + (rng.bool(0.3) ? rng.float(0, 3) : 0));
		const cell: (number | null)[] = rainOf(rng.float(0.4, 1), rng.int(0, 12)).map((v) => v! + (rng.bool(0.3) ? rng.float(0, 2) : 0));
		const windows: { first: number; read: number }[] = [];
		for (let at0 = rng.int(20, 80); at0 < DAYS - 30; at0 += rng.int(25, 160)) {
			// 1–10 blank days, then a reading: 3–7 make a window §2.4d spreads (its CHIRPS wet over the run, dry the day
			// before the reading, on it and after, as §2.4d looks for), fewer just a gap and a reading, more an outage
			// whose reading is set aside.
			const blanks = rng.int(1, 10);
			const read = at0 + blanks;
			gauge[at0 - 1] = 0;
			cell[at0 - 1] = 0;
			for (let i = at0; i < read; i++) {
				gauge[i] = null;
				cell[i] = i < read - 1 ? rng.float(15, 30) : 0;
			}
			gauge[read] = rng.float(20, 50);
			cell[read] = 0;
			cell[read + 1] = 0;
			windows.push({ first: at0, read });
		}
		for (let k = rng.int(0, 6); k > 0; k--) gauge[rng.int(0, DAYS - 1)] = null;
		// Across one window §2.4d may spread (3–7 blank days), part of it or all and past it.
		const short = windows.filter((v) => v.read - v.first >= 3 && v.read - v.first <= 7);
		expect(short.length, `seed ${seed}: no window of 3–7 blank days`).toBeGreaterThan(0);
		const w = short[rng.int(0, short.length - 1)]!;
		const unreliable: [string, string][] = [[iso(w.first + rng.int(0, 1)), iso(w.read + rng.int(-1, 2))]];
		for (let k = rng.int(0, 3); k > 0; k--) {
			const a = rng.int(0, DAYS - 1);
			unreliable.push([iso(a), iso(Math.min(a + rng.int(0, 40), DAYS - 1))]);
		}
		const base = mergeSettings({}, []);
		const s: ProjectSettings = { ...base, zeroRainRuns: { ...base.zeroRainRuns, accumulationMode: rng.bool() ? 'spread' : 'asRecorded' }, rainStations: { unreliable: { S1: unreliable } } };
		return { s, gauge, cell, unreliable, isCatchmentGauge: rng.bool(0.3) };
	}

	it('on every seed: forcing ⊇ record day by day, both blank on the unreliable days, and forcing is the run’s own record', () => {
		let wider = 0;
		let cut = 0;
		for (let seed = 1; seed <= SEEDS; seed++) {
			const { s, gauge, cell, unreliable, isCatchmentGauge } = station(seed);
			const x = seriesOf({ [stationSeriesKey('S1')]: ser(gauge), [stationChirpsSeriesKey('S1')]: ser(cell), rain_chirps_mm: ser(cell) });
			const fit = checkedStationRecord(s, x, 'S1', { fitExcludeAccumulations: true, isCatchmentGauge })!;
			const run = checkedStationRecord(s, x, 'S1', { isCatchmentGauge })!;
			const rec = fit.record.values;
			const forcing = fit.forcing!;
			expect(forcing.startDate, `seed ${seed}`).toBe(fit.record.startDate);
			expect(forcing.values.length, `seed ${seed}`).toBe(rec.length);
			for (let i = 0; i < rec.length; i++) if (rec[i] !== null) expect(forcing.values[i], `seed ${seed} day ${i}`).toBe(rec[i]);
			expect(forcing, `seed ${seed}`).toEqual(run.record);
			const d0 = toEpochDay(forcing.startDate);
			for (const [from, to] of unreliable) for (let d = toEpochDay(from); d <= toEpochDay(to); d++) expect(forcing.values[d - d0], `seed ${seed} ${iso(d - D0)}`).toBeNull();
			// The pairing reads them so: its complete years on the forcing's record, never fewer than the fit's, and its
			// shared days on the fit's.
			const stations = { S1: { name: 'S1', mapMm: 600, mapSource: 'invented', lat: null, lon: null, ...(isCatchmentGauge ? { isCatchmentGauge: true } : {}) } };
			const pairing = fitStationPairing({ settings: s, series: x, stations, stationId: 'S1', area: { id: 'U', name: 'U', chirps: (x as Record<string, DailySeries>)[stationChirpsSeriesKey('S1')], ratio: 1 } }, []);
			expect(pairing.commonYears, `seed ${seed}`).toBe(completeYears(forcing.values, cell));
			expect(pairing.commonYears, `seed ${seed}`).toBeGreaterThanOrEqual(completeYears(rec, cell));
			expect(pairing.days, `seed ${seed}`).toBe(rec.filter((v, i) => v !== null && cell[i] != null).length);
			if (forcing.values.filter((v) => v !== null).length > rec.filter((v) => v !== null).length) wider++;
			// An unreliable period across a window: without the periods, days the forcing's record reads and the fit's
			// leaves out (a spread day, or an as-recorded reading) that the period covers; the forcing above was blank on them.
			const free = checkedStationRecord({ ...s, rainStations: null }, x, 'S1', { fitExcludeAccumulations: true, isCatchmentGauge })!;
			const inPeriod = (i: number) => unreliable.some(([from, to]) => d0 + i >= toEpochDay(from) && d0 + i <= toEpochDay(to));
			if (free.forcing!.values.some((v, i) => v !== null && free.record.values[i] === null && inPeriod(i))) cut++;
		}
		// Positive controls: the property bit on stations where the two records really differ, spread windows and all.
		expect(wider).toBeGreaterThan(SEEDS / 2);
		expect(cut).toBeGreaterThan(SEEDS / 2);
	});
});
