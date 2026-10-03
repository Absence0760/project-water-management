// The river-network loader's parsing (geo/loadRivers.ts), its CLI arguments,
// and the committed synthetic network it loads by default (issue #345).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseArgs, SYNTHETIC_RIVERS_FILE } from '../../scripts/import-rivers.js';
import { riverRecords } from './loadRivers.js';
import { reachDescription, riverRef, SYNTHETIC_RIVERS } from './rivers.js';

const fixture = { name: 'rivers.synthetic.geojson', text: readFileSync(SYNTHETIC_RIVERS_FILE, 'utf8') };
const fc = (features: unknown[]) => ({ name: 'r.geojson', text: JSON.stringify({ type: 'FeatureCollection', features }) });
const line = (props: Record<string, unknown>, coordinates: unknown = [[21.3, -33.6], [21.31, -33.61]]) => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates } });

describe('the committed synthetic river network', () => {
	it('is invented: every source says SYNTHETIC, ids outside the real HydroRIVERS range of the region, orders 1–3', () => {
		const { records, problems, belowOrder } = riverRecords([fixture], '');
		expect(problems).toEqual([]);
		expect(belowOrder).toBe(0);
		expect(records.length).toBeGreaterThanOrEqual(10);
		for (const r of records) {
			expect(r.source).toMatch(/^SYNTHETIC/);
			expect(r.reachId).toBeGreaterThan(90_000_000);
			expect(r.strahler).toBeGreaterThanOrEqual(1);
			expect(r.strahler).toBeLessThanOrEqual(3);
			expect(r.geometry.type).toBe('LineString');
		}
	});

	it('flows together: every reach but the outlet and the far one ends where another starts, and order never falls downstream', () => {
		const { records } = riverRecords([fixture], '');
		const start = (r: (typeof records)[number]) => JSON.stringify((r.geometry.coordinates as number[][])[0]);
		const end = (r: (typeof records)[number]) => JSON.stringify((r.geometry.coordinates as number[][]).at(-1));
		const dangling = records.filter((r) => !records.some((o) => o !== r && start(o) === end(r)));
		// The outlet (90000002) and the reach far away (90000011, outside every test bbox) drain nowhere in the network.
		expect(dangling.map((r) => r.reachId).sort()).toEqual([90000002, 90000011]);
		for (const r of records) {
			const down = records.find((o) => o !== r && start(o) === end(r));
			if (down) expect(down.strahler!).toBeGreaterThanOrEqual(r.strahler!);
		}
	});
});

