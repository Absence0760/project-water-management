import type { ProjectModel } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { node } from '../__tests__/helpers.js';
import { ModelBody, modelProblems } from './validate.js';

const model = (nodes: ReturnType<typeof node>[]): ProjectModel =>
	({ nodes, crops: [], cropAreas: [], transfers: [] }) as unknown as ProjectModel;

describe('modelProblems', () => {
	it('accepts an empty model and a simple tree', () => {
		expect(modelProblems(model([]))).toEqual([]);
		const out = node('Gauge', null);
		expect(modelProblems(model([out, node('A', out.id), node('B', out.id)]))).toEqual([]);
	});

	it('requires exactly one outflow node', () => {
		expect(modelProblems(model([node('G1', null), node('G2', null)])).join()).toMatch(/exactly one outflow/);
	});

	it('detects loops and unknown downstream nodes', () => {
		const a = node('A', null);
		const b = node('B', a.id);
		a.downstreamNodeId = b.id;
		const c = node('C', null);
		expect(modelProblems(model([a, b, c])).join()).toMatch(/loop/);
		expect(modelProblems(model([c, node('D', crypto.randomUUID())])).join()).toMatch(/unknown node/);
	});

	it('rejects duplicate names case-insensitively', () => {
		const g = node('Gauge', null);
		expect(modelProblems(model([g, node('Farm', g.id), node('farm', g.id)])).join()).toMatch(/duplicate node name/);
	});
});

describe('other water users (WP-1.33)', () => {
	it('accepts a user node and fills the inert defaults on a farm; refuses crops and transfers on a user', () => {
		const out = node('Gauge', null);
		const town = node('Town', out.id, { kind: 'user', userDemandM3Day: new Array(12).fill(100), userReturnPct: 0.5, userPriority: 'junior' });
		const farm = node('A', town.id);
		const parsed = ModelBody.parse({ nodes: [out, town, farm], crops: [], cropAreas: [], transfers: [] });
		expect(parsed.nodes[1]).toMatchObject({ kind: 'user', userReturnPct: 0.5, userPriority: 'junior' });
		expect(parsed.nodes[2]).toMatchObject({ userDemandM3Day: null, userReturnPct: 0, userPriority: 'senior' });
		const m = model([out, town, farm]);
		expect(modelProblems(m)).toEqual([]);
		m.transfers = [{ id: 't', fromNodeId: farm.id, toNodeId: town.id, months: [1], maxRateM3s: 1, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0 }];
		m.crops = [{ id: 'c', name: 'Crop', cropFactor: new Array(12).fill(1) }];
		m.cropAreas = [{ nodeId: town.id, cropId: 'c', areaM2: 1 }];
		const problems = modelProblems(m).join(' | ');
		expect(problems).toMatch(/transfer t involves an other water user/);
		expect(problems).toMatch(/crop area on other water user "Town"/);
		for (const bad of [{ userDemandM3Day: [1] }, { userDemandM3Day: new Array(12).fill(-1) }, { userReturnPct: 1.5 }, { userPriority: 'first' }]) {
			expect(ModelBody.safeParse({ nodes: [out, { ...town, ...bad }, farm], crops: [], cropAreas: [], transfers: [] }).success, JSON.stringify(bad)).toBe(false);
		}
	});
});

