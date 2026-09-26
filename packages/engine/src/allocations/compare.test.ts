import { describe, expect, it } from 'vitest';
import { fromEpochDay, toEpochDay } from '../calendar';
import { allocationStatus, compareAllocations, type AllocationEntry, type AllocationUseNode } from './compare';

/** Days from `from` up to and including `to`. */
const span = (from: string, to: string) => toEpochDay(to) - toEpochDay(from) + 1;

const farm = (supplied: number[], groundwater?: number[], extra: Partial<AllocationUseNode> = {}): AllocationUseNode => ({
	nodeId: 'F',
	name: 'Farm F',
	kind: 'farm',
	supplied,
	groundwater: groundwater ?? null,
	...extra
});
const alloc = (volume: number, extra: Partial<AllocationEntry> = {}): AllocationEntry => ({
	id: `a${volume}`,
	nodeId: 'F',
	waterSource: 'surface',
	volumeM3PerYear: volume,
	...extra
});

describe('allocationStatus', () => {
	it('bands modelled use around the registered volume by the tolerance', () => {
		expect(allocationStatus(111, 100)).toBe('over');
		expect(allocationStatus(110, 100)).toBe('within');
		expect(allocationStatus(90, 100)).toBe('within');
		expect(allocationStatus(89, 100)).toBe('under');
		expect(allocationStatus(5, 0)).toBe('unregistered');
		expect(allocationStatus(0, 0)).toBe('none');
		expect(allocationStatus(104, 100, 0.03)).toBe('over');
	});
});

