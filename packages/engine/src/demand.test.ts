import { describe, expect, it } from 'vitest';
import type { Monthly } from './calendar';
import { grossFarmDemandM3PerDay, netDailyDemandM3 } from './demand';

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
