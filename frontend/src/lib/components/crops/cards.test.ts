import { describe, expect, it } from 'vitest';
import { WATER_YEAR_MONTHS } from '$lib/format/months';
import {
	CROP_PALETTE,
	cropAreaTotals,
	cropColouring,
	cropRows,
	cropsSummary,
	farmBarLabel,
	farmBars,
	OTHER_COLOUR,
	otherLabel,
	rankCrops
} from './cards';

const ha = (m2: number) => (m2 / 10_000).toFixed(1);

describe('cropAreaTotals and rankCrops', () => {
	const areas = [
		{ nodeId: 'f1', cropId: 'small', areaM2: 2_000 },
		{ nodeId: 'f1', cropId: 'big', areaM2: 1_000_000 },
		{ nodeId: 'f2', cropId: 'big', areaM2: 500_000 },
		{ nodeId: 'f2', cropId: 'mid', areaM2: 90_000 },
		{ nodeId: 'gone', cropId: 'small', areaM2: 9_999_999 }
	];

	it('sums each crop over the units shown only', () => {
		const t = cropAreaTotals(areas, ['f1', 'f2']);
		expect(t.get('big')).toBe(1_500_000);
		expect(t.get('small')).toBe(2_000);
		expect(t.has('none')).toBe(false);
	});

	it('ranks by planted area, largest first; equal areas (unplanted too) keep crop order', () => {
		const crops = [{ id: 'none' }, { id: 'small' }, { id: 'none2' }, { id: 'big' }, { id: 'mid' }];
		const ranked = rankCrops(crops, cropAreaTotals(areas, ['f1', 'f2'])).map((c) => c.id);
		expect(ranked).toEqual(['big', 'mid', 'small', 'none', 'none2']);
		// Stable: the same inputs give the same order, whatever the order of the areas.
		expect(rankCrops(crops, cropAreaTotals([...areas].reverse(), ['f1', 'f2'])).map((c) => c.id)).toEqual(ranked);
	});
});