describe('compareAllocations', () => {
	// Two whole water years, 2001/02 and 2002/03 (365 days each).
	const days = span('2001-10-01', '2003-09-30');

	it('sums modelled supply per water year against the registered volume', () => {
		const r = compareAllocations({ startDate: '2001-10-01', nodes: [farm(new Array(days).fill(100))], allocations: [alloc(30_000)] });
		const s = r.nodes[0]!.surface;
		expect(s.years.map((y) => [y.waterYear, y.days, y.partial])).toEqual([
			[2001, 365, false],
			[2002, 365, false]
		]);
		// 365 × 100 = 36 500 m³ against 30 000: 21.7 % over.
		expect(s.years[0]!.modelledM3).toBe(36_500);
		expect(s.years[0]!.registeredM3).toBeCloseTo(30_000, 9);
		expect(s.years[0]!.ratio).toBeCloseTo(36_500 / 30_000, 12);
		expect(s.years[0]!.status).toBe('over');
		expect(s.yearsOver).toBe(2);
		expect(s.meanModelledM3PerYear).toBe(36_500);
		expect(r.endDate).toBe('2003-09-30');
		// Nothing pumped, nothing registered: groundwater is 'none'.
		expect(r.nodes[0]!.groundwater.years.every((y) => y.status === 'none')).toBe(true);
	});

	it('splits supplied into surface water and groundwater', () => {
		const r = compareAllocations({
			startDate: '2001-10-01',
			nodes: [farm(new Array(days).fill(100), new Array(days).fill(40))],
			allocations: [alloc(21_900), alloc(14_600, { id: 'g', waterSource: 'groundwater' })]
		});
		const n = r.nodes[0]!;
		expect(n.surface.years[0]!.modelledM3).toBe(60 * 365);
		expect(n.surface.years[0]!.status).toBe('within');
		expect(n.groundwater.years[0]!.modelledM3).toBe(40 * 365);
		expect(n.groundwater.years[0]!.status).toBe('within');
		expect(n.groundwater.allocationIds).toEqual(['g']);
	});

	it('prorates the registered volume over a partial water year and its validity dates', () => {
		// The run starts on 1 April 2002: 183 of 2001/02's 365 days, then 2002/03, then the leap year 2003/04.
		const n = span('2002-04-01', '2004-09-30');
		const r = compareAllocations({
			startDate: '2002-04-01',
			nodes: [farm(new Array(n).fill(10))],
			allocations: [alloc(3650), alloc(1000, { id: 'late', validFrom: '2003-10-01' })]
		});
		const [y1, y2, y3] = r.nodes[0]!.surface.years;
		expect(y1).toMatchObject({ waterYear: 2001, days: 183, yearDays: 365, partial: true });
		expect(y1!.registeredM3).toBeCloseTo((3650 * 183) / 365, 9);
		expect(y2).toMatchObject({ waterYear: 2002, days: 365, partial: false });
		expect(y2!.registeredM3).toBeCloseTo(3650, 9);
		// 2003/04 has 29 February: 366 days, and the later licence adds its whole volume.
		expect(y3).toMatchObject({ waterYear: 2003, days: 366, yearDays: 366, partial: false });
		expect(y3!.registeredM3).toBeCloseTo(4650, 9);
		// Partial years are shown, not counted.
		expect(r.nodes[0]!.surface.wholeYears).toBe(2);
	});

	it('counts an allocation only on the days it is valid', () => {
		// Valid for the first 73 days of 2001/02 only: a fifth of its volume.
		const r = compareAllocations({
			startDate: '2001-10-01',
			nodes: [farm(new Array(days).fill(0))],
			allocations: [alloc(3650, { validTo: fromEpochDay(toEpochDay('2001-10-01') + 72) })]
		});
		expect(r.nodes[0]!.surface.years[0]!.registeredM3).toBeCloseTo(730, 9);
		expect(r.nodes[0]!.surface.years[1]!.registeredM3).toBe(0);
	});

	it('flags modelled use with no registered volume as unregistered', () => {
		const r = compareAllocations({ startDate: '2001-10-01', nodes: [farm(new Array(days).fill(5))], allocations: [] });
		expect(r.nodes[0]!.surface.years.map((y) => y.status)).toEqual(['unregistered', 'unregistered']);
		expect(r.nodes[0]!.surface.years[0]!.ratio).toBeNull();
	});

	it('lists unmatched allocations and ones for nodes the run lacks', () => {
		const r = compareAllocations({
			startDate: '2001-10-01',
			nodes: [farm([1])],
			allocations: [alloc(1, { id: 'u', nodeId: null }), alloc(2, { id: 'gone', nodeId: 'X' })]
		});
		expect(r.unmatchedAllocationIds).toEqual(['u']);
		expect(r.notInRunAllocationIds).toEqual(['gone']);
	});

	it('compares the registered storage with the modelled dam capacity', () => {
		const r = compareAllocations({
			startDate: '2001-10-01',
			nodes: [farm([1], undefined, { damCapacityM3: 50_000 })],
			allocations: [alloc(1, { storageM3: 20_000 }), alloc(2, { storageM3: 10_000 }), alloc(3)]
		});
		expect(r.nodes[0]!.storage).toEqual({ registeredM3: 30_000, modelledCapacityM3: 50_000 });
	});

	it('refuses a tolerance outside [0, 1) and a negative volume', () => {
		expect(() => compareAllocations({ startDate: '2001-10-01', nodes: [], allocations: [], tolerance: 1 })).toThrow(RangeError);
		expect(() => compareAllocations({ startDate: '2001-10-01', nodes: [farm([1])], allocations: [alloc(-1)] })).toThrow(RangeError);
	});

	// Invariant (WP-3.10 checkAllocations): the modelled use, summed over water
	// years and both sources, is the run's supplied series summed (plus what was
	// pumped into the dam, WP-3.9), and every run day falls in exactly one water year.
	it('keeps modelled use equal to the Σ supplied series', () => {
		let seed = 7;
		const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
		for (let k = 0; k < 20; k++) {
			const n = 50 + Math.floor(rnd() * 900);
			const supplied = Array.from({ length: n }, () => rnd() * 500);
			const gw = supplied.map((v) => v * rnd());
			const startDate = fromEpochDay(toEpochDay('1990-01-01') + Math.floor(rnd() * 5000));
			const r = compareAllocations({ startDate, nodes: [farm(supplied, gw)], allocations: [alloc(1000)] });
			const x = r.nodes[0]!;
			const total = [...x.surface.years, ...x.groundwater.years].reduce((s, y) => s + y.modelledM3, 0);
			expect(total).toBeCloseTo(
				supplied.reduce((s, v) => s + v, 0),
				6
			);
			expect(x.surface.years.reduce((s, y) => s + y.days, 0)).toBe(n);
		}
	});

	it('counts groundwater pumped into the dam as groundwater use when pumped (WP-3.9)', () => {
		// 10 days of 1 October 2001: 100 supplied/day of which 30 groundwater to the crop, and 20/day pumped into the dam.
		const supplied = new Array(10).fill(100);
		const r = compareAllocations({
			startDate: '2001-10-01',
			nodes: [farm(supplied, new Array(10).fill(30), { groundwaterToDam: new Array(10).fill(20) })],
			allocations: [alloc(1000)]
		});
		const x = r.nodes[0]!;
		expect(x.groundwater.years[0]!.modelledM3).toBeCloseTo(500, 9);
		expect(x.surface.years[0]!.modelledM3).toBeCloseTo(700, 9);
		// Σ over both sources = Σ supplied + Σ pumped into the dam.
		expect(x.groundwater.years[0]!.modelledM3 + x.surface.years[0]!.modelledM3).toBeCloseTo(1200, 9);
	});

	it('gives the same result at UTC+14 and UTC−11', () => {
		const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process!.env;
		const tz = env.TZ;
		const input = {
			startDate: '2002-04-01',
			nodes: [farm(new Array(span('2002-04-01', '2004-09-30')).fill(3))],
			allocations: [alloc(900, { validTo: '2003-12-31' })]
		};
		try {
			env.TZ = 'Pacific/Kiritimati';
			const east = JSON.stringify(compareAllocations(input));
			env.TZ = 'Pacific/Pago_Pago';
			const west = JSON.stringify(compareAllocations(input));
			env.TZ = 'UTC';
			expect(east).toBe(JSON.stringify(compareAllocations(input)));
			expect(west).toBe(east);
		} finally {
			env.TZ = tz;
		}
	});
});
