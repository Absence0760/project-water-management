import { describe, expect, it } from 'vitest';
import { damLevel, levelBand, LOW_PCT, sortDamLevels, YEAR_DAYS, type DamLevel } from './damLevels';

const dam = { nodeId: 'f1', name: 'Upper farm', capacityM3: 1000, minPct: 10 };
const series = (startDate: string, values: (number | null)[]) => ({ startDate, values });

describe('damLevel', () => {
	it('takes the last day with a value as the end, and the lowest day of the last year', () => {
		const l = damLevel(dam, series('2025-01-01', [900, 500, 250, 400, 600, null]));
		expect(l).toEqual({
			nodeId: 'f1',
			name: 'Upper farm',
			capacityM3: 1000,
			minPct: 10,
			endPct: 60,
			endDate: '2025-01-05',
			lowPct: 25,
			lowDate: '2025-01-03',
			daysAtMin: 0
		});
	});

	it('looks back one year from the end only: an older low does not count', () => {
		const values = [0, ...Array(YEAR_DAYS).fill(800)];
		const l = damLevel(dam, series('2024-01-01', values))!;
		expect(l.lowPct).toBe(80);
		expect(l.endDate).toBe('2024-12-31'); // index 365 of a leap year
		// The first day of the lowest stretch.
		expect(l.lowDate).toBe('2024-01-02');
	});

	it('counts the days at or below the minimum level in that year', () => {
		const l = damLevel(dam, series('2025-06-01', [100, 100.0000001, 99, 150, 100]))!;
		expect(l.daysAtMin).toBe(4);
		expect(damLevel({ ...dam, minPct: 0 }, series('2025-06-01', [0, 0]))!.daysAtMin).toBe(0);
	});

	it('is null without capacity or without any finite value', () => {
		expect(damLevel({ ...dam, capacityM3: 0 }, series('2025-01-01', [1]))).toBeNull();
		expect(damLevel(dam, series('2025-01-01', [null, Number.NaN]))).toBeNull();
		expect(damLevel(dam, series('2025-01-01', []))).toBeNull();
	});
});

describe('sortDamLevels and levelBand', () => {
	const l = (name: string, endPct: number, minPct = 0): DamLevel =>
		({ nodeId: name, name, capacityM3: 1, minPct, endPct, endDate: '', lowPct: 0, lowDate: '', daysAtMin: 0 });

	it('puts the emptiest dam first, then by name', () => {
		expect(sortDamLevels([l('B', 50), l('A', 50), l('C', 5)]).map((x) => x.name)).toEqual(['C', 'A', 'B']);
	});

	it('bands a dam at its minimum, below the low line, or fine', () => {
		expect(levelBand(l('x', 10, 10))).toBe('at-min');
		expect(levelBand(l('x', LOW_PCT - 1, 10))).toBe('low');
		expect(levelBand(l('x', LOW_PCT, 10))).toBe('ok');
		expect(levelBand(l('x', 0))).toBe('low');
	});
});