describe('cropColouring', () => {
	const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}` }));

	it('gives every crop its own colour while they fit, in rank order, and groups nothing', () => {
		const c = cropColouring(ids(3));
		expect([...c.colours.values()]).toEqual(CROP_PALETTE.slice(0, 3));
		expect(c.named).toEqual(['c0', 'c1', 'c2']);
		expect(c.other).toEqual([]);
		// Exactly the palette's length still fits.
		expect(cropColouring(ids(CROP_PALETTE.length)).other).toEqual([]);
	});

	it('names the top crops (one per palette colour) and groups the rest as Other', () => {
		const c = cropColouring(ids(30));
		expect(c.named).toEqual(ids(CROP_PALETTE.length).map((x) => x.id));
		expect(c.other).toHaveLength(30 - CROP_PALETTE.length);
		expect(c.other[0]).toBe(`c${CROP_PALETTE.length}`);
		for (const id of c.other) expect(c.colours.get(id)).toBe(OTHER_COLOUR);
	});

	it('never gives two named crops the same colour, nor Other’s', () => {
		const c = cropColouring(ids(30));
		const named = c.named.map((id) => c.colours.get(id));
		expect(new Set(named).size).toBe(named.length);
		expect(named).not.toContain(OTHER_COLOUR);
		expect(new Set(CROP_PALETTE).size).toBe(CROP_PALETTE.length);
		expect(CROP_PALETTE.length).toBeGreaterThanOrEqual(8);
	});

	it('follows the ranking: the largest crop takes the first colour wherever it sits in crop order', () => {
		const crops = [
			{ id: 'tiny', name: 'Tiny', cropFactor: [] },
			{ id: 'huge', name: 'Huge', cropFactor: [] }
		];
		const areas = [
			{ nodeId: 'f', cropId: 'tiny', areaM2: 10 },
			{ nodeId: 'f', cropId: 'huge', areaM2: 1e6 }
		];
		const c = cropColouring(rankCrops(crops, cropAreaTotals(areas, ['f'])));
		expect(c.colours.get('huge')).toBe(CROP_PALETTE[0]);
		expect(c.colours.get('tiny')).toBe(CROP_PALETTE[1]);
	});

	it('uses theme tokens only (they carry the light and dark steps)', () => {
		for (const p of CROP_PALETTE) expect(p).toMatch(/^var\(--series-\d+\)$/);
	});
});

describe('otherLabel', () => {
	it('names the group’s members', () => {
		expect(otherLabel(['Maize', 'Lucerne', 'Wheat'])).toBe('Other: Maize, Lucerne and Wheat');
		expect(otherLabel(['Maize'])).toBe('Other: Maize');
	});
});

describe('cropRows', () => {
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

	it('takes the area on the units shown and finds the peak need month', () => {
		const [orchard, blank] = cropRows(crops, cropAreaTotals(areas, ['f1', 'f2']), new Array(12).fill(0), WATER_YEAR_MONTHS);
		expect(orchard!.areaM2).toBe(300_000);
		expect(WATER_YEAR_MONTHS[orchard!.peak]).toBe('Jan'); // highest factor while A-pan is unset
		expect(orchard!.high).toEqual(['Jan']);
		expect(orchard!.factors).toEqual(factors);
		expect(orchard!.top).toBe(1.2); // above 1.0, so the sparkline's top is the highest factor
		expect(blank!.name).toBe('(unnamed)');
		expect(blank!.peak).toBe(-1);
		expect(blank!.factors).toEqual(new Array(12).fill(0));
		expect(blank!.top).toBe(1);
	});

	it('weights the peak by A-pan once it is set', () => {
		const apan = [100, 100, 300, 100, 100, 100, 100, 100, 100, 100, 100, 100];
		const [orchard] = cropRows(crops, cropAreaTotals(areas, ['f1']), apan, WATER_YEAR_MONTHS);
		expect(WATER_YEAR_MONTHS[orchard!.peak]).toBe('Dec'); // 0.8 × 300 beats 1.2 × 100
	});

	it('keeps 12 factors, a missing or negative one as 0, and tops the sparkline at 1.0 unless a factor is higher', () => {
		const [c] = cropRows([{ id: 'c', name: 'Short', cropFactor: [0.4, -0.2, 0.9] }], new Map(), [], WATER_YEAR_MONTHS);
		expect(c!.factors).toEqual([0.4, 0, 0.9, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
		expect(c!.top).toBe(1);
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

	it('stacks each planted unit by crop, scaled to the widest, and leaves out units with nothing planted', () => {
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

	it('puts the largest unit first (equal totals keep unit order) and stacks parts in the crops’ order', () => {
		const more = [...areas, { nodeId: 'f3', cropId: 'c1', areaM2: 400_000 }, { nodeId: 'f3', cropId: 'c2', areaM2: 50_000 }];
		const bars = farmBars(farms, [crops[1]!, crops[0]!], more);
		expect(bars.map((b) => b.id)).toEqual(['f3', 'f1', 'f2']);
		expect(bars[0]!.parts.map((p) => p.cropId)).toEqual(['c2', 'c1']);
		expect(bars[0]!.parts.reduce((s, p) => s + p.pct, 0)).toBeCloseTo(100, 9);
		const tie = farmBars(farms, crops, [
			{ nodeId: 'f2', cropId: 'c1', areaM2: 10 },
			{ nodeId: 'f1', cropId: 'c1', areaM2: 10 }
		]);
		expect(tie.map((b) => b.id)).toEqual(['f1', 'f2']);
	});

	it('is empty with nothing planted', () => {
		expect(farmBars(farms, crops, [])).toEqual([]);
	});
});

describe('cropsSummary', () => {
	it('reads as one line', () => {
		expect(cropsSummary(4, 3_125_000, 6, ha)).toBe('4 crops · 312.5 ha irrigated on 6 hydrological units · water year October to September');
		expect(cropsSummary(1, 0, 0, ha)).toBe('1 crop · nothing planted yet · water year October to September');
		expect(cropsSummary(1, 200_000, 1, ha)).toBe('1 crop · 20.0 ha irrigated on 1 hydrological unit · water year October to September');
	});
});
