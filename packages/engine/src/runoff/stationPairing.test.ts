// A rainfall station's pairing with the CHIRPS at it (issue #553, docs/model.md §2.4i): monthly
// Σ station ÷ Σ CHIRPS factors, refused under STATION_PAIRING_MIN_YEARS complete years in common.
// Synthetic values only (public repo).
import { describe, expect, it } from 'vitest';
import { fromEpochDay, monthOfEpochDay, toEpochDay } from '../calendar';
import { mergeSettings } from '../prepare';
import {
	STATION_PAIRING_MIN_YEARS,
	stationChirpsSeriesKey,
	stationSeriesKey,
	type DailySeries,
	type ModelInput,
	type NetworkNode,
	type ProjectSettings,
	type RainStationInputs,
	type RainStationSettings
} from '../project';
import { fitStationPairing, pairingFactorOn } from './stationPairing';

const daysBetween = (a: string, b: string) => toEpochDay(b) - toEpochDay(a);
// A CHIRPS-like record: a wet day every 4th (2 mm) and every 13th (30 mm), wetter Oct–Mar.
function chirpsOver(start: string, days: number, phase = 0): number[] {
	const d0 = toEpochDay(start);
	return Array.from({ length: days }, (_, i) => {
		const m = monthOfEpochDay(d0 + i);
		const season = m >= 4 && m <= 9 ? 0.3 : 1.5;
		return season * ((i + phase) % 13 === 0 ? 30 : (i + phase) % 4 === 0 ? 2 : 0) + 0.1; // never 0, so no suspect zero run
	});
}
/** station = CHIRPS × k(month) */
const scaled = (start: string, chirps: readonly (number | null)[], k: (month: number) => number) => chirps.map((v, i) => (v === null ? null : v * k(monthOfEpochDay(toEpochDay(start) + i))));

const K = [1.2, 1.1, 1.3, 0.9, 0.8, 0.7, 1.0, 1.05, 1.15, 1.4, 1.25, 1.35];
const STATIONS: RainStationInputs = { S1: { name: 'Hill station', mapMm: 700, mapSource: 'invented', lat: null, lon: null } };
const node = (id: string, name: string) => ({ id, name, kind: 'farm', areaKm2: 5 }) as unknown as NetworkNode;
const NODES = [node('U', 'Unit U'), node('V', 'Unit V')];
const settingsWith = (rainStations: RainStationSettings | null = null): ProjectSettings => ({ ...mergeSettings({}, []), rainStations });
const seriesOf = (m: Record<string, DailySeries>) => m as unknown as ModelInput['series'];

function pairing(opts: { start?: string; end?: string; chirps?: (number | null)[]; station?: (number | null)[]; rainStations?: RainStationSettings | null; chirpsKey?: string; extra?: Record<string, DailySeries> } = {}) {
	const start = opts.start ?? '2015-01-01';
	const days = daysBetween(start, opts.end ?? '2021-01-01');
	const chirps = opts.chirps ?? chirpsOver(start, days);
	const station = opts.station ?? scaled(start, chirps, (m) => K[m - 1]!);
	const series = seriesOf({
		[stationSeriesKey('S1')]: { startDate: start, values: station },
		[opts.chirpsKey ?? stationChirpsSeriesKey('S1')]: { startDate: start, values: chirps },
		...(opts.extra ?? {})
	});
	const warnings: string[] = [];
	const fit = fitStationPairing({ settings: settingsWith(opts.rainStations ?? null), series, stations: STATIONS, nodes: NODES, stationId: 'S1' }, warnings);
	return { fit, warnings, chirps, station, start };
}

