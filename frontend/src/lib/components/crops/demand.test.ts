import type { ProjectModel } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { annualMm3, catchmentDemand, cropStacks, DAILY_APAN_NO_MEANS, demandApanNote, farmDemands, highCropFactors, joinNames, noPlantedAreaNote } from './demand';

const apan = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100];

describe('farmDemands', () => {
	const model: ProjectModel = {
		nodes: [],
		crops: [
			{ id: 'vines', name: 'Vines', cropFactor: new Array(12).fill(0.5) },
			{ id: 'veg', name: 'Veg', cropFactor: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }
		],
		cropAreas: [
			{ nodeId: 'f1', cropId: 'vines', areaM2: 100_000 },
			{ nodeId: 'f1', cropId: 'veg', areaM2: 31_000 },
			{ nodeId: 'f2', cropId: 'vines', areaM2: 50_000 }
		],
		transfers: []
	};

	it('computes gross m³/day per water-year month with the engine helper', () => {
		const [f1] = farmDemands(model, apan, 28.25, ['f1']);
		// Oct: (100 000 m² × 50 mm + 31 000 m² × 100 mm) / 1000 / 31 days
		expect(f1!.monthlyM3Day[0]).toBeCloseTo((100_000 * 50 + 31_000 * 100) / 1000 / 31, 9);
		// Nov: vines only, 30 days
		expect(f1!.monthlyM3Day[1]).toBeCloseTo((100_000 * 50) / 1000 / 30, 9);
		expect(f1!.areaHa).toBeCloseTo(13.1, 9);
	});

	it('sums a year into Mm³/a and a days-weighted mean', () => {
		const [, f2] = farmDemands(model, apan, 28.25, ['f1', 'f2']);
		// 50 000 m² × 50 mm × 12 months = 30 000 m³
		expect(f2!.annualMm3).toBeCloseTo(0.03, 9);
		expect(f2!.meanM3Day).toBeCloseTo(30_000 / 365.25, 6);
	});

	it('is zero for a farm without crops', () => {
		const [f] = farmDemands(model, apan, 28.25, ['nobody']);
		expect(f!.annualMm3).toBe(0);
		expect(f!.areaHa).toBe(0);
	});

	it('divides the requirement by the unit’s irrigation efficiency, as a run abstracts it (audit N1)', () => {
		const farm = (id: string, e: number) => ({ id, name: id, kind: 'farm', irrigationEfficiency: e }) as unknown as ProjectModel['nodes'][number];
		const withE: ProjectModel = { ...model, nodes: [farm('f1', 1), farm('f2', 0.8)] };
		const [f1, f2] = farmDemands(withE, apan, 28.25, ['f1', 'f2']);
		expect(f1!.efficiency).toBe(1);
		expect(f2!.efficiency).toBe(0.8);
		// 30 000 m³ a year of requirement ÷ 0.8: drip-like losses raise what the unit abstracts.
		expect(f2!.annualMm3).toBeCloseTo(0.03 / 0.8, 9);
		expect(f2!.monthlyM3Day[1]).toBeCloseTo((50_000 * 50) / 1000 / 30 / 0.8, 9);
		expect(f2!.byCrop.get('vines')![1]).toBeCloseTo(f2!.monthlyM3Day[1]!, 9);
		// A crop on its own system blends in, weighted by its requirement (the engine's farmIrrigationEfficiency).
		const own: ProjectModel = { ...withE, crops: withE.crops.map((c) => (c.id === 'veg' ? { ...c, irrigationEfficiency: 0.5 } : c)) };
		const [g1] = farmDemands(own, apan, 28.25, ['f1']);
		// f1: vines 100 000 m² × 600 mm a year at e = 1, veg 31 000 m² × 100 mm at e = 0.5.
		const w = [100_000 * 600, 31_000 * 100];
		expect(g1!.efficiency).toBeCloseTo((w[0]! + w[1]!) / (w[0]! / 1 + w[1]! / 0.5), 12);
		// A non-farm with crop areas abstracts its requirement (e = 1); an efficiency outside (0, 1] runs as 1.
		const odd: ProjectModel = { ...model, nodes: [{ ...farm('f1', 0.5), kind: 'gauge' } as ProjectModel['nodes'][number], farm('f2', 0)] };
		expect(farmDemands(odd, apan, 28.25, ['f1', 'f2']).map((f) => f.efficiency)).toEqual([1, 1]);
	});
});

describe('annualMm3', () => {
	it('weights by days per month (February = februaryDays)', () => {
		expect(annualMm3(new Array(12).fill(1_000_000), 28)).toBeCloseTo(365, 9);
	});
});

describe('highCropFactors', () => {
	const months = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];

	it('names each crop with a factor above 1.0 and the months it happens in', () => {
		const crops = [
			{ id: 'a', name: 'Lucerne', cropFactor: [1.2, 1, 0.9, 1.05, 0, 0, 0, 0, 0, 0, 0, 0] },
			{ id: 'b', name: 'Vines', cropFactor: new Array(12).fill(0.6) }
		];
		expect(highCropFactors(crops, months)).toEqual([{ id: 'a', name: 'Lucerne', months: ['Oct', 'Jan'] }]);
	});

	it('lets exactly 1.0 pass: a pan factor of 1 is high but plausible', () => {
		expect(highCropFactors([{ id: 'a', name: 'X', cropFactor: new Array(12).fill(1) }], months)).toEqual([]);
	});
});

