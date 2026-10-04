// Regression tests for the bugs the deep second pass (deep*.e2e.test.ts) found,
// fixed in engine 1.69.0. Each asserts the behaviour docs/model.md specifies.
// Synthetic names and values only.
import { describe, expect, it } from 'vitest';
import type { Monthly } from '../calendar';
import type { ModelInput, NetworkNode, RunSeries, Transfer } from '../project';
import { runModelWith, withVerification } from '../run';

const flat = (v: number) => new Array(12).fill(v) as number[];
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
const ot = (id: string, from: string, to: string, cap: number, over: Partial<Transfer> = {}): Transfer => ({
	id,
	fromNodeId: from,
	toNodeId: to,
	months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
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
	topUpDam: true,
	...over
});
const get = (out: { series: RunSeries[] }, nodeId: string, key: string) => out.series.find((x) => x.nodeId === nodeId && x.key === key)!.values;

describe('fixed in 1.69.0: a demand-sized top-up off-take counts evaporation and seepage the dam can’t lose, so its water spills on arrival (§2.6a, §2.7a)', () => {
	// network/simulate.ts, the off-takes' need (`otShare`, ~line 1093): the top-up room is
	// cap − (q + g.Pd − g.E − g.Sp) with g = damDay(), the *unclamped* evaporation and seepage. The day's
	// dam step (§2.7a) clamps them to what is there, E = MIN(…, store + Pd + J) and Sp = MIN(…, store + Pd + J − E),
	// and off-take water arrives after that step (it is added to avail0, so it can't evaporate today).
	// Where the potential loss exceeds what the dam holds (a shallow dam with a large surface, a leaky dam),
	// the room is overstated by the difference, the off-take takes that much more from the source's river,
	// and it spills straight back below the destination (losing l of it on the way). §2.6a: sizing 'demand'
	// takes "only what the destination needs today ... plus, with topUpDam, its dam's room"; §2.6: water
	// that spills on arrival is "a river release under another name". Dam transfers don't have the problem:
	// their water is in J, which the dam step's clamp includes.
	// Fix: in otShare, clamp as the dam step does: E = MIN(g.E, q + g.Pd + J_dst), Sp = MIN(g.Sp, q + g.Pd + J_dst − E)
	// (J_dst = jToday[o.to], the transfers settled before), room = MAX(0, cap − (q + g.Pd − E − Sp)).
	const net = (over: Partial<NetworkNode>) => {
		const input: ModelInput = {
			settings: { ewrPragmaticM3PerDay: flat(0) as unknown as Monthly, apanMm: flat(310) as unknown as Monthly, lakeEvapFactor: 1 } as ModelInput['settings'],
			model: {
				nodes: [farm('G', { kind: 'gauge', downstreamNodeId: null, sortOrder: 99 }), farm('S', { areaKm2: 1 }), farm('D', { damCapacityM3: 100, damInitialPct: 1, ...over })],
				crops: [],
				cropAreas: [],
				transfers: [ot('o', 'S', 'D', 5000)],
				demandObjects: []
			},
			// January: A-pan 310 mm over 31 days, lake factor 1 → 10 mm/day of open-water evaporation.
			series: { rain_catchment_mm: { startDate: '2021-01-01', values: [0] } }
		};
		return withVerification(input, runModelWith(input, () => ({ naturalFlowM3Day: [10_000] })));
	};

	it('a full 100 m³ dam with 10 ha of surface (1 000 m³ of potential evaporation, 100 m³ actual): the top-up brings 100 m³, nothing spills', () => {
		const out = net({ damAreaFullM2: 100_000 });
		// The dam step: E = MIN(1 000, 100) = 100, so the dam starts the day empty and has room for 100.
		expect(get(out, 'D', 'dam_evaporation')[0]).toBeCloseTo(100, 9);
		expect(get(out, 'S', 'transfer_rule@o')[0]).toBeCloseTo(100, 9);
		expect(get(out, 'D', 'spill')[0]).toBeCloseTo(0, 9);
		expect(get(out, 'D', 'dam_storage')[0]).toBeCloseTo(100, 9);
	});

	it('a leaky dam (all of it seeps in a day) with some evaporation: the room is what the clamped losses leave, nothing spills', () => {
		// E = 10 mm × 3 000 m² = 30; Sp = MIN(1 × 100, 100 − 30) = 70; the dam starts empty: room 100 (the engine counts 130).
		const out = net({ damAreaFullM2: 3_000, damSeepagePerDay: 1 });
		expect(get(out, 'D', 'dam_evaporation')[0]).toBeCloseTo(30, 9);
		expect(get(out, 'D', 'dam_seepage')[0]).toBeCloseTo(70, 9);
		expect(get(out, 'S', 'transfer_rule@o')[0]).toBeCloseTo(100, 9);
		expect(get(out, 'D', 'spill')[0]).toBeCloseTo(0, 9);
	});
});

describe('fixed in 1.69.0: a demand-sized top-up off-take ignores water already transferred into the dam today, which then spills (§2.6a, §2.6 room)', () => {
	// network/simulate.ts `otShare` (~line 1093): the top-up room is cap − (q + Pd − E − Sp), without the
	// dam rules' transfers into the destination that day (`intoToday[o.to]`), although those are settled
	// before the off-takes are sized (§2.6: "Transfers are still settled first"). The room §2.6 defines for a
	// receiving dam subtracts what is "already scheduled into dst today"; §2.6a sizes a top-up to "its dam's
	// room". So a dam that a dam rule fills and an off-take tops up the same day takes both, and the
	// overlap spills on arrival. Fix: room = MAX(0, cap − (q + Pd − E − Sp) − intoToday[o.to]) (what it sends
	// makes no room, as for dam rules, probe `room-while-sending`).
	it('a 1 000 m³ dam at 500 m³ receiving 300 m³ by a dam rule: the off-take tops up the other 200 m³, nothing spills', () => {
		const input: ModelInput = {
			settings: { ewrPragmaticM3PerDay: flat(0) as unknown as Monthly, apanMm: flat(0) as unknown as Monthly, lakeEvapFactor: 1 } as ModelInput['settings'],
			model: {
				nodes: [farm('G', { kind: 'gauge', downstreamNodeId: null, sortOrder: 99 }), farm('S', { areaKm2: 1 }), farm('S2', { damCapacityM3: 1000, damInitialPct: 1 }), farm('D', { damCapacityM3: 1000, damInitialPct: 0.5 })],
				crops: [],
				cropAreas: [],
				transfers: [ot('o', 'S', 'D', 5000), { ...ot('t', 'S2', 'D', 300), source: 'dam', sizing: undefined, topUpDam: undefined }],
				demandObjects: []
			},
			series: { rain_catchment_mm: { startDate: '2021-01-01', values: [0] } }
		};
		const out = withVerification(input, runModelWith(input, () => ({ naturalFlowM3Day: [10_000] })));
		expect(get(out, 'S2', 'transfer_rule@t')[0]).toBeCloseTo(300, 9);
		expect(get(out, 'S', 'transfer_rule@o')[0]).toBeCloseTo(200, 9);
		expect(get(out, 'D', 'spill')[0]).toBeCloseTo(0, 9);
		expect(get(out, 'D', 'dam_storage')[0]).toBeCloseTo(1000, 9);
	});
});
