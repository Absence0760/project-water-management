// The quaternary dataset loader's parsing (geo/loadQuaternaries.ts), the
// committed synthetic fixture it loads by default, and the file `--out`
// writes for a production load (read back through the same parser).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseArgs, SYNTHETIC_FILE, writeQuaternariesJson } from '../../scripts/import-quaternaries.js';
import { evapZoneProblem, parseEvapZonesCsv, parseValuesCsv, quaternaryFeatureCollection, quaternaryRecords } from './loadQuaternaries.js';
import { SYNTHETIC_DATASET } from './quaternary.js';

const fixture = JSON.parse(readFileSync(SYNTHETIC_FILE, 'utf8'));
const square = (x: number, y: number) => ({ type: 'Polygon', coordinates: [[[x, y], [x + 0.1, y], [x + 0.1, y + 0.1], [x, y + 0.1], [x, y]]] });

describe('the committed synthetic quaternary dataset', () => {
	it('is invented: region Z (no DWS drainage region), every source says SYNTHETIC', () => {
		const { records, problems } = quaternaryRecords(fixture, '');
		expect(problems).toEqual([]);
		expect(records.length).toBeGreaterThanOrEqual(4);
		for (const r of records) {
			expect(r.code).toMatch(/^Z\d{2}[A-Z]$/);
			expect(r.source).toMatch(/^SYNTHETIC/);
		}
	});

	it('gives every quaternary an invented MAE and evaporation zone, each zone a distribution adding up to 100 %', () => {
		const { records, zones, problems } = quaternaryRecords(fixture, '');
		expect(problems).toEqual([]);
		expect(zones.map((z) => z.zone)).toEqual(['Z1', 'Z2']);
		for (const z of zones) expect(z.pct.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6);
		for (const r of records) {
			expect(r.maeMm).toBeGreaterThan(1000);
			expect(zones.map((z) => z.zone)).toContain(r.evapZone);
		}
		for (const z of fixture.evapZones as { note: string }[]) expect(z.note).toMatch(/^SYNTHETIC/);
	});

	it('is plausible: the monthly means add up to the MAR, the MAR is below the rain on the area, the area matches the polygon within 1 %', () => {
		const { records } = quaternaryRecords(fixture, '');
		const noArea = quaternaryRecords({ ...fixture, features: fixture.features.map((f: { properties: object }) => ({ ...f, properties: { ...f.properties, areaKm2: undefined } })) }, '').records;
		records.forEach((r, i) => {
			expect(r.monthlyMm3).toHaveLength(12);
			expect(r.monthlyMm3!.reduce((a, b) => a + b, 0)).toBeCloseTo(r.marMm3!, 3);
			expect(r.marMm3!).toBeLessThan((r.mapMm! * r.areaKm2!) / 1000);
			expect(Math.abs(noArea[i]!.areaKm2! - r.areaKm2!) / r.areaKm2!).toBeLessThan(0.01);
		});
	});
});

describe('quaternaryRecords', () => {
	it('reads the code from the DWS shapefile’s column names, the values from a CSV, the source from --source', () => {
		const boundaries = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { QUATERNARY: 'a21b' }, geometry: square(28, -26) }] };
		const csv = parseValuesCsv('code,area_km2,map_mm,mar_mm3,oct,nov,dec,jan,feb,mar,apr,may,jun,jul,aug,sep,period_start,period_end\nA21B,123,650,12,1,1,1,1,1,1,1,1,1,1,1,1,1920,2009\n');
		expect(csv.problems).toEqual([]);
		const { records, problems } = quaternaryRecords(boundaries, 'WR2012 (test)', csv.values);
		expect(problems).toEqual([]);
		expect(records[0]).toMatchObject({ code: 'A21B', areaKm2: 123, mapMm: 650, marMm3: 12, periodStart: 1920, periodEnd: 2009, source: 'WR2012 (test)' });
		expect(records[0]!.monthlyMm3).toEqual(new Array(12).fill(1));
		expect(records[0]!.bbox).toEqual([28, -26, 28.1, -25.9]);
	});

	it('skips, with a reason, a feature with no code, a repeated code, a bad polygon, a point, or no source', () => {
		const features = [
			{ type: 'Feature', properties: {}, geometry: square(28, -26) },
			{ type: 'Feature', properties: { code: 'A21B' }, geometry: square(28, -26) },
			{ type: 'Feature', properties: { code: 'A21B' }, geometry: square(29, -26) },
			{ type: 'Feature', properties: { code: 'A21C' }, geometry: { type: 'Point', coordinates: [28, -26] } },
			{ type: 'Feature', properties: { code: 'A21D' }, geometry: { type: 'Point', coordinates: [28, -26, 4] } }
		];
		const { records, problems } = quaternaryRecords({ type: 'FeatureCollection', features }, 'src');
		expect(records.map((r) => r.code)).toEqual(['A21B']);
		expect(problems).toEqual([
			expect.stringMatching(/feature 1: no quaternary code/),
			expect.stringMatching(/feature 3: A21B appears twice/),
			expect.stringMatching(/feature 4 \(A21C\): not a polygon/),
			expect.stringMatching(/feature 5 \(A21D\): has 3D coordinates/)
		]);
		expect(quaternaryRecords({ type: 'FeatureCollection', features: [features[1]] }, '').problems[0]).toMatch(/no source/);
		expect(quaternaryRecords({ type: 'Feature' }, 'src').problems[0]).toMatch(/not a GeoJSON FeatureCollection/);
	});
});