describe('fitStationPairing: the factors', () => {
	it('each month’s factor is Σ station ÷ Σ CHIRPS over the shared days, as computed by hand', () => {
		const { fit, warnings, chirps, station, start } = pairing();
		expect(fit.refused).toBeNull();
		expect(fit.pinned).toBe(false);
		expect(fit.chirpsAt).toEqual({ cell: true });
		expect(fit.stationName).toBe('Hill station');
		expect(fit.months).toHaveLength(12);
		const d0 = toEpochDay(start);
		for (let m = 1; m <= 12; m++) {
			let n = 0;
			let g = 0;
			let c = 0;
			for (let i = 0; i < chirps.length; i++)
				if (monthOfEpochDay(d0 + i) === m) {
					n++;
					g += station[i]!;
					c += chirps[i]!;
				}
			const x = fit.months[m - 1]!;
			expect(x).toMatchObject({ month: m, sharedDays: n, fitted: true, clamped: false, outsideBand: false });
			expect(x.gaugeMm).toBeCloseTo(g, 9);
			expect(x.chirpsMm).toBeCloseTo(c, 9);
			expect(x.ownFactor!).toBeCloseTo(g / c, 12);
			expect(x.factor).toBeCloseTo(K[m - 1]!, 12);
		}
		expect(fit).toMatchObject({ fitFrom: '2015-01-01', fitTo: '2020-12-31', commonYears: 6, days: chirps.length });
		expect(warnings).toEqual([]);
	});

	it('only days with a reading in both count: a gap in either is left out of the sums', () => {
		const start = '2015-01-01';
		const days = daysBetween(start, '2022-01-01'); // seven years, so two broken ones still leave five
		const chirps: (number | null)[] = chirpsOver(start, days);
		const station = scaled(start, chirps, () => 1.5);
		const jan2015 = toEpochDay('2015-01-10') - toEpochDay(start);
		const jan2016 = toEpochDay('2016-01-20') - toEpochDay(start);
		chirps[jan2015] = null;
		station[jan2016] = -1; // a no-data code
		station[jan2016 + 1] = 9999; // would pull January up if read against nothing: its CHIRPS is blank
		chirps[jan2016 + 1] = null;
		const { fit } = pairing({ start, end: '2022-01-01', chirps, station });
		expect(fit.months[0]!.sharedDays).toBe(7 * 31 - 3);
		expect(fit.months[0]!.ownFactor!).toBeCloseTo(1.5, 12);
		expect(fit.commonYears).toBe(5);
		expect(fit.days).toBe(days - 3);
	});

	it('a month under CHIRPS_FACTOR_MIN_MM of CHIRPS gets factor 1, with a warning (the day minimum can’t bind: five complete years hold ≥ 140 days of every month)', () => {
		const start = '2015-01-01';
		const chirps = chirpsOver(start, daysBetween(start, '2021-01-01')).map((v, i) => (monthOfEpochDay(toEpochDay(start) + i) === 7 ? 0 : v));
		const { fit, warnings } = pairing({ chirps, station: scaled(start, chirps, () => 2) });
		const jul = fit.months[6]!;
		expect(jul).toMatchObject({ fitted: false, ownFactor: null, factor: 1, clamped: false, outsideBand: false, chirpsMm: 0, sharedDays: 6 * 31 });
		expect(fit.months[5]!.factor).toBeCloseTo(2, 12);
		expect(warnings).toContain(
			'station pairing: "Hill station": the station and the CHIRPS at it have too little in common in Jul (fewer than 90 shared days, or under 50 mm of CHIRPS on them), so that month’s factor is 1'
		);
	});

	it('a factor past 0.25–4 is clamped, one past the 0.5–2 band is used as it is, both warn', () => {
		const k = [5, 2.5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.1];
		const { fit, warnings } = pairing({ station: scaled('2015-01-01', chirpsOver('2015-01-01', daysBetween('2015-01-01', '2021-01-01')), (m) => k[m - 1]!) });
		expect(fit.months[0]).toMatchObject({ factor: 4, clamped: true, outsideBand: true });
		expect(fit.months[0]!.ownFactor!).toBeCloseTo(5, 12);
		expect(fit.months[1]).toMatchObject({ clamped: false, outsideBand: true });
		expect(fit.months[1]!.factor).toBeCloseTo(2.5, 12);
		expect(fit.months[11]).toMatchObject({ factor: 0.25, clamped: true, outsideBand: true });
		expect(fit.months[2]).toMatchObject({ clamped: false, outsideBand: false });
		expect(warnings.some((w) => /^station pairing: "Hill station": the factor for Jan is 5 \(\d+ ÷ \d+ mm\), outside 0\.25–4; using 4 \(clamped\)$/.test(w))).toBe(true);
		expect(warnings.some((w) => /^station pairing: "Hill station": the factor for Feb is 2\.5 \(.*\), outside 0\.5–2: used as it is/.test(w))).toBe(true);
		expect(warnings.some((w) => w.includes('factor for Dec is 0.1') && w.includes('using 0.25 (clamped)'))).toBe(true);
		expect(warnings).toHaveLength(3);
	});
});

