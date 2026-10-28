// fit-donors.ts (issue #622 step 3): reading Caravan's files, the donor
// criteria, the basin's rain from our copy (the committed synthetic one), and
// the engine's own fit recovering a synthetic donor's parameters. Every
// basin, value and id here is invented.
import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION, runModel, toEpochDay } from '@water-management/engine';
import { encodeCellValue } from '../src/feeds/cellCache.js';
import { geometryAreaM2 } from '../src/geo/area.js';
import type { Geometry } from '../src/geo/geojson.js';
import { donorsFromJson, donorsToJson } from '../src/geo/gr4jDonors.js';
import { fixtureMirrorUrl } from '../src/mirror/source.js';
import { openStore } from '../src/mirror/store.js';
import {
	arealRain,
	basinCells,
	basinPolygons,
	basinRain,
	caravanBasins,
	donorInput,
	fitDonor,
	fitMethod,
	flowOver,
	flowYears,
	parseCsv,
	parseFitDonorsArgs,
	selectCandidates,
	streamflowFromCsv
} from './fit-donors.js';

const square = (w: number, s: number, e: number, n: number): Geometry => ({
	type: 'Polygon',
	coordinates: [
		[
			[w, s],
			[e, s],
			[e, n],
			[w, n],
			[w, s]
		]
	]
});

describe('Caravan’s files', () => {
	it('parses quoted CSV fields', () => {
		expect(parseCsv('a,b\n1,"x, ""y"""\r\n2,\n')).toEqual([
			{ a: '1', b: 'x, "y"' },
			{ a: '2', b: '' }
		]);
	});

	const other = 'gauge_id,area,country,gauge_lat,gauge_lon,gauge_name\nSYN_1,500.5,South Africa,-33.1,21.2,"RIVER A, SOMEWHERE"\nSYN_2,90000,South Africa,-30,25,"BIG"\nSYN_3,300,Namibia,-22,17,X\nSYN_4,200,Elsewhere,10,10,Y\nSYN_5,250,South Africa,-31,26,Z\n';
	const atlas =
		'gauge_id,ari_ix_sav,pre_mm_syr,slp_dg_sav,cly_pc_sav,snd_pc_sav,for_pc_sse,dor_pc_pva\nSYN_1,48,650,61,26,57,12,0\nSYN_2,30,400,20,20,60,0,10\nSYN_3,20,300,30,22,65,0,120\nSYN_4,60,900,10,30,40,50,0\nSYN_5,40,500,-999,25,55,5,\n';

	it('converts HydroATLAS’s scaled values into the donor’s units', () => {
		const [b] = caravanBasins(other, atlas);
		expect(b).toEqual({
			id: 'SYN_1',
			lon: 21.2,
			lat: -33.1,
			areaKm2: 500.5,
			country: 'South Africa',
			attributes: { aridity: 0.48, mapMm: 650, slopeDeg: 6.1, clayPct: 26, sandPct: 57, forestPct: 12 },
			dorPct: 0
		});
		// No-data (−999) and a missing value are null.
		const b5 = caravanBasins(other, atlas).find((x) => x.id === 'SYN_5')!;
		expect(b5.attributes.slopeDeg).toBeNull();
		expect(b5.dorPct).toBeNull();
	});

	it('keeps basins in region D1, under 5 % regulation and the area cap', () => {
		const sel = selectCandidates(caravanBasins(other, atlas));
		expect(sel.kept.map((b) => b.id)).toEqual(['SYN_1']);
		// SYN_4 is outside the region: not a candidate at all, so not refused either.
		expect(sel.refused).toEqual([
			{ id: 'SYN_2', reason: '90000 km², over --max-area 10000' },
			{ id: 'SYN_3', reason: 'regulated: 12.0 % (a donor is under 5 %)' },
			{ id: 'SYN_5', reason: 'no degree of regulation (dor_pc_pva)' }
		]);
		expect(selectCandidates(caravanBasins(other, atlas), { maxAreaKm2: 100_000, only: new Set(['SYN_2']) }).kept.map((b) => b.id)).toEqual(['SYN_2']);
	});

	it('reads the streamflow column and refuses a gap in the dates', () => {
		const ts = 'date,total_precipitation_sum,streamflow\n2000-01-01,3,0.5\n2000-01-02,0,\n2000-01-03,0,-1\n2000-01-04,0,0.25\n';
		expect(streamflowFromCsv(ts)).toEqual({ startDate: '2000-01-01', mmPerDay: [0.5, null, null, 0.25] });
		expect(() => streamflowFromCsv('date,streamflow\n2000-01-01,1\n2000-01-03,1\n')).toThrow(/jump/);
		expect(() => streamflowFromCsv('date,flow\n2000-01-01,1\n')).toThrow(/streamflow/);
		const f = streamflowFromCsv(ts);
		expect(flowOver(f, '1999-12-31', 3)).toEqual([null, 0.5, null]);
	});

	it('reads the polygons by gauge_id', () => {
		const m = basinPolygons({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { gauge_id: 'SYN_1' }, geometry: square(21, -33.2, 21.2, -33) }, { properties: {}, geometry: square(0, 0, 1, 1) }] });
		expect([...m.keys()]).toEqual(['SYN_1']);
	});
});

