// Demand objects on a unit (engine 1.7.0, issue #54 item 2b, docs/model.md
// §2.7f): their demand adds to the crops', the unit's supply is split by
// priority class, each returns its own share, and a model without any runs
// exactly as before.
import { describe, expect, it } from 'vitest';
import type { Monthly } from './calendar';
import type { CropArea, CropDef, DemandObject, DemandScheduleWindow, ModelInput, NetworkNode, RunSeries } from './project';
import { runModel, runModelWith, withVerification } from './run';
import { cloneInput, randomInput } from './testing/fuzz';
import { checkAll, sameOutput } from './testing/invariants';
import { verifyRun } from './verify/verify';
import { ENGINE_VERSION } from './version';

const flat = (v: number) => new Array(12).fill(v);

function node(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind: 'farm',
		downstreamNodeId: null,
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
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

const object = (over: Partial<DemandObject> = {}): DemandObject => ({
	id: 'town',
	nodeId: 'A',
	name: 'Town',
	category: 'municipal',
	sizing: 'monthly',
	monthlyM3Day: flat(50),
	count: null,
	litresPerUnitDay: null,
	lossPct: 0,
	monthlyFactor: null,
	returnPct: 0.5,
	priority: 'first',
	destination: 'internal',
	enabled: true,
	note: '',
	...over
});

// Unit A (no dam; everything it gets comes from its own runoff, routed to its
// absent dam) drains to gauge G. Its crop needs 100 m³/day in October at
// efficiency 0.5 (200 m³/day abstracted), half the losses returning.
function model(objects: DemandObject[] | undefined, natural = [400, 100, 0]): { input: ModelInput; natural: number[] } {
	const crops: CropDef[] = [{ id: 'c', name: 'Crop', cropFactor: flat(1) }];
	const cropAreas: CropArea[] = [{ nodeId: 'A', cropId: 'c', areaM2: 1000 }];
	return {
		natural,
		input: {
			settings: { ewrPragmaticM3PerDay: flat(0) as unknown as Monthly, apanMm: flat(3100) as unknown as Monthly },
			model: {
				nodes: [node('A', { downstreamNodeId: 'G', pctRunoffToDam: 1, irrigationEfficiency: 0.5, lossReturnFraction: 0.5 }), node('G', { kind: 'gauge', areaKm2: 0, sortOrder: 1 })],
				crops,
				cropAreas,
				transfers: [],
				...(objects ? { demandObjects: objects } : {})
			},
			series: { rain_catchment_mm: { startDate: '2020-10-01', values: natural.map(() => 0) } }
		}
	};
}

const run = (m: { input: ModelInput; natural: number[] }) => withVerification(m.input, runModelWith(m.input, () => ({ naturalFlowM3Day: m.natural })));
function get(out: { series: RunSeries[] }, nodeId: string | null, key: string): number[] {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}/${key}`);
	return s.values;
}

describe('demand objects in a run (engine 1.7.0)', () => {
	it('is engine 1.7.0 or later', () => {
		// Numerically, part by part: as strings '1.10.0' < '1.7.0'.
		const [maj, min] = ENGINE_VERSION.split('.').map(Number);
		expect(maj! > 1 || (maj === 1 && min! >= 7)).toBe(true);
	});

	const out = run(model([object()]));

	it('adds the object’s demand to the crops’ abstraction demand', () => {
		expect(get(out, 'A', 'crop_requirement')).toEqual([100, 100, 100]);
		expect(get(out, 'A', 'demand')).toEqual([250, 250, 250]);
		expect(get(out, 'A', 'object_demand@town')).toEqual([50, 50, 50]);
	});

	it('serves a first-priority object before the crops, and returns its share of what it got', () => {
		// Day 0: 400 runoff meets all 250. Day 1: 100: the town takes its 50 first, the crops get 50. Day 2: nothing.
		expect(get(out, 'A', 'supplied')).toEqual([250, 100, 0]);
		expect(get(out, 'A', 'object_supplied@town')).toEqual([50, 50, 0]);
		// Return: β(1 − e) × the crops' part + 0.5 × the town's: 0.25 × 200 + 25, then 0.25 × 50 + 25.
		expect(get(out, 'A', 'return_flow')).toEqual([75, 37.5, 0]);
		// The outflow carries the spill and the return: day 0 = 150 unused + 75 back.
		expect(get(out, 'A', 'outflow')).toEqual([225, 37.5, 0]);
	});

	it('reports each object in the unit’s summary', () => {
		const f = out.summary.farms.find((x) => x.nodeId === 'A')!;
		const o = f.demandObjects![0]!;
		expect(f.demandObjects).toHaveLength(1);
		expect({ id: o.id, name: o.name, category: o.category, priority: o.priority, destination: o.destination, daysShort: o.daysShort }).toEqual({
			id: 'town',
			name: 'Town',
			category: 'municipal',
			priority: 'first',
			destination: 'internal',
			daysShort: 1
		});
		expect(o.avgDemandM3Day).toBeCloseTo(50, 12);
		expect(o.avgSuppliedM3Day).toBeCloseTo(100 / 3, 12);
		expect(o.avgDeficitM3Day).toBeCloseTo(50 / 3, 12);
		expect(o.fractionSupplied).toBeCloseTo(2 / 3, 12);
		expect(o.avgReturnedM3Day).toBeCloseTo(50 / 3, 12);
		expect(f.avgDemandM3Day).toBe(250);
	});

	it('passes every self-check', () => {
		expect(out.summary.verification?.passed, JSON.stringify(out.summary.verification?.checks.filter((c) => !c.passed))).toBe(true);
	});

	it('shares a short day pro rata with the crops, or waits for them, by priority', () => {
		const shared = run(model([object({ priority: 'shared' })]));
		// Day 1: 100 for 250 wanted, 40 % each.
		expect(get(shared, 'A', 'object_supplied@town')[1]).toBeCloseTo(20, 12);
		const last = run(model([object({ priority: 'last' })]));
		expect(get(last, 'A', 'object_supplied@town')[1]).toBe(0);
		expect(last.summary.verification?.passed).toBe(true);
		expect(shared.summary.verification?.passed).toBe(true);
	});

	it('returns nothing from water piped out of the catchment', () => {
		const ext = run(model([object({ destination: 'external', returnPct: 0 })]));
		expect(get(ext, 'A', 'return_flow')).toEqual([50, 12.5, 0]);
		expect(ext.summary.farms[0]!.demandObjects![0]!.avgReturnedM3Day).toBe(0);
	});

	it('scales with the unit’s demand factor, from the day it applies', () => {
		const m = model([object()]);
		m.input.model.nodes[0]!.demandFactor = flat(2);
		m.input.settings.demandFactorFrom = '2020-10-02';
		expect(get(run(m), 'A', 'object_demand@town')).toEqual([50, 100, 100]);
	});

	it('runs a model without objects, with an empty list or with only disabled ones exactly as before', () => {
		const none = run(model(undefined));
		for (const objects of [[], [object({ enabled: false })]]) expect(sameOutput(none, run(model(objects)))).toBe(true);
		expect(none.series.some((s) => s.key.startsWith('object_'))).toBe(false);
		expect(none.summary.farms[0]!.demandObjects).toBeUndefined();
	});
});

const window = (over: Partial<DemandScheduleWindow> = {}): DemandScheduleWindow => ({ label: '', span: 'always', from: null, to: null, easterFrom: null, easterTo: null, weekdays: null, factor: 0, ...over });

describe('a demand object’s schedule (engine 1.16.0, issue #90 Q4)', () => {
	it('is engine 1.16.0 or later', () => {
		const [maj, min] = ENGINE_VERSION.split('.').map(Number);
		expect(maj! > 1 || (maj === 1 && min! >= 16)).toBe(true);
	});

	// 2020-10-01 was a Thursday: the run is Thu, Fri, Sat, Sun. Plenty of water every day.
	const plenty = [400, 400, 400, 400];
	const weekendsOff = object({ schedule: [window({ label: 'Weekends', weekdays: [6, 7] })] });
	const out = run(model([weekendsOff], plenty));

	it('switches the object off on the days it covers: no demand, no supply, no return', () => {
		expect(get(out, 'A', 'object_demand@town')).toEqual([50, 50, 0, 0]);
		expect(get(out, 'A', 'object_supplied@town')).toEqual([50, 50, 0, 0]);
		// The crops keep their 200 abstracted; return 0.25 × 200 + 0.5 × the town's supply.
		expect(get(out, 'A', 'demand')).toEqual([250, 250, 200, 200]);
		expect(get(out, 'A', 'return_flow')).toEqual([75, 75, 50, 50]);
	});

	it('counts the days off apart from the days short, and passes every self-check', () => {
		const o = out.summary.farms.find((f) => f.nodeId === 'A')!.demandObjects![0]!;
		expect(o.daysOff).toBe(2);
		expect(o.daysShort).toBe(0);
		expect(o.avgDemandM3Day).toBe(25);
		expect(out.summary.verification?.passed, JSON.stringify(out.summary.verification?.checks.filter((c) => !c.passed))).toBe(true);
	});

	it('has no days-off figure on an object without a schedule', () => {
		expect(run(model([object()], plenty)).summary.farms[0]!.demandObjects![0]!.daysOff).toBeUndefined();
	});

	it('multiplies the month’s demand, after the unit’s demand factor, and a peak can exceed 1', () => {
		const m = model([object({ schedule: [window({ span: 'range', from: '2020-10-02', to: '2020-10-03', factor: 1.5 })] })], plenty);
		m.input.model.nodes[0]!.demandFactor = flat(2);
		expect(get(run(m), 'A', 'object_demand@town')).toEqual([100, 150, 150, 100]);
	});

	it('is caught by the self-check when the demand ignores it', () => {
		// The same run checked against the model without the schedule: the objects' demand no longer adds up.
		const bare = model([object()], plenty).input;
		const bad = verifyRun(bare, out).verification;
		expect(bad.passed).toBe(false);
		expect(JSON.stringify(bad.checks.filter((c) => !c.passed))).toMatch(/demand object/);
	});

	it('runs a schedule that never changes a day (factor 1, or a window outside the run) exactly as no schedule', () => {
		const none = run(model([object()], plenty));
		for (const schedule of [[], [window({ factor: 1 })], [window({ span: 'range', from: '2019-01-01', to: '2019-12-31' })]]) {
			const withIt = run(model([object({ schedule })], plenty));
			// The series and supply match to the bit; only the days-off figure (0) is new.
			expect(withIt.series).toEqual(none.series);
		}
	});

	it('skips a malformed window with a warning and runs the rest', () => {
		const o = run(model([object({ schedule: [window({ label: 'Bad', factor: -1 }), window({ weekdays: [7] })] })], plenty));
		expect(get(o, 'A', 'object_demand@town')).toEqual([50, 50, 50, 0]);
		expect(o.summary.warnings.join()).toMatch(/schedule window 1 \("Bad"\) is skipped/);
	});
});

describe('demand objects on random networks', () => {
	it('keep every invariant and, removed, leave the rest of the seed as it was', () => {
		let withObjects = 0;
		for (let seed = 1; seed <= 60; seed++) {
			const input = randomInput(seed, { maxDays: 400 });
			if (!input.model.demandObjects?.length) continue;
			withObjects++;
			expect(checkAll(input, seed), `seed ${seed}`).toBeNull();
			// Every object switched off: the same run as the network without them.
			const off = cloneInput(input);
			for (const o of off.model.demandObjects!) o.enabled = false;
			const bare = cloneInput(input);
			delete bare.model.demandObjects;
			const a = runModel(off);
			const b = runModel(bare);
			// Warnings about objects on gauges and users differ; the numbers must not.
			expect(sameOutput({ ...a, summary: { ...a.summary, warnings: [] } }, { ...b, summary: { ...b.summary, warnings: [] } }), `seed ${seed}`).toBe(true);
		}
		expect(withObjects).toBeGreaterThan(5);
		// The fuzz gives half the objects a schedule (engine ≥ 1.16.0), so the checks above ran on some.
		let scheduled = 0;
		for (let seed = 1; seed <= 60; seed++) scheduled += (randomInput(seed, { maxDays: 400 }).model.demandObjects ?? []).filter((o) => o.schedule?.length).length;
		expect(scheduled).toBeGreaterThan(5);
	}, 300_000);
});
