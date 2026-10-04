// Ranked demand objects (engine 1.64.0, issue #343, docs/model.md §2.7f):
// within the 'first' and 'last' classes an object's rank orders it, equal
// ranks share pro rata, a 'shared' object ignores it, and a model without
// ranks runs exactly as before.
import { describe, expect, it } from 'vitest';
import type { Monthly } from './calendar';
import type { CropArea, CropDef, DemandObject, ModelInput, NetworkNode, RunSeries } from './project';
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
		returnFlowFraction: 0,
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
				nodes: [node('A', { downstreamNodeId: 'G', pctRunoffToDam: 1, irrigationEfficiency: 0.5, returnFlowFraction: 0.25 }), node('G', { kind: 'gauge', areaKm2: 0, sortOrder: 1 })],
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

const passed = (out: ReturnType<typeof run>) => expect(out.summary.verification?.passed, JSON.stringify(out.summary.verification?.checks.filter((c) => !c.passed))).toBe(true);

describe('ranked demand objects (engine 1.64.0, issue #343)', () => {
	it('is engine 1.64.0 or later', () => {
		const [maj, min] = ENGINE_VERSION.split('.').map(Number);
		expect(maj! > 1 || (maj === 1 && min! >= 64)).toBe(true);
	});

	const first = (id: string, rank: number | null) => object({ id, name: id, priority: 'first', rank });
	const last = (id: string, rank: number | null) => object({ id, name: id, priority: 'last', rank });

	it('supplies rank 1 before rank 2 before the crops', () => {
		// Day 1: 60 for 50 + 50 + 200: d1 is met, d2 gets the 10 left, the crops nothing.
		const out = run(model([first('d1', 1), first('d2', 2)], [400, 60, 0]));
		expect(get(out, 'A', 'object_supplied@d1')).toEqual([50, 50, 0]);
		expect(get(out, 'A', 'object_supplied@d2')).toEqual([50, 10, 0]);
		expect(get(out, 'A', 'supplied')).toEqual([300, 60, 0]);
		passed(out);
		// The other way round, by rank and not by id.
		const back = run(model([first('d1', 2), first('d2', 1)], [400, 60, 0]));
		expect(get(back, 'A', 'object_supplied@d1')[1]).toBe(10);
		expect(get(back, 'A', 'object_supplied@d2')[1]).toBe(50);
		passed(back);
	});

	it('shares pro rata between equal ranks, and none and 1 are one rank', () => {
		const out = run(model([first('d1', null), first('d2', 1)], [400, 60, 0]));
		expect(get(out, 'A', 'object_supplied@d1')[1]).toBe(30);
		expect(get(out, 'A', 'object_supplied@d2')[1]).toBe(30);
		passed(out);
	});

	it('orders the objects after the crops by rank too', () => {
		// Day 1: 270 for 200 + 50 + 50: the crops are met, l1 then l2 shares the 70 left.
		const out = run(model([last('l1', 1), last('l2', 2)], [400, 270, 0]));
		expect(get(out, 'A', 'object_supplied@l1')).toEqual([50, 50, 0]);
		expect(get(out, 'A', 'object_supplied@l2')).toEqual([50, 20, 0]);
		passed(out);
	});

	it('ignores a rank on a shared object: it always shares with the crops', () => {
		const plain = run(model([object({ priority: 'shared' })]));
		expect(sameOutput(plain, run(model([object({ priority: 'shared', rank: 3 })])))).toBe(true);
	});

	it('reports a rank in the unit’s summary only on an object that has one', () => {
		const out = run(model([first('d1', 1), first('d2', 2), object({ id: 'd3', name: 'd3', priority: 'last' })], [400, 60, 0]));
		const objs = out.summary.farms[0]!.demandObjects!;
		expect(objs.map((o) => o.rank)).toEqual([1, 2, undefined]);
	});

	it('is caught by the self-check when the order is not the model’s', () => {
		const ranked = model([first('d1', 1), first('d2', 2)], [400, 60, 0]);
		const out = run(ranked);
		const swapped = model([first('d1', 2), first('d2', 1)], [400, 60, 0]).input;
		const bad = verifyRun(swapped, out).verification;
		expect(bad.passed).toBe(false);
		expect(JSON.stringify(bad.checks.filter((c) => !c.passed))).toMatch(/supply level/);
	});

	it('runs a model without ranks exactly as one with every rank 1, on random networks', () => {
		let ranked = 0;
		for (let seed = 1; seed <= 60; seed++) {
			const input = randomInput(seed, { maxDays: 300 });
			if (!input.model.demandObjects?.length) continue;
			ranked += input.model.demandObjects.filter((o) => o.rank != null && o.priority !== 'shared').length;
			// The fuzz ranks some objects: the run keeps every invariant and self-check.
			expect(checkAll(input, seed), `seed ${seed}`).toBeNull();
			const none = cloneInput(input);
			for (const o of none.model.demandObjects!) delete o.rank;
			const ones = cloneInput(input);
			for (const o of ones.model.demandObjects!) o.rank = 1;
			const a = runModel(none);
			const b = runModel(ones);
			// The summary names an explicit rank 1; the numbers must not differ.
			const strip = (x: typeof a) => ({ ...x, summary: { ...x.summary, farms: x.summary.farms.map((f) => ({ ...f, demandObjects: f.demandObjects?.map(({ rank: _rank, ...o }) => o) })) } });
			expect(sameOutput(strip(a), strip(b)), `seed ${seed}`).toBe(true);
		}
		expect(ranked).toBeGreaterThan(3);
	}, 300_000);
});
