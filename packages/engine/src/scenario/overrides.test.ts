// Scenario overrides (roadmap WP-3.2): each op applies, bad targets become
// problems, node.remove keeps a valid tree, the base is never mutated, the
// classifier's rules, the validator, and a dam raise run end to end.
// Synthetic catchment: invented names and values only (public repo).
import { describe, expect, it } from 'vitest';
import { monthOfEpochDay, toEpochDay } from '../calendar';
import { diffInputs } from '../compare';
import { buildTopology } from '../network/topology';
import { blankEwrRuleTable } from '../reserve/rules';
import { runModel } from '../run';
import type { ModelInput, NetworkNode, RunSeries } from '../project';
import { scrambleOrder } from '../testing/fuzz';
import { checkAll } from '../testing/invariants';
import { MASKED_RULE, applyScenario, classifyOp, classifyScenario, type ScenarioMask } from './overrides';
import { structureIssues } from './structure';
import { validateScenarioOps, type ScenarioOp } from './ops';

function node(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: `Farm ${id}`,
		kind: 'farm',
		downstreamNodeId: null,
		sortOrder: 0,
		areaKm2: 5,
		areaHiKm2: 2.5,
		areaLoKm2: 2.5,
		flowShareManual: null,
		pctUpstreamToDam: 0.5,
		pctRunoffToDam: 0.8,
		damCapacityM3: 0,
		damInitialPct: 0.5,
		damMinPct: 0,
		divertCapacityM3Day: 5000,
		irrigationEfficiency: 0.8,
		lossReturnFraction: 0,
		damAreaFullM2: null,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

/** Outlet gauge G; farms A (dam) and B drain into it; farm C drains into A. */
function base(): ModelInput {
	const days = 500;
	const rain = Array.from({ length: days }, (_, t) => (t % 17 === 0 ? 40 : t % 5 === 0 ? 6 : 0));
	return {
		settings: {
			runoffModel: 'legacy',
			apanMm: [150, 180, 210, 220, 190, 160, 110, 80, 60, 60, 80, 110],
			ewrPragmaticM3PerDay: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
			ewrRules: [blankEwrRuleTable('G'), blankEwrRuleTable('A')]
		},
		model: {
			nodes: [
				node('G', { name: 'Outlet gauge', kind: 'gauge', areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0, divertCapacityM3Day: 0 }),
				node('A', { downstreamNodeId: 'G', damCapacityM3: 200_000, sortOrder: 1 }),
				node('B', { downstreamNodeId: 'G', sortOrder: 2 }),
				node('C', { downstreamNodeId: 'A', damCapacityM3: 50_000, sortOrder: 3 })
			],
			crops: [{ id: 'c1', name: 'Lucerne', cropFactor: [0.8, 0.9, 1, 1, 1, 0.9, 0.8, 0.6, 0.5, 0.5, 0.6, 0.7] }],
			cropAreas: [
				{ nodeId: 'A', cropId: 'c1', areaM2: 400_000 },
				{ nodeId: 'C', cropId: 'c1', areaM2: 200_000 }
			],
			transfers: [{ id: 't1', fromNodeId: 'C', toNodeId: 'A', months: [1, 2, 3], maxRateM3s: 0.05, dailyCapM3: null, minStoragePct: 0.2, enabled: true, priority: 0 }],
			landCover: [{ id: 'lc1', nodeId: 'B', coverClass: 'pine', areaKm2: 1, densityPct: 0.5, factors: null }]
		},
		series: { rain_catchment_mm: { startDate: '2020-10-01', values: rain } }
	};
}

function deepFreeze<T>(v: T): T {
	if (v && typeof v === 'object') {
		for (const x of Object.values(v)) deepFreeze(x);
		Object.freeze(v);
	}
	return v;
}

const one = (op: ScenarioOp, b = base()) => applyScenario(b, [op]);
const nodeOf = (x: ModelInput, id: string) => x.model.nodes.find((n) => n.id === id);

describe('applyScenario: each op', () => {
	it('node.set changes one whitelisted field', () => {
		const r = one({ op: 'node.set', nodeId: 'A', field: 'damCapacityM3', value: 240_000 });
		expect(r.problems).toEqual([]);
		expect(nodeOf(r.input, 'A')!.damCapacityM3).toBe(240_000);
		expect(r.applied).toHaveLength(1);
	});

	it('node.set rejects a missing node, a field the kind lacks and an out-of-range value', () => {
		expect(one({ op: 'node.set', nodeId: 'nope', field: 'damCapacityM3', value: 1 }).problems[0]).toMatch(/op 1 \(node\.set\): node nope not found/);
		expect(one({ op: 'node.set', nodeId: 'G', field: 'damCapacityM3', value: 1 }).problems[0]).toMatch(/can't be set on a gauge/);
		expect(one({ op: 'node.set', nodeId: 'A', field: 'damInitialPct', value: 1.5 }).problems[0]).toMatch(/at most 1/);
		// Not a field at all (a caller bypassing the types): refused, not written.
		const r = one({ op: 'node.set', nodeId: 'A', field: 'downstreamNodeId', value: 'B' } as unknown as ScenarioOp);
		expect(r.problems).toHaveLength(1);
		expect(nodeOf(r.input, 'A')!.downstreamNodeId).toBe('G');
	});

	it('node.set refuses a duplicate name (compare matches by name across copies)', () => {
		const r = one({ op: 'node.set', nodeId: 'A', field: 'name', value: 'farm b' });
		expect(r.problems[0]).toMatch(/duplicate node name/);
		expect(nodeOf(r.input, 'A')!.name).toBe('Farm A');
	});

	it('refuses flow shares over 100 % (the run would refuse them) and takes ones that fit', () => {
		const b = base();
		b.settings = { ...b.settings, flowShareMethod: 'manual' };
		for (const [id, v] of [['A', 0.4], ['B', 0.3], ['C', 0.3]] as const) nodeOf(b, id)!.flowShareManual = v;
		const r = one({ op: 'node.set', nodeId: 'A', field: 'flowShareManual', value: 0.9 }, b);
		expect(r.problems[0]).toMatch(/flow shares sum to 150\.00%, more than 100%/);
		expect(nodeOf(r.input, 'A')!.flowShareManual).toBe(0.4);
		expect(one({ op: 'node.set', nodeId: 'A', field: 'flowShareManual', value: 0.2 }, b).problems).toEqual([]);
		const hiLo = base();
		hiLo.settings = { ...hiLo.settings, flowShareMethod: 'hiLo' };
		expect(one({ op: 'settings.set', path: 'hiLoSplit.hi', value: 0.95 }, hiLo).problems[0]).toMatch(/sum to 114\.00%/);
	});

	it('node.set refuses a drought borehole rule on a farm without a dam', () => {
		const b = base();
		nodeOf(b, 'B')!.boreholeCapacityM3Day = 100;
		expect(one({ op: 'node.set', nodeId: 'B', field: 'boreholeRule', value: 'drought' }, b).problems[0]).toMatch(/drought borehole rule needs a farm dam/);
		expect(one({ op: 'node.set', nodeId: 'A', field: 'boreholeRule', value: 'drought' }, b).problems).toEqual([]);
	});

	it('node.add adds a leaf with the engine defaults for fields it leaves out', () => {
		const add = node('N', { name: 'New dam', downstreamNodeId: 'B', damCapacityM3: 30_000, areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0 });
		const r = one({ op: 'node.add', node: add });
		expect(r.problems).toEqual([]);
		const n = nodeOf(r.input, 'N')!;
		expect(n.boreholeRule).toBe('supplemental');
		expect(n.userPriority).toBe('senior');
		expect(() => buildTopology(r.input.model.nodes)).not.toThrow();
	});

	it('node.add takes a supply rule and river pump, and checks them (WP-3.8)', () => {
		const add = (over: Record<string, unknown>) =>
			one({ op: 'node.add', node: node('N', { name: 'Pump scheme', downstreamNodeId: 'B', damCapacityM3: 0, areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0, ...over }) });
		const r = add({ supplyRule: 'runOfRiver', pumpCapacityM3Day: 1200, supplyTriggerPct: 0.4, supplyStopPct: 0.6 });
		expect(r.problems).toEqual([]);
		expect(nodeOf(r.input, 'N')).toMatchObject({ supplyRule: 'runOfRiver', pumpCapacityM3Day: 1200 });
		expect(add({ supplyRule: 'always' }).problems[0]).toMatch(/supplyRule must be one of damFirst, riverFirst, trigger, runOfRiver/);
		expect(add({ pumpCapacityM3Day: -1 }).problems[0]).toMatch(/pumpCapacityM3Day/);
		expect(add({ supplyStopPct: 1.5 }).problems[0]).toMatch(/supplyStopPct/);
	});

	it('node.add rejects a used id, an unknown downstream node and a duplicate name', () => {
		expect(one({ op: 'node.add', node: node('A', { name: 'X', downstreamNodeId: 'G' }) }).problems[0]).toMatch(/already in use/);
		expect(one({ op: 'node.add', node: node('N', { downstreamNodeId: 'nowhere' }) }).problems[0]).toMatch(/unknown node nowhere/);
		expect(one({ op: 'node.add', node: node('N', { name: 'Farm A', downstreamNodeId: 'G' }) }).problems[0]).toMatch(/duplicate node name/);
	});

	it('node.remove re-links upstream nodes and drops every reference to the node', () => {
		const r = one({ op: 'node.remove', nodeId: 'A' });
		expect(r.problems).toEqual([]);
		expect(nodeOf(r.input, 'A')).toBeUndefined();
		expect(nodeOf(r.input, 'C')!.downstreamNodeId).toBe('G');
		expect(r.input.model.cropAreas.map((a) => a.nodeId)).toEqual(['C']);
		expect(r.input.model.transfers).toEqual([]);
		expect((r.input.settings.ewrRules ?? []).map((t) => t.siteNodeId)).toEqual(['G']);
		expect(r.applied[0]!.notes.join('; ')).toMatch(/now drains into G.*1 crop area.*1 transfer.*1 EWR rule table/);
		const topo = buildTopology(r.input.model.nodes);
		expect(r.input.model.nodes[topo.outflow]!.id).toBe('G');
	});

	it('node.remove drops land cover on the node, and refuses the outflow node and a missing one', () => {
		expect(one({ op: 'node.remove', nodeId: 'B' }).input.model.landCover).toEqual([]);
		expect(one({ op: 'node.remove', nodeId: 'G' }).problems[0]).toMatch(/outflow node and can't be removed/);
		expect(one({ op: 'node.remove', nodeId: 'nope' }).problems[0]).toMatch(/not found/);
	});

	it('node.remove keeps a valid tree on a deep chain with a fan above the removed node', () => {
		const b = base();
		b.model.nodes.push(node('D', { downstreamNodeId: 'C' }), node('E', { downstreamNodeId: 'C' }), node('F', { downstreamNodeId: 'E' }));
		let x = b;
		for (const id of ['C', 'E', 'A']) {
			const r = applyScenario(x, [{ op: 'node.remove', nodeId: id }]);
			expect(r.problems).toEqual([]);
			expect(() => buildTopology(r.input.model.nodes)).not.toThrow();
			x = r.input;
		}
		expect(x.model.nodes.map((n) => `${n.id}→${n.downstreamNodeId}`).sort()).toEqual(['B→G', 'D→G', 'F→G', 'G→null']);
	});

	it('cropArea.set upserts one row, 0 removes it, and it refuses non-farms and unknown crops', () => {
		expect(one({ op: 'cropArea.set', nodeId: 'A', cropId: 'c1', areaM2: 1 }).input.model.cropAreas[0]).toEqual({ nodeId: 'A', cropId: 'c1', areaM2: 1 });
		expect(one({ op: 'cropArea.set', nodeId: 'B', cropId: 'c1', areaM2: 5 }).input.model.cropAreas).toHaveLength(3);
		expect(one({ op: 'cropArea.set', nodeId: 'A', cropId: 'c1', areaM2: 0 }).input.model.cropAreas.map((a) => a.nodeId)).toEqual(['C']);
		expect(one({ op: 'cropArea.set', nodeId: 'G', cropId: 'c1', areaM2: 5 }).problems[0]).toMatch(/crops grow on farms/);
		expect(one({ op: 'cropArea.set', nodeId: 'A', cropId: 'zz', areaM2: 5 }).problems[0]).toMatch(/crop zz not found/);
	});

	it('crop.add adds a crop and refuses a used id or name', () => {
		const crop = { id: 'c2', name: 'Citrus', cropFactor: new Array(12).fill(0.7) };
		expect(one({ op: 'crop.add', crop }).input.model.crops.map((c) => c.id)).toEqual(['c1', 'c2']);
		expect(one({ op: 'crop.add', crop: { ...crop, id: 'c1' } }).problems[0]).toMatch(/already in use/);
		expect(one({ op: 'crop.add', crop: { ...crop, name: 'lucerne' } }).problems[0]).toMatch(/duplicate crop name/);
	});

	it('transfer.add / set / remove', () => {
		const t = { id: 't2', fromNodeId: 'A', toNodeId: 'B', months: [12, 1, 1], maxRateM3s: 0.1, dailyCapM3: 500, minStoragePct: 0.3, enabled: true, priority: 1 };
		const added = one({ op: 'transfer.add', transfer: t });
		expect(added.input.model.transfers[1]!.months).toEqual([1, 12]);
		expect(one({ op: 'transfer.add', transfer: { ...t, toNodeId: 'A' } }).problems[0]).toMatch(/from a node to itself/);
		expect(one({ op: 'transfer.add', transfer: { ...t, toNodeId: 'zz' } }).problems[0]).toMatch(/toNodeId zz not found/);
		expect(one({ op: 'transfer.add', transfer: { ...t, id: 't1' } }).problems[0]).toMatch(/already in use/);

		expect(one({ op: 'transfer.set', transferId: 't1', field: 'maxRateM3s', value: 0.2 }).input.model.transfers[0]!.maxRateM3s).toBe(0.2);
		expect(one({ op: 'transfer.set', transferId: 't1', field: 'toNodeId', value: 'C' }).problems[0]).toMatch(/itself/);
		expect(one({ op: 'transfer.set', transferId: 'zz', field: 'enabled', value: false }).problems[0]).toMatch(/transfer zz not found/);

		expect(one({ op: 'transfer.remove', transferId: 't1' }).input.model.transfers).toEqual([]);
		expect(one({ op: 'transfer.remove', transferId: 'zz' }).problems).toHaveLength(1);
	});

	it('landCover.add / remove', () => {
		const p = { id: 'lc2', nodeId: 'A', coverClass: 'invasive' as const, areaKm2: 0.5, densityPct: 1, factors: null };
		expect(one({ op: 'landCover.add', patch: p }).input.model.landCover).toHaveLength(2);
		expect(one({ op: 'landCover.add', patch: { ...p, nodeId: 'G' } }).problems[0]).toMatch(/lies on a farm/);
		expect(one({ op: 'landCover.add', patch: { ...p, id: 'lc1' } }).problems[0]).toMatch(/already in use/);
		expect(one({ op: 'landCover.remove', patchId: 'lc1' }).input.model.landCover).toEqual([]);
		expect(one({ op: 'landCover.remove', patchId: 'zz' }).problems[0]).toMatch(/not found/);
	});

	it('borehole.add / remove (WP-3.9), and a removed node takes its boreholes with it', () => {
		const b = { id: 'bh1', nodeId: 'A', name: 'New', capacityM3Day: 500, annualCapM3: 40_000, mode: 'supplemental' as const, emergencyBelowPct: 0.3, target: 'direct' as const, depletionFactor: 0.2 };
		const added = one({ op: 'borehole.add', borehole: b });
		expect(added.input.model.boreholes).toEqual([b]);
		expect(one({ op: 'borehole.add', borehole: { ...b, nodeId: 'G' } }).problems[0]).toMatch(/is a gauge/);
		expect(applyScenario(base(), [{ op: 'borehole.add', borehole: b }, { op: 'borehole.add', borehole: b }]).problems[0]).toMatch(/already in use/);
		expect(applyScenario(base(), [{ op: 'borehole.add', borehole: b }, { op: 'borehole.remove', boreholeId: 'bh1' }]).input.model.boreholes).toEqual([]);
		expect(one({ op: 'borehole.remove', boreholeId: 'zz' }).problems[0]).toMatch(/not found/);
		const gone = applyScenario(base(), [{ op: 'borehole.add', borehole: { ...b, nodeId: 'B' } }, { op: 'node.remove', nodeId: 'B' }]);
		expect(gone.input.model.boreholes).toEqual([]);
		expect(gone.applied.flatMap((a) => a.notes)).toContain('dropped 1 borehole(s)');
		expect(validateScenarioOps([{ op: 'borehole.add', borehole: { ...b, mode: 'sometimes' } }]).errors[0]).toMatch(/ops\[0\]\.borehole\.mode/);
		expect(classifyOp({ op: 'borehole.add', borehole: b }, ['A'], base())).toBe('proposal');
		expect(classifyOp({ op: 'borehole.add', borehole: { ...b, nodeId: 'B' } }, ['A'], base())).toBe('baseline');
	});

	it('settings.set writes a whitelisted path, nested ones over what is there', () => {
		const r = applyScenario(base(), [
			{ op: 'settings.set', path: 'lakeEvapFactor', value: 0.7 },
			{ op: 'settings.set', path: 'calibration.a', value: 0.2 },
			{ op: 'settings.set', path: 'calibration.summerMonths', value: [12, 1, 1, 2] }
		]);
		expect(r.problems).toEqual([]);
		expect(r.input.settings.lakeEvapFactor).toBe(0.7);
		expect(r.input.settings.calibration).toEqual({ a: 0.2, summerMonths: [1, 2, 12] });
	});

	it('settings.set refuses an unknown path, a bad value and a window that ends before it starts', () => {
		expect(one({ op: 'settings.set', path: 'fitRecord', value: null } as unknown as ScenarioOp).problems[0]).toMatch(/not a setting a scenario can change/);
		expect(one({ op: 'settings.set', path: 'runoffModel', value: 'pitman' } as unknown as ScenarioOp).problems[0]).toMatch(/must be one of/);
		const r = applyScenario(base(), [
			{ op: 'settings.set', path: 'reportStart', value: '2021-06-01' },
			{ op: 'settings.set', path: 'reportEnd', value: '2021-01-01' }
		]);
		expect(r.applied).toHaveLength(1);
		expect(r.problems[0]).toMatch(/op 2 \(settings\.set\): the reporting window starts/);
	});

	it('settings.set pe replaces GR4J\'s PE input whole, checked, and is baseline (engine ≥ 0.31.0)', () => {
		const mm = [110, 130, 150, 160, 140, 115, 75, 45, 30, 30, 45, 75];
		const monthly = { kind: 'monthly', mm, source: 'farm AWS FAO-56 ET₀' } as const;
		const r = applyScenario(base(), [{ op: 'settings.set', path: 'pe', value: monthly as never }]);
		expect(r.problems).toEqual([]);
		expect(r.input.settings.pe).toEqual(monthly);
		// A copy: editing the op afterwards doesn't reach the applied input.
		expect(r.input.settings.pe).not.toBe(monthly);
		expect(one({ op: 'settings.set', path: 'pe', value: { kind: 'pan' } }).input.settings.pe).toEqual({ kind: 'pan' });
		const err = (value: unknown) => one({ op: 'settings.set', path: 'pe', value } as unknown as ScenarioOp).problems[0];
		expect(err('monthly')).toMatch(/must be a PE input/);
		expect(err({ kind: 'etc' })).toMatch(/kind must be one of pan, monthly/);
		expect(err({ kind: 'pan', mm })).toMatch(/unknown field\(s\) mm for kind pan/);
		expect(err({ ...monthly, mm: mm.slice(1) })).toMatch(/mm must be 12 monthly values/);
		expect(err({ ...monthly, mm: [...mm.slice(1), -1] })).toMatch(/mm month 12: must be at least 0/);
		expect(err({ ...monthly, mm: [NaN, ...mm.slice(1)] })).toMatch(/mm month 1: must be a finite number/);
		expect(err({ ...monthly, mm: [10_001, ...mm.slice(1)] })).toMatch(/mm month 1: must be at most 10000/);
		expect(err({ ...monthly, source: ' ' })).toMatch(/source must say where the monthly PE came from/);
		expect(err({ kind: 'monthly', mm })).toMatch(/source must say/);
		expect(err({ ...monthly, source: 'x'.repeat(601) })).toMatch(/at most 600 characters/);
		expect(err({ ...monthly, note: 'x' })).toMatch(/unknown field\(s\) note/);
		// Positive control: the longest source note is fine.
		expect(err({ ...monthly, source: 'x'.repeat(600) })).toBeUndefined();
		// Validated at the API boundary too, and rebuilt as given.
		const v = validateScenarioOps([{ op: 'settings.set', path: 'pe', value: monthly }, { op: 'settings.set', path: 'pe', value: { kind: 'monthly', mm } }]);
		expect(v.ops).toEqual([{ op: 'settings.set', path: 'pe', value: monthly }]);
		expect(v.errors).toEqual(['ops[1].value: source must say where the monthly PE came from']);
		expect(classifyOp({ op: 'settings.set', path: 'pe', value: monthly as never }, ['A'])).toBe('baseline');
	});

	it('series.scale scales the days in range, keeps missing days, and copies only that series', () => {
		const b = base();
		b.series.rain_catchment_mm!.values[34] = null;
		const r = one({ op: 'series.scale', kind: 'rain_catchment_mm', factor: 0.9, from: '2020-11-04', to: '2020-11-06' }, b);
		const [before, after] = [b.series.rain_catchment_mm!.values, r.input.series.rain_catchment_mm!.values];
		// 2020-11-04 is day 34 (missing), 35 is 6 mm, 36 is 0.
		expect(after.slice(33, 38)).toEqual([before[33], null, 6 * 0.9, 0, before[37]]);
		expect(r.applied[0]!.notes).toEqual(['2 day(s) scaled']);
		expect(after).not.toBe(before);
		const whole = one({ op: 'series.scale', kind: 'rain_catchment_mm', factor: 2 }, b);
		expect(whole.input.series.rain_catchment_mm!.values[0]).toBe(80);
	});

	it('series.scale refuses a series the base lacks, a range outside it and an unscalable kind', () => {
		expect(one({ op: 'series.scale', kind: 'rain_chirps_mm', factor: 2 }).problems[0]).toMatch(/no rain_chirps_mm series/);
		expect(one({ op: 'series.scale', kind: 'rain_catchment_mm', factor: 2, from: '2030-01-01' }).problems[0]).toMatch(/no day/);
		expect(one({ op: 'series.scale', kind: 'flow_observed_m3s', factor: 2 } as unknown as ScenarioOp).problems[0]).toMatch(/can't be scaled/);
	});
});

describe('applyScenario: the whole list', () => {
	it('never mutates the base (deep-frozen), whatever the ops do', () => {
		const b = deepFreeze(base());
		const ops: ScenarioOp[] = [
			{ op: 'node.set', nodeId: 'A', field: 'damCapacityM3', value: 1 },
			{ op: 'transfer.set', transferId: 't1', field: 'months', value: [4, 2] },
			{ op: 'node.remove', nodeId: 'A' },
			{ op: 'cropArea.set', nodeId: 'C', cropId: 'c1', areaM2: 9 },
			{ op: 'landCover.remove', patchId: 'lc1' },
			{ op: 'settings.set', path: 'calibration.a', value: 0.3 },
			{ op: 'series.scale', kind: 'rain_catchment_mm', factor: 0.5 }
		];
		const snapshot = JSON.stringify(b);
		const r = applyScenario(b, ops);
		expect(r.problems).toEqual([]);
		expect(JSON.stringify(b)).toBe(snapshot);
		expect(r.input.model).not.toBe(b.model);
	});

	it('applies in order: a later op sees an earlier one, and one on a removed target is a problem', () => {
		const r = applyScenario(base(), [
			{ op: 'node.set', nodeId: 'A', field: 'name', value: 'Upper dam' },
			{ op: 'node.remove', nodeId: 'C' },
			{ op: 'cropArea.set', nodeId: 'C', cropId: 'c1', areaM2: 1 },
			{ op: 'node.set', nodeId: 'A', field: 'damCapacityM3', value: 1 }
		]);
		expect(r.applied.map((a) => a.index)).toEqual([0, 1, 3]);
		expect(r.problems).toEqual(['op 3 (cropArea.set): node C not found']);
	});

	it('an empty list returns an equal input', () => {
		const b = base();
		const r = applyScenario(b, []);
		expect(r.input).toEqual(b);
		expect(r).toMatchObject({ applied: [], problems: [] });
	});

	it('refuses to remove the last land: runModel needs a catchment area', () => {
		const b = base();
		for (const id of ['A', 'C']) Object.assign(nodeOf(b, id)!, { areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0 });
		expect(one({ op: 'node.remove', nodeId: 'B' }, b).problems[0]).toMatch(/no area left/);
		expect(one({ op: 'node.set', nodeId: 'B', field: 'areaKm2', value: 0 }, b).problems[0]).toMatch(/no area left/);
		// With the area set by hand the land can go.
		b.settings.calibration = { catchmentAreaKm2: 20 } as never;
		expect(one({ op: 'node.remove', nodeId: 'B' }, b).problems).toEqual([]);
	});

	it('a renamed node whose name has parentheses still passes every invariant', () => {
		// The order-invariance check sorts the name lists in warnings; a "(…)" in a name once broke that.
		const r = one({ op: 'node.set', nodeId: 'A', field: 'name', value: 'Farm A (upper)' });
		expect(runModel(r.input).summary.warnings.join(' ')).toMatch(/\(Farm A \(upper\); Farm C\)/);
		for (const seed of [1, 2, 3, 4, 5, 6]) expect(checkAll(r.input, seed)).toBeNull();
	});

	it('an op on a base that already has a structural issue still applies when it adds none', () => {
		const b = base();
		b.model.transfers.push({ ...b.model.transfers[0]!, id: 't9', fromNodeId: 'G' });
		b.model.nodes[0]!.kind = 'user';
		// The base has a transfer from a user; renaming a farm doesn't make that worse.
		expect(one({ op: 'node.set', nodeId: 'A', field: 'name', value: 'Renamed' }, b).problems).toEqual([]);
	});
});

describe('a dam raise', () => {
	const series = (out: { series: RunSeries[] }, nodeId: string) =>
		Object.fromEntries(out.series.filter((s) => s.nodeId === nodeId).map((s) => [s.key, s.values]));

	it('raising A’s dam 20 % changes A and what is downstream of it, never C upstream or B beside it', () => {
		const b = base();
		// Nothing else couples them: no transfer (t1 would let C send more into a bigger dam) and no EWR to share.
		b.model.transfers = [];
		const r = applyScenario(b, [{ op: 'node.set', nodeId: 'A', field: 'damCapacityM3', value: 200_000 * 1.2 }]);
		expect(r.problems).toEqual([]);
		const before = runModel(b);
		const after = runModel(r.input);
		expect(series(after, 'C')).toEqual(series(before, 'C'));
		expect(series(after, 'B')).toEqual(series(before, 'B'));
		expect(series(after, 'A').dam_storage).not.toEqual(series(before, 'A').dam_storage);
		const peak = (xs: number[]) => Math.max(...xs);
		expect(peak(series(after, 'A').dam_storage!)).toBeGreaterThan(peak(series(before, 'A').dam_storage!));
		expect(peak(series(after, 'A').dam_storage!)).toBeLessThanOrEqual(240_000);
	});

	it('gives identical results whatever the node order after applying (model.md §6)', () => {
		const r = applyScenario(base(), [{ op: 'node.set', nodeId: 'A', field: 'damCapacityM3', value: 240_000 }]);
		const a = runModel(r.input);
		for (const seed of [1, 2, 3]) {
			const s = runModel(scrambleOrder(r.input, seed));
			const key = (x: RunSeries) => `${x.nodeId}|${x.key}`;
			expect(new Map(s.series.map((x) => [key(x), x.values]))).toEqual(new Map(a.series.map((x) => [key(x), x.values])));
		}
	});
});

describe('demand.scale (issue #53 R1)', () => {
	const series = (out: { series: RunSeries[] }, nodeId: string) =>
		Object.fromEntries(out.series.filter((s) => s.nodeId === nodeId).map((s) => [s.key, s.values]));
	/** The base with an other water user U below A taking 1,000 m³/day every month. */
	const withUser = () => {
		const b = base();
		b.model.nodes.push(node('U', { name: 'Town', kind: 'user', downstreamNodeId: 'G', areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0, userDemandM3Day: new Array(12).fill(1000), sortOrder: 4 }));
		return b;
	};
	const ones = new Array<number>(12).fill(1);

	it('scales every farm by default, some farms and months when asked, and stacks', () => {
		const all = one({ op: 'demand.scale', factor: 0.85 });
		expect(all.problems).toEqual([]);
		expect(all.applied[0]!.notes).toEqual(['3 farm(s) scaled']);
		for (const id of ['A', 'B', 'C']) expect(nodeOf(all.input, id)!.demandFactor).toEqual(new Array(12).fill(0.85));
		expect(nodeOf(all.input, 'G')!.demandFactor).toBeUndefined();
		// Only A, in October and November (calendar months 10 and 11: water-year months 0 and 1).
		const some = one({ op: 'demand.scale', factor: 0.7, nodeIds: ['A'], months: [11, 10] });
		expect(some.applied[0]!.notes).toEqual([]);
		expect(nodeOf(some.input, 'A')!.demandFactor).toEqual([0.7, 0.7, ...ones.slice(2)]);
		expect(nodeOf(some.input, 'B')!.demandFactor).toBeUndefined();
		// January is water-year month 3, September month 11.
		expect(nodeOf(one({ op: 'demand.scale', factor: 0.5, nodeIds: ['B'], months: [1, 9] }).input, 'B')!.demandFactor).toEqual([1, 1, 1, 0.5, 1, 1, 1, 1, 1, 1, 1, 0.5]);
		const twice = applyScenario(base(), [
			{ op: 'demand.scale', factor: 0.9, nodeIds: ['A'] },
			{ op: 'demand.scale', factor: 0.9, nodeIds: ['A'], months: [10] }
		]);
		expect(nodeOf(twice.input, 'A')!.demandFactor![0]).toBeCloseTo(0.81, 12);
		expect(nodeOf(twice.input, 'A')!.demandFactor![1]).toBe(0.9);
	});

	it("scales the farm's crop requirement and abstraction, never its gross demand, rain or efficiency", () => {
		const b = base();
		const r = applyScenario(b, [{ op: 'demand.scale', factor: 0.85, nodeIds: ['A'], months: [12, 1, 2] }]);
		const out = runModel(b);
		const [x, y] = [series(out, 'A'), series(runModel(r.input), 'A')];
		expect(y.gross_demand).toEqual(x.gross_demand);
		expect(y.effective_rain).toEqual(x.effective_rain);
		expect(y.soil_water).toEqual(x.soil_water);
		let scaled = 0;
		const day0 = toEpochDay(out.startDate);
		for (let t = 0; t < x.demand!.length; t++) {
			const k = [12, 1, 2].includes(monthOfEpochDay(day0 + t)) ? 0.85 : 1;
			if (k !== 1 && x.demand![t]! > 0) scaled++;
			expect(y.crop_requirement![t]).toBeCloseTo(k * x.crop_requirement![t]!, 9);
			expect(y.demand![t]).toBeCloseTo(k * x.demand![t]!, 9);
			expect(y.demand![t]).toBeCloseTo(y.crop_requirement![t]! / 0.8, 9);
			expect(y.supplied![t]!).toBeLessThanOrEqual(y.demand![t]! * (1 + 1e-12));
		}
		expect(scaled).toBeGreaterThan(30);
		expect(checkAll(r.input)).toBeNull();
	});

	it("category 'user' scales the other water users' demand only", () => {
		const b = withUser();
		const r = applyScenario(b, [{ op: 'demand.scale', factor: 0.5, category: 'user' }]);
		expect(r.problems).toEqual([]);
		expect(r.applied[0]!.notes).toEqual(['1 other water user(s) scaled']);
		expect(nodeOf(r.input, 'A')!.demandFactor).toBeUndefined();
		const [x, y] = [runModel(b), runModel(r.input)];
		expect(series(y, 'U').demand!.every((v) => v === 500)).toBe(true);
		expect(series(y, 'A').demand).toEqual(series(x, 'A').demand);
		expect(checkAll(r.input)).toBeNull();
	});

	it('refuses a missing node, a node of another category and a category the model has none of', () => {
		expect(one({ op: 'demand.scale', factor: 0.8, nodeIds: ['A', 'Z'] }).problems).toEqual(['op 1 (demand.scale): node Z not found']);
		expect(one({ op: 'demand.scale', factor: 0.8, nodeIds: ['G'] }).problems).toEqual(['op 1 (demand.scale): "Outlet gauge" is a gauge, not a farm']);
		expect(one({ op: 'demand.scale', factor: 0.8, nodeIds: ['U'] }, withUser()).problems).toEqual(['op 1 (demand.scale): "Town" is an other water user, not a farm']);
		expect(one({ op: 'demand.scale', factor: 0.8, nodeIds: ['A'], category: 'user' }, withUser()).problems).toEqual(['op 1 (demand.scale): "Farm A" is a farm, not an other water user']);
		expect(one({ op: 'demand.scale', factor: 0.8, category: 'user' }).problems).toEqual(['op 1 (demand.scale): the model has no other water user to scale']);
		// Unchecked input (a stored op from before a validator change) meets the same rules.
		expect(one({ op: 'demand.scale', factor: 3 }).problems).toEqual(['op 1 (demand.scale): factor must be at most 2']);
		expect(one({ op: 'demand.scale', factor: 1, months: [] }).problems[0]).toMatch(/months must be a list of at least one calendar month/);
		// A skipped op changes nothing.
		expect(one({ op: 'demand.scale', factor: 0.8, nodeIds: ['A', 'Z'] }).input.model).toEqual(base().model);
	});

	it('run comparison lists it', () => {
		const r = one({ op: 'demand.scale', factor: 0.85, nodeIds: ['A'], months: [10] });
		const snap = (x: ModelInput) => ({ settings: x.settings, model: x.model, series: {} });
		expect(diffInputs(snap(base()), snap(r.input)).map((c) => c.text)).toEqual(['Farm A: demand factor none → 0.85, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1 × (Oct–Sep)']);
	});
});

describe('classifyOp', () => {
	const owned = ['A'];
	const b = base();
	const cls = (op: ScenarioOp) => classifyOp(op, owned, b);

	it('the applicant’s own dam, crops, transfers and land cover are the proposal', () => {
		expect(cls({ op: 'node.set', nodeId: 'A', field: 'damCapacityM3', value: 1 })).toBe('proposal');
		expect(cls({ op: 'cropArea.set', nodeId: 'A', cropId: 'c1', areaM2: 1 })).toBe('proposal');
		expect(cls({ op: 'crop.add', crop: { id: 'x', name: 'x', cropFactor: new Array(12).fill(1) } })).toBe('proposal');
		expect(cls({ op: 'landCover.add', patch: { id: 'p', nodeId: 'A', coverClass: 'pine', areaKm2: 1, densityPct: 1, factors: null } })).toBe('proposal');
		expect(classifyOp({ op: 'transfer.remove', transferId: 't1' }, ['A', 'C'], b)).toBe('proposal');
	});

	it('settings, series, other parties’ nodes and the own farm’s land and flow share are baseline', () => {
		expect(cls({ op: 'settings.set', path: 'lakeEvapFactor', value: 0.5 })).toBe('baseline');
		expect(cls({ op: 'series.scale', kind: 'rain_catchment_mm', factor: 0.9 })).toBe('baseline');
		// demand.scale: a proposal only on the author's own nodes, named (issue #53 R1).
		expect(cls({ op: 'demand.scale', factor: 0.85, nodeIds: ['A'] })).toBe('proposal');
		expect(cls({ op: 'demand.scale', factor: 0.85, nodeIds: ['A'], months: [1], category: 'farm' })).toBe('proposal');
		expect(cls({ op: 'demand.scale', factor: 0.85, nodeIds: ['A', 'B'] })).toBe('baseline');
		expect(cls({ op: 'demand.scale', factor: 0.85 })).toBe('baseline');
		expect(classifyOp({ op: 'demand.scale', factor: 0.85, category: 'user' }, ['A', 'B', 'C'], b)).toBe('baseline');
		expect(cls({ op: 'node.set', nodeId: 'B', field: 'damCapacityM3', value: 1 })).toBe('baseline');
		expect(cls({ op: 'node.set', nodeId: 'A', field: 'areaKm2', value: 9 })).toBe('baseline');
		expect(cls({ op: 'node.set', nodeId: 'A', field: 'flowShareManual', value: 0.9 })).toBe('baseline');
		expect(cls({ op: 'landCover.remove', patchId: 'lc1' })).toBe('baseline');
		// t1 runs C → A: it touches C, which A's owner doesn't own.
		expect(cls({ op: 'transfer.set', transferId: 't1', field: 'enabled', value: false })).toBe('baseline');
		expect(classifyOp({ op: 'transfer.set', transferId: 't1', field: 'fromNodeId', value: 'B' }, ['A', 'C'], b)).toBe('baseline');
	});

	it('new nodes: a pump or dam without land is a proposal, a gauge or new land is baseline', () => {
		const pump = node('N', { downstreamNodeId: 'A', areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0 });
		expect(cls({ op: 'node.add', node: pump })).toBe('proposal');
		expect(cls({ op: 'node.add', node: { ...pump, areaKm2: 1 } })).toBe('baseline');
		expect(cls({ op: 'node.add', node: { ...pump, kind: 'gauge' } })).toBe('baseline');
		expect(cls({ op: 'node.add', node: { ...pump, flowShareManual: 0.9 } })).toBe('baseline');
	});

	it('removing a node needs the input, and is baseline for land or a gauge', () => {
		const noLand = base();
		Object.assign(nodeOf(noLand, 'A')!, { areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0 });
		noLand.settings.ewrRules = [blankEwrRuleTable('G')];
		expect(classifyOp({ op: 'node.remove', nodeId: 'A' }, owned, noLand)).toBe('proposal');
		expect(classifyOp({ op: 'node.remove', nodeId: 'A' }, owned)).toBe('baseline');
		expect(cls({ op: 'node.remove', nodeId: 'A' })).toBe('baseline');
		// A (land-free) still hosts an EWR rule table, which the removal drops.
		expect(classifyOp({ op: 'node.remove', nodeId: 'A' }, owned, { ...noLand, settings: { ...noLand.settings, ewrRules: [blankEwrRuleTable('A')] } })).toBe('baseline');
		Object.assign(nodeOf(noLand, 'A')!, { flowShareManual: 0.3 });
		expect(classifyOp({ op: 'node.remove', nodeId: 'A' }, owned, noLand)).toBe('baseline');
	});

	it('classifyScenario counts nodes the scenario added as owned', () => {
		const pump = node('N', { downstreamNodeId: 'A', areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0, damCapacityM3: 1000 });
		const ops: ScenarioOp[] = [
			{ op: 'node.add', node: pump },
			{ op: 'node.set', nodeId: 'N', field: 'damCapacityM3', value: 2000 },
			{ op: 'transfer.add', transfer: { id: 't2', fromNodeId: 'N', toNodeId: 'A', months: [1], maxRateM3s: 0.1, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0 } },
			{ op: 'transfer.set', transferId: 't2', field: 'maxRateM3s', value: 0.2 },
			{ op: 'node.set', nodeId: 'B', field: 'damCapacityM3', value: 1 }
		];
		expect(classifyScenario(base(), ops, owned)).toEqual(['proposal', 'proposal', 'proposal', 'proposal', 'baseline']);
	});
});

describe('validateScenarioOps', () => {
	it('accepts every op kind and rebuilds it from known fields only', () => {
		const raw = [
			{ op: 'node.set', nodeId: 'A', field: 'damCapacityM3', value: 1, extra: 'dropped' },
			{ op: 'node.add', node: { ...node('N', { downstreamNodeId: 'A' }), junk: 1 } },
			{ op: 'node.remove', nodeId: 'A' },
			{ op: 'cropArea.set', nodeId: 'A', cropId: 'c1', areaM2: 0 },
			{ op: 'crop.add', crop: { id: 'c2', name: 'Citrus', cropFactor: new Array(12).fill(0.7) } },
			{ op: 'transfer.add', transfer: { id: 't2', fromNodeId: 'A', toNodeId: 'B', months: [1], maxRateM3s: 1, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0 } },
			{ op: 'transfer.set', transferId: 't1', field: 'dailyCapM3', value: null },
			{ op: 'transfer.remove', transferId: 't1' },
			{ op: 'landCover.add', patch: { id: 'p', nodeId: 'A', coverClass: 'pine', areaKm2: 1, densityPct: 1, factors: { mar: 0.1, lowFlow: 0.2 } } },
			{ op: 'landCover.remove', patchId: 'lc1' },
			{ op: 'settings.set', path: 'reportStart', value: null },
			{ op: 'series.scale', kind: 'rain_catchment_mm', factor: 0.9, from: '2021-01-01', to: '2021-12-31' },
			{ op: 'demand.scale', factor: 0.85 },
			{ op: 'demand.scale', factor: 0.7, nodeIds: ['A', 'B'], months: [12, 1], category: 'farm', junk: true }
		];
		const { ops, errors } = validateScenarioOps(raw);
		expect(errors).toEqual([]);
		expect(ops).toHaveLength(raw.length);
		expect(ops[0]).toEqual({ op: 'node.set', nodeId: 'A', field: 'damCapacityM3', value: 1 });
		expect('junk' in (ops[1] as { node: object }).node).toBe(false);
		// Optional fields stay out when not given, so the stored op (and its hash) is what was sent.
		expect(ops[12]).toEqual({ op: 'demand.scale', factor: 0.85 });
		expect(ops[13]).toEqual({ op: 'demand.scale', factor: 0.7, nodeIds: ['A', 'B'], months: [12, 1], category: 'farm' });
	});

	it('checks demand.scale: the factor 0–2, a non-empty list of distinct nodes and months, the category', () => {
		const { ops, errors } = validateScenarioOps([
			{ op: 'demand.scale', factor: 2.5 },
			{ op: 'demand.scale', factor: -0.1 },
			{ op: 'demand.scale' },
			{ op: 'demand.scale', factor: 1, nodeIds: [] },
			{ op: 'demand.scale', factor: 1, nodeIds: ['A', 'A'] },
			{ op: 'demand.scale', factor: 1, nodeIds: 'A' },
			{ op: 'demand.scale', factor: 1, months: [] },
			{ op: 'demand.scale', factor: 1, months: [0, 13] },
			{ op: 'demand.scale', factor: 1, months: [3, 3] },
			{ op: 'demand.scale', factor: 1, category: 'gauge' },
			{ op: 'demand.scale', factor: 0, nodeIds: ['A'], months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], category: 'user' }
		]);
		expect(errors).toEqual([
			'ops[0].factor: must be at most 2',
			'ops[1].factor: must be at least 0',
			'ops[2].factor: missing',
			'ops[3].nodeIds: must be a list of at least one node id (leave it out for every node of the category)',
			'ops[4].nodeIds: names a node more than once',
			'ops[5].nodeIds: must be a list of at least one node id (leave it out for every node of the category)',
			'ops[6].months: must be a list of at least one calendar month (leave it out for every month)',
			'ops[7].months: months must be whole numbers 1–12',
			'ops[8].months: names a month more than once',
			'ops[9].category: must be one of farm, user'
		]);
		expect(ops).toEqual([{ op: 'demand.scale', factor: 0, nodeIds: ['A'], months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], category: 'user' }]);
	});

	it('takes a crop’s own irrigation efficiency and the monthly effective-rain fraction (engine 0.43.0)', () => {
		const crop = { id: 'c2', name: 'Citrus', cropFactor: new Array(12).fill(0.5) };
		const f = new Array(12).fill(0.6);
		const good = validateScenarioOps([
			{ op: 'crop.add', crop: { ...crop, irrigationEfficiency: 0.9 } },
			{ op: 'crop.add', crop: { ...crop, id: 'c3', name: 'Olives', irrigationEfficiency: null } },
			{ op: 'settings.set', path: 'effectiveRainFractionMonthly', value: f },
			{ op: 'settings.set', path: 'effectiveRainFractionMonthly', value: null }
		]);
		expect(good.errors).toEqual([]);
		expect((good.ops[0] as { crop: { irrigationEfficiency?: number } }).crop.irrigationEfficiency).toBe(0.9);
		const bad = validateScenarioOps([
			{ op: 'crop.add', crop: { ...crop, irrigationEfficiency: 0 } },
			{ op: 'settings.set', path: 'effectiveRainFractionMonthly', value: [...f.slice(0, 11), 1.5] }
		]);
		expect(bad.ops).toEqual([]);
		expect(bad.errors).toHaveLength(2);
		// Applied, the scenario runs the crop on its own efficiency.
		expect(one({ op: 'crop.add', crop: { ...crop, irrigationEfficiency: 0.9 } }).input.model.crops.find((c) => c.id === 'c2')?.irrigationEfficiency).toBe(0.9);
	});

	it('names every error by path and drops the bad entries', () => {
		const { ops, errors } = validateScenarioOps([
			{ op: 'node.set', nodeId: 'A', field: 'kind', value: 'gauge' },
			{ op: 'node.set', nodeId: 'A', field: 'damMinPct', value: 2 },
			{ op: 'settings.set', path: 'simulationStart', value: '2021-02-30' },
			{ op: 'series.scale', kind: 'flow_observed_m3s', factor: 1 },
			{ op: 'series.scale', kind: 'rain_catchment_mm', factor: 11, from: '2022-01-01', to: '2021-01-01' },
			{ op: 'crop.add', crop: { id: 'c', name: '', cropFactor: [1] } },
			{ op: 'teleport' },
			'node.remove',
			{ op: 'node.remove', nodeId: 'A' }
		]);
		expect(ops).toEqual([{ op: 'node.remove', nodeId: 'A' }]);
		expect(errors).toEqual([
			'ops[0].field: is not a node field a scenario can set',
			'ops[1].value: must be at most 1',
			'ops[2].value: must be an ISO date (YYYY-MM-DD)',
			'ops[3].kind: must be one of rain_catchment_mm, rain_chirps_mm, rain_forecast_mm, evap_apan_mm',
			'ops[4].factor: must be at most 10',
			'ops[4]: from 2022-01-01 is after to 2021-01-01',
			'ops[5].crop.name: must be a name of 1–100 characters',
			'ops[5].crop.cropFactor: must be 12 crop factors ≥ 0',
			expect.stringMatching(/^ops\[6\]\.op: must be one of node\.set/),
			'ops[7]: must be an object'
		]);
	});

	it('rejects a non-list and an over-long list', () => {
		expect(validateScenarioOps({}).errors).toEqual(['ops: must be a list']);
		expect(validateScenarioOps(new Array(501).fill({ op: 'node.remove', nodeId: 'A' })).errors[0]).toMatch(/at most 500/);
	});
});

describe('mask: names (an application judged in its applicant’s namespace, WP-3.3)', () => {
	// The applicant owns A; B and C are hidden, shown to them as "Farm 1" and "Farm 2".
	const masked = { nodes: { B: 'Farm 1', C: 'Farm 2' }, crops: ['c1'] };
	const rename = (nodeId: string, value: string): ScenarioOp => ({ op: 'node.set', nodeId, field: 'name', value });

	it('never mutates the base, and restores every hidden name when nothing took it', () => {
		const b = deepFreeze(base());
		const r = applyScenario(b, [{ op: 'node.set', nodeId: 'A', field: 'damCapacityM3', value: 250_000 }], { mask: masked });
		expect(r.problems).toEqual([]);
		expect(r.renamed).toEqual([]);
		expect(r.input.model.nodes.map((n) => n.name)).toEqual(b.model.nodes.map((n) => n.name));
		expect(r.input.model.crops.map((c) => c.name)).toEqual(['Lucerne']);
	});

	it('lets an op take a hidden name, and suffixes the hidden one past every name in use', () => {
		const added: ScenarioOp = { op: 'node.add', node: { ...nodeOf(base(), 'B')!, id: 'N', name: 'Farm B (2)', downstreamNodeId: 'G' } };
		const r = applyScenario(base(), [added, rename('A', 'farm b')], { mask: masked });
		expect(r.problems).toEqual([]);
		expect(nodeOf(r.input, 'A')!.name).toBe('farm b');
		expect(nodeOf(r.input, 'B')!.name).toBe('Farm B (3)');
		expect(r.renamed).toEqual([{ kind: 'node', id: 'B', name: 'Farm B', as: 'Farm B (3)' }]);
		// Unmasked, the same rename is refused.
		expect(applyScenario(base(), [rename('A', 'farm b')]).problems).toEqual(['op 1 (node.set): duplicate node name "farm b"']);
	});

	it('quotes the mask name, never the real one, in what it says about a hidden node', () => {
		const r = applyScenario(base(), [{ op: 'node.remove', nodeId: 'A' }], { mask: masked });
		expect(r.applied[0]!.notes[0]).toBe('"Farm 2" now drains into G');
		expect(JSON.stringify([r.applied, r.problems])).not.toContain('Farm C');
	});

	it('classifies as applyScenario applies: a node added under a hidden name is still the applicant’s', () => {
		const add: ScenarioOp = { op: 'node.add', node: { ...nodeOf(base(), 'B')!, id: 'N', name: 'Farm C', downstreamNodeId: 'A', areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0 } };
		const set: ScenarioOp = { op: 'node.set', nodeId: 'N', field: 'damCapacityM3', value: 10 };
		expect(classifyScenario(base(), [add, set], ['A'], { mask: masked })).toEqual(['proposal', 'proposal']);
		// Unmasked the add collides, so N never exists and the set on it is the baseline's.
		expect(classifyScenario(base(), [add, set], ['A'])).toEqual(['proposal', 'baseline']);
	});

	it('leaves a hidden node an op renamed under the op’s name', () => {
		const r = applyScenario(base(), [rename('B', 'Something else')], { mask: masked });
		expect(nodeOf(r.input, 'B')!.name).toBe('Something else');
		expect(r.renamed).toEqual([]);
	});
});

describe('mask: ids, counts and value rules (docs/followups.md "Hidden ids and counts")', () => {
	// The applicant owns A. Hidden: nodes B and C, crop c2 (on C), transfer t2
	// (C → B), land-cover patch lc1 (on B) and borehole bh1 (on C). t1 (C → A)
	// touches A, so they see it.
	function baseM(): ModelInput {
		const b = base();
		b.model.crops.push({ id: 'c2', name: 'Pecans', cropFactor: new Array(12).fill(0.6) });
		b.model.cropAreas.push({ nodeId: 'C', cropId: 'c2', areaM2: 100_000 });
		b.model.transfers.push({ id: 't2', fromNodeId: 'C', toNodeId: 'B', months: [6], maxRateM3s: 0.01, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0 });
		b.model.boreholes = [
			{ id: 'bh1', nodeId: 'C', name: 'Secret hole', capacityM3Day: 100, annualCapM3: null, mode: 'emergency', emergencyBelowPct: 0.3, target: 'direct', depletionFactor: 0 }
		];
		return b;
	}
	const mask: ScenarioMask = { nodes: { B: 'Farm 1', C: 'Farm 2' }, crops: ['c2'], transfers: ['t2'], landCover: ['lc1'], boreholes: ['bh1'] };
	const apply = (ops: ScenarioOp[], b = baseM()) => applyScenario(b, ops, { mask });
	/** What the applicant is told: what applied (with its notes) and the problems, the probed id written as ID. */
	const told = (r: ReturnType<typeof applyScenario>, id: string) => JSON.stringify([r.applied, r.problems]).replaceAll(id, 'ID');

	const targeting: [string, string, (id: string) => ScenarioOp][] = [
		['transfer.set', 't2', (id) => ({ op: 'transfer.set', transferId: id, field: 'maxRateM3s', value: 1 })],
		['transfer.remove', 't2', (id) => ({ op: 'transfer.remove', transferId: id })],
		['landCover.remove', 'lc1', (id) => ({ op: 'landCover.remove', patchId: id })],
		['borehole.remove', 'bh1', (id) => ({ op: 'borehole.remove', boreholeId: id })],
		['cropArea.set', 'c2', (id) => ({ op: 'cropArea.set', nodeId: 'A', cropId: id, areaM2: 10 })]
	];

	it.each(targeting)('%s on a hidden id answers exactly as on a free one (not found)', (_, hidden, op) => {
		const h = apply([op(hidden)]);
		const f = apply([op('free-id')]);
		expect(h.problems).toEqual([expect.stringMatching(/not found$/)]);
		expect(told(h, hidden)).toBe(told(f, 'free-id'));
		expect([h.renamed, h.reIds]).toEqual([[], []]);
		// Positive control: unmasked (a team scenario) the hidden id is found and the op applies.
		expect(applyScenario(baseM(), [op(hidden)]).problems).toEqual([]);
	});

	const reusing: [string, string, (id: string) => ScenarioOp][] = [
		['transfer', 't2', (id) => ({ op: 'transfer.add', transfer: { id, fromNodeId: 'A', toNodeId: 'C', months: [1], maxRateM3s: 0.02, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 1 } })],
		['crop', 'c2', (id) => ({ op: 'crop.add', crop: { id, name: 'Olives', cropFactor: new Array(12).fill(0.5) } })],
		['landCover', 'lc1', (id) => ({ op: 'landCover.add', patch: { id, nodeId: 'A', coverClass: 'pine', areaKm2: 0.5, densityPct: 0.4, factors: null } })],
		[
			'borehole',
			'bh1',
			(id) => ({
				op: 'borehole.add',
				borehole: { id, nodeId: 'A', name: 'New hole', capacityM3Day: 50, annualCapM3: null, mode: 'supplemental', emergencyBelowPct: 0.3, target: 'direct', depletionFactor: 0 }
			})
		]
	];
	const listOf = (x: ModelInput, kind: string) =>
		(({ crop: x.model.crops, transfer: x.model.transfers, landCover: x.model.landCover ?? [], borehole: x.model.boreholes ?? [] }) as Record<string, { id: string }[]>)[kind]!;

	it.each(reusing)('a new %s reusing a hidden id applies exactly as a free one, and moves to a fresh id', (kind, hidden, op) => {
		// Frozen: masking and restoring never touch the base.
		const h = apply([op(hidden)], deepFreeze(baseM()));
		const f = apply([op('free-id')]);
		expect(h.problems).toEqual([]);
		expect(told(h, hidden)).toBe(told(f, 'free-id'));
		expect(h.reIds).toEqual([{ kind, id: hidden, as: `${hidden}-2` }]);
		expect(f.reIds).toEqual([]);
		// The hidden item keeps its id and everything else, so it still lines up with the base by id.
		expect(listOf(h.input, kind).find((x) => x.id === hidden)).toEqual(listOf(baseM(), kind).find((x) => x.id === hidden));
		expect(listOf(h.input, kind).filter((x) => x.id === `${hidden}-2`)).toHaveLength(1);
		expect(structureIssues(h.input)).toEqual(structureIssues(baseM()));
		// Positive control: unmasked, the id is in use.
		expect(applyScenario(baseM(), [op(hidden)]).problems).toEqual([expect.stringMatching(/already in use$/)]);
	});

	it('moves the crop areas an op gave a new crop under a hidden crop’s id with it, and leaves the hidden one’s alone', () => {
		const r = apply([reusing[1]![2]('c2'), { op: 'cropArea.set', nodeId: 'A', cropId: 'c2', areaM2: 5_000 }]);
		expect(r.problems).toEqual([]);
		expect(r.input.model.cropAreas.filter((a) => a.cropId.startsWith('c2'))).toEqual([
			{ nodeId: 'C', cropId: 'c2', areaM2: 100_000 },
			{ nodeId: 'A', cropId: 'c2-2', areaM2: 5_000 }
		]);
		expect(r.input.model.crops.find((c) => c.id === 'c2')!.name).toBe('Pecans');
	});

	it('meets no hidden crop whatever the new crop is named (the opaque names are ones no op holds)', () => {
		for (const name of ['#crop1#', '#crop2#', 'pecans']) {
			const r = apply([{ op: 'crop.add', crop: { id: 'n1', name, cropFactor: new Array(12).fill(0.5) } }]);
			expect(r.problems, name).toEqual([]);
		}
	});

	it('counts only what the applicant sees of what a removed node drops', () => {
		// C carries crop areas of c1 and of the hidden c2, t1 (C → A, visible), and the hidden t2 and bh1.
		expect(apply([{ op: 'node.remove', nodeId: 'C' }]).applied[0]!.notes).toEqual(['dropped 1 transfer(s)']);
		expect(apply([{ op: 'node.remove', nodeId: 'B' }]).applied[0]!.notes).toEqual([]);
		// Positive control: unmasked, every count.
		expect(applyScenario(baseM(), [{ op: 'node.remove', nodeId: 'C' }]).applied[0]!.notes).toEqual(['dropped 2 crop area(s)', 'dropped 2 transfer(s)', 'dropped 1 borehole(s)']);
		expect(applyScenario(baseM(), [{ op: 'node.remove', nodeId: 'B' }]).applied[0]!.notes).toEqual(['dropped 1 transfer(s)', 'dropped 1 land-cover patch(es)']);
		// Their own farm still counts what is theirs, and the EWR table sited there (settings are theirs to see).
		expect(apply([{ op: 'node.remove', nodeId: 'A' }]).applied[0]!.notes).toEqual([
			'"Farm 2" now drains into G',
			'dropped 1 crop area(s)',
			'dropped 1 transfer(s)',
			'dropped 1 EWR rule table(s) sited there'
		]);
	});

	it('says only that the op doesn’t apply to the catchment as modelled when hidden data breaks a rule', () => {
		// C's dam gone: the hidden borehole bh1 (emergency mode) and C's drought rule both need it.
		const b = baseM();
		Object.assign(nodeOf(b, 'C')!, { boreholeCapacityM3Day: 200, boreholeRule: 'drought' });
		const op: ScenarioOp = { op: 'node.set', nodeId: 'C', field: 'damCapacityM3', value: 0 };
		expect(apply([op], b).problems).toEqual([`op 1 (node.set): ${MASKED_RULE}`]);
		// Positive control: unmasked, the rules and the borehole are named.
		const plain = applyScenario(b, [op]).problems;
		expect(plain).toHaveLength(1);
		expect(plain[0]).toContain('Secret hole');
		expect(plain[0]).toContain('drought borehole rule');
	});

	it('says only that for the catchment-wide value rules too, while any node is hidden', () => {
		const b = baseM();
		(b.settings as Record<string, unknown>).flowShareMethod = 'manual';
		nodeOf(b, 'C')!.flowShareManual = 0.5;
		const shares: ScenarioOp = { op: 'node.set', nodeId: 'A', field: 'flowShareManual', value: 0.6 };
		expect(applyScenario(b, [shares]).problems).toEqual([expect.stringContaining('more than 100%')]);
		expect(apply([shares], b).problems).toEqual([`op 1 (node.set): ${MASKED_RULE}`]);
		// No land left once their own farm's goes, because no hidden farm has any.
		const dry = baseM();
		for (const id of ['B', 'C']) Object.assign(nodeOf(dry, id)!, { areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0 });
		const noLand: ScenarioOp[] = (['areaKm2', 'areaHiKm2', 'areaLoKm2'] as const).map((field) => ({ op: 'node.set', nodeId: 'A', field, value: 0 }));
		const plain = applyScenario(dry, noLand).problems;
		expect(plain).toEqual([expect.stringContaining('the catchment has no area left')]);
		expect(apply(noLand, dry).problems).toEqual([plain[0]!.replace(/: the catchment has no area left.*$/, `: ${MASKED_RULE}`)]);
		// With no node hidden, nothing to hide: the rule keeps its words.
		expect(applyScenario(b, [shares], { mask: { crops: ['c2'] } }).problems).toEqual(applyScenario(b, [shares]).problems);
	});

	it('classifies as it applies: an op on a hidden id meets the applicant’s own item, never the hidden one', () => {
		const ops: ScenarioOp[] = [reusing[0]![2]('t2'), { op: 'transfer.set', transferId: 't2', field: 'maxRateM3s', value: 0.03 }];
		const r = apply(ops);
		expect(r.problems).toEqual([]);
		expect(r.input.model.transfers.find((t) => t.id === 't2')!.maxRateM3s).toBe(0.01);
		expect(r.input.model.transfers.find((t) => t.id === 't2-2')!.maxRateM3s).toBe(0.03);
		expect(classifyScenario(baseM(), ops, ['A', 'C'], { mask })).toEqual(['proposal', 'proposal']);
		// Unmasked the add collides, so the set meets the C → B transfer: not wholly theirs.
		expect(classifyScenario(baseM(), ops, ['A', 'C'])).toEqual(['proposal', 'baseline']);
	});
});