describe('fitStationPairing: where the CHIRPS at the station is read', () => {
	it('the station’s own cell when the input has it, even with a site', () => {
		const start = '2015-01-01';
		const other = chirpsOver(start, daysBetween(start, '2021-01-01'), 3).map((v) => v * 3);
		const { fit } = pairing({ rainStations: { sites: { S1: { unitId: 'U' } } }, extra: { 'rain_chirps_mm@U': { startDate: start, values: other } } });
		expect(fit.chirpsAt).toEqual({ cell: true });
		expect(fit.months[0]!.factor).toBeCloseTo(K[0]!, 12);
	});

	it('else the CHIRPS of the unit it stands in, named', () => {
		const { fit } = pairing({ rainStations: { sites: { S1: { unitId: 'U' } } }, chirpsKey: 'rain_chirps_mm@U' });
		expect(fit.refused).toBeNull();
		expect(fit.chirpsAt).toEqual({ unitId: 'U', unitName: 'Unit U' });
		expect(fit.months[3]!.factor).toBeCloseTo(K[3]!, 12);
	});

	it('refused without CHIRPS at the station: no cell and no site, or a site whose unit has none', () => {
		const none = pairing({ chirpsKey: 'rain_chirps_mm' }); // only the catchment's CHIRPS, which is no station's
		expect(none.fit).toMatchObject({ refused: 'there is no CHIRPS at the station: it has no CHIRPS cell series and no unit it stands in', months: [], pinned: false });
		expect(none.warnings).toEqual(['station pairing: "Hill station" is refused: there is no CHIRPS at the station: it has no CHIRPS cell series and no unit it stands in. Its areas’ CHIRPS isn’t corrected against it']);
		const site = pairing({ rainStations: { sites: { S1: { unitId: 'V' } } }, chirpsKey: 'rain_chirps_mm@U' });
		expect(site.fit.chirpsAt).toEqual({ unitId: 'V', unitName: 'Unit V' });
		expect(site.fit.refused).toBe('there is no CHIRPS for the unit it stands in ("Unit V")');
		expect(site.fit.months).toEqual([]);
	});

	it('refused without a record for the station', () => {
		const warnings: string[] = [];
		const fit = fitStationPairing(
			{ settings: settingsWith(), series: seriesOf({ [stationChirpsSeriesKey('S1')]: { startDate: '2015-01-01', values: chirpsOver('2015-01-01', 3000) } }), stations: STATIONS, nodes: NODES, stationId: 'S1' },
			warnings
		);
		expect(fit).toMatchObject({ refused: 'the station has no record', months: [], days: 0, commonYears: 0, fitFrom: null, fitTo: null });
		expect(warnings).toHaveLength(1);
	});
});

describe('fitStationPairing: complete years in common', () => {
	it(`refused with ${STATION_PAIRING_MIN_YEARS - 1} complete years, accepted with ${STATION_PAIRING_MIN_YEARS}`, () => {
		const four = pairing({ start: '2016-01-01', end: '2020-01-01' });
		expect(four.fit.commonYears).toBe(4);
		expect(four.fit.refused).toBe('the station and the CHIRPS at it have 4 complete calendar years in common (every day a reading in both), fewer than 5');
		expect(four.fit.months).toEqual([]);
		expect(four.fit).toMatchObject({ fitFrom: '2016-01-01', fitTo: '2019-12-31', days: daysBetween('2016-01-01', '2020-01-01') });
		expect(four.warnings[0]).toMatch(/^station pairing: "Hill station" is refused: .*4 complete calendar years/);
		const five = pairing({ start: '2016-01-01', end: '2021-01-01' });
		expect(five.fit.commonYears).toBe(5);
		expect(five.fit.refused).toBeNull();
		expect(five.fit.months).toHaveLength(12);
	});

	it('a year is complete only from 1 January to 31 December: partial years at the ends don’t count', () => {
		// 2015-07-01 … 2021-06-30: six years of days, but only 2016–2020 are whole.
		const { fit } = pairing({ start: '2015-07-01', end: '2021-07-01' });
		expect(fit.commonYears).toBe(5);
		expect(fit.refused).toBeNull();
		const short = pairing({ start: '2015-07-01', end: '2020-07-01' }); // five years of days, four whole
		expect(short.fit.commonYears).toBe(4);
		expect(short.fit.refused).not.toBeNull();
	});

	it('a leap year needs its 29 February: without it the year is incomplete', () => {
		const start = '2016-01-01';
		const chirps: (number | null)[] = chirpsOver(start, daysBetween(start, '2021-01-01'));
		const feb29 = toEpochDay('2016-02-29') - toEpochDay(start);
		expect(fromEpochDay(toEpochDay(start) + feb29)).toBe('2016-02-29');
		expect(pairing({ start, chirps }).fit.commonYears).toBe(5); // positive control: 2016 with its 366 days
		chirps[feb29] = null;
		const { fit } = pairing({ start, chirps, station: scaled(start, chirpsOver(start, chirps.length), (m) => K[m - 1]!) });
		expect(fit.commonYears).toBe(4);
		expect(fit.refused).toMatch(/4 complete calendar years/);
	});

	it('a day the user marks unreliable breaks its year (the checked record is what is in common)', () => {
		const ok = pairing({ start: '2016-01-01', end: '2021-01-01' });
		expect(ok.fit.refused).toBeNull();
		const { fit } = pairing({ start: '2016-01-01', end: '2021-01-01', rainStations: { unreliable: { S1: [['2018-06-01', '2018-06-01']] } } });
		expect(fit.commonYears).toBe(4);
		expect(fit.refused).not.toBeNull();
	});

	it('complete years needn’t be consecutive', () => {
		const start = '2014-01-01';
		const chirps: (number | null)[] = chirpsOver(start, daysBetween(start, '2021-01-01'));
		for (const y of [2015, 2018]) chirps[toEpochDay(`${y}-03-03`) - toEpochDay(start)] = null;
		const { fit } = pairing({ start, chirps, station: scaled(start, chirpsOver(start, chirps.length), (m) => K[m - 1]!) });
		expect(fit.commonYears).toBe(5);
		expect(fit.refused).toBeNull();
	});
});

