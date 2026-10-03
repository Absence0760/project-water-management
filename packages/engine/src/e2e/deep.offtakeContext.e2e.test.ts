// Deep end-to-end pass: river off-takes (docs/model.md §2.6a) beside the rest
// of a unit: the source farm's own hands-off flow (§2.7h, which binds the
// farm's pump, never an off-take), river abstractions at the source and at the
// destination (§2.7j: the off-take sizes to and serves the dam side only, and
// takes after the source's own abstractions), an allocation cap at the
// destination (§2.12a: off-take water used ≤ the room, the rest flows on, and
// the unit's river takes share what is left of the room) and a full-allocation
// run (§2.12a: a demand-sized off-take takes the scaled demand). Worked by
// hand. Synthetic names and values only.
import { describe, expect, it } from 'vitest';
import type { AllocationEntry } from '../allocations/compare';
import type { Monthly } from '../calendar';
import type { DemandObject, ModelInput, ModelOutput, NetworkNode, ProjectSettings, RunSeries, Transfer } from '../project';
import { runModelWith, withVerification } from '../run';

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
		lossReturnFraction: 0,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}
const gauge = (): NetworkNode => farm('G', { kind: 'gauge', downstreamNodeId: null, sortOrder: 99 });
const town = (id: string, nodeId: string, m3Day: number, over: Partial<DemandObject> = {}): DemandObject => ({
	id,
	nodeId,
	name: `Town ${id}`,
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
	note: '',
	...over
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
	sizing: 'capacity',
	lossPct: 0,
	handsOffM3Day: null,
	handsOffEwr: false,
	topUpDam: false,
	...over
});
function build(b: { nodes: NetworkNode[]; transfers: Transfer[]; objects?: DemandObject[]; allocations?: AllocationEntry[]; settings?: Partial<ProjectSettings>; start?: string; days: number }): ModelInput {
	return {
		settings: { ewrPragmaticM3PerDay: flat(0) as unknown as Monthly, apanMm: flat(0) as unknown as Monthly, ...b.settings } as ModelInput['settings'],
		model: { nodes: b.nodes, crops: [], cropAreas: [], transfers: b.transfers, demandObjects: b.objects ?? [], ...(b.allocations ? { allocations: b.allocations } : {}) },
		series: { rain_catchment_mm: { startDate: b.start ?? '2021-01-01', values: new Array(b.days).fill(0) } }
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

describe('deep: an off-take and its source farm’s own hands-off flow (§2.7h decisions)', () => {
	it('the farm’s hands-off flow binds its own pump, not the off-take; the off-take keeps only its own', () => {
		const net = (rule: Partial<Transfer>) =>
			build({ nodes: [gauge(), farm('S', { areaKm2: 1, handsOffM3Day: flat(900) }), farm('D')], transfers: [ot('o', 'S', 'D', 500, rule)], days: 1 });
		const none = run(net({}), [1000]);
		near(get(none, 'S', 'transfer_rule@o'), [500]);
		near(get(none, 'S', 'outflow'), [500]);
		passes(none);
		const own = run(net({ handsOffM3Day: 900 }), [1000]);
		near(get(own, 'S', 'transfer_rule@o'), [100]);
		passes(own);
	});
});

describe('deep: off-takes beside river abstractions (§2.7j)', () => {
	it('at the source: the off-take takes from the flow its river abstraction left', () => {
		const input = build({ nodes: [gauge(), farm('S', { areaKm2: 1 }), farm('D')], transfers: [ot('o', 'S', 'D', 1000)], objects: [town('tr', 'S', 300, { waterSource: 'river', riverPumpM3Day: 1e6 })], days: 1 });
		const out = run(input, [1000]);
		near(get(out, 'S', 'river_take@tr'), [300]);
		near(get(out, 'S', 'transfer_rule@o'), [700]);
		near(get(out, 'S', 'outflow'), [0]);
		passes(out);
	});

	it('at the destination: a demand-sized off-take sizes to the dam side only; capacity-sized water passing on feeds the river abstraction', () => {
		const net = (sizing: 'demand' | 'capacity') =>
			build({
				nodes: [gauge(), farm('S', { areaKm2: 1 }), farm('D')],
				transfers: [ot('o', 'S', 'D', 1000, { sizing })],
				objects: [town('td', 'D', 300), town('tr', 'D', 200, { waterSource: 'river', riverPumpM3Day: 1e6 })],
				days: 1
			});
		const byDemand = run(net('demand'), [1000]);
		near(get(byDemand, 'S', 'transfer_rule@o'), [300]);
		near(get(byDemand, 'D', 'offtake_used'), [300]);
		near(get(byDemand, 'D', 'river_take@tr'), [0]);
		near(get(byDemand, 'D', 'supplied'), [300]);
		passes(byDemand);
		const byCap = run(net('capacity'), [1000]);
		near(get(byCap, 'D', 'offtake_used'), [300]);
		near(get(byCap, 'D', 'river_take@tr'), [200]);
		near(get(byCap, 'D', 'supplied'), [500]);
		near(get(byCap, 'D', 'outflow'), [500]);
		passes(byCap);
	});
});

describe('deep: off-takes under an allocation mode (§2.12a)', () => {
	it('cap at the destination: used = MIN(arrived, D, room), the rest flows on; its river abstraction gets what is left of the room (none)', () => {
		const input = build({
			nodes: [gauge(), farm('S', { areaKm2: 1 }), farm('D')],
			transfers: [ot('o', 'S', 'D', 300)],
			objects: [town('td', 'D', 300), town('tr', 'D', 200, { waterSource: 'river', riverPumpM3Day: 1e6 })],
			allocations: [{ id: 'a', nodeId: 'D', waterSource: 'surface', volumeM3PerYear: 1e9, maxRateM3s: 100 / 86400 }],
			settings: { allocationMode: 'cap' },
			days: 2
		});
		const out = run(input, [1000, 1000]);
		near(get(out, 'D', 'allocation_room_surface'), [100, 100]);
		near(get(out, 'D', 'offtake_in'), [300, 300]);
		near(get(out, 'D', 'offtake_used'), [100, 100]);
		near(get(out, 'D', 'river_take@tr'), [0, 0]);
		near(get(out, 'D', 'supplied'), [100, 100]);
		near(get(out, 'D', 'outflow'), [200, 200]);
		passes(out);
	});

	it('cap at the destination with an annual volume: off-take water used counts against it and stops when it is used up', () => {
		const input = build({
			nodes: [gauge(), farm('S', { areaKm2: 1 }), farm('D')],
			transfers: [ot('o', 'S', 'D', 300)],
			objects: [town('td', 'D', 300)],
			allocations: [{ id: 'a', nodeId: 'D', waterSource: 'surface', volumeM3PerYear: 750 }],
			settings: { allocationMode: 'cap' },
			start: '2021-03-01',
			days: 4
		});
		const out = run(input, [1000, 1000, 1000, 1000]);
		near(get(out, 'D', 'allocation_room_surface'), [750, 450, 150, 0]);
		near(get(out, 'D', 'offtake_used'), [300, 300, 150, 0]);
		near(get(out, 'D', 'outflow'), [0, 0, 150, 300]);
		passes(out);
	});

	it('full allocation: a demand-sized off-take takes the scaled demand (k = registered ÷ demand)', () => {
		const days = 365;
		const input = build({
			nodes: [gauge(), farm('S', { areaKm2: 1 }), farm('D')],
			transfers: [ot('o', 'S', 'D', 1000, { sizing: 'demand' })],
			objects: [town('td', 'D', 100)],
			allocations: [{ id: 'a', nodeId: 'D', waterSource: 'surface', volumeM3PerYear: 18250 }],
			settings: { allocationMode: 'fullAllocation' },
			start: '2020-10-01',
			days
		});
		const out = run(input, new Array(days).fill(1000));
		near(get(out, 'D', 'allocation_demand_factor'), new Array(days).fill(0.5));
		near(get(out, 'S', 'transfer_rule@o'), new Array(days).fill(50));
		near(get(out, 'D', 'supplied'), new Array(days).fill(50));
		passes(out);
	});

	it('full allocation: a senior user is scaled before its claim passes upstream, so an off-take above it keeps the scaled claim', () => {
		const days = 365;
		const input = build({
			nodes: [gauge(), farm('S', { areaKm2: 1, downstreamNodeId: 'U' }), farm('U', { kind: 'user', downstreamNodeId: 'G', damAreaFullM2: null, userDemandM3Day: flat(500), userReturnPct: 0, userPriority: 'senior' }), farm('D')],
			transfers: [ot('o', 'S', 'D', 1000)],
			allocations: [{ id: 'u', nodeId: 'U', waterSource: 'surface', volumeM3PerYear: 36500 }],
			settings: { allocationMode: 'fullAllocation' },
			start: '2020-10-01',
			days
		});
		const out = run(input, new Array(days).fill(1000));
		near(get(out, 'U', 'demand'), new Array(days).fill(100));
		near(get(out, 'S', 'senior_requirement'), new Array(days).fill(100));
		near(get(out, 'S', 'transfer_rule@o'), new Array(days).fill(900));
		near(get(out, 'U', 'supplied'), new Array(days).fill(100));
		passes(out);
	});

	it('full allocation scales a river-sourced demand too (D = F/e + every object, §2.7j)', () => {
		const days = 365;
		const input = build({
			nodes: [gauge(), farm('D', { areaKm2: 1 })],
			transfers: [],
			objects: [town('tr', 'D', 100, { waterSource: 'river', riverPumpM3Day: 1e6 })],
			allocations: [{ id: 'a', nodeId: 'D', waterSource: 'surface', volumeM3PerYear: 18250 }],
			settings: { allocationMode: 'fullAllocation' },
			start: '2020-10-01',
			days
		});
		const out = run(input, new Array(days).fill(1000));
		near(get(out, 'D', 'river_take@tr'), new Array(days).fill(50));
		passes(out);
	});
});
