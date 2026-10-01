// The gauging-station loader's parsing (geo/loadGaugeStations.ts), its CLI
// arguments, and the committed synthetic fixture it loads by default.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseArgs, SYNTHETIC_STATIONS_FILE } from '../../scripts/import-gauge-stations.js';
import { buildExamples } from '../../scripts/examples/catchments.js';
import { sandspruitMap } from '../../scripts/examples/map.js';
import { parseDate, stationRecords } from './loadGaugeStations.js';
import { haversineKm, SYNTHETIC_STATIONS } from './stations.js';

const fixture = { name: 'gauge-stations.synthetic.geojson', text: readFileSync(SYNTHETIC_STATIONS_FILE, 'utf8') };

describe('the committed synthetic gauging stations', () => {
	it('are invented: region Z (no DWS drainage region), every source says SYNTHETIC', () => {
		const { records, problems } = stationRecords([fixture], '');
		expect(problems).toEqual([]);
		expect(records.length).toBeGreaterThanOrEqual(5);
		for (const r of records) {
			expect(r.code).toMatch(/^Z\d[A-Z]\d{3}$/);
			expect(r.source).toMatch(/^SYNTHETIC/);
		}
		// A reservoir among them, so the proposal's river-gauge filter is exercised.
		expect(records.some((r) => /^Z\dR/.test(r.code))).toBe(true);
	});
});

describe('parseDate', () => {
	it('reads YYYY-MM-DD, YYYY/MM/DD and YYYYMMDD; refuses a day that does not exist', () => {
		expect(parseDate('1968-10-01')).toBe('1968-10-01');
		expect(parseDate('1968/10/01')).toBe('1968-10-01');
		expect(parseDate('19681001')).toBe('1968-10-01');
		expect(parseDate('')).toBeNull();
		expect(parseDate(undefined)).toBeNull();
		expect(parseDate('2023-02-30')).toBe('bad');
		expect(parseDate('Oct 1968')).toBe('bad');
	});
});

describe('stationRecords', () => {
	it('reads the DWS catalogue transcribed as CSV, columns in any order, the source from --source', () => {
		const csv = 'name,code,lat,lon,river,catchment_km2,record_start,record_end\nSome weir,a2h012,-25.66,27.89,Crocodile,2555,1904-03-01,\n';
		const { records, problems } = stationRecords([{ name: 'cat.csv', text: csv }], 'DWS catalogue (test)');
		expect(problems).toEqual([]);
		expect(records).toEqual([
			{ code: 'A2H012', name: 'Some weir', river: 'Crocodile', lon: 27.89, lat: -25.66, catchmentKm2: 2555, recordStart: '1904-03-01', recordEnd: null, source: 'DWS catalogue (test)' }
		]);
	});

	it('skips, with a reason, a bad code, a missing position, a bad date, a record ending before it starts, a repeat, and no source', () => {
		const csv = [
			'code,lat,lon,record_start,record_end,source',
			'XX1,-25,27,,,s',
			'A2H001,,27,,,s',
			'A2H002,-25,27,1990-13-01,,s',
			'A2H003,-25,27,2000-01-01,1990-01-01,s',
			'A2H004,-25,27,,,s',
			'A2H004,-25.1,27,,,s',
			'A2H005,-25,27,,,'
		].join('\n');
		const { records, problems } = stationRecords([{ name: 'c.csv', text: csv }], '');
		expect(records.map((r) => r.code)).toEqual(['A2H004']);
		expect(problems).toEqual([
			expect.stringMatching(/row 2: "XX1" is not a station code/),
			expect.stringMatching(/row 3 \(A2H001\): no position/),
			expect.stringMatching(/row 4 \(A2H002\): a record date is not a day/),
			expect.stringMatching(/row 5 \(A2H003\): the record ends before it starts/),
			expect.stringMatching(/row 7: A2H004 appears twice/),
			expect.stringMatching(/row 8 \(A2H005\): no source/)
		]);
	});

	it('refuses a GeoJSON feature that is not a point, and a file that is not a FeatureCollection', () => {
		const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { code: 'A2H001' }, geometry: { type: 'LineString', coordinates: [[27, -25], [28, -25]] } }] };
		expect(stationRecords([{ name: 'l.geojson', text: JSON.stringify(fc) }], 's').problems).toEqual([expect.stringMatching(/feature 1: not a 2D point/)]);
		expect(stationRecords([{ name: 'f.geojson', text: '{"type":"Feature"}' }], 's').problems).toEqual(['f.geojson: not a GeoJSON FeatureCollection']);
	});
});

describe('parseArgs', () => {
	it('loads the synthetic fixture with no file, under its own label', () => {
		expect(parseArgs([])).toEqual({ files: [SYNTHETIC_STATIONS_FILE], dataset: SYNTHETIC_STATIONS, source: '' });
	});

	it('needs a label for the operator’s own files, never the fixture’s, and resolves paths from where the command was typed', () => {
		expect(parseArgs(['a.csv'])).toMatch(/--dataset/);
		expect(parseArgs(['a.csv', '--dataset', SYNTHETIC_STATIONS])).toMatch(/committed fixture/);
		expect(parseArgs(['a.csv', 'b.geojson', '--dataset', 'DWS 2026-10', '--source', 'DWS catalogue'], { INIT_CWD: '/work' })).toEqual({
			files: ['/work/a.csv', '/work/b.geojson'],
			dataset: 'DWS 2026-10',
			source: 'DWS catalogue'
		});
	});
});

describe('the fixture near Sandspruit', () => {
	it('has river gauges within 20 km of the seeded outlet and one beyond 20 km', () => {
		const sandspruit = buildExamples({ fit: false }).find((e) => /Sandspruit/.test(e.name))!;
		const outlet = sandspruitMap(sandspruit.model).find((f) => f.kind === 'gauge' && f.name === 'Sandspruit Outlet')!;
		const at = outlet.geometry.coordinates as [number, number];
		const km = stationRecords([fixture], '').records.filter((r) => /H/.test(r.code[2]!)).map((r) => haversineKm(at, [r.lon, r.lat]));
		expect(km.filter((d) => d < 20).length).toBeGreaterThanOrEqual(3);
		expect(km.some((d) => d > 20 && d < 50)).toBe(true);
	});
});
