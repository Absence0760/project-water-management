// The basic-needs floor (engine 1.38.0, issue #123, docs/model.md §2.7f): a
// restriction (the demand.scale factor) never cuts a domestic or municipal
// demand object below population × 25 l per person a day; days and volume
// supplied below the floor are reported apart from the ordinary shortfall;
// the curtailment report never leaves the unit less than its floor.
import { describe, expect, it } from 'vitest';
import type { Monthly } from './calendar';
import { basicNeedsM3Day, basicNeedsPopulation, BASIC_NEEDS_SERIES } from './network/demandObjects';
import type { CropArea, CropDef, DemandObject, ModelInput, NetworkNode, RunSeries } from './project';
import { runModel, runModelWith, withVerification } from './run';
import { cloneInput, randomInput } from './testing/fuzz';
import { checkAll } from './testing/invariants';
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

// 1 000 people at 230 l a day: 230 m³/day, a floor of 25 m³/day.
const village = (over: Partial<DemandObject> = {}): DemandObject => ({
	id: 'village',
	nodeId: 'A',
	name: 'Village',
	category: 'domestic',
	sizing: 'perUnit',
	monthlyM3Day: null,
	count: 1000,
	litresPerUnitDay: 230,
	lossPct: 0,
	monthlyFactor: null,
	returnPct: 0,
	priority: 'first',
	destination: 'internal',
	enabled: true,
	note: '',
	...over
});

