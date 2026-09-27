import { describe, expect, it } from 'vitest';
import type { DemandObject } from '../project';
import { demandObjectsByNode, objectMonthlyM3Day, objectReturnShare, parseDemandObjectKey, planObjects, splitSupply, objectDemandKey, objectSuppliedKey } from './demandObjects';

const obj = (over: Partial<DemandObject> = {}): DemandObject => ({
	id: 'o1',
	nodeId: 'A',
	name: 'Town',
	category: 'municipal',
	sizing: 'monthly',
	monthlyM3Day: new Array(12).fill(100),
	count: null,
	litresPerUnitDay: null,
	lossPct: 0,
	monthlyFactor: null,
	returnPct: 0,
	priority: 'shared',
	destination: 'internal',
	enabled: true,
	note: '',
	...over
});

describe('objectMonthlyM3Day', () => {
	it('takes a monthly demand as entered', () => {
		const m = Array.from({ length: 12 }, (_, i) => i * 10);
		expect(Array.from(objectMonthlyM3Day(obj({ monthlyM3Day: m }), []))).toEqual(m);
	});

	it('sizes per unit: count × litres ÷ 1000 × the month’s profile ÷ (1 − losses)', () => {
		// 2 000 people × 230 l = 460 m³/day at the tap; 20 % lost on the way, so 575 m³/day abstracted.
		const f = [1, 1, 2.5, 2.5, 1, 1, 1, 1, 1, 1, 1, 0];
		const got = objectMonthlyM3Day(obj({ sizing: 'perUnit', monthlyM3Day: null, count: 2000, litresPerUnitDay: 230, lossPct: 0.2, monthlyFactor: f }), []);
		for (let m = 0; m < 12; m++) expect(got[m]).toBeCloseTo((575 * f[m]!), 9);
	});

	it('runs a bad value as 0 (or a bad factor as 1) and says so', () => {
		const w: string[] = [];
		const got = objectMonthlyM3Day(obj({ monthlyM3Day: [1, -2, Number.NaN, 4, 5, 6, 7, 8, 9, 10, 11, 12] }), w);
		expect(Array.from(got.slice(0, 4))).toEqual([1, 0, 0, 4]);
		expect(w.join()).toMatch(/isn't a number ≥ 0 runs as 0/);
		const w2: string[] = [];
		expect(Array.from(objectMonthlyM3Day(obj({ sizing: 'perUnit', count: 10, litresPerUnitDay: 100, monthlyFactor: [-1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] }), w2))[0]).toBe(1);
		expect(w2.join()).toMatch(/profile value/);
	});

	it('is 0 without a count, with a warning', () => {
		const w: string[] = [];
		expect(Array.from(objectMonthlyM3Day(obj({ sizing: 'perUnit', count: null, litresPerUnitDay: 230 }), w)).every((v) => v === 0)).toBe(true);
		expect(w).toHaveLength(1);
	});
});

describe('objectReturnShare', () => {
	it('is the return share, clamped, and 0 for water piped out', () => {
		expect(objectReturnShare(obj({ returnPct: 0.4 }))).toBe(0.4);
		expect(objectReturnShare(obj({ returnPct: 1.7 }))).toBe(1);
		expect(objectReturnShare(obj({ returnPct: 0.4, destination: 'external' }))).toBe(0);
	});
});

describe('demandObjectsByNode', () => {
	it('keeps enabled objects on farms, in id order, and skips the rest with a warning', () => {
		const w: string[] = [];
		const nodes = [
			{ id: 'A', kind: 'farm' as const },
			{ id: 'U', kind: 'user' as const }
		];
		const by = demandObjectsByNode(
			{
				nodes: nodes as never,
				demandObjects: [obj({ id: 'z' }), obj({ id: 'b' }), obj({ id: 'off', enabled: false }), obj({ id: 'u', nodeId: 'U' }), obj({ id: 'x', nodeId: 'X' })]
			},
			w
		);
		expect(by.get('A')!.map((o) => o.id)).toEqual(['b', 'z']);
		expect(by.has('U')).toBe(false);
		expect(w).toHaveLength(2);
	});
});

describe('splitSupply', () => {
	const po = planObjects(
		[obj({ id: 'first', priority: 'first' }), obj({ id: 'shared', priority: 'shared' }), obj({ id: 'last', priority: 'last' })],
		1,
		[0],
		null,
		0,
		[]
	);
	const out = () => [new Float64Array(1), new Float64Array(1), new Float64Array(1)];

	it('gives everyone their demand when the unit is fully supplied', () => {
		const o = out();
		expect(splitSupply(500, 200, po, 0, o)).toBe(200);
		expect(o.map((x) => x[0])).toEqual([100, 100, 100]);
	});

	it('serves the first class, then the crops and shared objects pro rata, then the last', () => {
		// 100 for "first", then 200 crop + 100 shared want 300 but 150 is left: half each; "last" gets nothing.
		const o = out();
		expect(splitSupply(250, 200, po, 0, o)).toBe(100);
		expect(o.map((x) => x[0])).toEqual([100, 50, 0]);
		// Short of the first class: it shares what there is, nobody else gets any.
		const o2 = out();
		expect(splitSupply(40, 200, po, 0, o2)).toBe(0);
		expect(o2.map((x) => x[0])).toEqual([40, 0, 0]);
		// Everything but the last class met in full: it gets the rest.
		const o3 = out();
		expect(splitSupply(430, 200, po, 0, o3)).toBe(200);
		expect(o3.map((x) => x[0])).toEqual([100, 100, 30]);
	});
});

describe('series keys', () => {
	it('round-trip', () => {
		expect(parseDemandObjectKey(objectDemandKey('abc'))).toEqual({ id: 'abc', what: 'demand' });
		expect(parseDemandObjectKey(objectSuppliedKey('abc'))).toEqual({ id: 'abc', what: 'supplied' });
		expect(parseDemandObjectKey('demand')).toBeNull();
	});
});
