import type { ProjectModel } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { annualMm3, farmDemands, highCropFactors } from './demand';

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
