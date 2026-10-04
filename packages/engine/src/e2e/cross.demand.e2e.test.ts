// End-to-end, round 2: demand features combined on one unit, worked by hand
// from docs/model.md and run through the whole model with the self-checks on.
//
//   - a drought restriction (§2.7i) on a unit whose dam comes into service
//     part-way through the run (§2.7g), with a demand object on a weekday
//     schedule (§2.7f) and a basic-needs floor: the level a review decides
//     with no dam in service, on the in-service day and while the dam fills
//     (engine ≥ 1.70.0: a filling dam is left out of the reviews);
//   - demand objects (§2.7f) on the dam and on a river abstraction beside it
//     (§2.7j), a supplemental dam-target borehole (§2.7d) and an allocation
//     cap on both sources (§2.12a): who gets the surface room, day by day.
// Natural flow is fed directly (runModelWith). Synthetic names and values only.
import { describe, expect, it } from 'vitest';
import type { Monthly } from '../calendar';
import type { Borehole, DemandObject, DroughtRestrictionRule, ModelInput, ModelOutput, NetworkNode, RunSeries } from '../project';
import type { AllocationEntry } from '../allocations/compare';
import { runModelWith, withVerification } from '../run';
import { checkInvariants } from '../verify/checks';

const flat = (v: number) => new Array(12).fill(v);

