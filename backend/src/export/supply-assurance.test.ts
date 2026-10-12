// The summary CSV's assurance-of-supply blocks (WP-3.4): built from a real
// engine summary of a small synthetic case, so the figures are the engine's.
import { supplyAssurance } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { splitCsv } from '../allocations/parse.js';
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

	it('water account: a run without base flow, transfers out, off-takes, bed losses or a storage reset has none of their columns', () => {
		const header = lines[lines.indexOf(ACCOUNT_TITLE) + 2]!;
		for (const h of ['base-flow', 'off-takes', 'bed losses', 'transferred out', 'storage reset', 'pools']) expect(header).not.toContain(h);
	});

	it('a run from an older engine says so in each block', () => {
		const old = [...supplyAssuranceLines(undefined)];
		expect(old.filter((l) => l.startsWith('Not computed: run made before engine 0.32.0')).length).toBe(3);
		expect(old.filter((l) => l === '').length).toBe(2);
	});
});

describe('water account with every optional term (engine 1.86.0)', () => {
	const six = (v: number) => new Array<number>(6).fill(v);
	const node = {
		runoff: six(100),
		landCover: zeros(6),
		supplied: zeros(6),
		returned: zeros(6),
		groundwater: zeros(6),
		depletion: zeros(6),
		storage: zeros(6),
		initialStorageM3: 0
	};
	const full = supplyAssurance({
		startDate: '2001-09-29',
		days: 6,
		window: { from: 0, to: 5, reportStart: '2001-09-29', reportEnd: '2001-10-04' },
		annualThreshold: 0.7,
		demandNodes: [],
		accountNodes: [
			// The unit's dam sends 3 a day out of the catchment (counted out in its transfer too) and is reset by 20 on day 2.
			{
				...node,
				kind: 'farm',
				transfer: six(-3),
				externalOut: six(3),
				storage: [0, 20, 20, 20, 20, 20],
				storageSet: [0, 20, 0, 0, 0, 0],
				offtakeOut: six(10),
				reachLoss: six(5),
				baseflowGain: six(7),
				baseflowLoss: six(4)
			},
			{ ...node, kind: 'gauge', runoff: zeros(6), transfer: zeros(6), offtakeIn: six(8) }
		],
		natural: six(100),
		outflow: six(93),
		rainMm: null,
		areaKm2: null,
		sites: []
	});
	const lines = [...supplyAssuranceLines(full)];
	const cells = (l: string) => splitCsv(l, ',')[0]!.cells;
	const at = lines.indexOf(ACCOUNT_TITLE);
	const header = cells(lines[at + 2]!);
	// The account's rows: the water years and the run (no EWR site, so nothing follows them).
	const rows = lines.slice(at + 3).map(cells);

	it('adds base flow, a storage reset, off-take and bed losses and transfers out as columns', () => {
		expect(header).toEqual(
			expect.arrayContaining([
				'IN storage set into (+) / out of (−) the dams by a storage reset (m³)',
				'IN base-flow gain from outside the catchment (m³)',
				'OUT river off-takes: lost on the way (m³)',
				'OUT bed losses in the reaches (m³)',
				'OUT transferred out of the catchment (m³)',
				'OUT base-flow loss from the units’ runoff (m³)'
			])
		);
		const run = rows.find((r) => r[0] === 'Whole run')!;
		const col = (h: string) => Number(run[header.indexOf(h)]);
		expect(col('IN base-flow gain from outside the catchment (m³)')).toBe(42);
		expect(col('OUT base-flow loss from the units’ runoff (m³)')).toBe(24);
		expect(col('OUT bed losses in the reaches (m³)')).toBe(30);
		expect(col('OUT transferred out of the catchment (m³)')).toBe(18);
		expect(col('OUT river off-takes: lost on the way (m³)')).toBe(12);
	});

	it('the IN columns add up to Total in and the OUT columns to Total out, on every row', () => {
		expect(rows.length).toBe(3);
		for (const r of rows) {
			const sum = (prefix: string) => header.reduce((a, h, i) => (h.startsWith(prefix) ? a + Number(r[i]) : a), 0);
			const col = (h: string) => Number(r[header.indexOf(h)]);
			expect(sum('IN ')).toBeCloseTo(col('Total in (m³)'), 6);
			expect(sum('OUT ')).toBeCloseTo(col('Total out (m³)'), 6);
			expect(col('Total in (m³)') - col('Total out (m³)') - col('Change in storage (m³)')).toBeCloseTo(col('Residual: in − out − change in storage (m³)'), 6);
		}
	});
});
