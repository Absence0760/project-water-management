import { STRESS_THRESHOLDS, supplyAssurance, type WaterAccountRow } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { accountBars, accountLines, classCounts, classOf, ewrMetShare, nodeAssurance, notComputedText, partWaterYears, pctText, reliabilityLine, stressLegend } from './reliability';

const zeros = (n: number) => new Array<number>(n).fill(0);

/** A synthetic farm over two water years, with a dam that ends fuller than it started. */
const a = supplyAssurance({
	startDate: '2001-09-29',
	days: 6,
	window: { from: 0, to: 5, reportStart: '2001-09-29', reportEnd: '2001-10-04' },
	annualThreshold: 0.9,
	demandNodes: [{ nodeId: 'A', name: 'Farm A', kind: 'farm', demand: [10, 10, 0, 10, 10, 10], supplied: [10, 5, 0, 10, 0, 4] }],
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
			storage: [10, 20, 30, 40, 50, 60],
			initialStorageM3: 0
		}
	],
	natural: [100, 100, 100, 100, 100, 100],
	outflow: [80, 85, 90, 80, 90, 86],
	rainMm: null,
	areaKm2: null,
	sites: []
});

describe('assurance helpers', () => {
	it('says which engine did not compute it', () => {
		expect(notComputedText('0.31.1')).toMatch(/^Not computed by engine 0\.31:/);
		expect(notComputedText(null)).toMatch(/^Not computed by engine before 0\.32:/);
	});

	it('the legend spells out each class range from the run’s thresholds', () => {
		expect(stressLegend({ thresholds: STRESS_THRESHOLDS }).map((l) => `${l.label} ${l.range}`)).toEqual([
			'Low ≥ 95%',
			'Moderate 85% to under 95%',
			'High 70% to under 85%',
			'Severe 50% to under 70%',
			'Critical below 50%'
		]);
	});

	it('counts the months in each class', () => {
		// September 2001: 15/20 = 75 % High; October: 14/30 Critical.
		expect(classCounts(a.stress.nodes[0]!)).toEqual({ low: 0, moderate: 0, high: 1, severe: 0, critical: 1 });
	});

	it('the part water years the annual measure left out (engine ≥ 1.11.0), null on an older run', () => {
		// Both water years of the six days are part years.
		expect(partWaterYears(a)).toBe(2);
		const r = a.reliability[0]!;
		expect(partWaterYears({ reliability: [{ ...r, partWaterYears: 0 }, { ...r, partWaterYears: 1 }] })).toBe(1);
		const { partWaterYears: _, ...old } = r;
		expect(partWaterYears({ reliability: [old] })).toBeNull();
	});

	it('formats percentages and EWR shares', () => {
		expect(pctText(0.4)).toBe('40%');
		expect(pctText(null)).toBe('–');
		expect(ewrMetShare({ requiredM3: 0, metM3: 0 })).toBeNull();
		expect(ewrMetShare({ requiredM3: 200, metM3: 150 })).toBe(0.75);
	});
});

describe('water account view', () => {
	const t = a.waterAccount.total;

	it('shows only the terms this network has', () => {
		const keys = accountLines([t]).map((l) => l.key);
		expect(keys).toEqual(['naturalFlowM3', 'consumptiveIrrigationM3', 'outflowM3', 'storageChangeM3', 'residualM3']);
	});

	it('the in and out bars are the same length when the account closes; storage kept is an out', () => {
		// In 600; out: irrigation 29 + outflow 511 + 60 into storage.
		expect(t.residualM3).toBe(0);
		const b = accountBars(t);
		expect(b.total).toBe(600);
		expect(b.inBar.map((s) => [s.label, s.m3])).toEqual([['Natural flow', 600]]);
		expect(b.outBar.map((s) => [s.label, s.m3])).toEqual([
			['Consumptive irrigation', 29],
			['Outflow at the outlet', 511],
			['Into dam storage', 60]
		]);
		expect(b.outBar.reduce((s, x) => s + x.pct, 0)).toBeCloseTo(100, 10);
	});

	it('a dam that ran down supplies water: storage goes on the in side', () => {
		const r: WaterAccountRow = { ...t, storageChangeM3: -50, naturalFlowM3: 550 };
		const b = accountBars(r);
		expect(b.inBar.map((s) => s.label)).toEqual(['Natural flow', 'Drawn from dam storage']);
	});
});

describe('one node’s assurance (a unit’s detail, its dam on the Dams page)', () => {
	it('classes a ratio by the run’s own thresholds', () => {
		expect(classOf(0.95, STRESS_THRESHOLDS)).toBe('low');
		expect(classOf(0.9, STRESS_THRESHOLDS)).toBe('moderate');
		expect(classOf(0.49, STRESS_THRESHOLDS)).toBe('critical');
		expect(classOf(null, STRESS_THRESHOLDS)).toBeNull();
		expect(classOf(NaN, STRESS_THRESHOLDS)).toBeNull();
		// Thresholds stored with the run win over the engine's current ones.
		expect(classOf(0.9, [{ cls: 'low', min: 0.8 }])).toBe('low');
	});

	it('picks the node’s reliability and grid, and classes each month pooled over the window', () => {
		const n = nodeAssurance(a, 'A')!;
		expect(n.reliability.name).toBe('Farm A');
		expect(n.grid?.nodeId).toBe('A');
		expect(n.months).toHaveLength(12);
		// September 2001 (index 11): demand 20 over two days, 15 supplied → 75%, High.
		expect(n.months[11]).toEqual({ ratio: 0.75, cls: 'high' });
		// October 2001 (index 0): demand 30 over three demand days, 14 supplied → under 50%, Critical.
		expect(n.months[0]!.ratio).toBeCloseTo(14 / 30, 9);
		expect(n.months[0]!.cls).toBe('critical');
		// A month with no demand in the window has no class.
		expect(n.months[3]).toEqual({ ratio: null, cls: null });
		expect(nodeAssurance(a, 'gone')).toBeNull();
	});

	it('says the reliability in one line, and says so when there was no demand', () => {
		const r = nodeAssurance(a, 'A')!.reliability;
		expect(reliabilityLine(r)).toBe(`${pctText(r.timeReliability, 1)} of demand days fully met · ${pctText(r.volumetricReliability, 1)} of the demand volume supplied`);
		expect(reliabilityLine({ ...r, waterYears: 3, waterYearsMet: 2, annualReliability: 2 / 3 })).toMatch(/ · 2 of 3 water years met \(67%\)$/);
		expect(reliabilityLine({ ...r, waterYears: 1, waterYearsMet: 1, annualReliability: 1 })).toMatch(/1 of 1 water year met \(100%\)$/);
		expect(reliabilityLine({ ...r, demandDays: 0 })).toBe('No demand in the reporting window.');
	});
});
