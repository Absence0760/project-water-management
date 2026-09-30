import { describe, expect, it } from 'vitest';
import type { SupplyAssurance, SupplyReliability } from '@water-management/engine';
import { compareAssurance } from './assurance';

const rel = (name: string, over: Partial<SupplyReliability> = {}): SupplyReliability => ({
	nodeId: crypto.randomUUID(),
	name,
	kind: 'farm',
	demandM3: 1000,
	suppliedM3: 900,
	demandDays: 100,
	metDays: 80,
	timeReliability: 0.8,
	volumetricReliability: 0.9,
	waterYears: 4,
	waterYearsMet: 3,
	annualReliability: 0.75,
	failureRuns: 5,
	meanFailureDays: 4,
	longestFailureDays: 9,
	meanFailureDeficitM3: 20,
	maxFailureDeficitM3: 40,
	months: [],
	...over
});
const assurance = (reliability: SupplyReliability[], over: Partial<SupplyAssurance> = {}): SupplyAssurance =>
	({ reportStart: '2020-10-01', reportEnd: '2024-09-30', days: 1461, annualThreshold: 0.9, reliability, stress: {} as SupplyAssurance['stress'], waterAccount: {} as SupplyAssurance['waterAccount'], ...over }) as SupplyAssurance;

describe('compareAssurance', () => {
	it('matches farms and water users by name and gives each measure B − A', () => {
		const a = assurance([rel('Upper farm'), rel('Town', { kind: 'user' })]);
		const b = assurance([
			rel('Upper farm', { timeReliability: 0.9, volumetricReliability: 0.95, waterYearsMet: 4, annualReliability: 1, longestFailureDays: 3 }),
			rel('Town', { kind: 'user' })
		]);
		const c = compareAssurance(a, b)!;
		expect(c.rows.map((r) => r.name)).toEqual(['Upper farm', 'Town']);
		const upper = c.rows[0]!;
		expect(upper.time.a).toBe(0.8);
		expect(upper.time.b).toBe(0.9);
		expect(upper.time.delta).toBeCloseTo(0.1);
		expect(upper.volumetric.delta).toBeCloseTo(0.05);
		expect(upper.annual.delta).toBeCloseTo(0.25);
		expect([upper.yearsA, upper.yearsB]).toEqual(['3 of 4', '4 of 4']);
		expect(upper.longestFailureDays.delta).toBe(-6);
		expect(c.rows[1]!.kind).toBe('user');
		expect(c).toMatchObject({ onlyInA: [], onlyInB: [], missing: null, thresholds: null, windows: null });
	});

	it('lists units in one run only, and pairs namesakes in order', () => {
		const c = compareAssurance(assurance([rel('Dup', { metDays: 1 }), rel('Dup', { timeReliability: 0.5 }), rel('Gone')]), assurance([rel('Dup'), rel('Dup'), rel('New')]))!;
		expect(c.rows.map((r) => r.time.a)).toEqual([0.8, 0.5]);
		expect(c.onlyInA).toEqual(['Gone']);
		expect(c.onlyInB).toEqual(['New']);
	});

	it('keeps a measure without data as not comparable', () => {
		const c = compareAssurance(assurance([rel('Dry', { waterYears: 0, waterYearsMet: 0, annualReliability: null })]), assurance([rel('Dry')]))!;
		expect(c.rows[0]!.annual).toEqual({ a: null, b: 0.75, delta: null });
		expect(c.rows[0]!.yearsA).toBe('–');
	});

	it('says which run has no assurance of supply, and when the thresholds or windows differ', () => {
		expect(compareAssurance(undefined, undefined)).toBeNull();
		expect(compareAssurance(assurance([]), assurance([]))).toBeNull();
		const older = compareAssurance(undefined, assurance([rel('Upper farm')]))!;
		expect(older).toMatchObject({ missing: 'a', rows: [], onlyInA: [], onlyInB: [] });
		expect(compareAssurance(assurance([rel('Upper farm')]), undefined)!.missing).toBe('b');
		const differ = compareAssurance(assurance([rel('X')]), assurance([rel('X')], { annualThreshold: 0.8, reportStart: '2021-10-01' }))!;
		expect(differ.thresholds).toEqual({ a: 0.9, b: 0.8 });
		expect(differ.windows).toEqual({ a: '2020-10-01 to 2024-09-30', b: '2021-10-01 to 2024-09-30' });
	});
});
