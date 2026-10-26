import { describe, expect, it } from 'vitest';
import { newNetworkNode, type NetworkNode } from '@water-management/engine';
import { nodeNavGroups, nodeSections, sectionId, SECTION_TITLE } from './nodeSections';

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
			'Base-flow loss and gain',
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

	it("gives the sheet's section menu each fieldset's id and legend, and the bar names each section by its legend word for word (issues #462, #586 R4-N)", () => {
		const n = node({ id: 'u1', kind: 'farm', damCapacityM3: 50_000 });
		const [group, ...rest] = nodeNavGroups(n.id, nodeSections(n, 0));
		expect(rest).toEqual([]);
		expect(group!.label).toBeNull();
		expect(group!.sections.map((s) => s.id)).toEqual(nodeSections(n, 0).map((s) => sectionId('u1', s)));
		expect(group!.sections.map((s) => s.label)).toEqual(nodeSections(n, 0).map((s) => SECTION_TITLE[s]));
		expect(group!.sections.find((s) => s.id === sectionId('u1', 'reach'))).toEqual({ id: 'nd-sec-reach-u1', label: 'Bed losses in the reach below' });
	});
});