describe('WR2012 evaporation: each quaternary’s MAE and zone, each zone’s monthly % of MAE', () => {
	const months = 'oct,nov,dec,jan,feb,mar,apr,may,jun,jul,aug,sep';
	const even = new Array(12).fill('8.333').join(',');

	it('reads mae_mm and evap_zone from the values CSV and the zones from --evap-zones', () => {
		const boundaries = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { code: 'A21B' }, geometry: square(28, -26) }] };
		const values = parseValuesCsv('code,map_mm,mae_mm,evap_zone\nA21B,650,1700,7a\n');
		const zones = parseEvapZonesCsv(`zone,${months}\n7A,${even}\n`);
		expect(zones.problems).toEqual([]);
		const got = quaternaryRecords(boundaries, 'src', values.values, zones.zones);
		expect(got.problems).toEqual([]);
		expect(got.records[0]).toMatchObject({ code: 'A21B', mapMm: 650, maeMm: 1700, evapZone: '7A' });
		expect(got.zones).toEqual([{ zone: '7A', pct: new Array(12).fill(8.333) }]);
	});

	it('refuses a zone whose months are missing, negative or don’t add up to 95–105 %, naming it', () => {
		expect(evapZoneProblem('7A', new Array(12).fill(8.4))).toBeNull();
		expect(evapZoneProblem('7A', new Array(11).fill(9))).toMatch(/zone 7A: needs a percentage for each of the 12 months/);
		expect(evapZoneProblem('7A', [-1, ...new Array(11).fill(9.2)])).toMatch(/zone 7A: a month's percentage is negative/);
		expect(evapZoneProblem('7A', new Array(12).fill(7.5))).toMatch(/zone 7A: its months add up to 90 %, not 95–105 %/);
		expect(evapZoneProblem('7A', new Array(12).fill(9))).toMatch(/add up to 108 %/);
		expect(evapZoneProblem('7-A', new Array(12).fill(8.4))).toMatch(/not a zone label/);
		const csv = parseEvapZonesCsv(`zone,${months}\n1A,${even}\n2A,${new Array(12).fill('7').join(',')}\n1A,${even}\n`);
		expect([...csv.zones.keys()]).toEqual(['1A']);
		expect(csv.problems).toEqual([expect.stringMatching(/zone 2A: its months add up to 84 %.*zone skipped/), expect.stringMatching(/zone 1A appears twice/)]);
		expect(parseEvapZonesCsv('zone,oct\n1A,9\n').problems[0]).toMatch(/no "nov", .* columns/);
	});

	it('loads a quaternary whose zone has no distribution without its evaporation, and lists it as skipped for it', () => {
		const features = [
			{ type: 'Feature', properties: { code: 'A21B', maeMm: 1700, evapZone: '1A' }, geometry: square(28, -26) },
			{ type: 'Feature', properties: { code: 'A21C', maeMm: 1650, evapZone: '9Z' }, geometry: square(28.1, -26) },
			{ type: 'Feature', properties: { code: 'A21D', maeMm: 1650 }, geometry: square(28.2, -26) },
			{ type: 'Feature', properties: { code: 'A21E', mapMm: 600 }, geometry: square(28.3, -26) }
		];
		const got = quaternaryRecords({ type: 'FeatureCollection', evapZones: [{ zone: '1a', pct: new Array(12).fill(8.4) }], features }, 'src');
		expect(got.records.map((r) => [r.code, r.maeMm, r.evapZone])).toEqual([
			['A21B', 1700, '1A'],
			['A21C', null, null],
			['A21D', null, null],
			['A21E', null, null]
		]);
		expect(got.problems).toEqual([
			'A21C: evaporation zone 9Z has no monthly distribution in this load; loaded without its evaporation',
			'A21D: an MAE but no evaporation zone; loaded without its evaporation'
		]);
	});

	it('--out carries the MAE, the zone and the zones, which the production load reads back', () => {
		const { records, zones } = quaternaryRecords(fixture, '');
		const back = quaternaryRecords(JSON.parse(JSON.stringify(quaternaryFeatureCollection(records, zones))), 'unused');
		expect(back.problems).toEqual([]);
		expect(back.zones).toEqual(zones);
		expect(back.records.map((r) => [r.maeMm, r.evapZone])).toEqual(records.map((r) => [r.maeMm, r.evapZone]));
	});
});