describe('fitStationPairing: pinned factors and determinism', () => {
	const PIN = [1, 2, 3, 4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.1, 1.2, 1.3];
	it('pinned factors replace the fit, warn about nothing, and are never refused', () => {
		const { fit, warnings } = pairing({ rainStations: { pinnedFactors: { S1: PIN } } });
		expect(fit.pinned).toBe(true);
		expect(fit.months.map((m) => m.factor)).toEqual(PIN);
		expect(fit.months.every((m) => !m.clamped && !m.outsideBand)).toBe(true);
		expect(warnings).toEqual([]);
		const short = pairing({ start: '2018-01-01', end: '2019-01-01', rainStations: { pinnedFactors: { S1: PIN } } });
		expect(short.fit.refused).toBeNull();
		expect(short.fit.months.map((m) => m.factor)).toEqual(PIN);
	});

	it('pinned factors that aren’t 12 positive numbers are fitted instead, with a warning', () => {
		const { fit, warnings } = pairing({ rainStations: { pinnedFactors: { S1: [1, 2] } } });
		expect(fit.pinned).toBe(false);
		expect(fit.months[0]!.factor).toBeCloseTo(K[0]!, 12);
		expect(warnings).toEqual(['station pairing: "Hill station": its pinned factors aren’t 12 positive numbers, so they are fitted instead']);
	});

	it('is deterministic: the same input gives the same fit and warnings', () => {
		const a = pairing({ rainStations: { unreliable: { S1: [['2017-01-01', '2017-01-31']] } } });
		const b = pairing({ rainStations: { unreliable: { S1: [['2017-01-01', '2017-01-31']] } } });
		expect(a.fit).toEqual(b.fit);
		expect(a.warnings).toEqual(b.warnings);
	});
});

describe('pairingFactorOn', () => {
	it('the factor of the day’s calendar month', () => {
		const { fit } = pairing();
		expect(pairingFactorOn(fit, toEpochDay('2030-01-31'))).toBeCloseTo(K[0]!, 12);
		expect(pairingFactorOn(fit, toEpochDay('2030-02-01'))).toBeCloseTo(K[1]!, 12);
		expect(pairingFactorOn(fit, toEpochDay('2024-02-29'))).toBeCloseTo(K[1]!, 12);
		expect(pairingFactorOn(fit, toEpochDay('1999-12-31'))).toBeCloseTo(K[11]!, 12);
	});

	it('null when the pairing is refused', () => {
		const { fit } = pairing({ start: '2016-01-01', end: '2018-01-01' });
		expect(fit.refused).not.toBeNull();
		expect(pairingFactorOn(fit, toEpochDay('2017-03-01'))).toBeNull();
	});
});