describe('catchmentDemand and cropStacks', () => {
	// Seven crops with uneven factors and apan, over three farms (one unplanted).
	const apanVaried = [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110];
	const crops = Array.from({ length: 7 }, (_, i) => ({
		id: `c${i}`,
		name: `Crop ${i}`,
		cropFactor: Array.from({ length: 12 }, (_, m) => ((i + m) % 5) * 0.2)
	}));
	const model: ProjectModel = {
		nodes: [],
		crops,
		cropAreas: [
			...crops.map((c, i) => ({ nodeId: 'f1', cropId: c.id, areaM2: 10_000 * (i + 1) })),
			...crops.slice(0, 3).map((c, i) => ({ nodeId: 'f2', cropId: c.id, areaM2: 7_500 * (i + 2) }))
		],
		transfers: []
	};
	const demand = farmDemands(model, apanVaried, 28.25, ['f1', 'f2', 'f3']);
	const totals = catchmentDemand(demand);
	const sumOf = (stacks: { values: number[] }[]) => Array.from({ length: 12 }, (_, m) => stacks.reduce((s, x) => s + x.values[m]!, 0));

	it('splits each farm by crop into parts that sum to its monthly demand', () => {
		for (const d of demand) {
			const parts = [...d.byCrop.values()];
			sumOf(parts.map((values) => ({ values }))).forEach((v, m) => expect(v).toBeCloseTo(d.monthlyM3Day[m]!, 9));
		}
		expect(demand[2]!.byCrop.size).toBe(0);
	});

	it('totals the farms like the table footer', () => {
		totals.monthly.forEach((v, m) => expect(v).toBeCloseTo(demand.reduce((s, d) => s + d.monthlyM3Day[m]!, 0), 9));
		expect(totals.annual).toBeCloseTo(annualMm3(totals.monthly), 9);
		expect(totals.mean).toBeCloseTo((totals.annual * 1e6) / 365.25, 6);
	});

	it('stacks every crop in crop order without a named set, and the stacks sum to the table totals', () => {
		const stacks = cropStacks(demand, crops);
		expect(stacks.map((s) => s.id)).toEqual(crops.map((c) => c.id));
		sumOf(stacks).forEach((v, m) => expect(v).toBeCloseTo(totals.monthly[m]!, 9));
	});

	it('stacks the named crops in the order given, bottom first, and sums the rest as "Other", still summing to the totals', () => {
		const named = ['c6', 'c2', 'c0', 'c4', 'c5'];
		const stacks = cropStacks(demand, crops, named);
		expect(stacks.map((s) => s.id)).toEqual([...named, 'other']);
		expect(stacks[5]!.name).toBe('Other (2 crops)');
		sumOf(stacks).forEach((v, m) => expect(v).toBeCloseTo(totals.monthly[m]!, 9));
		// One crop left over is still "Other" (it has no colour of its own), in the singular.
		expect(cropStacks(demand, crops, crops.slice(0, 6).map((c) => c.id)).at(-1)!.name).toBe('Other (1 crop)');
		// Every crop named: no "Other".
		expect(cropStacks(demand, crops, crops.map((c) => c.id)).some((s) => s.id === 'other')).toBe(false);
	});

	it('leaves out crops with no demand', () => {
		const m2: ProjectModel = { ...model, cropAreas: model.cropAreas.filter((a) => a.cropId === 'c1') };
		expect(cropStacks(farmDemands(m2, apanVaried, 28.25, ['f1']), crops).map((s) => s.id)).toEqual(['c1']);
		expect(cropStacks(farmDemands(m2, new Array(12).fill(0), 28.25, ['f1']), crops)).toEqual([]);
	});
});

describe('joinNames', () => {
	it('joins with commas and a final "and"', () => {
		expect(joinNames([])).toBe('');
		expect(joinNames(['A'])).toBe('A');
		expect(joinNames(['A', 'B'])).toBe('A and B');
		expect(joinNames(['A', 'B', 'C'])).toBe('A, B and C');
	});
});

describe('noPlantedAreaNote', () => {
	it('is null when every farm is planted', () => {
		expect(noPlantedAreaNote([])).toBeNull();
	});

	it('uses the singular for one farm', () => {
		expect(noPlantedAreaNote(['Farm 5'])).toBe('Farm 5 has no planted area, so its irrigation demand counts as zero.');
	});

	it('uses the plural and a joined list for several', () => {
		expect(noPlantedAreaNote(['Farm 5', 'Farm 6', 'Farm 8'])).toBe(
			'Farm 5, Farm 6 and Farm 8 have no planted area, so their irrigation demand counts as zero.'
		);
	});

	it('names at most five, then "and N more"', () => {
		const names = Array.from({ length: 8 }, (_, i) => `F${i + 1}`);
		expect(noPlantedAreaNote(names)).toBe(
			'F1, F2, F3, F4, F5 and 3 more have no planted area, so their irrigation demand counts as zero.'
		);
		expect(noPlantedAreaNote(names.slice(0, 5))).toBe(
			'F1, F2, F3, F4 and F5 have no planted area, so their irrigation demand counts as zero.'
		);
	});
});

describe('demandApanNote (issue #173)', () => {
	it('says the chart shows the monthly means only when a daily A-pan series exists, which runs use instead', () => {
		expect(demandApanNote(false)).toBeNull();
		expect(demandApanNote(true)).toMatch(/^Shows the monthly A-pan means\. Runs use the daily A-pan series/);
	});

	it('the alert with no monthly means but a daily series says runs still take the series', () => {
		expect(DAILY_APAN_NO_MEANS).toMatch(/^The monthly A-pan means aren't set, so this preview shows no demand\. Runs use the daily A-pan series/);
	});
});
