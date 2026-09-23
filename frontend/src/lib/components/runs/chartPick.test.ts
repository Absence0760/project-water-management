import { describe, expect, it } from 'vitest';
import { CATCHMENT, comparisonRefs, seriesForNode } from './chartPick';

const refs = [
	{ nodeId: null, key: 'natural_flow', label: 'Natural', unit: 'm³/day' },
	{ nodeId: null, key: 'observed_flow', label: 'Observed', unit: 'm³/s' },
	{ nodeId: null, key: 'simulated_outflow', label: 'Simulated', unit: 'm³/day' },
	{ nodeId: 'f1', key: 'dam_storage', label: 'Dam', unit: 'm³' }
];

describe('chart series selection', () => {
	it('filters by node, with catchment = null nodeId', () => {
		expect(seriesForNode(refs, CATCHMENT)).toHaveLength(3);
		expect(seriesForNode(refs, 'f1').map((r) => r.key)).toEqual(['dam_storage']);
	});

	it('compares only series sharing the first unit, in a fixed order', () => {
		expect(comparisonRefs(refs).map((r) => r.key)).toEqual(['natural_flow', 'simulated_outflow']);
		expect(comparisonRefs([])).toEqual([]);
	});
});
