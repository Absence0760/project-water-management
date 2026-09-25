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
		irrigationEfficiency: 1,
		lossReturnFraction: 0,
		damAreaFullM2: null,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0
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
				{ id: 't', fromNodeId: 'g', toNodeId: 'g', months: [13], maxRateM3s: 1, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0 }
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

	it('needs an irrigation efficiency above 0% (abstraction = crop requirement ÷ efficiency, N1)', () => {
		const a = node('a', 'A', null);
		a.irrigationEfficiency = 0;
		expect(messages(model([a]))).toEqual(['"A": irrigation efficiency must be above 0%.']);
	});

	it('needs a whole-number transfer priority (Q18)', () => {
		const g = node('g', 'G', null);
		const f = node('f', 'F', 'g');
		const t = { id: 't', fromNodeId: 'f', toNodeId: 'g', months: [1], maxRateM3s: 1, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0.5 };
		expect(messages(model([g, f], { transfers: [t] }))).toContain('Transfer 1: priority must be a whole number.');
		expect(messages(model([g, f], { transfers: [{ ...t, priority: 2 }] }))).not.toContain('Transfer 1: priority must be a whole number.');
	});

	it('checks the dam evaporation fields: area ≥ 0 or unknown, exponent in (0, 3], seepage 0–100 % (N2)', () => {
		const a = node('a', 'A', null);
		a.damAreaFullM2 = null;
		expect(messages(model([a]))).toEqual([]);
		a.damAreaFullM2 = -1;
		a.damAreaExponent = 0;
		a.damSeepagePerDay = 2;
		expect(messages(model([a]))).toEqual([
			'"A": percentages must be between 0% and 100%.',
			'"A": the dam area exponent must be above 0 and at most 3.',
			'"A": the dam area can\'t be negative.'
		]);
	});

	it('checks an other water user as the API does (WP-1.33)', () => {
		const town: NetworkNode = { ...node('u', 'Town', 'g'), kind: 'user', userDemandM3Day: new Array(12).fill(10), userReturnPct: 0.5, userPriority: 'senior' };
		expect(messages(model([node('g', 'Gauge', null), town, node('a', 'A', 'u')]))).toEqual([]);
		const bad = model([node('g', 'Gauge', null), { ...town, userReturnPct: 2, userDemandM3Day: [1, -1] }, node('a', 'A', 'u')], {
			crops: [{ id: 'c', name: 'Crop', cropFactor: new Array(12).fill(1) }],
			cropAreas: [{ nodeId: 'u', cropId: 'c', areaM2: 100 }],
			transfers: [{ id: 't', fromNodeId: 'a', toNodeId: 'u', months: [1], maxRateM3s: 1, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0 }]
		});
		expect(messages(bad)).toEqual([
			'"Town": the share returned must be between 0% and 100%.',
			'"Town": demand needs 12 monthly values, none negative.',
			'"Town" is an other water user: its demand is monthly, so remove its crop areas.',
			'"Town" is an other water user: transfers run between farm dams.'
		]);
	});

	it('checks boreholes as the API does (WP-1.34)', () => {
		const g = node('g', 'Gauge', null);
		expect(messages(model([g, { ...node('a', 'A', 'g'), boreholeCapacityM3Day: 100, streamDepletionFrac: 0.5 }]))).toEqual([]);
		expect(messages(model([{ ...g, boreholeCapacityM3Day: 5 }, node('a', 'A', 'g')]))).toEqual(['"Gauge": a gauge can\'t have boreholes.']);
		expect(messages(model([g, { ...node('a', 'A', 'g'), boreholeCapacityM3Day: 5, boreholeRule: 'drought' }]))).toEqual(['"A": the drought borehole rule needs a farm dam to trigger on.']);
		expect(messages(model([g, { ...node('a', 'A', 'g'), streamDepletionFrac: 1.5, streamDepletionLagDays: -1 }]))).toEqual([
			'"A": borehole capacity and depletion lag can\'t be negative.',
			'"A": stream depletion and the drought trigger must be between 0% and 100%.'
		]);
	});
});