describe('riverRecords', () => {
	it('reads HydroRIVERS fields as ogr2ogr writes them, the source from --source', () => {
		const { records, problems } = riverRecords([fc([line({ HYRIV_ID: 10552361, ORD_STRA: 4, UPLAND_SKM: 1234.5, LENGTH_KM: 2.31, DIS_AV_CMS: 3.2, ENDORHEIC: 1 })])], 'HydroRIVERS v1.0');
		expect(problems).toEqual([]);
		expect(records).toEqual([
			{
				reachId: 10552361,
				name: '',
				strahler: 4,
				upstreamKm2: 1234.5,
				lengthKm: 2.31,
				dischargeM3s: 3.2,
				endorheic: true,
				geometry: { type: 'LineString', coordinates: [[21.3, -33.6], [21.31, -33.61]] },
				bbox: [21.3, -33.61, 21.31, -33.6],
				source: 'HydroRIVERS v1.0'
			}
		]);
	});

	it('reads the readable names too, and a name and a source of its own', () => {
		const { records } = riverRecords([fc([line({ reachId: 7, strahler: 2, upstreamKm2: 10, name: 'Sandspruit', source: 'Own survey' })])], 'fallback');
		expect(records[0]).toMatchObject({ reachId: 7, strahler: 2, upstreamKm2: 10, name: 'Sandspruit', source: 'Own survey', lengthKm: null, dischargeM3s: null, endorheic: null });
	});

	it('reads ENDORHEIC as 0/1 or false/true, and anything else as not given (196, the pans’ cross-check)', () => {
		const flags = [0, 1, '0', '1', false, true, 2, 'yes', null].map((v, i) => line({ reachId: i + 1, ENDORHEIC: v, source: 's' }));
		const { records, problems } = riverRecords([fc(flags)], 's');
		expect(problems).toEqual([]);
		expect(records.map((r) => r.endorheic)).toEqual([false, true, false, true, false, true, null, null, null]);
		expect(riverRecords([fc([line({ reachId: 1, endorheic: false, source: 's' })])], 's').records[0]!.endorheic).toBe(false);
	});

	it('makes a reach name one line, as a feature name (a reach added to a project carries it; issue #385)', () => {
		const { records } = riverRecords([fc([line({ reachId: 7, name: 'Sand\r\nspruit\u2028river', source: 's' })])], 'fallback');
		expect(records[0]!.name).toBe('Sand spruit river');
	});

	it('leaves out reaches below the minimum order (counted, not problems)', () => {
		const { records, problems, belowOrder } = riverRecords([fc([line({ HYRIV_ID: 1, ORD_STRA: 1 }), line({ HYRIV_ID: 2, ORD_STRA: 3 }), line({ HYRIV_ID: 3 })])], 's', 2);
		expect(records.map((r) => r.reachId)).toEqual([2]);
		expect(belowOrder).toBe(2);
		expect(problems).toEqual([]);
	});

	it('skips, with a reason, a reach with no id, a repeated id, a point, a bad position or no source; drops out-of-range values', () => {
		const { records, problems } = riverRecords(
			[
				fc([
					line({}),
					line({ HYRIV_ID: 5, UPLAND_SKM: -3, DIS_AV_CMS: 'x', ORD_STRA: 40 }),
					line({ HYRIV_ID: 5 }),
					{ type: 'Feature', properties: { HYRIV_ID: 6 }, geometry: { type: 'Point', coordinates: [21, -33] } },
					line({ HYRIV_ID: 8 }, [[200, -33], [21, -33]])
				]),
				{ name: 'bad.json', text: '{' },
				{ name: 'other.json', text: '{"type":"Feature"}' }
			],
			'src'
		);
		expect(records.map((r) => r.reachId)).toEqual([5]);
		expect(records[0]).toMatchObject({ strahler: null, upstreamKm2: null, dischargeM3s: null });
		expect(problems).toEqual([
			expect.stringMatching(/^r\.geojson feature 1: no reach id/),
			'r.geojson feature 3: reach 5 appears twice',
			'r.geojson feature 4 (reach 6): not a line',
			expect.stringMatching(/^r\.geojson feature 5 \(reach 8\): has/),
			'bad.json: not valid JSON',
			'other.json: not a GeoJSON FeatureCollection'
		]);
		expect(riverRecords([fc([line({ HYRIV_ID: 9 })])], '').problems).toEqual([expect.stringMatching(/no source/)]);
	});
});

describe('parseArgs', () => {
	it('loads the synthetic fixture with no file; a real file needs a dataset label other than the fixture’s', () => {
		expect(parseArgs([])).toEqual({ files: [SYNTHETIC_RIVERS_FILE], dataset: SYNTHETIC_RIVERS, source: '', minOrder: 1 });
		expect(parseArgs(['r.geojson'])).toMatch(/--dataset/);
		expect(parseArgs(['r.geojson', '--dataset', SYNTHETIC_RIVERS])).toMatch(/fixture/);
		expect(parseArgs(['r.geojson', '--dataset', 'x'.repeat(51)])).toMatch(/50/);
		expect(parseArgs(['r.geojson', '--dataset', 'H', '--min-order', '0'])).toMatch(/Strahler/);
		expect(parseArgs(['r.geojson', '--dataset', 'HydroRIVERS-v10', '--source', 'HydroRIVERS v1.0', '--min-order', '3'], { INIT_CWD: '/data' })).toEqual({
			files: ['/data/r.geojson'],
			dataset: 'HydroRIVERS-v10',
			source: 'HydroRIVERS v1.0',
			minOrder: 3
		});
	});
});

describe('reachDescription and riverRef', () => {
	it('says where the reach came from, its order and upstream area, within the description limit', () => {
		expect(reachDescription({ reachId: 12, strahler: 3, upstreamKm2: 412.5, source: 'HydroRIVERS v1.0' })).toBe('From the river network, reach 12 (Strahler order 3, 413 km² upstream): HydroRIVERS v1.0');
		expect(reachDescription({ reachId: 12, strahler: null, upstreamKm2: 54.94, source: 'S' })).toBe('From the river network, reach 12 (54.9 km² upstream): S');
		expect(reachDescription({ reachId: 12, strahler: null, upstreamKm2: null, source: 'x'.repeat(600) })).toHaveLength(500);
		expect(riverRef('HydroRIVERS-v10', 10552361)).toBe('river-network:HydroRIVERS-v10:10552361');
	});
});