describe('import-quaternaries arguments', () => {
	it('loads the synthetic fixture with no arguments, and needs a dataset label (not "synthetic") for a file', () => {
		expect(parseArgs([])).toEqual({ file: SYNTHETIC_FILE, dataset: SYNTHETIC_DATASET, source: '', values: null, evapZones: null, out: null });
		expect(parseArgs(['q.geojson'])).toMatch(/--dataset/);
		expect(parseArgs(['q.geojson', '--dataset', 'synthetic'])).toMatch(/committed fixture/);
		expect(parseArgs(['q.geojson', '--dataset', 'WR2012', '--source', 'WR2012 study', '--values', 'v.csv'], { INIT_CWD: '/data' })).toEqual({
			file: '/data/q.geojson',
			dataset: 'WR2012',
			source: 'WR2012 study',
			values: '/data/v.csv',
			evapZones: null,
			out: null
		});
	});

	it('--evap-zones names the zones’ CSV, resolved from where the command was typed', () => {
		expect(parseArgs(['q.geojson', '--dataset', 'WR2012', '--evap-zones', 'zones.csv'], { INIT_CWD: '/data' })).toMatchObject({ evapZones: '/data/zones.csv' });
		expect(parseArgs(['q.geojson', '--dataset', 'WR2012', '--evap-zones'])).toMatch(/--evap-zones takes a CSV/);
	});

	it('--out names a GeoJSON file to write for a production load, and needs a boundaries file', () => {
		expect(parseArgs(['q.geojson', '--dataset', 'WR2012', '--out', 'out/q.geojson.gz'], { INIT_CWD: '/data' })).toMatchObject({ out: '/data/out/q.geojson.gz' });
		expect(parseArgs(['q.geojson', '--dataset', 'WR2012', '--out', 'q.csv'])).toMatch(/--out takes a \.geojson/);
		expect(parseArgs(['--out', 'q.geojson'])).toMatch(/needs a boundaries file/);
	});
});

describe('the file `import:quaternaries --out` writes', () => {
	it('carries each outline with its values, so the production load reads back the same records', () => {
		const dir = mkdtempSync(join(tmpdir(), 'quaternaries-out-'));
		try {
			const out = join(dir, 'q.geojson.gz');
			const got = writeQuaternariesJson({ file: SYNTHETIC_FILE, dataset: 'WR2012-test', source: '', values: null, evapZones: null, out });
			const direct = quaternaryRecords(fixture, '');
			expect(got).toEqual({ written: direct.records.length, problems: [] });
			const back = quaternaryRecords(JSON.parse(gunzipSync(readFileSync(out)).toString('utf8')), 'unused');
			expect(back.problems).toEqual([]);
			expect(back.records).toEqual(direct.records);
			// Nothing is written when no feature could be read.
			expect(quaternaryFeatureCollection([]).features).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
