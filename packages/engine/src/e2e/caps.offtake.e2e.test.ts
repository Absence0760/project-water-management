// End-to-end: a demand-sized river off-take into a unit under an allocation
// cap (docs/model.md §2.6a, §2.12a; engine ≥ 1.70.0, issue #393, #90 Q28, a
// provisional answer pending the hydrologist). The rule sizes to the demand
// the cap still allows, not the unit's full demand:
//
//   need_dst = MIN(D_dst, room_surface(dst, t)) + [topUpDam] room_dam
//   room_surface(dst, t) = MIN(MAX(0, budget(y) − surface use so far in y), licence limit today)
//
// the destination's surface room at the start of the day, the same number its
// allocation_room_surface column shows (Infinity, blank, without a surface
// cap or in a water year none of its surface licences is in force in). Before
// 1.70.0 it sized to D_dst: the extra arrived, flowed on below the unit, and
// its conveyance losses left the catchment.
//
// The catchment: a source unit S with no dam and all the natural flow (1 000
// m³/day unless a test says otherwise), a destination D with a town of 300
// m³/day and no dam, both draining to a gauge G, so D's only supply is the
// off-take. Days from 1 March 2021 (water year 2020). Synthetic names and
// values only.
import { describe, expect, it } from 'vitest';
import type { AllocationEntry } from '../allocations/compare';
import type { Monthly } from '../calendar';
import type { DemandObject, ModelInput, ModelOutput, NetworkNode, ProjectSettings, RunSeries, Transfer } from '../project';
import { runModelWith, withVerification } from '../run';
import { applyScenario } from '../scenario';
import { checkTransferLimits } from '../verify/checks';

