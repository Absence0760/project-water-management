import { describe, expect, it } from 'vitest';
import { newNetworkNode, type NetworkNode } from '@water-management/engine';
import { nodeSections, SECTION_SHORT, SECTION_TITLE } from './nodeSections';

const node = (over: Partial<NetworkNode>): NetworkNode => ({ ...newNetworkNode('n', 1, 'out'), ...over });

describe('nodeSections', () => {
	it("orders a unit's form by how water moves: the dam beside its survey, supply before irrigation and demand, the two borehole set-ups together", () => {
		expect(nodeSections(node({ kind: 'farm', damCapacityM3: 50_000 }), 0).map((s) => SECTION_TITLE[s])).toEqual([
			'Catchment area',
			'Flow share',
			'Dam',
			'Dam survey and releases',
			'Routing',
			'Supply',
			'Irrigation',
			'Demand objects',
			'Combined boreholes (one capacity)',
			'Individual boreholes',
			'Land cover',
			'Bed losses in the reach below'
		]);
	});

	it('leaves out the dam survey on a unit with no dam, unless it still carries development fields', () => {
		expect(nodeSections(node({ kind: 'farm', damCapacityM3: 0 }), 0)).not.toContain('damSurvey');
		expect(nodeSections(node({ kind: 'farm', damCapacityM3: 0, damSurveyDate: '2020-01-01' }), 0)).toContain('damSurvey');
	});

	it('shows a gauge its area only, and a user its groundwater, plus anything left from another kind; both the bed losses below them', () => {
		expect(nodeSections(node({ kind: 'gauge' }), 0)).toEqual(['area', 'reach']);
		expect(nodeSections(node({ kind: 'gauge' }), 2)).toEqual(['area', 'demand', 'reach']);
		expect(nodeSections(node({ kind: 'user' }), 0)).toEqual(['groundwater', 'boreholes', 'reach']);
	});

	it('has a short name for every section on the jump row', () => {
		expect(SECTION_SHORT.groundwater).toBe('Combined boreholes');
		expect(SECTION_SHORT.damSurvey).toBe('Dam survey');
		expect(SECTION_SHORT.reach).toBe('Bed losses');
	});
});