// Unit A (no dam) drains to gauge G; its crop needs 100 m³/day at efficiency 0.5 (200 abstracted).
function model(objects: DemandObject[], natural: number[], factor: number | null): { input: ModelInput; natural: number[] } {
	const crops: CropDef[] = [{ id: 'c', name: 'Crop', cropFactor: flat(1) }];
	const cropAreas: CropArea[] = [{ nodeId: 'A', cropId: 'c', areaM2: 1000 }];
	return {
		natural,
		input: {
			settings: { ewrPragmaticM3PerDay: flat(0) as unknown as Monthly, apanMm: flat(3100) as unknown as Monthly },
			model: {
				nodes: [
					node('A', { downstreamNodeId: 'G', pctRunoffToDam: 1, irrigationEfficiency: 0.5, ...(factor === null ? {} : { demandFactor: flat(factor) }) }),
					node('G', { kind: 'gauge', areaKm2: 0, sortOrder: 1 })
				],
				crops,
				cropAreas,
				transfers: [],
				demandObjects: objects
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
const passed = (out: ReturnType<typeof run>) => expect(out.summary.verification?.passed, JSON.stringify(out.summary.verification?.checks.filter((c) => !c.passed))).toBe(true);

describe('the basic-needs floor of a demand object (engine 1.38.0)', () => {
	it('is engine 1.38.0 or later', () => {
		const [maj, min] = ENGINE_VERSION.split('.').map(Number);
		expect(maj! > 1 || (maj === 1 && min! >= 38)).toBe(true);
	});

	it('is population × 25 l a day, from a per-unit count or an entered population, on domestic and municipal objects only', () => {
		expect(basicNeedsM3Day(village())).toBe(25);
		// Grossed up for distribution losses, as the demand is, so the 25 l reach the tap.
		expect(basicNeedsM3Day(village({ lossPct: 0.2 }))).toBeCloseTo(31.25, 12);
		expect(basicNeedsM3Day(village({ population: 400 }))).toBe(10);
		expect(basicNeedsM3Day(village({ category: 'municipal', sizing: 'monthly', count: null, monthlyM3Day: flat(400), population: 2000 }))).toBe(50);
		// A monthly object without a population, and people's water only: no floor.
		expect(basicNeedsM3Day(village({ category: 'municipal', sizing: 'monthly', count: null, monthlyM3Day: flat(400) }))).toBeNull();
		for (const category of ['industrial', 'livestock', 'irrigation', 'external', 'other'] as const) expect(basicNeedsPopulation(village({ category }))).toBeNull();
		expect(basicNeedsPopulation(village({ count: 0 }))).toBeNull();
		expect(basicNeedsPopulation(village({ population: -5 }))).toBeNull();
	});

	// Day 0: plenty. Day 1: 30 m³ for 45 wanted. Day 2: 10 m³, under the floor.
	const natural = [400, 30, 10];
	const out = run(model([village()], natural, 0.1));

	it('holds a restriction at the floor: MAX(demand × factor, MIN(floor, demand))', () => {
		// 230 × 0.1 = 23 < 25: the village keeps 25; the crops are cut to 20.
		expect(get(out, 'A', 'object_demand@village')).toEqual([25, 25, 25]);
		expect(get(out, 'A', 'demand')).toEqual([45, 45, 45]);
		expect(get(out, 'A', BASIC_NEEDS_SERIES.key)).toEqual([25, 25, 25]);
		passed(out);
	});

	it('reports the days and volume below the floor apart from the shortfall, and the litres per person supplied', () => {
		expect(get(out, 'A', 'object_supplied@village')).toEqual([25, 25, 10]);
		const o = out.summary.farms[0]!.demandObjects![0]!;
		expect(o.basicNeedsPopulation).toBe(1000);
		expect(o.basicNeedsM3Day).toBe(25);
		expect(o.daysShort).toBe(1);
		expect(o.daysBelowBasicNeeds).toBe(1);
		expect(o.avgBelowBasicNeedsM3Day).toBeCloseTo(5, 12);
		expect(o.avgSuppliedLitresPerPersonDay).toBeCloseTo(20, 12);
	});

	it('counts a day short but above the floor as short only', () => {
		// No restriction: demand 230 + 200. Day 1 gives the village (first) 30 of its 230: short, not below 25.
		const o = run(model([village()], natural, null)).summary.farms[0]!.demandObjects![0]!;
		expect(o.daysShort).toBe(2);
		expect(o.daysBelowBasicNeeds).toBe(1);
		expect(o.avgBelowBasicNeedsM3Day).toBeCloseTo(5, 12);
	});

	it('leaves a factor of 1 or more, and a cut above the floor, as they were, to the bit', () => {
		for (const factor of [null, 1, 1.5, 0.5]) {
			const withFloor = run(model([village()], natural, factor));
			const without = run(model([village({ category: 'other' })], natural, factor));
			for (const key of ['object_demand@village', 'object_supplied@village', 'demand', 'supplied', 'outflow']) expect(get(withFloor, 'A', key)).toEqual(get(without, 'A', key));
			passed(withFloor);
		}
	});

	it('holds a full cut (factor 0) at the floor, and a smaller demand than the floor at its demand', () => {
		expect(get(run(model([village()], natural, 0)), 'A', 'object_demand@village')).toEqual([25, 25, 25]);
		// 100 people at 230 l: 23 m³/day, a floor of 2.5; cut to 0.1 → 2.3 → held at 2.5.
		expect(get(run(model([village({ count: 100 })], natural, 0.1)), 'A', 'object_demand@village')[0]).toBeCloseTo(2.5, 12);
		// 1 000 people at 20 l (below the 25 l floor): the floor is the whole demand, 20 m³/day.
		const small = run(model([village({ litresPerUnitDay: 20 })], natural, 0.1));
		expect(get(small, 'A', 'object_demand@village')).toEqual([20, 20, 20]);
		expect(get(small, 'A', BASIC_NEEDS_SERIES.key)).toEqual([20, 20, 20]);
		passed(small);
	});

	it('keeps a day its schedule switches off off', () => {
		const off = run(
			model([village({ schedule: [{ label: 'Off', span: 'range', from: '2020-10-02', to: '2020-10-02', easterFrom: null, easterTo: null, weekdays: null, factor: 0 }] })], natural, 0.1)
		);
		expect(get(off, 'A', 'object_demand@village')).toEqual([25, 0, 25]);
		expect(get(off, 'A', BASIC_NEEDS_SERIES.key)).toEqual([25, 0, 25]);
		const o = off.summary.farms[0]!.demandObjects![0]!;
		expect(o.daysOff).toBe(1);
		expect(o.daysBelowBasicNeeds).toBe(1);
		passed(off);
	});

	it('runs a population that isn’t a number ≥ 0 (which a save refuses) as no floor, with a warning', () => {
		const bad = run(model([village({ population: -5 })], natural, 0.1));
		expect(get(bad, 'A', 'object_demand@village')[0]).toBeCloseTo(23, 12);
		expect(bad.summary.warnings.join()).toMatch(/population -5 is not a number ≥ 0; it has no basic-needs floor/);
	});

	it('has no basic_needs column and no floor figures without a floor', () => {
		const none = run(model([village({ category: 'livestock' })], natural, 0.1));
		expect(none.series.some((s) => s.key === BASIC_NEEDS_SERIES.key)).toBe(false);
		const o = none.summary.farms[0]!.demandObjects![0]!;
		expect(o.basicNeedsM3Day).toBeUndefined();
		expect(o.daysBelowBasicNeeds).toBeUndefined();
		expect(none.summary.curtailment!.farms[0]!.basicNeedsM3Day).toBeUndefined();
	});

	it('puts the floor on the curtailment row, whose volume left is never below it', () => {
		const row = out.summary.curtailment!.farms[0]!;
		expect(row.basicNeedsM3Day).toBe(25);
		expect(row.volumeLeftM3Day).toBeGreaterThanOrEqual(25);
		expect(row.basicNeedsHeldM3Day).toBe(0);
	});

	it('is caught by the self-check when the restriction cuts through the floor', () => {
		// The run checked against the model without the people: the object's demand no longer adds up.
		const bare = model([village({ category: 'other' })], natural, 0.1).input;
		const bad = verifyRun(bare, out).verification;
		expect(bad.passed).toBe(false);
		expect(JSON.stringify(bad.checks.filter((c) => !c.passed))).toMatch(/basic_needs|demand object/);
	});
});

describe('the basic-needs floor on random networks', () => {
	it('keeps every invariant under a restriction on every unit, and changes nothing without people', () => {
		let withFloor = 0;
		for (let seed = 1; seed <= 60; seed++) {
			const base = randomInput(seed, { maxDays: 300 });
			if (!base.model.demandObjects?.some((o) => basicNeedsM3Day(o) !== null)) continue;
			withFloor++;
			// A restriction (the demand.scale factor) on every unit, from a full cut to none.
			const input = cloneInput(base);
			const cuts = [0, 0.1, 0.5, 1];
			input.model.nodes.forEach((n, i) => {
				if (n.kind === 'farm') n.demandFactor = flat(cuts[(seed + i) % cuts.length]!);
			});
			expect(checkAll(input, seed), `seed ${seed}`).toBeNull();
			// Without any floor the same restriction only scales: the floor never lowers an object's demand, and
			// on a unit whose factor is 1 it changes nothing.
			// (A full allocation rescales the unit's whole demand to its registered volume, so a floor there
			// legitimately lowers the other objects' share: compared without it.)
			const floored = cloneInput(input);
			floored.settings.allocationMode = 'none';
			const bare = cloneInput(floored);
			for (const o of bare.model.demandObjects!) Object.assign(o, { population: null, category: 'other' });
			const a = runModel(floored);
			const b = runModel(bare);
			const factorOf = new Map(input.model.nodes.map((n) => [n.id, n.demandFactor?.[0] ?? 1]));
			for (const s of a.series) {
				if (!s.key.startsWith('object_demand@')) continue;
				const t = b.series.find((x) => x.nodeId === s.nodeId && x.key === s.key)!.values;
				if (factorOf.get(s.nodeId!)! >= 1) expect(s.values, `seed ${seed} ${s.key}`).toEqual(t);
				else s.values.forEach((v, d) => expect(v, `seed ${seed} ${s.key} day ${d}`).toBeGreaterThanOrEqual(t[d]!));
			}
		}
		expect(withFloor).toBeGreaterThan(3);
	}, 300_000);
});
