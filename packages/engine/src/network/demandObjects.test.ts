import { describe, expect, it } from 'vitest';
import type { DemandObject } from '../project';
import { demandObjectsByNode, fromSupplyOrder, objectMonthlyM3Day, objectRank, objectReturnShare, parseDemandObjectKey, planObjects, splitSupply, objectDemandKey, objectSuppliedKey, supplyLevels, supplyOrder } from './demandObjects';

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

describe('planObjects with a schedule (engine 1.17.0)', () => {
	const sched = obj({ schedule: [{ label: '', span: 'always', from: null, to: null, easterFrom: null, easterTo: null, weekdays: [7], factor: 0 }] });
	it('multiplies each day by its schedule factor and keeps the factors', () => {
		// Epoch day 3 = 1970-01-04, a Sunday.
		const po = planObjects([sched], 3, [3, 3, 3], null, 0, [], 1);
		expect(Array.from(po.demand[0]!)).toEqual([100, 100, 0]);
		expect(Array.from(po.schedule[0]!)).toEqual([1, 1, 0]);
		expect(Array.from(po.total)).toEqual([100, 100, 0]);
	});
	it('needs the run start only when an object has a schedule', () => {
		expect(() => planObjects([sched], 3, [3, 3, 3], null, 0, [])).toThrow(/needs the run start/);
		expect(planObjects([obj()], 3, [3, 3, 3], null, 0, []).schedule).toEqual([null]);
	});
});

