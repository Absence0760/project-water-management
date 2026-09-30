// The over/under-use chart's shapes (usePlot.ts): the Allocations tab's rows
// and the screen-reader description both the tab and the evidence report use.
import { compareAllocations } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { unitRows } from './allocations';
import { comparisonUseRows, USE_AXIS_MAX, USE_AXIS_MIN, useAxis, useSummary, type UseRow } from './usePlot';

// Two whole water years from 2001-10-01, and a part year after them.
const days = 365 + 365 + 30;
const comparison = () =>
	compareAllocations({
		startDate: '2001-10-01',
		tolerance: 0.1,
		nodes: [
			{ nodeId: 'A', name: 'Farm A', kind: 'farm', supplied: new Array(days).fill(100) },
			{ nodeId: 'B', name: 'Farm B', kind: 'farm', supplied: new Array(days).fill(10), groundwater: new Array(days).fill(10) },
			{ nodeId: 'C', name: 'Farm C', kind: 'farm', supplied: new Array(days).fill(5) }
		],
		allocations: [
			// A: 36 500 m³ a year against 30 000 registered (122 %), above the band.
			{ id: 'a', nodeId: 'A', waterSource: 'surface', volumeM3PerYear: 30_000 },
			// B: groundwater 3 650 m³ a year against 3 650 (100 %); its surface use has nothing registered.
			{ id: 'b', nodeId: 'B', waterSource: 'groundwater', volumeM3PerYear: 3650 }
			// C: nothing registered at all.
		]
	});

describe('comparisonUseRows', () => {
	it('draws each unit and source with a registered volume, in the list’s order, one mark per whole water year', () => {
		const c = comparison();
		const { rows, axisMax, clipped } = comparisonUseRows(c, unitRows(c));
		expect(rows.map((r) => r.label)).toEqual(['Farm A, surface water', 'Farm B, groundwater']);
		expect(rows.map((r) => [r.name, r.suffix])).toEqual([
			['Farm A', ', surface water'],
			['Farm B', ', groundwater']
		]);
		// The part year (30 days of 2003/04) is in the table, not the chart.
		expect(rows[0]!.marks.map((m) => [m.waterYear, m.run, Number(m.ratio.toFixed(3))])).toEqual([
			[2001, 'baseline', 1.217],
			[2002, 'baseline', 1.217]
		]);
		expect(rows[1]!.marks.map((m) => Number(m.ratio.toFixed(3)))).toEqual([1, 1]);
		expect(axisMax).toBe(USE_AXIS_MIN);
		expect(clipped).toBe(0);
	});

	it('follows the order it is given, and leaves out a unit–source it has no comparison for', () => {
		const c = comparison();
		const { rows } = comparisonUseRows(c, [
			{ nodeId: 'B', source: 'groundwater' },
			{ nodeId: 'Z', source: 'surface' },
			{ nodeId: 'A', source: 'surface' }
		]);
		expect(rows.map((r) => r.key)).toEqual(['B:groundwater', 'A:surface']);
	});

	it('has no rows when nothing is registered', () => {
		const c = compareAllocations({ startDate: '2001-10-01', nodes: [{ nodeId: 'A', name: 'A', kind: 'farm', supplied: new Array(400).fill(1) }], allocations: [] });
		expect(comparisonUseRows(c, unitRows(c)).rows).toEqual([]);
	});
});

describe('useAxis', () => {
	it('stretches to the largest ratio within [min, max] and flags the marks past it', () => {
		const raw = (ratios: number[]) => [{ key: 'k', label: 'k', name: 'k', suffix: '', marks: ratios.map((ratio, i) => ({ waterYear: 2000 + i, run: 'baseline' as const, ratio, over: ratio > 1.1 })) }];
		expect(useAxis(raw([0.4])).axisMax).toBe(USE_AXIS_MIN);
		expect(useAxis(raw([2.21])).axisMax).toBe(2.3);
		const far = useAxis(raw([0.9, 12]));
		expect(far.axisMax).toBe(USE_AXIS_MAX);
		expect(far.clipped).toBe(1);
		expect(far.rows[0]!.marks.map((m) => m.clipped)).toEqual([false, true]);
	});
});

describe('useSummary', () => {
	// A mark is "over" as the engine judged it; here, as allocationStatus would at a 10 % band, unless given.
	const row = (key: string, marks: ([number, 'baseline' | 'application'] | [number, 'baseline' | 'application', boolean])[]): UseRow => ({
		key,
		label: key,
		name: key,
		suffix: '',
		marks: marks.map(([ratio, run, over], i) => ({ waterYear: 2000 + i, run, ratio, clipped: false, over: over ?? ratio > 1.1 }))
	});

	it('counts the whole years above the band, and in how many rows', () => {
		const rows = [row('A', [[1.2, 'baseline'], [1.05, 'baseline']]), row('B', [[0.5, 'baseline'], [3.4, 'baseline']]), row('C', [[1, 'baseline']])];
		expect(useSummary(rows, 0.1, false)).toBe('2 of 5 whole water years are above the ±10 % band (over 110 % of the registered volume), in 2 of 3 units and water sources.');
		// The band's edge is within (the comparison's "above" is strictly over 100 % + the band).
		expect(useSummary([row('A', [[1.1, 'baseline']])], 0.1, false)).toBe('0 of 1 whole water year is above the ±10 % band (over 110 % of the registered volume).');
		expect(useSummary([row('A', [[1.2, 'baseline']])], 0.1, false)).toBe('1 of 1 whole water year is above the ±10 % band (over 110 % of the registered volume), in 1 of 1 unit and water source.');
	});

	it('says "above the registered volume" when no band is recorded', () => {
		expect(useSummary([row('A', [[1.05, 'baseline', true], [0.9, 'baseline', false]])], null, false)).toBe('1 of 2 whole water years is above the registered volume, in 1 of 1 unit and water source.');
	});

	it('counts the engine’s judgement, not its own arithmetic, at the band’s edge', () => {
		// 5.500000000000001 m³ against 5 m³ is above 5 × 1.1 for the engine, yet its ratio isn't above 1.1 in floating point.
		const modelled = 5.500000000000001;
		expect(modelled > 5 * 1.1).toBe(true);
		expect(modelled / 5 > 1.1).toBe(false);
		expect(useSummary([row('A', [[modelled / 5, 'baseline', true]])], 0.1, false)).toMatch(/^1 of 1 whole water year is above/);
		// Control: a year the engine calls within isn't counted.
		expect(useSummary([row('A', [[1.05, 'baseline', false]])], 0.1, false)).toMatch(/^0 of 1 whole water year is above/);
	});

	it('leaves rows with no mark out of "of N units" (a unit–source with no whole year)', () => {
		expect(useSummary([row('A', [[1.2, 'baseline']]), row('B', [])], 0.1, false)).toMatch(/, in 1 of 1 unit and water source\.$/);
	});

	it('counts each run of an application', () => {
		const rows = [row('A', [[0.9, 'baseline'], [1.3, 'application']]), row('B', [[1.3, 'baseline'], [1.4, 'application']])];
		expect(useSummary(rows, 0.1, true)).toBe(
			'Years above the ±10 % band (over 110 % of the registered volume): baseline 1 of 2 whole water years, in 1 of 2 units and water sources; application 2 of 2 whole water years, in 2 of 2 units and water sources.'
		);
	});
});
