// The DWS evaporation stations' reader, loader and proposal rules (issue #646
// item 6; geo/dwsEvaporation.ts, loadEvaporationStations.ts,
// evaporationStations.ts; docs/maps.md § Evaporation stations). Against the
// committed INVENTED fixtures and small hand-made pages only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDwsRows } from '../feeds/sources/dws.js';
import { parseArgs, SYNTHETIC_EVAPORATION_STATIONS_DIR, SYNTHETIC_EVAPORATION_STATIONS_LIST } from '../../scripts/import-evaporation-stations.js';
import { EVAP_MAX_MM, parseDwsEvaporation } from './dwsEvaporation.js';
import {
	conversionsFor,
	distanceToBoundaryKm,
	MIN_YEARS,
	monthlyMeans,
	rankEvaporationStations,
	stationApan,
	trimmedRecord,
	type EvaporationStationRow
} from './evaporationStations.js';
import type { Geometry } from './geojson.js';
import { evaporationStationRecords, panOf } from './loadEvaporationStations.js';

const page = (rows: string[], header = 'DATE        D EVAP  QUAL', spec = 'POS. 10-18  = Daily pan evaporation in millimetres 9999.9') =>
	['<html><body><p><pre>', 'STATION Z9E001  TEST', spec, '', header, ...rows, 'ZZZZZZZZZZZZ', '</pre></p></body></html>'].join('\n');
const row = (date: string, v: string, q = '1') => `${date}${v.padStart(10)}${q.padStart(6)}`;
const gap = (date: string, q = '255') => `${date}${q.padStart(16)}`;

const fixture = (code: string) => ({ name: `${code}-reply.synthetic.html`, text: readFileSync(join(SYNTHETIC_EVAPORATION_STATIONS_DIR, `${code}-reply.synthetic.html`), 'utf8') });
const list = { name: 'stations.synthetic.csv', text: readFileSync(SYNTHETIC_EVAPORATION_STATIONS_LIST, 'utf8') };
const replies = ['Z1E001', 'Z1E002', 'Z1E003', 'Z2E001'].map(fixture);

describe('parseDwsEvaporation', () => {
	it('reads values, gap codes and a blank value column; trims to the first and last day with a value', () => {
		const r = parseDwsEvaporation(page([gap('20200101'), row('20200102', '7.5'), gap('20200103'), row('20200104', '0.0'), row('20200105', '-999'), gap('20200106', '170')]));
		expect(r).toEqual({ startDate: '2020-01-02', values: [7.5, null, 0], daysWithValue: 2, station: 'Z9E001' });
	});

	it('refuses a page that is not an evaporation table in mm', () => {
		expect(() => parseDwsEvaporation(page([row('20200101', '1.0')], 'DATE     D AVG F/R  QUAL'))).toThrow(/not a daily evaporation table/);
		expect(() => parseDwsEvaporation(page([row('20200101', '1.0')], undefined, 'POS. 10-18  = Daily avg flow rate in cubic metres/sec'))).toThrow(/not a daily evaporation in mm/);
		expect(() => parseDwsEvaporation('<html><body>nothing</body></html>')).toThrow(/no data table/);
		expect(() => parseDwsEvaporation('<html>ScriptServer error</html>')).toThrow(/ScriptServer/);
	});

	it('refuses an impossible or repeated day, a value above the bound, and a table with no value', () => {
		expect(() => parseDwsEvaporation(page([row('20210230', '1.0')]))).toThrow(/impossible date/);
		expect(() => parseDwsEvaporation(page([row('20200101', '1.0'), row('20200101', '2.0')]))).toThrow(/twice/);
		expect(() => parseDwsEvaporation(page([row('20200101', String(EVAP_MAX_MM + 1))]))).toThrow(/above 50 mm/);
		expect(() => parseDwsEvaporation(page([gap('20200101')]))).toThrow(/no day with a value/);
		// Positive control: the bound itself is a value.
		expect(parseDwsEvaporation(page([row('20200101', String(EVAP_MAX_MM))])).values).toEqual([EVAP_MAX_MM]);
	});

	it('reads every committed synthetic reply', () => {
		for (const f of replies) {
			const r = parseDwsEvaporation(f.text);
			expect(r.station).toBe(f.name.slice(0, 6));
			expect(r.daysWithValue).toBeGreaterThan(0.9 * r.values.length);
		}
	});

	it('is never read as flow: the DWS flow reader (production\'s `dws` load) refuses an evaporation reply', () => {
		// The production gate: DWS's permission covers verified daily flow only, so a pan record must not ride in as a
		// `dws` reference load (referenceLoad.ts loadDws, scripts/release/map-data-gates.mjs). Control: the evaporation reader reads it above.
		for (const f of replies) expect(() => parseDwsRows(f.text), f.name).toThrow(/expected DATE D AVG F\/R QUAL/);
	});
});

