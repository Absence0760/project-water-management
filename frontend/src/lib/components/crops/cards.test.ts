import { describe, expect, it } from 'vitest';
import { WATER_YEAR_MONTHS } from '$lib/format/months';
import { cropCards, cropColours, cropsSummary, farmBarLabel, farmBars, OTHER_COLOUR, SPARK_W } from './cards';

const P = ['a', 'b', 'c'];
const stack = (id: string) => ({ id, name: id, values: new Array(12).fill(1) });
const ha = (m2: number) => (m2 / 10_000).toFixed(1);

describe('cropColours', () => {
	it('gives a crop its chart part colour, and crops with no demand the next unused ones', () => {
		const crops = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
		const c = cropColours(crops, [stack('y')], P);
		expect(c.get('y')).toBe('a');
		expect(c.get('x')).toBe('b');
		expect(c.get('z')).toBe('c');
	});

	it('greys crops grouped into Other, and runs out of colours into grey', () => {
		const grouped = cropColours([{ id: 'x' }, { id: 'y' }, { id: 'z' }], [stack('x'), stack('other')], P);
		expect(grouped.get('x')).toBe('a');
		expect(grouped.get('y')).toBe(OTHER_COLOUR);
		const many = cropColours([{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }], [], P);
		expect([...many.values()]).toEqual(['a', 'b', 'c', OTHER_COLOUR]);
	});
});

describe('cropCards', () => {
	const factors = [0.5, 0.6, 0.8, 1.2, 0.8, 0.6, 0.4, 0, 0, 0, 0.2, 0.4];
	const crops = [
		{ id: 'c1', name: 'Orchard', cropFactor: factors },
		{ id: 'c2', name: '', cropFactor: new Array(12).fill(0) }
	];
	const areas = [
		{ nodeId: 'f1', cropId: 'c1', areaM2: 200_000 },
		{ nodeId: 'f2', cropId: 'c1', areaM2: 100_000 },
		{ nodeId: 'gone', cropId: 'c1', areaM2: 999_999 }
	];

	it('sums the area on the farms shown and finds the peak need month', () => {
		const [orchard, blank] = cropCards(crops, areas, ['f1', 'f2'], new Array(12).fill(0), WATER_YEAR_MONTHS);
		expect(orchard!.areaM2).toBe(300_000);
		expect(WATER_YEAR_MONTHS[orchard!.peak]).toBe('Jan'); // highest factor while A-pan is unset
		expect(orchard!.high).toEqual(['Jan']);
		expect(orchard!.label).toBe('Orchard crop factor by month, October to September: 0.00 to 1.20, highest in Jan');
		expect(blank!.name).toBe('(unnamed)');
		expect(blank!.peak).toBe(-1);
		expect(blank!.label).toBe('(unnamed) crop factor by month: 0 in every month');
	});

	it('weights the peak by A-pan once it is set', () => {
		const apan = [100, 100, 300, 100, 100, 100, 100, 100, 100, 100, 100, 100];
		const [orchard] = cropCards(crops, areas, ['f1'], apan, WATER_YEAR_MONTHS);
		expect(WATER_YEAR_MONTHS[orchard!.peak]).toBe('Dec'); // 0.8 × 300 beats 1.2 × 100
	});

	it('draws 12 points across the box, the highest factor at the top', () => {
		const [orchard] = cropCards(crops, areas, ['f1'], [], WATER_YEAR_MONTHS);
		const pts = orchard!.line.split(' ').map((p) => p.split(',').map(Number));
		expect(pts).toHaveLength(12);
		expect(pts[0]![0]).toBe(0);
		expect(pts[11]![0]).toBe(SPARK_W);
		expect(Math.min(...pts.map((p) => p[1]!))).toBe(pts[3]![1]); // Jan, 1.2
		expect(orchard!.fill.startsWith('M0,')).toBe(true);
		expect(orchard!.fill.endsWith('Z')).toBe(true);
	});
});

describe('farmBars', () => {
	const farms = [
		{ id: 'f1', name: 'Upper farm' },
		{ id: 'f2', name: 'Lower farm' },
		{ id: 'f3', name: '' }
	];
	const crops = [
		{ id: 'c1', name: 'Orchard' },
		{ id: 'c2', name: 'Vines' }
	];
	const areas = [
		{ nodeId: 'f1', cropId: 'c1', areaM2: 200_000 },
		{ nodeId: 'f1', cropId: 'c2', areaM2: 100_000 },
		{ nodeId: 'f2', cropId: 'c2', areaM2: 150_000 }
	];

	it('stacks each planted farm by crop, scaled to the widest farm, and leaves out farms with nothing planted', () => {
		const bars = farmBars(farms, crops, areas);
		expect(bars.map((b) => b.name)).toEqual(['Upper farm', 'Lower farm']);
		expect(bars[0]!.totalM2).toBe(300_000);
		expect(bars[0]!.parts.map((p) => [p.name, Math.round(p.pct)])).toEqual([
			['Orchard', 67],
			['Vines', 33]
		]);
		expect(bars[1]!.parts.map((p) => Math.round(p.pct))).toEqual([50]);
		expect(farmBarLabel(bars[0]!, ha)).toBe('Upper farm: 30.0 ha, Orchard 20.0 ha and Vines 10.0 ha');
	});

	it('is empty with nothing planted', () => {
		expect(farmBars(farms, crops, [])).toEqual([]);
	});
});

describe('cropsSummary', () => {
	it('reads as one line', () => {
		expect(cropsSummary(4, 3_125_000, 6, ha)).toBe('4 crops · 312.5 ha irrigated on 6 farms · water year October to September');
		expect(cropsSummary(1, 0, 0, ha)).toBe('1 crop · nothing planted yet · water year October to September');
		expect(cropsSummary(1, 200_000, 1, ha)).toBe('1 crop · 20.0 ha irrigated on 1 farm · water year October to September');
	});
});
