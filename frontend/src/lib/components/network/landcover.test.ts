import { describe, expect, it } from 'vitest';
import { classDefaults, coverShare } from './landcover';

describe('land cover in the Network tab (WP-1.35)', () => {
	it('gives each class its indicative reductions', () => {
		expect(classDefaults('pine')).toEqual({ mar: 0.4, lowFlow: 0.55 });
		expect(classDefaults('other')).toEqual({ mar: 0, lowFlow: 0 });
	});

	it('works out the condensed share of the farm', () => {
		const p = (areaKm2: number, densityPct: number) => ({ id: 'x', nodeId: 'a', coverClass: 'pine' as const, areaKm2, densityPct, factors: null });
		expect(coverShare({ areaKm2: 10 }, [p(4, 0.5), p(1, 1)])).toBeCloseTo(0.3, 12);
		expect(coverShare({ areaKm2: 0 }, [p(4, 0.5)])).toBe(0);
	});
});