function unit(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: `Unit ${id}`,
		kind: 'farm',
		downstreamNodeId: 'G',
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
const gauge = (): NetworkNode => unit('G', { kind: 'gauge', downstreamNodeId: null, areaKm2: 0, sortOrder: 9 });
const object = (id: string, category: DemandObject['category'], m3Day: number, over: Partial<DemandObject> = {}): DemandObject => ({
	id,
	nodeId: 'A',
	name: id,
	category,
	sizing: 'monthly',
	monthlyM3Day: flat(m3Day),
	count: null,
	litresPerUnitDay: null,
	lossPct: 0,
	monthlyFactor: null,
	returnPct: 0,
	priority: 'first',
	destination: 'internal',
	enabled: true,
	note: '',
	...over
});

function build(a: NetworkNode, o: { objects: DemandObject[]; start: string; days: number; settings?: Record<string, unknown>; boreholes?: Borehole[]; allocations?: AllocationEntry[] }): ModelInput {
	return {
		settings: { ewrPragmaticM3PerDay: flat(0) as unknown as Monthly, apanMm: flat(0) as unknown as Monthly, ...o.settings } as ModelInput['settings'],
		model: { nodes: [a, gauge()], crops: [], cropAreas: [], transfers: [], demandObjects: o.objects, ...(o.boreholes ? { boreholes: o.boreholes } : {}), ...(o.allocations ? { allocations: o.allocations } : {}) },
		series: { rain_catchment_mm: { startDate: o.start, values: new Array(o.days).fill(0) } }
	};
}
const run = (input: ModelInput, natural: number[]) => withVerification(input, runModelWith(input, () => ({ naturalFlowM3Day: natural })));
function get(out: { series: RunSeries[] }, nodeId: string | null, key: string): number[] {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}/${key}; have ${out.series.filter((x) => x.nodeId === nodeId).map((x) => x.key).join(', ')}`);
	return s.values;
}
const near = (a: number[], b: number[], digits = 9) => {
	expect(a.length).toBe(b.length);
	a.forEach((v, t) => expect(v, `day ${t}`).toBeCloseTo(b[t]!, digits));
};
function passes(input: ModelInput, out: ModelOutput) {
	expect(checkInvariants(input, out)).toBeNull();
	expect(out.summary.verification?.passed, JSON.stringify(out.summary.verification?.checks.filter((c) => !c.passed))).toBe(true);
	expect(out.summary.waterBalance!.total.residualM3).toBeCloseTo(0, 6);
}

describe('a drought restriction on a unit whose dam comes into service mid-run, with a scheduled demand object', () => {
	// 1–10 October 2021 (1 October a Friday). Unit A's on-channel dam (1 000 m³, catching all its runoff,
	// initial level 50 %) is in service from Monday 4 October. Its town takes 100 m³/day (2 000 people:
	// a floor of 50 m³/day); its works 200 m³/day, off at weekends. Level 1 below 60 % cuts both by half,
	// level 2 below 30 % cuts both in full (the town keeps its floor).
	const start = '2021-10-01';
	const a = unit('A', { pctRunoffToDam: 1, damCapacityM3: 1000, damInitialPct: 0.5, damInServiceFrom: '2021-10-04' });
	const objects = [
		object('town', 'municipal', 100, { population: 2000 }),
		object('works', 'industrial', 200, { priority: 'last', schedule: [{ label: 'Weekends', span: 'always', from: null, to: null, easterFrom: null, easterTo: null, weekdays: [6, 7], factor: 0 }] })
	];
	const levels = [
		{ label: 'L1', belowPct: 0.6, cuts: { municipal: 0.5, industrial: 0.5 } },
		{ label: 'L2', belowPct: 0.3, cuts: { municipal: 1, industrial: 1 } }
	];
	const Q = [500, 500, 0, 1000, 0, 0, 0, 0, 0, 0];
	const demand = [300, 100, 100, 300, 300, 300, 300, 300, 100, 100];

	it('a review on the in-service day leaves the new, empty dam out (engine ≥ 1.70.0, first filling, #90 Q30): no level until the 8 Oct review', () => {
		const rule: DroughtRestrictionRule = { reviewDates: ['10-04', '10-08'], levels };
		const input = build(a, { objects, start, days: 10, settings: { droughtRestriction: rule } });
		const out = run(input, Q);
		// No capacity before 4 October: the starting storage is 50 % of the first day's capacity, 0.
		near(get(out, 'A', 'dam_capacity'), [0, 0, 0, 1000, 1000, 1000, 1000, 1000, 1000, 1000]);
		// The first day: the latest review (8 Oct last year) has no lift after it, so the level is decided
		// from the starting storage, and no dam has capacity that day: level 0. On 4 Oct the dam is in
		// service but filling (it starts the day empty, below the mildest level's 60 %), so the review reads no
		// dam: level 0 (before 1.70.0, 0 ÷ 1000 < 30 %: level 2). 4 Oct: 0 + 1000 − 300 = 700 m³, so the dam starts
		// 5 Oct at 70 % ≥ 60 % and counts from then. The 8 Oct review reads it empty (700 − 300 − 300 − 100): level 2.
		expect(get(out, null, 'restriction_level')).toEqual([0, 0, 0, 0, 0, 0, 0, 2, 2, 2]);
		near(get(out, 'A', 'demand'), demand);
		near(get(out, 'A', 'restricted_demand'), [300, 100, 100, 300, 300, 300, 300, 50, 50, 50]);
		near(get(out, 'A', 'supplied'), [300, 100, 0, 300, 300, 300, 100, 0, 0, 0]);
		near(get(out, 'A', 'spill'), [200, 400, 0, 0, 0, 0, 0, 0, 0, 0]);
		near(get(out, 'A', 'dam_storage'), [0, 0, 0, 700, 400, 100, 0, 0, 0, 0]);
		near(get(out, 'A', 'basic_needs'), [50, 50, 50, 50, 50, 50, 50, 50, 50, 50]);
		expect(out.summary.droughtRestriction!.filling).toEqual([{ nodeId: 'A', inServiceFrom: '2021-10-04', joinedOn: '2021-10-05' }]);
		passes(input, out);
	});

	it('a review before the dam exists decides level 0 (no dam to read), held through the in-service day until the next review', () => {
		const rule: DroughtRestrictionRule = { reviewDates: ['10-02', '10-08'], levels };
		const input = build(a, { objects, start, days: 10, settings: { droughtRestriction: rule } });
		const out = run(input, Q);
		expect(get(out, null, 'restriction_level')).toEqual([0, 0, 0, 0, 0, 0, 0, 2, 2, 2]);
		// 4 Oct: 0 + 1000 − 300 = 700; then 400, 100, and Thursday gets the last 100. 8 Oct review: 0 % → level 2.
		near(get(out, 'A', 'supplied'), [300, 100, 0, 300, 300, 300, 100, 0, 0, 0]);
		near(get(out, 'A', 'dam_storage'), [0, 0, 0, 700, 400, 100, 0, 0, 0, 0]);
		near(get(out, 'A', 'restricted_demand'), [300, 100, 100, 300, 300, 300, 300, 50, 50, 50]);
		const s = out.summary.droughtRestriction!;
		expect(s.daysByLevel).toEqual([7, 0, 3]);
		passes(input, out);
	});
});

describe('demand objects on the dam and on a river abstraction, a dam-target borehole and an allocation cap', () => {
	// Unit A: an off-channel dam (1 000 m³, 200 in it, runoff passes it by), a town of 300 m³/day on the dam
	// ('first'), an irrigation object of 400 m³/day on its own river pump (250 m³/day), and a supplemental
	// borehole (150 m³/day) pumping into the dam. Registered: 1 000 m³ of surface water and 10 000 m³ of
	// groundwater for the 2021/22 water year. The run starts on 1 October 2021: the whole budget.
	const start = '2021-10-01';
	const a = unit('A', { damCapacityM3: 1000, damInitialPct: 0.2 });
	const objects = [object('town', 'municipal', 300), object('irr', 'irrigation', 400, { priority: 'shared', waterSource: 'river', riverPumpM3Day: 250 })];
	const boreholes: Borehole[] = [{ id: 'bh', nodeId: 'A', name: 'BH1', mode: 'supplemental', emergencyBelowPct: 0.3, target: 'dam', depletionFactor: 0, capacityM3Day: 150, annualCapM3: null } as Borehole];
	const allocations: AllocationEntry[] = [
		{ id: 's', nodeId: 'A', waterSource: 'surface', volumeM3PerYear: 1000 },
		{ id: 'g', nodeId: 'A', waterSource: 'groundwater', volumeM3PerYear: 10_000 }
	];
	const input = build(a, { objects, boreholes, allocations, start, days: 4, settings: { allocationMode: 'cap' } });
	const out = run(input, [1000, 1000, 100, 1000]);

	it('the dam side draws first within the surface room; the river abstraction takes what room it leaves; the borehole tops up only what the room can draw', () => {
		// Day 0: room 1000. The borehole tops the dam up to the town's 300 (100); the town draws 300; the river
		//   pump takes 250 of 1000 flowing: surface use 550.
		// Day 1: room 450. The dam is empty: the borehole puts 150 in, the town draws it; the pump takes 250 (room 300).
		// Day 2: room 50. The dam side may draw 50: the borehole pumps 50 for it; nothing is left for the river pump.
		// Day 3: room 0: nothing, though the river carries 1000 and the borehole has room.
		near(get(out, 'A', 'allocation_room_surface'), [1000, 450, 50, 0]);
		near(get(out, 'A', 'allocation_room_groundwater'), [10_000, 9900, 9750, 9700]);
		near(get(out, 'A', 'groundwater_to_dam'), [100, 150, 50, 0]);
		near(get(out, 'A', 'object_supplied@town'), [300, 150, 50, 0]);
		near(get(out, 'A', 'river_take@irr'), [250, 250, 0, 0]);
		near(get(out, 'A', 'object_supplied@irr'), [250, 250, 0, 0]);
		near(get(out, 'A', 'supplied'), [550, 400, 50, 0]);
		near(get(out, 'A', 'dam_storage'), [0, 0, 0, 0]);
		near(get(out, 'A', 'outflow'), [750, 750, 100, 1000]);
		// The pump was spent on days 0 and 1 with water and room left: 150, then MIN(150, room 50).
		near(get(out, 'A', 'river_pump_limited@irr'), [150, 50, 0, 0]);
		passes(input, out);
	});

	it('the summary: the surface cap reached in 2021/22, the year’s surface use the whole budget', () => {
		const src = out.summary.allocations!.nodes.find((n) => n.nodeId === 'A')!.sources.find((s) => s.waterSource === 'surface')!;
		expect((src.capReached ?? []).map((r) => r.waterYear)).toEqual([2021]);
		const sup = get(out, 'A', 'supplied');
		expect(sup.reduce((x, y) => x + y, 0)).toBeCloseTo(1000, 9);
	});
});
