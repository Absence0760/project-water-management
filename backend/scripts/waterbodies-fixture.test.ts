import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { matchDam } from '../src/dams/observed/match.js';
import { waterbodyRecords } from '../src/dams/observed/loadWaterbodies.js';
import { parseArgs } from './import-waterbodies.js';
import { buildExamples } from './examples/catchments.js';
import { sandspruitMap } from './examples/map.js';
import { caseOf, fixtureWaterbodies, geohash, POLYGONS_FILE, polygonsFile, SERIES_DIR, seriesCsv } from './waterbodies-fixture.js';

describe('the synthetic Waterbodies fixture', () => {
	it('is what the generator writes (pnpm gen:waterbodies-fixture after changing it)', () => {
		const wbs = fixtureWaterbodies();
		expect(readFileSync(POLYGONS_FILE, 'utf8')).toBe(polygonsFile(wbs));
		expect(readdirSync(SERIES_DIR).sort()).toEqual(wbs.map((w) => `${w.wbId}.csv`).sort());
		wbs.forEach((w, i) => expect(readFileSync(`${SERIES_DIR}${w.wbId}.csv`, 'utf8'), w.uid).toBe(seriesCsv(w, i)));
	});

	it('gives the Sandspruit example’s dams each case: matched, merged (Grootdraai) and none (Klipdrift)', () => {
		const sandspruit = buildExamples({ fit: false }).find((e) => e.name.includes('Sandspruit'))!;
		const { records, problems } = waterbodyRecords(JSON.parse(readFileSync(POLYGONS_FILE, 'utf8')));
		expect(problems).toEqual([]);
		const dams = sandspruitMap(sandspruit.model).filter((f) => f.kind === 'dam');
		expect(dams.length).toBeGreaterThan(3);
		const got = Object.fromEntries(
			dams.map((d) => [d.name, matchDam(d.geometry as never, records.filter((r) => r.bbox[0] < 21.4).map((r) => ({ uid: r.uid, geometry: r.geometry }))).status])
		);
		expect(got).toEqual(Object.fromEntries(dams.map((d) => [d.name, caseOf(d.name)])));
		expect(Object.values(got)).toEqual(expect.arrayContaining(['matched', 'merged', 'none']));
	});

	it('names each waterbody by the standard geohash of its centre', () => {
		// Two published geohash examples.
		expect(geohash(-5.6, 42.6, 5)).toBe('ezs42');
		expect(geohash(10.40744, 57.64911, 11)).toBe('u4pruydqqvj');
	});
});

describe('pnpm import:waterbodies arguments', () => {
	it('loads the synthetic set with no arguments, else a labelled file, with an optional box', () => {
		expect(parseArgs([])).toMatchObject({ file: POLYGONS_FILE, dataset: 'synthetic', bbox: null });
		expect(parseArgs(['wb.geojson', '--dataset', 'waterbodies-v0.0.3', '--bbox', '18,-35,23,-31'], { INIT_CWD: '/x' })).toMatchObject({
			file: '/x/wb.geojson',
			dataset: 'waterbodies-v0.0.3',
			bbox: [18, -35, 23, -31],
			source: expect.stringContaining('Digital Earth Africa')
		});
		expect(parseArgs(['wb.geojson'])).toMatch(/--dataset/);
		expect(parseArgs(['wb.geojson', '--dataset', 'synthetic'])).toMatch(/committed fixture/);
		expect(parseArgs(['wb.geojson', '--dataset', 'x', '--bbox', '23,-35,18,-31'])).toMatch(/w,s,e,n/);
		expect(parseArgs(['--dataset', 'x'])).toMatch(/no options/);
	});

	it('skips what isn’t a waterbody polygon, and what lies outside the box', () => {
		const sq = (x: number) => [
			[
				[x, -33],
				[x + 0.01, -33],
				[x + 0.01, -32.99],
				[x, -32.99],
				[x, -33]
			]
		];
		const r = waterbodyRecords(
			{
				type: 'FeatureCollection',
				features: [
					{ type: 'Feature', properties: { uid: 'zzzzza0001' }, geometry: { type: 'Polygon', coordinates: sq(21) } },
					{ type: 'Feature', properties: { UID: 'zzzzza0002' }, geometry: { type: 'Polygon', coordinates: sq(25) } },
					{ type: 'Feature', properties: { uid: 'zzzzza0001' }, geometry: { type: 'Polygon', coordinates: sq(21.1) } },
					{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: sq(21.2) } },
					{ type: 'Feature', properties: { uid: 'zzzzza0003' }, geometry: { type: 'Point', coordinates: [21, -33] } }
				]
			},
			[20, -34, 22, -32]
		);
		expect(r.records.map((x) => x.uid)).toEqual(['zzzzza0001']);
		expect(r.outside).toBe(1);
		expect(r.problems).toHaveLength(3);
		expect(waterbodyRecords({ type: 'nope' }).problems).toEqual(['the file is not a GeoJSON FeatureCollection']);
	});
});
