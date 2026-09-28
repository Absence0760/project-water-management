// The summary CSV's assurance-of-supply blocks (WP-3.4): built from a real
// engine summary of a small synthetic case, so the figures are the engine's.
import { supplyAssurance } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_TITLE, RELIABILITY_TITLE, STRESS_TITLE, supplyAssuranceLines } from './supply-assurance.js';

const zeros = (n: number) => new Array<number>(n).fill(0);

/** One farm over 29 Sep – 4 Oct 2001 (two water years), one outlet EWR site. */
const a = supplyAssurance({
	startDate: '2001-09-29',
	days: 6,
	window: { from: 0, to: 5, reportStart: '2001-09-29', reportEnd: '2001-10-04' },
	annualThreshold: 0.7,
	demandNodes: [{ nodeId: 'A', name: 'Farm, upper', kind: 'farm', demand: [10, 10, 0, 10, 10, 10], supplied: [10, 5, 0, 10, 0, 4] }],
	accountNodes: [
		{
			kind: 'farm',
			runoff: [100, 100, 100, 100, 100, 100],
			landCover: zeros(6),
			transfer: zeros(6),
			supplied: [10, 5, 0, 10, 0, 4],
			returned: zeros(6),
			groundwater: zeros(6),
			depletion: zeros(6),
			storage: zeros(6),
			initialStorageM3: 0
		}
	],
	natural: [100, 100, 100, 100, 100, 100],
	outflow: [90, 95, 100, 90, 100, 96],
	rainMm: null,
	areaKm2: null,
	sites: [{ nodeId: null, name: 'Outlet', required: [95, 95, 95, 95, 95, 95], shortfall: [-5, 0, 0, -5, 0, 0] }]
});

describe('assurance of supply CSV blocks (engine ≥ 0.32.0)', () => {
	const lines = [...supplyAssuranceLines(a)];

	it('reliability: one row per farm, fractions as percentages', () => {
		expect(lines[0]).toBe(RELIABILITY_TITLE);
		expect(lines).toContain('Window,2001-09-29,2001-10-04,6 days');
		// time 2/5, volumetric 29/50; no complete water year, two part years left out (engine ≥ 1.11.0), so no annual figure;
		// 2 failure runs, mean 1.5 days, deficits 10.5 mean, 16 max.
		expect(lines).toContain('Farm or user,Kind,Demand (m³),Supplied (m³),Demand days,Days fully met,Time-based (% of demand days met),Volumetric (% of demand supplied),Complete water years,Part water years left out,Water years met,Annual (% of complete water years met),Failure runs,Mean failure length (days),Longest failure (days),Mean deficit per failure (m³),Largest deficit of a failure (m³)');
		expect(lines).toContain('"Farm, upper",farm,50,29,5,2,40,58,0,2,0,,2,1.5,2,10.5,16');
	});

	it('stress: a class and a percentage per water-year month, the system first', () => {
		const at = lines.indexOf(STRESS_TITLE);
		expect(at).toBeGreaterThan(0);
		expect(lines[at + 1]).toBe('Classes,Low ≥ 95 %,Moderate ≥ 85 %,High ≥ 70 %,Severe ≥ 50 %,Critical below');
		expect(lines).toContain('Stress,All farms and users');
		expect(lines).toContain('Stress,"Farm, upper"');
		// 2000/01: September 15/20 = 75 % (High); 2001/02: October 14/30 (Critical).
		const y0 = lines.find((l) => l.startsWith('2000/01,'))!;
		expect(y0.endsWith(',High,75')).toBe(true);
		const y1 = lines.find((l) => l.startsWith('2001/02,'))!;
		expect(y1.startsWith('2001/02,Critical,46.6666666667,')).toBe(true);
	});

	it('water account: in, out, storage and a zero residual per water year and the run; EWR required vs met', () => {
		const at = lines.indexOf(ACCOUNT_TITLE);
		expect(at).toBeGreaterThan(lines.indexOf(STRESS_TITLE));
		const header = lines[at + 2]!.split(',');
		expect(header[0]).toBe('Water year');
		const run = lines.find((l) => l.startsWith('Whole run,6,'))!.split(',');
		const col = (h: string) => Number(run[header.indexOf(h)]);
		expect(col('IN natural flow (m³)')).toBe(600);
		expect(col('OUT consumptive irrigation (m³)')).toBe(29);
		expect(col('OUT outflow at the outlet (m³)')).toBe(571);
		expect(col('Residual: in − out − change in storage (m³)')).toBe(0);
		// Outlet: required 570, met 570 − 10.
		expect(lines).toContain('Whole run,570,560,98.2456140351,2');
	});

	it('a run from an older engine says so in each block', () => {
		const old = [...supplyAssuranceLines(undefined)];
		expect(old.filter((l) => l.startsWith('Not computed: run made before engine 0.32.0')).length).toBe(3);
		expect(old.filter((l) => l === '').length).toBe(2);
	});
});