describe('boreholes (WP-1.34)', () => {
	it('fills no boreholes by default, and refuses them on a gauge, and the drought rule without a dam', () => {
		const out = node('Gauge', null);
		const farm = node('A', out.id);
		const parsed = ModelBody.parse({ nodes: [out, farm], crops: [], cropAreas: [], transfers: [] });
		expect(parsed.nodes[1]).toMatchObject({ boreholeCapacityM3Day: null, boreholeRule: 'supplemental', boreholeTriggerPct: 0.3, streamDepletionFrac: 0, streamDepletionLagDays: 0 });
		const gauge = node('Gauge', null, { boreholeCapacityM3Day: 5 });
		expect(modelProblems(model([gauge, node('A', gauge.id)])).join()).toMatch(/gauge "Gauge" can't have boreholes/);
		expect(modelProblems(model([out, node('B', out.id, { damCapacityM3: 0, boreholeCapacityM3Day: 5, boreholeRule: 'drought' })])).join()).toMatch(/drought borehole rule needs a farm dam/);
		expect(modelProblems(model([out, node('C', out.id, { damCapacityM3: 1000, boreholeCapacityM3Day: 5, boreholeRule: 'drought' })]))).toEqual([]);
		for (const bad of [{ boreholeCapacityM3Day: -1 }, { streamDepletionFrac: 1.1 }, { streamDepletionLagDays: -2 }, { boreholeTriggerPct: 2 }]) {
			expect(ModelBody.safeParse({ nodes: [out, { ...farm, ...bad }], crops: [], cropAreas: [], transfers: [] }).success, JSON.stringify(bad)).toBe(false);
		}
	});
});

describe('dam storage (WP-3.5)', () => {
	const curve = [
		{ levelM: 100, areaM2: 0, volumeM3: 0 },
		{ levelM: 102, areaM2: 6000, volumeM3: 5000 },
		{ levelM: 104, areaM2: 10_000, volumeM3: 20_000 }
	];

	it('fills the off defaults, and accepts a curve, a release rule and a seepage share', () => {
		const out = node('Gauge', null);
		const farm = node('A', out.id, { damCapacityM3: 20_000 });
		const parsed = ModelBody.parse({ nodes: [out, farm], crops: [], cropAreas: [], transfers: [] });
		expect(parsed.nodes[1]).toMatchObject({ damCurve: null, damReleaseRule: 'none', damReleaseM3Day: null, damOutletCapacityM3Day: null, damSeepageReturnPct: 1 });
		const set = { ...farm, damCurve: curve, damReleaseRule: 'fixed', damReleaseM3Day: new Array(12).fill(40), damOutletCapacityM3Day: 500, damSeepageReturnPct: 0.3 };
		const ok = ModelBody.parse({ nodes: [out, set], crops: [], cropAreas: [], transfers: [] });
		expect(ok.nodes[1]).toMatchObject({ damCurve: curve, damReleaseRule: 'fixed', damOutletCapacityM3Day: 500, damSeepageReturnPct: 0.3 });
		expect(modelProblems(model([out, set as never]))).toEqual([]);
	});

	it('EWR site flag (engine 1.5.0): true unless set; a gauge may be taken off, never the outlet or a farm', () => {
		const out = node('Gauge', null);
		const weir = node('Weir', out.id, { kind: 'gauge', damCapacityM3: 0 });
		const farm = node('A', weir.id);
		const parsed = ModelBody.parse({ nodes: [out, weir, farm], crops: [], cropAreas: [], transfers: [] });
		expect(parsed.nodes.map((n) => n.ewrSite)).toEqual([true, true, true]);
		expect(ModelBody.safeParse({ nodes: [out, { ...weir, ewrSite: 'no' }], crops: [], cropAreas: [], transfers: [] }).success).toBe(false);
		expect(modelProblems(model([out, { ...weir, ewrSite: false } as never, farm]))).toEqual([]);
		expect(modelProblems(model([{ ...out, ewrSite: false } as never, weir, farm])).join()).toMatch(/"Gauge" is the outlet, which is always an EWR site/);
		expect(modelProblems(model([out, weir, { ...farm, ewrSite: false } as never])).join()).toMatch(/"A": only a gauge can be taken off the EWR sites/);
	});

	it('GN 538 property area and rate (engine 1.12.0): null unless set; the rate is one of the six Table 2 values', () => {
		const out = node('Gauge', null);
		const farm = node('A', out.id);
		const parse = (over: object) => ModelBody.safeParse({ nodes: [out, { ...farm, ...over }], crops: [], cropAreas: [], transfers: [] });
		expect(ModelBody.parse({ nodes: [out, farm], crops: [], cropAreas: [], transfers: [] }).nodes[1]).toMatchObject({ gaPropertyAreaHa: null, gaRateM3HaYear: null });
		for (const r of [0, 45, 75, 150, 275, 400]) expect(parse({ gaPropertyAreaHa: 60, gaRateM3HaYear: r }).success).toBe(true);
		expect(parse({ gaPropertyAreaHa: 0.5, gaRateM3HaYear: null }).success).toBe(true);
		for (const bad of [{ gaRateM3HaYear: 100 }, { gaRateM3HaYear: '45' }, { gaPropertyAreaHa: -1 }, { gaPropertyAreaHa: 1e8 }]) expect(parse(bad).success, JSON.stringify(bad)).toBe(false);
	});

	it('supply rule and river pump (WP-3.8): fills the dam-only defaults, accepts each rule, refuses bad values and invalid combinations', () => {
		const out = node('Gauge', null);
		const farm = node('A', out.id, { damCapacityM3: 20_000 });
		const parsed = ModelBody.parse({ nodes: [out, farm], crops: [], cropAreas: [], transfers: [] });
		expect(parsed.nodes[1]).toMatchObject({ supplyRule: 'damFirst', pumpCapacityM3Day: null, supplyTriggerPct: 0.4, supplyStopPct: 0.6 });
		const trigger = { ...farm, supplyRule: 'trigger', pumpCapacityM3Day: 1200, supplyTriggerPct: 0.3, supplyStopPct: 0.7 };
		const ok = ModelBody.parse({ nodes: [out, trigger], crops: [], cropAreas: [], transfers: [] });
		expect(ok.nodes[1]).toMatchObject({ supplyRule: 'trigger', pumpCapacityM3Day: 1200, supplyTriggerPct: 0.3, supplyStopPct: 0.7 });
		expect(modelProblems(model([out, trigger as never]))).toEqual([]);
		expect(modelProblems(model([out, { ...farm, supplyRule: 'runOfRiver', damCapacityM3: 0, pumpCapacityM3Day: 500 } as never]))).toEqual([]);
		for (const bad of [{ supplyRule: 'pumpFirst' }, { pumpCapacityM3Day: -1 }, { supplyTriggerPct: 1.5 }, { supplyStopPct: -0.1 }]) {
			expect(ModelBody.safeParse({ nodes: [out, { ...farm, ...bad }], crops: [], cropAreas: [], transfers: [] }).success, JSON.stringify(bad)).toBe(false);
		}
		expect(modelProblems(model([out, { ...farm, supplyRule: 'runOfRiver' } as never])).join()).toMatch(/"A": run of river has no dam/);
		expect(modelProblems(model([out, { ...farm, damCapacityM3: 0, supplyRule: 'trigger' } as never])).join()).toMatch(/"A": the trigger supply rule needs a farm dam/);
		expect(modelProblems(model([out, { ...trigger, supplyStopPct: 0.2 } as never])).join()).toMatch(/stop level must be at least its trigger level/);
		const onGauge = node('Gauge', null, { pumpCapacityM3Day: 10 });
		expect(modelProblems(model([onGauge, node('B', onGauge.id)])).join()).toMatch(/"Gauge": only a farm has a supply rule/);
	});

	it('a pump capacity on an other water user (engine 1.58.0): accepted, null by default, refused negative; a supply rule on it is refused', () => {
		const out = node('Gauge', null);
		const user = node('Town', out.id, { kind: 'user', areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0, userDemandM3Day: Array(12).fill(500) });
		const parse = (over: object) => ModelBody.safeParse({ nodes: [out, { ...user, ...over }], crops: [], cropAreas: [], transfers: [] });
		expect(parse({}).data!.nodes[1]).toMatchObject({ kind: 'user', pumpCapacityM3Day: null });
		const capped = parse({ pumpCapacityM3Day: 1200 });
		expect(capped.data!.nodes[1]).toMatchObject({ pumpCapacityM3Day: 1200 });
		expect(modelProblems(model([out, { ...user, pumpCapacityM3Day: 1200 } as never]))).toEqual([]);
		expect(modelProblems(model([out, { ...user, pumpCapacityM3Day: 0 } as never]))).toEqual([]);
		expect(parse({ pumpCapacityM3Day: -1 }).success).toBe(false);
		expect(modelProblems(model([out, { ...user, supplyRule: 'riverFirst' } as never])).join()).toMatch(/"Town": only a farm has a supply rule; an other water user always takes from the river/);
	});

	it('hands-off flow and River to dam by month (engine 1.32.0, issue #204): off by default, twelve finite values ≥ 0, farms only', () => {
		const out = node('Gauge', null);
		const farm = node('A', out.id, { damCapacityM3: 20_000 });
		const parse = (over: object, on: object = farm) => ModelBody.safeParse({ nodes: [out, { ...on, ...over }], crops: [], cropAreas: [], transfers: [] });
		expect(ModelBody.parse({ nodes: [out, farm], crops: [], cropAreas: [], transfers: [] }).nodes[1]).toMatchObject({ handsOffM3Day: null, handsOffEwr: false, divertMonthlyM3Day: null });
		const set = { handsOffM3Day: [0, 0, 0, 120, 120, 120, 120, 0, 0, 0, 0, 0.5], handsOffEwr: true, divertMonthlyM3Day: [900, 900, 900, 900, 900, 900, 0, 0, 0, 0, 0, 0] };
		const ok = parse(set);
		expect(ok.success).toBe(true);
		expect(ok.data!.nodes[1]).toMatchObject(set);
		expect(modelProblems(model([out, { ...farm, ...set } as never]))).toEqual([]);
		expect(parse({ handsOffM3Day: null, divertMonthlyM3Day: null }).success).toBe(true);
		const eleven = Array(11).fill(1);
		for (const bad of [
			{ handsOffM3Day: eleven },
			{ handsOffM3Day: [...eleven, 1, 1] },
			{ handsOffM3Day: [...eleven, -1] },
			{ handsOffM3Day: [...eleven, Infinity] },
			{ handsOffM3Day: [...eleven, '1'] },
			{ handsOffEwr: 'yes' },
			{ divertMonthlyM3Day: eleven },
			{ divertMonthlyM3Day: [...eleven, -0.1] },
			{ divertMonthlyM3Day: [...eleven, Number.NaN] }
		])
			expect(parse(bad).success, JSON.stringify(bad)).toBe(false);
		// Farms only is a model rule.
		for (const over of [{ handsOffM3Day: Array(12).fill(10) }, { handsOffEwr: true }, { divertMonthlyM3Day: Array(12).fill(10) }]) {
			const gauge = node('Gauge', null, over);
			expect(modelProblems(model([gauge, node('B', gauge.id)])).join(), JSON.stringify(over)).toMatch(/"Gauge": only a farm has a hands-off flow/);
		}
	});

	it('monthly transfer rates (engine 1.14.0): default null, twelve rates ≥ 0, months and max rate kept in step', () => {
		const out = node('Gauge', null);
		const a = node('A', out.id, { damCapacityM3: 1000 });
		const b = node('B', out.id, { damCapacityM3: 1000 });
		const t = { id: crypto.randomUUID(), fromNodeId: a.id, toNodeId: b.id, months: [1], maxRateM3s: 1, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0 };
		const body = (tr: object) => ({ nodes: [out, a, b], crops: [], cropAreas: [], transfers: [tr] });
		expect(ModelBody.parse(body(t)).transfers[0]!.monthlyRateM3s).toBeNull();
		const rates = [0, 0, 0, 1, 0.5, 0, 0, 0, 0, 0, 0, 0];
		const ok = ModelBody.parse(body({ ...t, months: [1, 2], monthlyRateM3s: rates }));
		expect(ok.transfers[0]!.monthlyRateM3s).toEqual(rates);
		expect(modelProblems(ok as never)).toEqual([]);
		for (const bad of [[1, 2], [...rates.slice(1), -1], [...rates.slice(1), 'x']]) expect(ModelBody.safeParse(body({ ...t, monthlyRateM3s: bad })).success, JSON.stringify(bad)).toBe(false);
		expect(modelProblems(ModelBody.parse(body({ ...t, monthlyRateM3s: rates })) as never).join()).toMatch(/its months must be the months with a monthly rate above 0/);
	});

	it('river off-takes (engine 1.14.0): dam-transfer defaults, the fields in range, unit to unit, never into a branch that drains back', () => {
		const out = node('Gauge', null);
		const up = node('Up', out.id);
		const mid = node('Mid', up.id);
		const canal = node('Canal', out.id);
		const t = { id: crypto.randomUUID(), fromNodeId: up.id, toNodeId: canal.id, months: [1], maxRateM3s: 0.01, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0 };
		const body = (tr: object, nodes = [out, up, mid, canal]) => ({ nodes, crops: [], cropAreas: [], transfers: [tr] });
		expect(ModelBody.parse(body(t)).transfers[0]).toMatchObject({ source: 'dam', handsOffM3Day: null, handsOffEwr: false, lossPct: 0, sizing: 'demand', topUpDam: false });
		const river = { ...t, source: 'river', handsOffM3Day: 120, handsOffEwr: true, lossPct: 0.2, sizing: 'capacity', topUpDam: true };
		const ok = ModelBody.parse(body(river));
		expect(ok.transfers[0]).toMatchObject({ source: 'river', handsOffM3Day: 120, handsOffEwr: true, lossPct: 0.2, sizing: 'capacity', topUpDam: true });
		expect(modelProblems(ok as never)).toEqual([]);
		for (const bad of [{ source: 'pipe' }, { lossPct: 1 }, { lossPct: -0.1 }, { handsOffM3Day: -1 }, { sizing: 'full' }, { topUpDam: 'yes' }])
			expect(ModelBody.safeParse(body({ ...river, ...bad })).success, JSON.stringify(bad)).toBe(false);
		// Mid drains into Up: an off-take Up → Mid would take water before it arrives.
		expect(modelProblems(ModelBody.parse(body({ ...river, toNodeId: mid.id })) as never).join()).toMatch(/its destination drains into its source/);
		expect(modelProblems(ModelBody.parse(body({ ...river, toNodeId: out.id })) as never).join()).toMatch(/runs from one unit to another/);
	});

	it('canal seepage back to the river (engine 1.42.0): none by default, a share 0–1, rejoining below the source or a farm below it', () => {
		const out = node('Gauge', null);
		const low = node('Low', out.id);
		const up = node('Up', low.id);
		const canal = node('Canal', out.id);
		const t = { id: crypto.randomUUID(), fromNodeId: up.id, toNodeId: canal.id, months: [1], maxRateM3s: 0.01, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0, source: 'river', lossPct: 0.2 };
		const body = (tr: object) => ({ nodes: [out, low, up, canal], crops: [], cropAreas: [], transfers: [tr] });
		expect(ModelBody.parse(body(t)).transfers[0]).toMatchObject({ lossReturnPct: 0, lossReturnNodeId: null });
		for (const at of [null, up.id, low.id]) expect(modelProblems(ModelBody.parse(body({ ...t, lossReturnPct: 0.5, lossReturnNodeId: at })) as never), String(at)).toEqual([]);
		for (const bad of [{ lossReturnPct: 1.01 }, { lossReturnPct: -0.1 }, { lossReturnNodeId: 'not-a-uuid' }])
			expect(ModelBody.safeParse(body({ ...t, ...bad })).success, JSON.stringify(bad)).toBe(false);
		// The canal and the gauge aren't below Up on the river as farms: refused.
		for (const at of [canal.id, out.id, crypto.randomUUID()])
			expect(modelProblems(ModelBody.parse(body({ ...t, lossReturnPct: 0.5, lossReturnNodeId: at })) as never).join()).toMatch(/its seepage can rejoin the river only below "Up" or a farm downstream of it/);
	});

	it('refuses bad fields, and a curve that is not monotone or sits on a gauge', () => {
		const out = node('Gauge', null);
		const farm = node('A', out.id, { damCapacityM3: 20_000 });
		for (const bad of [
			{ damReleaseRule: 'spill' },
			{ damReleaseM3Day: [1] },
			{ damReleaseM3Day: new Array(12).fill(-1) },
			{ damOutletCapacityM3Day: -1 },
			{ damSeepageReturnPct: 1.2 },
			{ damCurve: [{ levelM: 1, areaM2: -1, volumeM3: 0 }] },
			{ damCurve: [{ levelM: 1, areaM2: 1, volumeM3: 1, extra: 1 }] },
			{ damCurve: new Array(201).fill(curve[1]) }
		]) {
			expect(ModelBody.safeParse({ nodes: [out, { ...farm, ...bad }], crops: [], cropAreas: [], transfers: [] }).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
		}
		const falling = { ...farm, damCurve: [curve[0], curve[2], { ...curve[1], volumeM3: 30_000 }] };
		expect(modelProblems(model([out, falling as never])).join()).toMatch(/"A": dam survey curve: the survey area falls/);
		const onGauge = node('Gauge', null, { damCurve: curve });
		expect(modelProblems(model([onGauge, node('B', onGauge.id)])).join()).toMatch(/"Gauge": dam survey curve: only a farm has a dam/);
	});
});

describe('development over the run (engine 1.30.0, issue #67)', () => {
	const out = node('Gauge', null);
	const farm = node('A', out.id, { damCapacityM3: 20_000 });
	const town = node('Town', out.id, { kind: 'user', damCapacityM3: 0 });
	const parse = (...nodes: object[]) => ModelBody.parse({ nodes, crops: [], cropAreas: [], transfers: [] });

	it('fills null, and accepts a survey date with a sediment rate, an in-service date and an abstraction start', () => {
		expect(parse(out, farm).nodes[1]).toMatchObject({ damSurveyDate: null, damSedimentPctPerYear: null, damInServiceFrom: null, abstractionFrom: null });
		const dev = { damSurveyDate: '2012-02-29', damSedimentPctPerYear: 0.2, damInServiceFrom: '2000-10-01', abstractionFrom: '2001-01-01' };
		const ok = parse(out, { ...farm, ...dev }, { ...town, abstractionFrom: '2005-07-15' });
		expect(ok.nodes[1]).toMatchObject(dev);
		expect(ok.nodes[2]).toMatchObject({ abstractionFrom: '2005-07-15' });
		expect(modelProblems(ok as never)).toEqual([]);
		// A rate of 0 needs no survey date.
		expect(modelProblems(parse(out, { ...farm, damSedimentPctPerYear: 0 }) as never)).toEqual([]);
	});

	it('refuses a field of the wrong shape, and one that breaks a model rule', () => {
		for (const bad of [{ damSurveyDate: '2012-2-1' }, { damInServiceFrom: 20_120_201 }, { abstractionFrom: '1 Oct 2001' }, { damSedimentPctPerYear: 0.21 }, { damSedimentPctPerYear: -0.01 }, { damSedimentPctPerYear: '0.1' }])
			expect(ModelBody.safeParse({ nodes: [out, { ...farm, ...bad }], crops: [], cropAreas: [], transfers: [] }).success, JSON.stringify(bad)).toBe(false);
		const problems = (...nodes: object[]) => modelProblems(parse(...nodes) as never).join();
		expect(problems(out, { ...farm, damSurveyDate: '2021-02-30' })).toMatch(/"A": the survey date must be a date/);
		expect(problems(out, { ...farm, damSedimentPctPerYear: 0.01 })).toMatch(/"A": a sediment rate needs the date the capacity was surveyed/);
		expect(problems(out, farm, { ...town, damInServiceFrom: '2001-01-01' })).toMatch(/"Town": only a farm has a dam/);
		expect(problems({ ...out, abstractionFrom: '2001-01-01' }, farm)).toMatch(/"Gauge": a gauge takes no water/);
	});
});

describe('land cover (WP-1.35)', () => {
	it('defaults to none, accepts a patch on a farm, and refuses one on a gauge or an unknown node', () => {
		const out = node('Gauge', null);
		const farm = node('A', out.id);
		expect(ModelBody.parse({ nodes: [out, farm], crops: [], cropAreas: [], transfers: [] }).landCover).toEqual([]);
		const patch = { id: crypto.randomUUID(), nodeId: farm.id, coverClass: 'pine' as const, areaKm2: 1, densityPct: 0.5, factors: null };
		const m = { ...model([out, farm]), landCover: [patch] };
		expect(modelProblems(m)).toEqual([]);
		expect(modelProblems({ ...m, landCover: [{ ...patch, nodeId: out.id }] }).join()).toMatch(/land cover lies on a farm/);
		expect(modelProblems({ ...m, landCover: [{ ...patch, nodeId: crypto.randomUUID() }] }).join()).toMatch(/unknown node/);
		expect(modelProblems({ ...m, landCover: [patch, patch] }).join()).toMatch(/duplicate land-cover id/);
		for (const bad of [{ coverClass: 'bamboo' }, { densityPct: 2 }, { areaKm2: -1 }, { factors: { mar: 1.2, lowFlow: 0 } }]) {
			expect(ModelBody.safeParse({ nodes: [out, farm], crops: [], cropAreas: [], transfers: [], landCover: [{ ...patch, ...bad }] }).success, JSON.stringify(bad)).toBe(false);
		}
	});
});

describe('ModelBody (PUT /model, project documents)', () => {
	const body = (nodes: Record<string, unknown>[]) => ({ nodes, crops: [], cropAreas: [], transfers: [] });

	it('needs 0 < irrigation efficiency ≤ 1 and a loss return fraction in 0–1 (N1)', () => {
		const out = node('Gauge', null);
		const farm = node('A', out.id);
		expect(ModelBody.safeParse(body([out, farm])).success).toBe(true);
		expect(ModelBody.safeParse(body([out, { ...farm, irrigationEfficiency: 0 }])).success).toBe(false);
		expect(ModelBody.safeParse(body([out, { ...farm, irrigationEfficiency: 1.01 }])).success).toBe(false);
		expect(ModelBody.safeParse(body([out, { ...farm, lossReturnFraction: -0.1 }])).success).toBe(false);
	});

	it('takes an optional own irrigation efficiency per crop, 0 < e ≤ 1 or null (engine 0.43.0)', () => {
		const out = node('Gauge', null);
		const crop = { id: crypto.randomUUID(), name: 'Citrus', cropFactor: new Array(12).fill(0.5) };
		const m = (c: Record<string, unknown>) => ({ ...body([out]), crops: [c] });
		expect(ModelBody.parse(m(crop)).crops[0]).not.toHaveProperty('irrigationEfficiency');
		expect(ModelBody.parse(m({ ...crop, irrigationEfficiency: 0.9 })).crops[0]!.irrigationEfficiency).toBe(0.9);
		expect(ModelBody.parse(m({ ...crop, irrigationEfficiency: 1 })).crops[0]!.irrigationEfficiency).toBe(1);
		expect(ModelBody.parse(m({ ...crop, irrigationEfficiency: null })).crops[0]!.irrigationEfficiency).toBeNull();
		for (const bad of [0, -0.1, 1.01, 85, '0.9', Infinity]) expect(ModelBody.safeParse(m({ ...crop, irrigationEfficiency: bad })).success, String(bad)).toBe(false);
	});

	it('needs a whole-number transfer priority, and gives a transfer from an older document its list position (Q18)', () => {
		const out = node('Gauge', null);
		const a = node('A', out.id);
		const b = node('B', out.id);
		const t = { id: crypto.randomUUID(), fromNodeId: a.id, toNodeId: b.id, months: [1], maxRateM3s: 1, dailyCapM3: null, minStoragePct: 0, enabled: true };
		const m = (transfers: Record<string, unknown>[]) => ({ nodes: [out, a, b], crops: [], cropAreas: [], transfers });
		expect(ModelBody.safeParse(m([{ ...t, priority: 1.5 }])).success).toBe(false);
		const parsed = ModelBody.parse(m([t, { ...t, id: crypto.randomUUID() }]));
		expect(parsed.transfers.map((x) => x.priority)).toEqual([0, 1]);
	});

	it('reads a model from before engine 0.16.0 as migration 006 stored it: return flow % → efficiency', () => {
		const out = node('Gauge', null);
		const { irrigationEfficiency: _e, lossReturnFraction: _b, ...legacy } = node('A', out.id);
		const parsed = ModelBody.parse(body([out, { ...legacy, returnFlowPct: 0.25 }, { ...legacy, id: crypto.randomUUID(), name: 'B', returnFlowPct: 0 }]));
		expect(parsed.nodes[1]).toMatchObject({ irrigationEfficiency: 0.75, lossReturnFraction: 1 });
		expect(parsed.nodes[2]).toMatchObject({ irrigationEfficiency: 1, lossReturnFraction: 0 });
		expect(parsed.nodes[1]).not.toHaveProperty('returnFlowPct');
	});
});

describe('demand objects (engine 1.7.0, issue #54 item 2b)', () => {
	const gauge = node('Gauge', null, { kind: 'gauge' });
	const unit = node('Unit', gauge.id);
	const body = (o: Record<string, unknown>) => ({ nodes: [gauge, unit], crops: [], cropAreas: [], transfers: [], demandObjects: [{ id: crypto.randomUUID(), nodeId: unit.id, name: 'Town', ...o }] });

	it('fills the defaults: a monthly demand, shared priority, internal, on, no return', () => {
		const parsed = ModelBody.parse(body({ monthlyM3Day: new Array(12).fill(10) }));
		expect(parsed.demandObjects![0]).toMatchObject({ category: 'other', sizing: 'monthly', count: null, litresPerUnitDay: null, lossPct: 0, monthlyFactor: null, returnPct: 0, priority: 'shared', destination: 'internal', enabled: true, note: '' });
		expect(modelProblems(parsed)).toEqual([]);
	});

	it('refuses 11 months, losses of 100 %, an unknown class and a negative count', () => {
		expect(ModelBody.safeParse(body({ monthlyM3Day: new Array(11).fill(1) })).success).toBe(false);
		expect(ModelBody.safeParse(body({ sizing: 'perUnit', count: 10, litresPerUnitDay: 90, lossPct: 1 })).success).toBe(false);
		expect(ModelBody.safeParse(body({ monthlyM3Day: new Array(12).fill(1), priority: 'senior' })).success).toBe(false);
		expect(ModelBody.safeParse(body({ sizing: 'perUnit', count: -1, litresPerUnitDay: 90 })).success).toBe(false);
	});

	it('refuses an object with no size, one on a gauge, and a return from water piped out', () => {
		expect(modelProblems(ModelBody.parse(body({ sizing: 'perUnit' }))).join()).toMatch(/needs a count and litres/);
		expect(modelProblems(ModelBody.parse(body({ monthlyM3Day: new Array(12).fill(1), nodeId: gauge.id }))).join()).toMatch(/only a unit has demand objects/);
		expect(modelProblems(ModelBody.parse(body({ monthlyM3Day: new Array(12).fill(1), destination: 'external', returnPct: 0.2 }))).join()).toMatch(/nothing returns/);
	});

	it('takes the people an object serves for its basic-needs floor (engine 1.44.0), none by default, never negative', () => {
		const monthly = { monthlyM3Day: new Array(12).fill(10), category: 'municipal' };
		expect(ModelBody.parse(body(monthly)).demandObjects![0]!.population).toBeNull();
		expect(ModelBody.parse(body({ ...monthly, population: 2000 })).demandObjects![0]!.population).toBe(2000);
		for (const population of [-1, Number.POSITIVE_INFINITY, 'many']) expect(ModelBody.safeParse(body({ ...monthly, population })).success, String(population)).toBe(false);
	});

	describe('a schedule (engine 1.17.0, issue #90 Q4)', () => {
		const monthly = { monthlyM3Day: new Array(12).fill(10) };
		it('is none by default, and fills a window’s blanks', () => {
			expect(ModelBody.parse(body(monthly)).demandObjects![0]!.schedule).toBeNull();
			const parsed = ModelBody.parse(body({ ...monthly, schedule: [{ span: 'always', weekdays: [6, 7], factor: 0 }] }));
			expect(parsed.demandObjects![0]!.schedule).toEqual([{ label: '', span: 'always', from: null, to: null, easterFrom: null, easterTo: null, weekdays: [6, 7], factor: 0 }]);
			expect(modelProblems(parsed)).toEqual([]);
		});
		it('refuses a bad shape: an unknown span, a factor out of range, weekday 0, a fractional Easter offset, too many windows', () => {
			for (const w of [{ span: 'monthly', factor: 1 }, { span: 'always', factor: -1 }, { span: 'always', factor: 11 }, { span: 'always', weekdays: [0], factor: 0 }, { span: 'easter', easterFrom: 0.5, easterTo: 1, factor: 0 }])
				expect(ModelBody.safeParse(body({ ...monthly, schedule: [w] })).success, JSON.stringify(w)).toBe(false);
			expect(ModelBody.safeParse(body({ ...monthly, schedule: Array.from({ length: 25 }, () => ({ span: 'always', factor: 1 })) })).success).toBe(false);
		});
		it('refuses a window the run can’t use: a date that doesn’t exist, a span that ends before it starts', () => {
			expect(modelProblems(ModelBody.parse(body({ ...monthly, schedule: [{ span: 'yearly', from: '02-30', to: '03-01', factor: 0 }] }))).join()).toMatch(/schedule window 1: a yearly span needs/);
			expect(modelProblems(ModelBody.parse(body({ ...monthly, schedule: [{ label: 'Shutdown', span: 'range', from: '2021-07-14', to: '2021-07-01', factor: 0 }] }))).join()).toMatch(/window 1 \("Shutdown"\): its date range ends/);
		});
	});
});
