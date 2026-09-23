import { describe, expect, it } from 'vitest';
import type { NetworkNode, ProjectModel } from '@water-management/engine';
import { validateModel } from './validate';

function node(id: string, name: string, down: string | null): NetworkNode {
	return {
		id,
		name,
		kind: down === null ? 'gauge' : 'farm',
		downstreamNodeId: down,
		sortOrder: 0,
		areaKm2: 1,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: 0,
		pctRunoffToDam: 0,
		damCapacityM3: 0,
		damInitialPct: 0,
		damMinPct: 0,
		divertCapacityM3Day: 0,
		returnFlowPct: 0
	};
}

const model = (nodes: NetworkNode[], extra: Partial<ProjectModel> = {}): ProjectModel => ({
	nodes,
	crops: [],
	cropAreas: [],
	transfers: [],
	...extra
});

const messages = (m: ProjectModel) => validateModel(m).map((i) => i.message);

describe('validateModel', () => {
	it('accepts an empty model', () => {
		expect(validateModel(model([]))).toEqual([]);
	});

	it('accepts a valid tree', () => {
		const m = model([node('g', 'Gauge', null), node('a', 'A', 'g'), node('b', 'B', 'a')]);
		expect(validateModel(m)).toEqual([]);
	});

	it('flags duplicate names case-insensitively', () => {
		const m = model([node('g', 'Gauge', null), node('a', 'Farm', 'g'), node('b', ' farm ', 'g')]);
		expect(messages(m)).toEqual(['Node name "Farm" is used 2 times.']);
	});

	it('flags blank names', () => {
		expect(messages(model([node('g', '  ', null)]))).toContain('Every node needs a name.');
	});

	it('requires exactly one outlet', () => {
		expect(messages(model([node('a', 'A', null), node('b', 'B', null)]))[0]).toMatch(/2 outlets/);
		expect(messages(model([node('a', 'A', 'b'), node('b', 'B', 'a')]))).toContain(
			'The network needs one outlet (a node that drains nowhere).'
		);
	});

	it('detects a cycle once', () => {
		const m = model([node('g', 'G', null), node('a', 'A', 'b'), node('b', 'B', 'c'), node('c', 'C', 'a')]);
		const cycles = messages(m).filter((x) => x.startsWith('Cycle'));
		expect(cycles).toHaveLength(1);
		expect(cycles[0]).toMatch(/A → B → C → A|B → C → A → B|C → A → B → C/);
	});

	it('detects self-drainage and dangling references', () => {
		const m = model([node('g', 'G', null), node('a', 'A', 'a'), node('b', 'B', 'zzz')]);
		expect(messages(m)).toEqual(['"A" drains into itself.', '"B" drains into a node that no longer exists.']);
	});

	it('checks crop and transfer references', () => {
		const m = model([node('g', 'G', null)], {
			crops: [{ id: 'c', name: 'Citrus', cropFactor: [1] }],
			cropAreas: [{ nodeId: 'x', cropId: 'c', areaM2: 1 }],
			transfers: [
				{ id: 't', fromNodeId: 'g', toNodeId: 'g', months: [13], maxRateM3s: 1, dailyCapM3: null, minStoragePct: 0, enabled: true }
			]
		});
		expect(validateModel(m).map((i) => i.area)).toEqual(['crops', 'crops', 'transfers', 'transfers']);
	});

	it('flags out-of-range fractions and negative quantities', () => {
		const a = node('a', 'A', null);
		a.damMinPct = 1.5;
		a.damCapacityM3 = -1;
		expect(messages(model([a]))).toEqual([
			'"A": percentages must be between 0% and 100%.',
			'"A": areas and capacities can\'t be negative.'
		]);
	});
});
