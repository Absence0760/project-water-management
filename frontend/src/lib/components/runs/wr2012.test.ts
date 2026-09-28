import type { Wr2012Report } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { describeScaling, monthsText, ratioText, yearsText } from './wr2012';

const scaling = (over: Partial<Wr2012Report['scaling']> = {}) =>
	({
		scaling: {
			rule: 'area',
			requested: 'area',
			factor: 0.25,
			areaFactor: 0.25,
			rainFactor: null,
			modelAreaKm2: 10,
			referenceAreaKm2: 40,
			modelMapMm: null,
			referenceMapMm: null,
			...over
		}
	}) as Wr2012Report;

describe('WR2012 run report helpers', () => {
	it('ratioText shows the deviation from 1 with its sign', () => {
		expect(ratioText(1.3)).toBe('1.30 (+30 %)');
		expect(ratioText(0.6)).toBe('0.60 (−40 %)');
		expect(ratioText(1)).toBe('1.00 (±0 %)');
		expect(ratioText(null)).toBe('–');
	});

	it('describeScaling names the rule and the factor', () => {
		expect(describeScaling(scaling())).toBe('Area ratio: 10 km² ÷ 40 km² = 0.25');
		expect(
			describeScaling(scaling({ rule: 'areaRain', requested: 'areaRain', rainFactor: 1.1, factor: 0.275, modelMapMm: 660, referenceMapMm: 600 }))
		).toBe('Area and rainfall ratio: (10 km² ÷ 40 km²) × (660 mm ÷ 600 mm) = 0.275');
		expect(describeScaling(scaling({ requested: 'areaRain' }))).toMatch(/rainfall ratio was asked for but the data for it is missing/);
	});

	it('yearsText and monthsText', () => {
		expect(yearsText([2001, 2002, 2003])).toBe('2001/02 – 2003/04 (3 water years)');
		expect(yearsText([1999])).toBe('1999/00 (1 water year)');
		expect(monthsText([1, 2, 12])).toBe('Dec, Jan, Feb');
	});
});
