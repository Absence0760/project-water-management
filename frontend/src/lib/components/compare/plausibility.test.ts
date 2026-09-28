import type { PlausibilityComparison, PlausibilityMetric, PlausibilitySiteDelta } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { plausibilityRows, waterYear } from './plausibility';

const m = (a: number | null, b: number | null): PlausibilityMetric => ({ a, b, delta: a !== null && b !== null ? b - a : null });

function site(over: Partial<PlausibilitySiteDelta> = {}): PlausibilitySiteDelta {
	return {
		name: 'Outlet',
		nameA: null,
		isOutlet: true,
		nodeId: null,
		onlyIn: null,
		naturalised: {
			flowKindA: 'flow_observed_m3s',
			flowKindB: 'flow_observed_m3s',
			judgedYears: m(3, 3),
			failedA: [2001, 2002],
			failedB: [2002, 2003],
			newlyFailing: [2003],
			nowPassing: [2001],
			passedA: false,
			passedB: false
		},
		lowFlow: {
			flowKindA: 'flow_observed_m3s',
			flowKindB: 'flow_observed_m3s',
			days: m(900, 900),
			observedQ90M3s: m(0.1, 0.1),
			simulatedQ90M3s: m(0.03, 0.09),
			ratio: m(0.3, 0.9),
			withinA: false,
			withinB: true
		},
		...over
	};
}

describe('plausibilityRows', () => {
	it('gives each site’s failing years and Q90 ratio side by side, with what changed', () => {
		const c: PlausibilityComparison = { sites: [site()], rainSource: null, flowDoubleMass: null };
		expect(plausibilityRows(c)).toEqual([
			{
				key: 'outlet|nat',
				site: 'Outlet',
				check: 'Natural ≥ observed + abstraction',
				a: 'fails 2001/02, 2002/03: 2 of 3 (gauge)',
				b: 'fails 2002/03, 2003/04: 2 of 3 (gauge)',
				okA: false,
				okB: false,
				change: 'newly fails 2003/04; now passes 2001/02'
			},
			{
				key: 'outlet|q90',
				site: 'Outlet',
				check: 'Dry-season Q90, simulated ÷ observed',
				a: '0.30× (outside the factor of 2)',
				b: '0.90× (within the factor of 2)',
				okA: false,
				okB: true,
				change: '+0.60×'
			}
		]);
	});

	it('names a gauge (and its old name), says what a side didn’t check, and passes with no failing year', () => {
		const gauge = site({
			name: 'Upper weir',
			nameA: 'Weir 1',
			isOutlet: false,
			nodeId: 'g1',
			naturalised: { ...site().naturalised!, flowKindA: null, failedA: null, judgedYears: m(null, 2), failedB: [], newlyFailing: [], nowPassing: [], passedA: null, passedB: true },
			lowFlow: null
		});
		const rows = plausibilityRows({ sites: [gauge], rainSource: null, flowDoubleMass: null });
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ key: 'g1|nat', site: 'Upper weir (was Weir 1)', a: 'not checked', b: 'passes all 2 (gauge)', okA: null, okB: true, change: '–' });
	});

	it('adds the catchment-wide rain-source split and double-mass breaks', () => {
		const rows = plausibilityRows({
			sites: [],
			rainSource: {
				goodYears: m(8, 7),
				fallbackYears: m(2, 3),
				goodFractionNotMet: m(0.1, 0.1),
				fallbackFractionNotMet: m(0.15, 0.3),
				warnsA: false,
				warnsB: true,
				fallbackWaterYearsA: [2001, 2002],
				fallbackWaterYearsB: [2001, 2002, 2003]
			},
			flowDoubleMass: {
				flowKindA: 'flow_observed_m3s',
				flowKindB: 'flow_observed_m3s',
				wholeSlope: m(0.1, 0.12),
				breaksA: [{ afterWaterYear: 2005, change: -0.25, unexplained: -0.2, hint: 'newUse' }],
				breaksB: []
			}
		});
		expect(rows.map((r) => [r.site, r.check, r.a, r.b, r.okA, r.okB, r.change])).toEqual([
			[
				'Catchment',
				'EWR days by rain source',
				'15% of days not met in 2 fallback-rain years, 10% in good-rain years',
				'30% of days not met in 3 fallback-rain years, 10% in good-rain years (warns)',
				true,
				false,
				'+1 fallback-rain years'
			],
			['Catchment', 'Observed flow vs rain (double mass)', 'after 2005/06 (−25 %, new use)', 'no break the model doesn’t share', false, true, 'runoff ratio +0.020']
		]);
	});

	it('writes water years as the hydrological year', () => {
		expect(waterYear(1999)).toBe('1999/00');
		expect(waterYear(2009)).toBe('2009/10');
	});
});
