import { describe, expect, it } from 'vitest';
import { commonOptions, deltaStats, fmtSig, isFlowSeries, matchOverlay, pickOption, seriesDelta, summaryText, type SeriesRefLike } from './overlay';

const ref = (nodeId: string | null, key: string, unit = 'm³/day', label = key): SeriesRefLike => ({ nodeId, key, label, unit });

describe('commonOptions', () => {
	it('keeps keys both sides stored with the same unit, in B order with B labels', () => {
		const a = [ref(null, 'natural_flow'), ref(null, 'simulated_outflow'), ref(null, 'rain', 'mm')];
		const b = [ref(null, 'simulated_outflow', 'm³/day', 'Outflow B'), ref(null, 'natural_flow'), ref(null, 'rain', 'm³/day'), ref(null, 'ewr')];
		expect(commonOptions(a, b)).toEqual([
			{ key: 'simulated_outflow', label: 'Outflow B', unit: 'm³/day' },
			{ key: 'natural_flow', label: 'natural_flow', unit: 'm³/day' }
		]);
	});
});

describe('matchOverlay', () => {
	const nodesA = [
		{ id: 'g', name: 'Outlet', sortOrder: 0 },
		{ id: 'f1', name: 'Farm 1', sortOrder: 1 },
		{ id: 'f2', name: 'Bergwater', sortOrder: 2 },
		{ id: 'f3', name: 'Old farm', sortOrder: 3 }
	];

	it('puts the catchment first, then nodes matched by id in network order, naming a rename', () => {
		const nodesB = [
			{ id: 'f2', name: 'Bergwater', sortOrder: 1 },
			{ id: 'f1', name: 'Rooikloof', sortOrder: 2 },
			{ id: 'g', name: 'Outlet', sortOrder: 0 }
		];
		const refsA = [ref(null, 'simulated_outflow'), ref('g', 'outflow'), ref('f1', 'outflow'), ref('f1', 'dam_storage', 'm³'), ref('f2', 'outflow')];
		const refsB = [ref(null, 'simulated_outflow'), ref('g', 'outflow'), ref('f1', 'outflow'), ref('f1', 'dam_storage', 'm³'), ref('f2', 'outflow')];
		const m = matchOverlay(refsA, refsB, nodesA, nodesB);
		expect(m.groups.map((g) => [g.id, g.label, g.wasName])).toEqual([
			['catchment', 'Catchment (outflow gauge)', null],
			['g|g', 'Outlet', null],
			['f2|f2', 'Bergwater', null],
			['f1|f1', 'Rooikloof', 'Farm 1']
		]);
		expect(m.groups[3]!.options.map((o) => o.key)).toEqual(['outflow', 'dam_storage']);
		expect(m).toMatchObject({ onlyA: [], onlyB: [], noCommon: [] });
	});

	it('matches across a copy by name (trimmed, case-insensitive) and lists nodes only one run has', () => {
		const nodesB = [
			{ id: 'x-g', name: 'outlet ', sortOrder: 0 },
			{ id: 'x-f2', name: 'BERGWATER', sortOrder: 1 },
			{ id: 'x-new', name: 'New farm', sortOrder: 2 }
		];
		const refsA = [ref('g', 'outflow'), ref('f2', 'outflow'), ref('f3', 'outflow')];
		const refsB = [ref('x-g', 'outflow'), ref('x-f2', 'outflow'), ref('x-new', 'outflow')];
		const m = matchOverlay(refsA, refsB, nodesA, nodesB);
		expect(m.groups.map((g) => [g.nodeIdA, g.nodeIdB])).toEqual([
			['g', 'x-g'],
			['f2', 'x-f2']
		]);
		// Case and whitespace alone are not a rename worth naming; the label is B's name.
		expect(m.groups[0]!.wasName).toBeNull();
		expect(m.groups[1]!.label).toBe('BERGWATER');
		expect(m.onlyA).toEqual([{ nodeId: 'f3', name: 'Old farm' }]);
		expect(m.onlyB).toEqual([{ nodeId: 'x-new', name: 'New farm' }]);
	});

	it('lists a matched node whose series share nothing, and drops a catchment with nothing in common', () => {
		const m = matchOverlay([ref(null, 'natural_flow'), ref('f1', 'outflow')], [ref(null, 'rain', 'mm'), ref('f1', 'outflow', 'm³')], nodesA, nodesA);
		expect(m.groups).toEqual([]);
		expect(m.noCommon).toEqual([{ nodeId: 'f1', name: 'Farm 1' }]);
	});

	it('matches a node missing from the model snapshot by id only, never by its placeholder name', () => {
		const m = matchOverlay([ref('u1', 'outflow'), ref('u2', 'outflow')], [ref('u1', 'outflow'), ref('u3', 'outflow')], [], []);
		expect(m.groups.map((g) => g.id)).toEqual(['u1|u1']);
		expect(m.groups[0]!.label).toBe('Unknown node');
		expect(m.onlyA.map((n) => n.nodeId)).toEqual(['u2']);
		expect(m.onlyB.map((n) => n.nodeId)).toEqual(['u3']);
	});

	it('gives nothing when neither run stored a series', () => {
		expect(matchOverlay([], [], [], [])).toEqual({ groups: [], onlyA: [], onlyB: [], noCommon: [] });
	});
});

