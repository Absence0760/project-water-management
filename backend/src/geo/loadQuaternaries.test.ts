// The quaternary dataset loader's parsing (geo/loadQuaternaries.ts) and the
// committed synthetic fixture it loads by default.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseArgs, SYNTHETIC_FILE } from '../../scripts/import-quaternaries.js';
import { parseValuesCsv, quaternaryRecords } from './loadQuaternaries.js';
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

describe('import-quaternaries arguments', () => {
	it('loads the synthetic fixture with no arguments, and needs a dataset label (not "synthetic") for a file', () => {
		expect(parseArgs([])).toEqual({ file: SYNTHETIC_FILE, dataset: SYNTHETIC_DATASET, source: '', values: null });
		expect(parseArgs(['q.geojson'])).toMatch(/--dataset/);
		expect(parseArgs(['q.geojson', '--dataset', 'synthetic'])).toMatch(/committed fixture/);
		expect(parseArgs(['q.geojson', '--dataset', 'WR2012', '--source', 'WR2012 study', '--values', 'v.csv'], { INIT_CWD: '/data' })).toEqual({
			file: '/data/q.geojson',
			dataset: 'WR2012',
			source: 'WR2012 study',
			values: '/data/v.csv'
		});
	});
});