describe('planObjects with a full allocation’s scale (engine 1.70.0, issue #90 Q29)', () => {
	// A town of 100 m³/day (2 000 people: a floor of 50), a unit factor of 0.2 from day 1, k per day.
	const town = obj({ population: 2000 });
	const factor = new Float64Array(12).fill(0.2);
	it('scales before the factor and the floor: MAX(100 k × 0.2, MIN(50, 100 k))', () => {
		const k = Float64Array.from([0.25, 0.25, 1, 2]);
		const po = planObjects([town], 4, [0, 0, 0, 0], factor, 1, [], undefined, k);
		// Day 0 is before the factor: 100 × 0.25 = 25. Day 1: MAX(5, MIN(50, 25)) = 25. Day 2: MAX(20, 50) = 50.
		// Day 3: MAX(40, MIN(50, 200)) = 50.
		expect(Array.from(po.demand[0]!)).toEqual([25, 25, 50, 50]);
		expect(Array.from(po.total)).toEqual([25, 25, 50, 50]);
	});
	it('a factor above 1 raises the scaled demand, with no floor (1.2 × 100 × 0.5 = 60)', () => {
		const po = planObjects([town], 1, [0], new Float64Array(12).fill(1.2), 0, [], undefined, Float64Array.from([0.5]));
		expect(po.demand[0]![0]).toBeCloseTo(60, 12);
	});
	it('a k of 0 takes the object to 0, the floor included', () => {
		const po = planObjects([town], 2, [0, 0], factor, 0, [], undefined, Float64Array.from([0, 0]));
		expect(Array.from(po.demand[0]!)).toEqual([0, 0]);
	});
	it('a scale of 1 on every day is the plan without one, to the bit, the schedule included', () => {
		const sched = obj({ population: 2000, monthlyM3Day: [101.3, 7.7, 33.1, 1, 2, 3, 4, 5, 6, 7, 8, 9], schedule: [{ label: '', span: 'always', from: null, to: null, easterFrom: null, easterTo: null, weekdays: [7], factor: 0.37 }] });
		const f = Float64Array.from([0.3, 0.71, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.9]);
		const a = planObjects([sched], 3, [0, 1, 2], f, 0, [], 1);
		const b = planObjects([sched], 3, [0, 1, 2], f, 0, [], 1, new Float64Array(3).fill(1));
		expect(Array.from(b.demand[0]!)).toEqual(Array.from(a.demand[0]!));
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

describe('the supply order (engine 1.64.0, issue #343)', () => {
	it('maps first / shared / last onto 1 / 2 / 3 with the crops at 2, numbering only the classes present', () => {
		expect(supplyOrder([obj({ priority: 'first' }), obj({ priority: 'shared' }), obj({ priority: 'last' })])).toEqual({ positions: [1, 2, 3], crops: 2 });
		expect(supplyOrder([obj({ priority: 'last' }), obj({ priority: 'shared' })])).toEqual({ positions: [2, 1], crops: 1 });
		expect(supplyOrder([])).toEqual({ positions: [], crops: 1 });
	});

	it('orders within a class by rank, none being 1, and ignores a rank on a shared object', () => {
		const o = [obj({ priority: 'first', rank: 2 }), obj({ priority: 'first', rank: null }), obj({ priority: 'shared', rank: 5 }), obj({ priority: 'last', rank: 3 }), obj({ priority: 'last', rank: 1 })];
		expect(supplyOrder(o)).toEqual({ positions: [2, 1, 3, 5, 4], crops: 3 });
		expect(objectRank(obj({ priority: 'shared', rank: 5 }))).toBe(0);
	});

	it('runs a rank that isn’t a whole number from 1 to 99 as 1, with a warning', () => {
		for (const rank of [0, 1.5, 100, NaN]) {
			const w: string[] = [];
			expect(objectRank(obj({ priority: 'first', rank }), w)).toBe(1);
			expect(w[0]).toMatch(/rank/);
		}
		// An unknown priority runs with the crops, as before.
		expect(supplyLevels([obj({ priority: 'oops' as never })])).toEqual({ level: [0], cropLevel: 0, count: 1 });
	});

	it('turns a numbered order back into classes and ranks, which give the same order', () => {
		// Two municipalities before the crops in order, a third with them, livestock after.
		const back = fromSupplyOrder([1, 2, 3, 4], 3);
		expect(back).toEqual([
			{ priority: 'first', rank: 1 },
			{ priority: 'first', rank: 2 },
			{ priority: 'shared', rank: null },
			{ priority: 'last', rank: null }
		]);
		expect(supplyOrder(back.map((x) => obj(x)))).toEqual({ positions: [1, 2, 3, 4], crops: 3 });
		// Gaps and equal numbers: dense, equal stays equal, a lone class keeps no rank.
		expect(fromSupplyOrder([1, 1, 7, 9], 5)).toEqual([
			{ priority: 'first', rank: null },
			{ priority: 'first', rank: null },
			{ priority: 'last', rank: 1 },
			{ priority: 'last', rank: 2 }
		]);
		for (let seed = 1; seed <= 200; seed++) {
			let x = seed;
			const rnd = (n: number) => ((x = (x * 1103515245 + 12345) % 2147483648), x % n);
			const positions = Array.from({ length: 1 + rnd(6) }, () => 1 + rnd(5));
			const crops = 1 + rnd(5);
			const round = supplyOrder(fromSupplyOrder(positions, crops).map((y) => obj(y)));
			// The same weak order, renumbered densely.
			const all = [...positions, crops];
			const dense = (p: number) => [...new Set(all)].sort((a, b) => a - b).indexOf(p) + 1;
			expect(round, `seed ${seed}`).toEqual({ positions: positions.map(dense), crops: dense(crops) });
		}
	});
});

describe('splitSupply without ranks (bit-identical to engine 1.63.0)', () => {
	// The three-class split as engine 1.63.0 had it, verbatim but for the field names.
	function before(G: number, crop: number, demand: number[], tier: number[], out: number[]): number {
		const total = demand.reduce((s, v) => s + v, 0);
		if (G >= crop + total) {
			demand.forEach((d, k) => (out[k] = d));
			return crop;
		}
		let rem = Math.max(G, 0);
		let cropGot = 0;
		for (let t = 0; t < 3; t++) {
			let want = t === 1 ? crop : 0;
			for (let k = 0; k < demand.length; k++) if (tier[k] === t) want += demand[k]!;
			if (!(want > 0)) {
				for (let k = 0; k < demand.length; k++) if (tier[k] === t) out[k] = 0;
				continue;
			}
			if (rem >= want) {
				for (let k = 0; k < demand.length; k++) if (tier[k] === t) out[k] = demand[k]!;
				if (t === 1) cropGot = crop;
				rem -= want;
			} else {
				const f = rem / want;
				for (let k = 0; k < demand.length; k++) if (tier[k] === t) out[k] = demand[k]! * f;
				if (t === 1) cropGot = crop * f;
				rem = 0;
			}
		}
		return cropGot;
	}

	it('gives every object and the crops the same bits as before on random days', () => {
		const P = ['first', 'shared', 'last'] as const;
		let x = 7;
		const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648), x / 2147483648);
		for (let c = 0; c < 2000; c++) {
			const n = 1 + Math.floor(rnd() * 5);
			const objs = Array.from({ length: n }, (_, k) => obj({ id: `o${k}`, priority: P[Math.floor(rnd() * 3)]!, monthlyM3Day: new Array(12).fill(rnd() < 0.2 ? 0 : rnd() * 1000) }));
			const po = planObjects(objs, 1, [0], null, 0, []);
			const crop = rnd() < 0.2 ? 0 : rnd() * 2000;
			const G = rnd() * (crop + po.total[0]! + 100);
			const got = objs.map(() => new Float64Array(1));
			const want = new Array<number>(n).fill(NaN);
			const tier = objs.map((o) => ({ first: 0, shared: 1, last: 2 })[o.priority]);
			expect(splitSupply(G, crop, po, 0, got)).toBe(before(G, crop, po.demand.map((d) => d[0]!), tier, want));
			expect(got.map((g) => g[0])).toEqual(want);
		}
	});
});

describe('series keys', () => {
	it('round-trip', () => {
		expect(parseDemandObjectKey(objectDemandKey('abc'))).toEqual({ id: 'abc', what: 'demand' });
		expect(parseDemandObjectKey(objectSuppliedKey('abc'))).toEqual({ id: 'abc', what: 'supplied' });
		expect(parseDemandObjectKey('demand')).toBeNull();
	});
});