describe('the station loader', () => {
	it('loads the synthetic list with each station’s record', () => {
		const { stations, problems } = evaporationStationRecords(list, replies, 'src');
		expect(problems).toEqual([]);
		expect(stations.map((s) => [s.code, s.pan])).toEqual([
			['Z1E001', 'class_a'],
			['Z1E002', 'symons'],
			['Z1E003', 'class_a'],
			['Z2E001', 'class_a']
		]);
		expect(stations[0]).toMatchObject({ startDate: '2014-01-01', source: 'src' });
	});

	it('skips a station with no record, a record naming another station, a bad code or pan, and a repeat', () => {
		const text = ['code,name,pan,lat,lon', 'Z1E001,a,A,-33,21', 'Z1E002,b,S,-33,21', 'Z1H001,c,A,-33,21', 'Z1E003,d,X,-33,21', 'Z1E001,e,A,-33,21'].join('\n');
		const wrong = { name: 'Z1E002-reply.html', text: fixture('Z1E001').text };
		const { stations, problems } = evaporationStationRecords({ name: 'l.csv', text }, [fixture('Z1E001'), wrong], 'src');
		expect(stations.map((s) => s.code)).toEqual(['Z1E001']);
		expect(problems).toHaveLength(4);
		expect(problems.join('\n')).toMatch(/names Z1E001, the list Z1E002/);
		expect(problems.join('\n')).toMatch(/not an evaporation station code/);
		expect(problems.join('\n')).toMatch(/pan must be A/);
		expect(problems.join('\n')).toMatch(/appears twice/);
	});

	it('reads the pan as DWS’s lists write it', () => {
		expect(['A', '[A]', 'Class-A', 'class_a'].map(panOf)).toEqual(['class_a', 'class_a', 'class_a', 'class_a']);
		expect(['S', '[S]', 'Symons'].map(panOf)).toEqual(['symons', 'symons', 'symons']);
		expect(panOf('X')).toBeNull();
	});

	it('the CLI defaults to the synthetic dataset and asks a real load for its records, label and no "synthetic"', () => {
		expect(parseArgs([])).toMatchObject({ dataset: 'synthetic' });
		expect(parseArgs(['l.csv', '--dataset', 'D'])).toMatch(/--records/);
		expect(parseArgs(['l.csv', '--records', 'r'])).toMatch(/--dataset/);
		expect(parseArgs(['l.csv', '--records', 'r', '--dataset', 'synthetic'])).toMatch(/committed fixture/);
		expect(parseArgs(['l.csv', '--records', 'r', '--dataset', 'DWS 2026-11', '--source', 'reply 12'], { INIT_CWD: '/x' })).toEqual({ list: '/x/l.csv', records: '/x/r', dataset: 'DWS 2026-11', source: 'reply 12' });
	});
});

describe('monthlyMeans', () => {
	/** `years` full years of a constant daily value from 2001-01-01 (none leap). */
	const constant = (years: number, v: number) => new Array(365 * years).fill(v);

	it('gives each month’s total as the mean day × its days, in water-year order', () => {
		const m = monthlyMeans('2001-01-01', constant(3, 2));
		expect(m.problem).toBeNull();
		// Oct 31 days, Feb 28 (2001–2003 are not leap years).
		expect(m.meansMm[0]).toBe(62);
		expect(m.meansMm[4]).toBe(56);
		expect(m.years).toEqual(new Array(12).fill(3));
		expect([m.first, m.last]).toEqual(['2001-01', '2003-12']);
	});

	it('counts a month with 80 % of its days read, scaled up; leaves out one with less', () => {
		const v: (number | null)[] = constant(3, 2);
		// January 2001: 25 of 31 read (80.6 %) — counted, as 2 mm × 31.
		for (let i = 0; i < 6; i++) v[i] = null;
		// February 2001: 22 of 28 read (78.6 %) — left out.
		for (let i = 31; i < 37; i++) v[i] = null;
		const m = monthlyMeans('2001-01-01', v);
		expect(m.years[3]).toBe(3);
		expect(m.meansMm[3]).toBe(62);
		expect(m.years[4]).toBe(2);
		expect(m.problem).toMatch(/fewer than 3 complete years of Feb/);
	});

	it(`needs ${MIN_YEARS} counted years of every month`, () => {
		const m = monthlyMeans('2001-01-01', constant(2, 2));
		expect(m.meansMm.every((x) => x === null)).toBe(true);
		expect(m.problem).toMatch(/any month/);
	});
});