describe('our forcing over a basin', () => {
	it('weights each CHIRPS cell by its area inside the polygon', () => {
		const g = square(21.025, -33.2, 21.1, -33.1);
		const got = basinCells(g);
		if ('problem' in got) throw new Error(got.problem);
		// 2 rows × 2 columns of 0.05° cells, the west column half inside.
		expect(got.cells).toHaveLength(4);
		const total = got.weights.reduce((a, b) => a + b, 0);
		expect(total / geometryAreaM2(g)!).toBeCloseTo(1, 4);
	});

	it('averages the final days, leaving the sea out of a day’s mean', () => {
		const enc = (xs: (number | null)[]) => xs.map(encodeCellValue);
		const rain = arealRain('ff-f', [enc([2, 4, 9, Number.NaN]), enc([4, Number.NaN, 9, Number.NaN])], [1, 3]);
		expect(rain).toEqual([3.5, 4, null, null]);
	});

	it('reads a basin’s rain from the copy, trimmed to its final days', async () => {
		const store = openStore(fixtureMirrorUrl());
		const got = await basinRain(store, 'sat', square(25.05, -20.25, 25.25, -20.05), { start: '2022-12-30', end: '2026-01-05' });
		if ('problem' in got) throw new Error(got.problem);
		// The synthetic copy holds finals for 2023–2025.
		expect(got.startDate).toBe('2023-01-01');
		expect(got.rainMm).toHaveLength(toEpochDay('2025-12-31') - toEpochDay('2023-01-01') + 1);
		expect(got.rainMm.every((v) => v !== null && v >= 0)).toBe(true);
	});
});