describe('pickOption', () => {
	const group = { id: 'x', nodeIdA: 'a', nodeIdB: 'b', label: 'X', wasName: null, options: [ref(null, 'demand'), ref(null, 'outflow')] };
	it('keeps the current kind, else outflow, else the first', () => {
		expect(pickOption(group, 'demand')).toBe('demand');
		expect(pickOption(group, 'dam_storage')).toBe('outflow');
		expect(pickOption({ ...group, options: [ref(null, 'demand')] }, 'x')).toBe('demand');
		expect(pickOption({ ...group, options: [ref(null, 'natural_flow'), ref(null, 'simulated_outflow')] }, '')).toBe('simulated_outflow');
		expect(pickOption(undefined, 'outflow')).toBe('');
	});
});

describe('seriesDelta', () => {
	it('takes B − A over the shared days, with a gap wherever either side has none', () => {
		const a = { startDate: '2020-01-01', values: [1, 2, 3, null, 5] };
		const b = { startDate: '2020-01-02', values: [4, 4, 4, 4, 4, 4] };
		expect(seriesDelta(a, b)).toEqual({ startDate: '2020-01-02', values: [2, 1, null, -1] });
	});

	it('treats a non-finite value as missing, not as zero', () => {
		expect(seriesDelta({ startDate: '2020-01-01', values: [Number.NaN, 1] }, { startDate: '2020-01-01', values: [1, 1] }).values).toEqual([null, 0]);
	});

	it('is empty when the periods do not overlap', () => {
		expect(seriesDelta({ startDate: '2020-01-01', values: [1, 2] }, { startDate: '2021-01-01', values: [1] })).toEqual({
			startDate: '2021-01-01',
			values: []
		});
	});

	it('is exactly zero for the same series (same inputs, same results)', () => {
		const s = { startDate: '2019-12-30', values: [0.1, 0.2, 0.3] };
		expect(seriesDelta(s, s).values).toEqual([0, 0, 0]);
	});
});

describe('deltaStats', () => {
	it('summarises the shared days: means, the largest change and how often B is above or below', () => {
		const a = { startDate: '2020-01-01', values: [1, 2, 3, null, 5] };
		const b = { startDate: '2020-01-01', values: [1, 4, 0, 9, 6] };
		expect(deltaStats(a, b)).toEqual({
			days: 4,
			meanA: 11 / 4,
			meanB: 11 / 4,
			meanDelta: 0,
			largest: { date: '2020-01-03', delta: -3 },
			daysHigher: 2,
			daysLower: 1
		});
	});

	it('has no means and no largest change without shared days, and no largest change when equal', () => {
		expect(deltaStats({ startDate: '2020-01-01', values: [1] }, { startDate: '2020-02-01', values: [1] })).toMatchObject({
			days: 0,
			meanA: null,
			meanDelta: null,
			largest: null
		});
		expect(deltaStats({ startDate: '2020-01-01', values: [1, 2] }, { startDate: '2020-01-01', values: [1, 2] }).largest).toBeNull();
	});
});

describe('isFlowSeries', () => {
	it('is a m³/day flow, not a demand/supply/deficit/EWR column', () => {
		expect(isFlowSeries({ key: 'outflow', unit: 'm³/day' })).toBe(true);
		expect(isFlowSeries({ key: 'simulated_outflow', unit: 'm³/day' })).toBe(true);
		expect(isFlowSeries({ key: 'dam_storage', unit: 'm³' })).toBe(false);
		expect(isFlowSeries({ key: 'supplied', unit: 'm³/day' })).toBe(false);
		expect(isFlowSeries({ key: 'ewr_charge', unit: 'm³/day' })).toBe(false);
		expect(isFlowSeries(undefined)).toBe(false);
	});
});

describe('fmtSig', () => {
	it('keeps three significant figures so a small change never rounds to 0', () => {
		expect(fmtSig(0.0000347, true)).toBe('+0.0000347');
		expect(fmtSig(-0.0132)).toBe('−0.0132');
		expect(fmtSig(12.345)).toBe('12.3');
		expect(fmtSig(123456.7)).toBe('123,457');
		expect(fmtSig(0, true)).toBe('0');
		expect(fmtSig(null)).toBe('–');
	});
});

describe('summaryText', () => {
	const stats = { days: 120, meanA: 1000, meanB: 1100, meanDelta: 100, largest: { date: '2021-12-11', delta: -864 }, daysHigher: 9, daysLower: 1 };
	it('reads the stats out in the displayed unit', () => {
		expect(summaryText(stats, 'm³/s', 1 / 86_400)).toBe(
			'Over the 120 days both runs have: mean A 0.0116, mean B 0.0127, B − A +0.00116 m³/s. ' +
				'B is higher on 9 days and lower on 1 day; the largest change is −0.01 m³/s on 2021-12-11.'
		);
	});
	it('says when the runs are identical, and when they share no day', () => {
		expect(summaryText({ ...stats, meanB: 1000, meanDelta: 0, largest: null, daysHigher: 0, daysLower: 0 }, 'm³')).toBe(
			'Over the 120 days both runs have: mean A 1,000, mean B 1,000, B − A 0 m³. The two runs are identical on every one of those days.'
		);
		expect(summaryText({ ...stats, days: 0 }, 'm³')).toMatch(/^The two runs share no day/);
	});
});
