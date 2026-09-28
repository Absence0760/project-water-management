import { describe, expect, it } from 'vitest';
import { DAM_AGO_DAYS, DAM_YEAR_DAYS, damFigures } from './damLevel';

// 1 000 m³ dam with a 10 % minimum operating level (NetworkNode.damMinPct is a fraction).
const fig = (values: (number | null)[], startDate = '2025-01-01', minFrac = 0.1, cap = 1000) => damFigures(values, cap, minFrac, startDate);

describe('damFigures', () => {
	it('takes the last day with a value as the end, and the lowest day of the last year', () => {
		expect(fig([900, 500, 250, 400, 600, null])).toEqual({
			damEndM3: 600,
			damAgoM3: null,
			damLowM3: 250,
			damLowDate: '2025-01-03',
			damDaysAtMin: 0
		});
	});

	it('looks back one year from the end only, and gives the first day of the lowest stretch', () => {
		const f = fig([0, ...Array(DAM_YEAR_DAYS).fill(800)], '2024-01-01')!;
		expect(f.damLowM3).toBe(800);
		expect(f.damLowDate).toBe('2024-01-02');
	});

	it('counts the days at or below the minimum level (with a float tolerance), none without one', () => {
		expect(fig([100, 100.0000001, 99, 150, 100], '2025-06-01')!.damDaysAtMin).toBe(4);
		expect(fig([0, 0], '2025-06-01', 0)!.damDaysAtMin).toBe(0);
	});

	it('reads the storage DAM_AGO_DAYS before the end, null when the run is shorter or has no value then', () => {
		expect(fig([...Array(DAM_AGO_DAYS).fill(0), 700, ...Array(DAM_AGO_DAYS - 1).fill(500), 400, null])!.damAgoM3).toBe(700);
		expect(fig(Array(DAM_AGO_DAYS).fill(500))!.damAgoM3).toBeNull();
		expect(fig([null, ...Array(DAM_AGO_DAYS).fill(500)])!.damAgoM3).toBeNull();
	});

	it('is null without capacity or without any finite value', () => {
		expect(fig([1], '2025-01-01', 0.1, 0)).toBeNull();
		expect(fig([null, Number.NaN])).toBeNull();
		expect(fig([])).toBeNull();
	});

	it('takes a Float64Array (the simulation storage)', () => {
		expect(damFigures(Float64Array.from([300, 200, 400]), 1000, 0.2, '2025-01-01')).toMatchObject({ damLowM3: 200, damDaysAtMin: 1 });
	});
});
