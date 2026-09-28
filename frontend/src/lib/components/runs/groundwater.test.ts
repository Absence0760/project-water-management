import type { GroundwaterAnnualUse } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { aboveGa, groundwaterByNode } from './groundwater';

const year = (nodeId: string, waterYear: number, days: number, abstractionM3: number, capReached = false): GroundwaterAnnualUse => ({
	nodeId,
	name: `Farm ${nodeId}`,
	kind: 'farm',
	waterYear,
	label: `${waterYear}/${String((waterYear + 1) % 100).padStart(2, '0')}`,
	days,
	abstractionM3,
	toDamM3: 0,
	streamDepletionM3: 0,
	annualCapM3: null,
	gaLimitM3: 40_000,
	boreholes: [{ id: 'b', name: 'BH', abstractionM3, annualCapM3: capReached ? abstractionM3 : null, capReached }]
});

describe('groundwaterByNode (WP-3.9)', () => {
	it('groups the run’s rows by node and weighs partial years by their length', () => {
		const out = groundwaterByNode([year('a', 2003, 183, 10_000), year('a', 2004, 365, 45_000, true), year('b', 2003, 548, 3000)]);
		expect(out.map((n) => n.nodeId)).toEqual(['a', 'b']);
		const a = out[0]!;
		expect(a.meanM3Year).toBeCloseTo((55_000 / 548) * 365.25, 9);
		expect(a.maxYear.label).toBe('2004/05');
		expect(a.yearsAboveGa).toBe(1);
		expect(a.yearsCapReached).toBe(1);
		expect(out[1]).toMatchObject({ yearsAboveGa: 0, yearsCapReached: 0 });
	});

	it('carries the property’s GN 538 volume and counts a year above it over the year or any 12 months ending in it (engine 1.12.0)', () => {
		const y = (waterYear: number, abstractionM3: number, rolling12MaxM3: number | null) => ({ ...year('a', waterYear, 365, abstractionM3), gaLimitM3: 20_000, gaBasis: 'property' as const, rolling12MaxM3 });
		// 2004/05 is under 20 000 over its water year, but the 12 months to March 2005 are not.
		const [a] = groundwaterByNode([y(2003, 18_300, null), y(2004, 18_200, 36_500), y(2005, 21_000, 21_000), y(2006, 1000, 19_000)]);
		expect(a).toMatchObject({ gaLimitM3: 20_000, gaBasis: 'property', max12M3: 36_500, yearsAboveGa: 2 });
		expect(aboveGa({ abstractionM3: 18_200, rolling12MaxM3: 36_500, gaLimitM3: 20_000 })).toBe(true);
		expect(aboveGa({ abstractionM3: 18_200, rolling12MaxM3: undefined, gaLimitM3: 20_000 })).toBe(false);
		// An older run: the ceiling, no 12-month figure.
		expect(groundwaterByNode([year('b', 2003, 365, 3000)])[0]).toMatchObject({ gaLimitM3: 40_000, gaBasis: 'ceiling', max12M3: null });
	});

	it('is empty for a run without boreholes', () => {
		expect(groundwaterByNode(undefined)).toEqual([]);
	});
});