describe('the fit', () => {
	/** Seasonal invented rain: wet winters, the odd storm, deterministic. */
	function rain(days: number, start: string): number[] {
		let s = 7;
		const rnd = () => ((s = (s * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
		const d0 = toEpochDay(start);
		return Array.from({ length: days }, (_, t) => {
			const m = new Date((d0 + t) * 86_400_000).getUTCMonth() + 1;
			const wet = [5, 6, 7, 8, 9].includes(m) ? 0.35 : 0.08;
			return rnd() < wet ? Math.round(-Math.log(1 - rnd()) * (rnd() < 0.05 ? 40 : 8) * 10) / 10 : 0;
		});
	}

	it('recovers a synthetic donor’s parameters with the engine’s own calibrate', () => {
		const start = '1990-01-01';
		const r = rain(Math.round(10 * 365.25), start);
		const pe = [120, 150, 175, 180, 150, 130, 90, 65, 50, 55, 75, 95];
		const area = 120;
		const truth = { x1: 300, x2: 0, x3: 60, x4: 1.5 };
		const base = donorInput({ startDate: start, rainMm: r, flowMmPerDay: r.map(() => null), peMonthlyMm: pe, areaKm2: area, peSource: 'invented' });
		base.settings.gr4j = { ...truth, warmupDays: 365 };
		const natural = runModel(base).series.find((s) => s.key === 'natural_flow')!.values;
		const mm = natural.map((q) => (q === null ? null : q / (area * 1000)));
		expect(flowYears(mm)).toBeGreaterThanOrEqual(8);
		const fit = fitDonor(donorInput({ startDate: start, rainMm: r, flowMmPerDay: mm, peMonthlyMm: pe, areaKm2: area, peSource: 'invented' }), { budget: 600, starts: 1 });
		expect(fit.kgeFit!).toBeGreaterThan(0.97);
		expect(fit.params.x2).toBe(0);
		expect(Math.abs(Math.log(fit.params.x1 / truth.x1))).toBeLessThan(0.2);
		expect(fit.kgeValidation).not.toBeNull();
		expect(fit.report.bounds).toBe('typical');
		expect(fit.report.objective).toBe('kgePrime');
	});

	it('writes a file the donor loader reads back', () => {
		const meta = { source: 's', version: 'v', method: fitMethod({ product: 'sat', from: '1981-01-01', to: '2023-12-31', evaporation: 'dPET', budget: 1500, starts: 5, seed: 1, maxAreaKm2: 10_000 }), attribution: 'a', engineVersion: ENGINE_VERSION };
		expect(meta.method).toMatch(/KGE′, Perrin’s typical bounds/);
		const donor = {
			id: 'SYN_1',
			lon: 21.2,
			lat: -33.1,
			areaKm2: 500,
			attributes: { aridity: 0.48, mapMm: 650, slopeDeg: 6.1, clayPct: 26, sandPct: 57, forestPct: 12 },
			dorPct: 0,
			pawcMm: null,
			flowYears: 12.5,
			params: { x1: 310, x2: 0, x3: 61, x4: 1.6 },
			kgeFit: 0.81,
			kgeValidation: 0.7
		};
		const back = donorsFromJson(JSON.parse(donorsToJson(meta, [donor])));
		if (typeof back === 'string') throw new Error(back);
		expect(back.donors).toEqual([donor]);
		expect(back.problems).toEqual([]);
		expect(back.meta.engineVersion).toBe(ENGINE_VERSION);
	});
});

describe('the command line', () => {
	it('needs the Caravan directory, the polygons and the output, and checks the rest', () => {
		expect(parseFitDonorsArgs([])).toMatch(/--caravan/);
		const ok = parseFitDonorsArgs(['--caravan', 'c', '--basins', 'b.geojson', '--out', 'd.json.gz', '--only', 'A,B'], { INIT_CWD: '/w' });
		expect(ok).toMatchObject({ caravan: '/w/c', basins: '/w/b.geojson', out: '/w/d.json.gz', from: '1981-01-01', to: null, product: 'sat', maxAreaKm2: 10_000, budget: 1500, starts: 5, seed: 1 });
		expect((ok as { only: Set<string> }).only).toEqual(new Set(['A', 'B']));
		expect(parseFitDonorsArgs(['--caravan', 'c', '--basins', 'b', '--out', 'd.csv'])).toMatch(/--out/);
		expect(parseFitDonorsArgs(['--caravan', 'c', '--basins', 'b', '--out', 'd.json', '--product', 'era5'])).toMatch(/--product/);
		expect(parseFitDonorsArgs(['--caravan', 'c', '--basins', 'b', '--out', 'd.json', '--starts', '0'])).toMatch(/--starts/);
		expect(parseFitDonorsArgs(['--caravan', 'c', '--basins', 'b', '--out', 'd.json', '--from', '2000-01-01', '--to', '1999-01-01'])).toMatch(/--to/);
		expect(parseFitDonorsArgs(['--bogus'])).toBe('unknown option --bogus');
	});
});
