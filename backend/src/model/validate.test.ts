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
