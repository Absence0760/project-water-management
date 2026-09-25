import { describe, expect, it } from 'vitest';
import { farmOperatingRules, readFarmSpec } from './farms';
import { Report } from './report';
import { syntheticB023 } from './testWorkbook';
import { B023Workbook } from './workbook';

// Ported from scripts/wbt-import/test_farm_ops.py (engine ≥ 0.16.0, docs/engine-audit.md Q5, N1, N2).
describe('farm operating rules', () => {
	it('Q5: the workbook min is the transfer minimum, not an operating level', () => {
		const report = new Report();
		expect(farmOperatingRules('Synthetic farm', { damMinPct: 0.3 }, report).damMinPct).toBe(0);
		expect(report.notes.length).toBe(1);
		expect(report.notes[0]!.message).toContain('transfer minimum');
		expect(report.notes[0]!.message).toBe(
			"farm Synthetic farm: [Farm spec] min dam % 0.3 is the workbook's transfer minimum (each transfer rule keeps its own); the dam's minimum operating level is left at 0 (docs/engine-audit.md Q5)"
		);
	});

	it('Q5: no note without a workbook min', () => {
		const report = new Report();
		expect(farmOperatingRules('Synthetic farm', {}, report).damMinPct).toBe(0);
		expect(report.notes).toEqual([]);
	});

	it('N1: return flow becomes efficiency with every loss returning', () => {
		const ops = farmOperatingRules('Synthetic farm', { returnFlowPct: 0.2 }, new Report());
		expect(ops.irrigationEfficiency).toBeCloseTo(0.8);
		expect(ops.irrigationEfficiency).toBe(1 - 0.2); // the same float arithmetic as the Python
		expect(ops.lossReturnFraction).toBe(1);
		expect(ops).not.toHaveProperty('returnFlowPct');
	});

	it('N1: no return flow is full efficiency and no return', () => {
		const ops = farmOperatingRules('Synthetic farm', { returnFlowPct: 0 }, new Report());
		expect([ops.irrigationEfficiency, ops.lossReturnFraction]).toEqual([1, 0]);
	});

	it('N1: all returning maps to the smallest efficiency', () => {
		expect(farmOperatingRules('Synthetic farm', { returnFlowPct: 1 }, new Report()).irrigationEfficiency).toBe(0.01);
	});

	it('N2: no surface area in the workbook', () => {
		const ops = farmOperatingRules('Synthetic farm', { damCapacityM3: 90000 }, new Report());
		expect([ops.damAreaFullM2, ops.damAreaExponent, ops.damSeepagePerDay]).toEqual([null, 0.7, 0]);
	});
});

describe('readFarmSpec', () => {
	it('reads each farm row and the method settings', () => {
		const t = readFarmSpec(new B023Workbook(syntheticB023().build()), new Report());
		expect([...t.farms.keys()]).toEqual(['Farm A', 'Farm B']);
		expect(t.farms.get('Farm A')).toMatchObject({ areaKm2: 5, areaHiKm2: 4, areaLoKm2: 1, flowShareManual: 0.5, selectedShare: 0.4, damCapacityM3: 100000, damMinPct: 0.3 });
		expect(t.method).toBe('area');
		expect(t.hiLoSplit).toEqual({ hi: 0.8, lo: 0.2 });
		expect(t.tolerance).toBe(0.0002);
	});

	it('maps Hi/Lo and Specific, and notes an unknown method', () => {
		expect(readFarmSpec(new B023Workbook(syntheticB023().set('Farm spec', 'M27', 'Hi/Lo').build()), new Report()).method).toBe('hiLo');
		const report = new Report();
		expect(readFarmSpec(new B023Workbook(syntheticB023().set('Farm spec', 'M27', 'Pitman').build()), report).method).toBe('area');
		expect(report.notes.map((n) => n.message)).toEqual(["unknown fragmentation method 'Pitman'; using area"]);
	});

	it('defaults a blank hi/lo split to 0.81 / 0.19', () => {
		const b = syntheticB023().set('Farm spec', 'I27', null).set('Farm spec', 'J27', null);
		expect(readFarmSpec(new B023Workbook(b.build()), new Report()).hiLoSplit).toEqual({ hi: 0.81, lo: 0.19 });
	});

	it('lists a blank share under the Specific method (the Python reads 0 without a word)', () => {
		const report = new Report();
		const b = syntheticB023().set('Farm spec', 'M27', 'Specific').set('Farm spec', 'L31', null);
		const t = readFarmSpec(new B023Workbook(b.build()), report);
		expect(t.method).toBe('manual');
		expect(t.farms.get('Farm B')!.flowShareManual).toBe(0);
		expect(report.unmapped).toEqual([expect.objectContaining({ code: 'flow-share-missing', element: 'Farm B', cell: 'L31', sheet: 'Farm spec' })]);
		// Not listed under the other methods, where the share isn't used.
		const other = new Report();
		readFarmSpec(new B023Workbook(syntheticB023().set('Farm spec', 'L31', null).build()), other);
		expect(other.unmapped).toEqual([]);
	});

	it('reads numeric text, and lists text that is not a number (imported as 0)', () => {
		const report = new Report();
		const b = syntheticB023().set('Farm spec', 'T30', '4320').set('Farm spec', 'P31', 'about 5000');
		const t = readFarmSpec(new B023Workbook(b.build()), report);
		expect(t.farms.get('Farm A')!.divertCapacityM3Day).toBe(4320);
		expect(t.farms.get('Farm B')!.damCapacityM3).toBe(0);
		expect(report.unmapped).toEqual([
			expect.objectContaining({ code: 'non-numeric-value', cell: 'P31', element: 'Farm B', text: 'about 5000', message: "[Farm spec] Dam capacity for Farm B (P31) holds 'about 5000', not a number; imported as 0" })
		]);
	});
});