describe('stationApan', () => {
	const { stations } = evaporationStationRecords(list, replies, 'src');
	const means = (code: string) => {
		const s = stations.find((x) => x.code === code)!;
		return monthlyMeans(s.startDate, s.values);
	};

	it('takes a Class-A pan’s means as they stand, and refuses a conversion for it', () => {
		const m = means('Z1E001');
		expect(stationApan('class_a', m, null)).toMatchObject({ ok: true, apanMm: m.meansMm, conversion: null });
		expect(stationApan('class_a', m, 'wr90')).toMatchObject({ ok: false });
	});

	it('converts a Symons pan only through the equation picked; the synthetic one passes Taljaard’s floor, not WR90’s', () => {
		const m = means('Z1E002');
		expect(stationApan('symons', m, null)).toMatchObject({ ok: false, reason: expect.stringMatching(/pick the equation/) });
		const t = stationApan('symons', m, 'taljaard2023');
		expect(t.ok).toBe(true);
		if (t.ok) {
			expect(t.spanMm).toEqual(m.meansMm);
			expect(t.apanMm.every((a, i) => a > m.meansMm[i]!)).toBe(true);
			expect(t.note).toMatch(/Taljaard/);
		}
		expect(stationApan('symons', m, 'wr90')).toMatchObject({ ok: false, reason: expect.stringMatching(/Jul is below 32\.5 mm/) });
		expect(conversionsFor(m).map((c) => [c.id, c.result.ok])).toEqual([
			['taljaard2023', true],
			['wr90', false]
		]);
	});

	it('refuses a record too short for the means', () => {
		expect(stationApan('class_a', means('Z1E003'), null)).toMatchObject({ ok: false, reason: expect.stringMatching(/fewer than 3/) });
	});
});

describe('ranking from the boundary', () => {
	const square = (w: number, s: number, d: number): Geometry => ({
		type: 'Polygon',
		coordinates: [
			[
				[w, s],
				[w + d, s],
				[w + d, s + d],
				[w, s + d],
				[w, s]
			]
		]
	});
	const box = square(21.25, -33.85, 0.15);

	it('is 0 inside the boundary and the distance to its nearest edge outside', () => {
		expect(distanceToBoundaryKm([21.3, -33.8], box)).toBe(0);
		// 0.1° east of the east edge at 33.8° S: 0.1 × 111.32 × cos(33.8°) ≈ 9.25 km.
		expect(distanceToBoundaryKm([21.5, -33.8], box)).toBeCloseTo(9.25, 1);
		expect(distanceToBoundaryKm([21.3, -33.8], { type: 'Point', coordinates: [21.3, -33.8] })).toBe(Number.POSITIVE_INFINITY);
	});

	it('lists the stations within the radius nearest first, with span and completeness', () => {
		const rows: EvaporationStationRow[] = evaporationStationRecords(list, replies, 'src').stations.map((s) => ({
			code: s.code,
			name: s.name,
			pan: s.pan,
			lon: s.lon,
			lat: s.lat,
			startDate: s.startDate,
			length: s.values.length,
			daysWithValue: s.daysWithValue,
			dataset: 'synthetic',
			source: s.source
		}));
		const r = rankEvaporationStations(box, rows, 100);
		expect(r.map((s) => s.code)).toEqual(['Z1E001', 'Z1E002', 'Z1E003']);
		expect(r[0]).toMatchObject({ distanceKm: 0, recordStart: '2014-01-01', recordEnd: '2017-12-31', recordYears: 4, synthetic: true });
		expect(r[0]!.completeness).toBeGreaterThan(0.95);
		expect(r[0]!.completeness).toBeLessThan(1);
		expect(rankEvaporationStations(box, rows, 300).map((s) => s.code)).toContain('Z2E001');
	});

	it('trims a record to its days with values', () => {
		expect(trimmedRecord('2020-01-01', [null, 1, null, 2, null])).toEqual({ startDate: '2020-01-02', values: [1, null, 2] });
	});
});
