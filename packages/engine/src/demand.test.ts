import { describe, expect, it } from 'vitest';
import type { Monthly } from './calendar';
import { grossCropMm, grossFarmDemandM3PerDay, netDailyDemandM3 } from './demand';

const flat = (v: number) => new Array(12).fill(v) as unknown as Monthly;

describe('grossFarmDemandM3PerDay', () => {
	it('sums crop area × A-pan × crop factor and spreads over the month', () => {
		const crops = [
			{ id: 'a', name: 'Citrus', cropFactor: flat(0.5) },
			{ id: 'b', name: 'Pears', cropFactor: flat(1) }
		];
		const areas = new Map([
			['a', 10_000],
			['b', 20_000]
		]);
		const out = grossFarmDemandM3PerDay(flat(100), crops, areas);
		// Oct (31 days): (10000·50 + 20000·100)/1000 = 2500 m³ → /31
		expect(out[0]).toBeCloseTo(2500 / 31, 10);
		// Feb uses 28.25 days
		expect(out[4]).toBeCloseTo(2500 / 28.25, 10);
	});

	it('ignores crops with no planted area', () => {
		const out = grossFarmDemandM3PerDay(flat(100), [{ id: 'x', name: 'X', cropFactor: flat(1) }], new Map());
		expect(out.every((v) => v === 0)).toBe(true);
	});
});

describe('netDailyDemandM3', () => {
	it('subtracts effective rainfall on the cropped area and floors at zero', () => {
		expect(netDailyDemandM3(1000, 100_000, 5, 0.65)).toBeCloseTo(1000 - 325, 10);
		expect(netDailyDemandM3(100, 100_000, 50, 0.65)).toBe(0);
	});
});

describe('b023 rounding precisions', () => {
	it('rounds gross crop mm and farm m³/day like [Crop demand] / [Farm demand]', () => {
		// client catchment Farm A, October: A-pan 128.736… × factor 0.7 = 90.115… → 90.12 mm;
		// (207 000 + 183 300) m² × 90.12 / 1000 / 31 = 1134.64… → 1134.6 m³/day.
		const apan = flat(128.73636363636365);
		const crops = [
			{ id: 'o', name: 'Onions', cropFactor: flat(0.7) },
			{ id: 'p', name: 'Pasture', cropFactor: flat(0.7) }
		];
		const areas = new Map([
			['o', 207_000],
			['p', 183_300]
		]);
		expect(grossCropMm(apan, crops[0]!, 2)[0]).toBe(90.12);
		expect(grossFarmDemandM3PerDay(apan, crops, areas, 28.25, { cropMm: 2, farmM3Day: 1 })[0]).toBe(1134.6);
	});

	it('rounds the net daily demand to whole m³, half away from zero', () => {
		expect(netDailyDemandM3(100.5, 0, 0, 0.65, 0)).toBe(101);
		expect(netDailyDemandM3(1134.6, 390_300, 3, 0.65, 0)).toBe(374); // 1134.6 − 761.085 = 373.515
	});
});