const flat = (v: number) => new Array(12).fill(v) as number[];
const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
function farm(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: `Unit ${id}`,
		kind: 'farm',
		downstreamNodeId: 'G',
		sortOrder: 0,
		areaKm2: 0,
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
const gauge = (): NetworkNode => farm('G', { kind: 'gauge', downstreamNodeId: null, sortOrder: 99 });
const town = (nodeId: string, m3Day: number): DemandObject => ({
	id: `town-${nodeId}`,
	nodeId,
	name: `Town at ${nodeId}`,
	category: 'municipal',
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
	note: ''
});
const ot = (id: string, from: string, to: string, cap: number, over: Partial<Transfer> = {}): Transfer => ({
	id,
	fromNodeId: from,
	toNodeId: to,
	months: ALL,
	maxRateM3s: 1,
	dailyCapM3: cap,
	minStoragePct: 0,
	enabled: true,
	priority: 0,
	source: 'river',
	sizing: 'demand',
	lossPct: 0,
	handsOffM3Day: null,
	handsOffEwr: false,
	topUpDam: false,
	...over
});
const surface = (over: Partial<AllocationEntry> = {}): AllocationEntry => ({ id: 'L', nodeId: 'D', waterSource: 'surface', volumeM3PerYear: 1e9, ...over });

function build(b: { transfers?: Transfer[]; allocations?: AllocationEntry[]; nodes?: NetworkNode[]; objects?: DemandObject[]; settings?: Partial<ProjectSettings>; days: number; start?: string }): ModelInput {
	return {
		settings: { ewrPragmaticM3PerDay: flat(0) as unknown as Monthly, apanMm: flat(0) as unknown as Monthly, allocationMode: 'cap', ...b.settings } as ModelInput['settings'],
		model: {
			nodes: b.nodes ?? [gauge(), farm('S', { areaKm2: 1 }), farm('D')],
			crops: [],
			cropAreas: [],
			transfers: b.transfers ?? [ot('o', 'S', 'D', 1000)],
			demandObjects: b.objects ?? [town('D', 300)],
			...(b.allocations ? { allocations: b.allocations } : {})
		},
		series: { rain_catchment_mm: { startDate: b.start ?? '2021-03-01', values: new Array(b.days).fill(0) } }
	};
}
const run = (input: ModelInput, natural: number[]) => withVerification(input, runModelWith(input, () => ({ naturalFlowM3Day: natural })));
function get(out: { series: RunSeries[] }, nodeId: string, key: string): number[] {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}/${key}`);
	return s.values;
}
const near = (a: number[], b: number[], digits = 9) => {
	expect(a.length).toBe(b.length);
	a.forEach((v, t) => expect(v, `day ${t}`).toBeCloseTo(b[t]!, digits));
};
function passes(out: ModelOutput) {
	expect(out.summary.verification?.passed, JSON.stringify(out.summary.verification?.checks.filter((c) => !c.passed))).toBe(true);
}
const thousand = (n: number) => new Array(n).fill(1000);

describe('caps × off-take sizing: the year’s volume (§2.6a, §2.12a, engine ≥ 1.70.0)', () => {
	it('control: without an allocation the rule takes the full demand, 300 m³ a day', () => {
		const out = run(build({ days: 4 }), thousand(4));
		near(get(out, 'S', 'transfer_rule@o'), [300, 300, 300, 300]);
		passes(out);
	});

	it('budget remaining, partly used, then exhausted: 750 m³ for the year takes 300, 300, 150, 0', () => {
		// Room at the start of each day: 750, 450, 150, 0 (MAX(0, 750 − use so far)). The rule asks for MIN(300, room).
		const out = run(build({ days: 4, allocations: [surface({ volumeM3PerYear: 750 })] }), thousand(4));
		near(get(out, 'D', 'allocation_room_surface'), [750, 450, 150, 0]);
		near(get(out, 'S', 'transfer_rule@o'), [300, 300, 150, 0]);
		near(get(out, 'D', 'offtake_in'), [300, 300, 150, 0]);
		near(get(out, 'D', 'offtake_used'), [300, 300, 150, 0]);
		near(get(out, 'D', 'deficit'), [0, 0, 150, 300]);
		// What the rule didn't take stays in the river at the source, not below D: S passes 700, 700, 850, 1 000 and D
		// passes nothing on (before 1.70.0 S passed 700 every day and D passed 0, 0, 150, 300).
		near(get(out, 'S', 'outflow'), [700, 700, 850, 1000]);
		near(get(out, 'D', 'outflow'), [0, 0, 0, 0]);
		const src = out.summary.allocations!.nodes.find((n) => n.nodeId === 'D')!.sources[0]!;
		expect(src.capReached!.map((r) => r.waterYear)).toEqual([2020]);
		expect(src.limitBound).toEqual([{ waterYear: 2020, days: 2, volumeDays: 2, rateDays: 0, monthsDays: 0 }]);
		passes(out);
	});

	it('the self-check refuses a run whose demand-sized rule delivered more than the room (the pre-1.70.0 sizing)', () => {
		const input = build({ days: 4, allocations: [surface({ volumeM3PerYear: 750 })] });
		const out = run(input, thousand(4));
		expect(checkTransferLimits(input, out)).toBeNull();
		// Day 3 as before 1.70.0: the rule took the full 300 with no room left, and D passed it on.
		const bad = structuredClone(out);
		const set = (id: string, key: string, v: number) => (bad.series.find((s) => s.nodeId === id && s.key === key)!.values[3] = v);
		set('S', 'transfer_rule@o', 300);
		set('S', 'offtake_out', 300);
		set('S', 'outflow', 700);
		set('D', 'offtake_in', 300);
		expect(checkTransferLimits(input, bad)).toBe('D day 3: its demand-sized river off-takes delivered 300, more than its surface allocation room today 0');
	});

	it('budget remaining far above the demand: the capped demand is the demand, so nothing changes', () => {
		const out = run(build({ days: 4, allocations: [surface({ volumeM3PerYear: 1e9 })] }), thousand(4));
		near(get(out, 'S', 'transfer_rule@o'), [300, 300, 300, 300]);
		passes(out);
	});

	it('the river shorter than the capped demand: the rule takes what flows (the cap is a ceiling, not a target)', () => {
		const out = run(build({ days: 4, allocations: [surface({ volumeM3PerYear: 750 })] }), [120, 120, 120, 120]);
		near(get(out, 'S', 'transfer_rule@o'), [120, 120, 120, 120]);
		near(get(out, 'D', 'allocation_room_surface'), [750, 630, 510, 390]);
		passes(out);
	});
});

describe('caps × off-take sizing: conveyance losses', () => {
	// 20 % losses, budget 750: the rule takes need ÷ 0.8 so that need arrives: 375, 375, 187.5, 0; it loses 75, 75,
	// 37.5, 0 (187.5 m³). Before 1.70.0 it took 375 every day and lost 300 m³, 112.5 m³ of it carrying water D could
	// not use. The gauge sees 1 000 − taken + D's outflow (0): 625, 625, 812.5, 1 000.
	const out = run(build({ days: 4, transfers: [ot('o', 'S', 'D', 1000, { lossPct: 0.2 })], allocations: [surface({ volumeM3PerYear: 750 })] }), thousand(4));
	it('the rule grosses up the capped demand only', () => {
		near(get(out, 'S', 'transfer_rule@o'), [375, 375, 187.5, 0]);
		near(get(out, 'D', 'offtake_in'), [300, 300, 150, 0]);
		near(get(out, 'G', 'outflow'), [625, 625, 812.5, 1000]);
		passes(out);
	});
	it('the losses that leave the catchment are those of the water D may use: 187.5 m³', () => {
		expect(out.summary.waterBalance!.total.conveyanceLossM3).toBeCloseTo(187.5, 9);
	});
	it('half the losses seeping back below the source return 93.75 m³; the balance still closes', () => {
		const back = run(build({ days: 4, transfers: [ot('o', 'S', 'D', 1000, { lossPct: 0.2, lossReturnPct: 0.5 })], allocations: [surface({ volumeM3PerYear: 750 })] }), thousand(4));
		near(get(back, 'S', 'offtake_loss_return'), [37.5, 37.5, 18.75, 0]);
		expect(back.summary.waterBalance!.total.conveyanceLossM3).toBeCloseTo(93.75, 9);
		passes(back);
	});
});

describe('caps × off-take sizing: the licence’s rate and months', () => {
	it('a maximum rate of 100 m³/day: the rule takes 100, S keeps 900 in the river', () => {
		const out = run(build({ days: 3, allocations: [surface({ maxRateM3s: 100 / 86_400 })] }), thousand(3));
		near(get(out, 'D', 'allocation_room_surface'), [100, 100, 100]);
		near(get(out, 'S', 'transfer_rule@o'), [100, 100, 100]);
		near(get(out, 'S', 'outflow'), [900, 900, 900]);
		near(get(out, 'D', 'deficit'), [200, 200, 200]);
		expect(out.summary.allocations!.nodes.find((n) => n.nodeId === 'D')!.sources[0]!.limitBound).toEqual([{ waterYear: 2020, days: 3, volumeDays: 0, rateDays: 3, monthsDays: 0 }]);
		passes(out);
	});

	it('outside the licence’s months of use the room is 0, so the rule takes nothing', () => {
		const out = run(build({ days: 3, allocations: [surface({ months: [6, 7, 8] })] }), thousand(3));
		near(get(out, 'S', 'transfer_rule@o'), [0, 0, 0]);
		near(get(out, 'S', 'outflow'), [1000, 1000, 1000]);
		expect(out.summary.allocations!.nodes.find((n) => n.nodeId === 'D')!.sources[0]!.limitBound).toEqual([{ waterYear: 2020, days: 3, volumeDays: 0, rateDays: 0, monthsDays: 3 }]);
		passes(out);
	});

	it('a water year with no surface licence in force (engine ≥ 1.70.0, Q24) isn’t capped: the full demand, a blank room', () => {
		const out = run(build({ days: 3, allocations: [surface({ volumeM3PerYear: 0, validFrom: '2021-10-01' })] }), thousand(3));
		near(get(out, 'S', 'transfer_rule@o'), [300, 300, 300]);
		expect(get(out, 'D', 'allocation_room_surface').every((v) => Number.isNaN(v))).toBe(true);
		passes(out);
	});

	it('a groundwater licence alone doesn’t cap the off-take (off-take water is surface use)', () => {
		const out = run(build({ days: 3, allocations: [surface({ waterSource: 'groundwater', volumeM3PerYear: 10 })] }), thousand(3));
		near(get(out, 'S', 'transfer_rule@o'), [300, 300, 300]);
		passes(out);
	});
});

describe('caps × off-take sizing: several rules, sizing kinds, top-ups', () => {
	it('two rules of one priority from S share the capped need pro rata to their capacity (600 : 200 of 100 → 75 : 25)', () => {
		const out = run(build({ days: 2, transfers: [ot('o1', 'S', 'D', 600), ot('o2', 'S', 'D', 200)], allocations: [surface({ maxRateM3s: 100 / 86_400 })] }), thousand(2));
		near(get(out, 'S', 'transfer_rule@o1'), [75, 75]);
		near(get(out, 'S', 'transfer_rule@o2'), [25, 25]);
		near(get(out, 'D', 'offtake_used'), [100, 100]);
		passes(out);
	});

	it('two sources into D share it the same way, whichever runs first', () => {
		const out = run(
			build({ days: 2, nodes: [gauge(), farm('S1', { areaKm2: 1 }), farm('S2', { areaKm2: 1 }), farm('D')], transfers: [ot('o1', 'S1', 'D', 600), ot('o2', 'S2', 'D', 200)], allocations: [surface({ maxRateM3s: 100 / 86_400 })] }),
			thousand(2)
		);
		// Each source gets half the natural flow (1 km² each): plenty for 75 and 25.
		near(get(out, 'S1', 'transfer_rule@o1'), [75, 75]);
		near(get(out, 'S2', 'transfer_rule@o2'), [25, 25]);
		passes(out);
	});

	it('a capacity-sized rule is untouched: it runs full, D uses its room and the rest flows on below D', () => {
		const out = run(build({ days: 2, transfers: [ot('o', 'S', 'D', 300, { sizing: 'capacity' })], allocations: [surface({ maxRateM3s: 100 / 86_400 })] }), thousand(2));
		near(get(out, 'S', 'transfer_rule@o'), [300, 300]);
		near(get(out, 'D', 'offtake_used'), [100, 100]);
		near(get(out, 'D', 'outflow'), [200, 200]);
		passes(out);
	});

	it('a top-up rule: the capped demand plus the dam’s room (filling a dam is not use)', () => {
		// D has an empty 1 000 m³ dam and a rate of 100 m³/day. Day 0: need = MIN(300, 100) + 1 000 = 1 100: 100 used,
		// 1 000 into the dam; the dam can't give D more (the room is used). Day 1: the dam is full, need = 100.
		// Before 1.70.0 day 0's need was 300 + 1 000 = 1 300 and the 200 D couldn't use spilled.
		const out = run(
			build({ days: 2, nodes: [gauge(), farm('S', { areaKm2: 1 }), farm('D', { damCapacityM3: 1000 })], transfers: [ot('o', 'S', 'D', 2000, { topUpDam: true })], allocations: [surface({ maxRateM3s: 100 / 86_400 })] }),
			[5000, 5000]
		);
		near(get(out, 'S', 'transfer_rule@o'), [1100, 100]);
		near(get(out, 'D', 'offtake_used'), [100, 100]);
		near(get(out, 'D', 'offtake_to_dam'), [1000, 0]);
		near(get(out, 'D', 'dam_storage'), [1000, 1000]);
		near(get(out, 'D', 'supplied'), [100, 100]);
		near(get(out, 'D', 'outflow'), [0, 0]);
		passes(out);
	});

	it('full allocation has no room: the rule sizes to the scaled demand as before (k = 18 250 ÷ 109 500 = 1/6 → 50)', () => {
		const out = run(build({ days: 365, start: '2020-10-01', allocations: [surface({ volumeM3PerYear: 18_250 })], settings: { allocationMode: 'fullAllocation' } }), thousand(365));
		expect(get(out, 'S', 'transfer_rule@o').every((v) => Math.abs(v - 50) < 1e-9)).toBe(true);
		passes(out);
	});

	it('a scenario adding a rate licence to D cuts the rule’s take, and removing it restores it', () => {
		const base = build({ days: 2 });
		const capped = applyScenario(base, [{ op: 'allocation.set', allocation: surface({ maxRateM3s: 50 / 86_400 }) }]);
		expect(capped.problems).toEqual([]);
		near(get(run(capped.input, thousand(2)), 'S', 'transfer_rule@o'), [50, 50]);
		const back = applyScenario(capped.input, [{ op: 'allocation.remove', allocationId: 'L' }]);
		near(get(run(back.input, thousand(2)), 'S', 'transfer_rule@o'), [300, 300]);
	});
});

describe('caps × off-take sizing: invariants over a year', () => {
	// A whole water year of a varying river (0 … 2 000 m³/day), 10 % losses with half returned below the source,
	// a 50 000 m³ volume and a rate of 250 m³/day on D (demand 300).
	const days = 365;
	const natural = Array.from({ length: days }, (_, t) => 1000 + 1000 * Math.sin((2 * Math.PI * t) / 97));
	const input = build({ days, start: '2020-10-01', transfers: [ot('o', 'S', 'D', 1000, { lossPct: 0.1, lossReturnPct: 0.5 })], allocations: [surface({ volumeM3PerYear: 50_000, maxRateM3s: 250 / 86_400 })] });
	const out = run(input, natural);
	const room = get(out, 'D', 'allocation_room_surface');
	const xin = get(out, 'D', 'offtake_in');
	const used = get(out, 'D', 'offtake_used');
	const taken = get(out, 'S', 'transfer_rule@o');

	it('every self-check passes, the water balance included', () => passes(out));

	it('each day what arrives is at most MIN(demand, room), so all of it is used and none passes on below D', () => {
		for (let t = 0; t < days; t++) {
			expect(xin[t]!, `day ${t}`).toBeLessThanOrEqual(Math.min(300, room[t]!) * (1 + 1e-12) + 1e-9);
			expect(used[t]!, `day ${t}`).toBeCloseTo(xin[t]!, 9);
		}
		expect(get(out, 'D', 'outflow').every((v) => Math.abs(v) < 1e-9)).toBe(true);
	});

	it('the year’s use never exceeds the 50 000 m³ budget, and reaches it (the cap binds)', () => {
		const u = used.reduce((a, b) => a + b, 0);
		expect(u).toBeLessThanOrEqual(50_000 * (1 + 1e-12));
		expect(u).toBeCloseTo(50_000, 6);
	});

	it('mass balance at the gauge: natural − used − the losses that leave = what reaches it', () => {
		const G = get(out, 'G', 'outflow');
		for (let t = 0; t < days; t++) expect(G[t]!, `day ${t}`).toBeCloseTo(natural[t]! - used[t]! - taken[t]! * 0.1 * 0.5, 6);
	});

	it('the rule takes the documented share: MIN(the flow, capped need ÷ 0.9) every day', () => {
		for (let t = 0; t < days; t++) expect(taken[t]!, `day ${t}`).toBeCloseTo(Math.min(natural[t]!, Math.min(300, room[t]!) / 0.9), 6);
	});
});
