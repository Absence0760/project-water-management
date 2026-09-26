import type { GroundwaterAnnualUse } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { groundwaterByNode } from './groundwater';

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

	it('is empty for a run without boreholes', () => {
		expect(groundwaterByNode(undefined)).toEqual([]);
	});
});
