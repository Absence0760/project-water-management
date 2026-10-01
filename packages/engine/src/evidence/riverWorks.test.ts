// What a model takes from the river, for the evidence report's licensing
// checks (issue #54, #90 Q15 and Q16): which nodes and off-takes abstract,
// which are bounded, which keep the EWR, and which a proposal touches. The
// report-level checks are in report.test.ts.
import { describe, expect, it } from 'vitest';
import type { DemandObject, NetworkNode, ProjectModel, Transfer } from '../project';
import type { ScenarioOp } from '../scenario/ops';
import { nodeRiverWorks, offtakeRiverWorks, proposedRiverWorks, riverWorks, riverWorksTouched, unboundedRiverWorks, type RiverWorksLookup } from './riverWorks';

const node = (over: Partial<NetworkNode>): NetworkNode => ({
	id: 'F',
	name: 'Farm',
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
	lossReturnFraction: 0,
	damAreaFullM2: 0,
	damAreaExponent: 0.7,
	damSeepagePerDay: 0,
	...over
});
const transfer = (over: Partial<Transfer>): Transfer => ({
	id: 'T1',
	fromNodeId: 'F',
	toNodeId: 'H',
	months: [1, 2, 3],
	maxRateM3s: 0.1,
	dailyCapM3: null,
	minStoragePct: 0,
	enabled: true,
	priority: 1,
	source: 'river',
	...over
});
const crops = { cropAreas: [{ nodeId: 'F', cropId: 'c', areaM2: 1000 }], demandObjects: [] };
const object = (over: Partial<DemandObject> = {}): DemandObject =>
	({ id: 'D1', nodeId: 'F', name: 'Packhouse', category: 'industrial', sizing: 'monthly', monthlyM3Day: new Array(12).fill(10), count: null, litresPerUnitDay: null, lossPct: 0, enabled: true, ...over }) as DemandObject;
const model = (over: Partial<ProjectModel>): ProjectModel => ({ nodes: [], crops: [], cropAreas: [], transfers: [], ...over });

describe('nodeRiverWorks', () => {
	it('a river pump under each river rule, bounded by a size ≥ 0 only, and none at 0, under dam only, or without demand', () => {
		for (const supplyRule of ['riverFirst', 'trigger', 'runOfRiver'] as const) {
			expect(nodeRiverWorks(node({ supplyRule }), crops)).toEqual([{ kind: 'pump', id: 'F', name: 'Farm', bounded: false, protectsEwr: false }]);
			expect(nodeRiverWorks(node({ supplyRule, pumpCapacityM3Day: 500 }), crops)[0]!.bounded).toBe(true);
		}
		expect(nodeRiverWorks(node({ supplyRule: 'riverFirst', pumpCapacityM3Day: Number.NaN }), crops)[0]!.bounded).toBe(false);
		expect(nodeRiverWorks(node({ supplyRule: 'riverFirst', pumpCapacityM3Day: 0 }), crops)).toEqual([]);
		expect(nodeRiverWorks(node({ supplyRule: 'damFirst', pumpCapacityM3Day: null }), crops)).toEqual([]);
		// It pumps only for demand (Gr ≤ the demand left).
		expect(nodeRiverWorks(node({ supplyRule: 'riverFirst' }), { cropAreas: [], demandObjects: [] })).toEqual([]);
	});

	it('River to dam fills a dam from the river (bounded by its capacity); by month, a month above 0 is enough; none under run of river', () => {
		expect(nodeRiverWorks(node({ damCapacityM3: 1e4, divertCapacityM3Day: 200 }), crops)).toEqual([{ kind: 'divert', id: 'F', name: 'Farm', bounded: true, protectsEwr: false }]);
		const winter = [100, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
		expect(nodeRiverWorks(node({ damCapacityM3: 1e4, divertCapacityM3Day: 0, divertMonthlyM3Day: winter }), crops).map((w) => w.kind)).toEqual(['divert']);
		// Set by month, the one value is inert.
		expect(nodeRiverWorks(node({ damCapacityM3: 1e4, divertCapacityM3Day: 200, divertMonthlyM3Day: new Array(12).fill(0) }), crops)).toEqual([]);
		// It fills the dam whether or not the unit has demand.
		expect(nodeRiverWorks(node({ damCapacityM3: 1e4, divertCapacityM3Day: 200 }), { cropAreas: [], demandObjects: [] }).map((w) => w.kind)).toEqual(['divert']);
	});

	it('a unit with no dam takes what its split and River to dam route straight to its demand: unbounded with an upstream or runoff share', () => {
		expect(nodeRiverWorks(node({ pctUpstreamToDam: 0.5 }), crops)).toEqual([{ kind: 'noDam', id: 'F', name: 'Farm', bounded: false, protectsEwr: false }]);
		// Own runoff routed to the absent dam is irrigated too (the hands-off cut trims it, §2.7h; supplyOf warns).
		expect(nodeRiverWorks(node({ pctRunoffToDam: 1 }), crops)).toEqual([{ kind: 'noDam', id: 'F', name: 'Farm', bounded: false, protectsEwr: false }]);
		expect(nodeRiverWorks(node({ divertCapacityM3Day: 300 }), crops)).toEqual([{ kind: 'noDam', id: 'F', name: 'Farm', bounded: true, protectsEwr: false }]);
		// Without demand it takes nothing; an enabled demand object is demand.
		expect(nodeRiverWorks(node({ pctUpstreamToDam: 0.5 }), { cropAreas: [], demandObjects: [] })).toEqual([]);
		expect(nodeRiverWorks(node({ pctUpstreamToDam: 0.5 }), { cropAreas: [], demandObjects: [object({ enabled: false })] })).toEqual([]);
		expect(nodeRiverWorks(node({ pctUpstreamToDam: 0.5 }), { cropAreas: [], demandObjects: [object()] })).toHaveLength(1);
		// A dam there all run: the split is the on-channel dam catching its inflow, not a take.
		expect(nodeRiverWorks(node({ pctUpstreamToDam: 1, damCapacityM3: 1e4 }), crops)).toEqual([]);
	});

	it('river first or trigger with no dam takes the routed river past its pump: both takes, the routed one unbounded; run of river routes nothing', () => {
		for (const supplyRule of ['riverFirst', 'trigger'] as const) {
			const w = nodeRiverWorks(node({ supplyRule, pumpCapacityM3Day: 100, pctUpstreamToDam: 1 }), crops);
			expect(w.map((x) => `${x.kind}:${x.bounded}`)).toEqual(['pump:true', 'noDam:false']);
		}
		expect(nodeRiverWorks(node({ supplyRule: 'runOfRiver', pumpCapacityM3Day: 100, pctUpstreamToDam: 1, divertCapacityM3Day: 50 }), crops).map((x) => x.kind)).toEqual(['pump']);
	});

	it('reads the dam over the run (§2.7g): one not in service from the start, or silted empty by the end, leaves days with no dam', () => {
		const win = { startDate: '2000-10-01', endDate: '2010-09-30' };
		const dam = { pctUpstreamToDam: 1, damCapacityM3: 1e5, divertCapacityM3Day: 200 };
		expect(nodeRiverWorks(node(dam), crops, win).map((x) => x.kind)).toEqual(['divert']);
		const later = nodeRiverWorks(node({ ...dam, damInServiceFrom: '2005-01-01' }), crops, win);
		expect(later.map((x) => `${x.kind}:${x.bounded}`)).toEqual(['divert:true', 'noDam:false']);
		expect(later[1]!.someDays).toBe(true);
		// In service before the run: there throughout.
		expect(nodeRiverWorks(node({ ...dam, damInServiceFrom: '1990-01-01' }), crops, win).map((x) => x.kind)).toEqual(['divert']);
		// In service after the run ends: no dam at all in it, so no River to dam into it either.
		expect(nodeRiverWorks(node({ ...dam, damInServiceFrom: '2020-01-01' }), crops, win).map((x) => x.kind)).toEqual(['noDam']);
		// Silted empty before the run ends (20 % a year from a 2000 survey).
		expect(nodeRiverWorks(node({ ...dam, damSurveyDate: '2000-10-01', damSedimentPctPerYear: 0.2 }), crops, win).map((x) => x.kind)).toEqual(['divert', 'noDam']);
		// Without a window a dam counts as there throughout.
		expect(nodeRiverWorks(node({ ...dam, damInServiceFrom: '2005-01-01' }), crops).map((x) => x.kind)).toEqual(['divert']);
	});

	it('takes nothing in a run that ends before its abstraction starts (§2.7g)', () => {
		const win = { startDate: '2000-10-01', endDate: '2010-09-30' };
		expect(nodeRiverWorks(node({ supplyRule: 'riverFirst', abstractionFrom: '2012-01-01' }), crops, win)).toEqual([]);
		expect(nodeRiverWorks(node({ supplyRule: 'riverFirst', abstractionFrom: '2008-01-01' }), crops, win)).toHaveLength(1);
		const user = node({ kind: 'user', userDemandM3Day: new Array(12).fill(50), abstractionFrom: '2012-01-01' });
		expect(nodeRiverWorks(user, crops, win)).toEqual([]);
	});

	it('keeps the EWR: the EWR kept, or a hands-off flow above 0 in every month it takes; one dry month, or a value the run reads as 0, isn’t', () => {
		const n = { supplyRule: 'riverFirst' as const, pumpCapacityM3Day: 100, damCapacityM3: 1e4, divertCapacityM3Day: 50 };
		const kept = (over: Partial<NetworkNode>) => nodeRiverWorks(node({ ...n, ...over }), crops).map((w) => w.protectsEwr);
		expect(kept({ handsOffEwr: true })).toEqual([true, true]);
		expect(kept({ handsOffM3Day: new Array(12).fill(300) })).toEqual([true, true]);
		expect(kept({ handsOffM3Day: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1] })).toEqual([false, false]);
		expect(kept({ handsOffM3Day: new Array(12).fill(0) })).toEqual([false, false]);
		expect(kept({ handsOffM3Day: [...new Array(11).fill(300), Number.POSITIVE_INFINITY] })).toEqual([false, false]);
		expect(kept({ handsOffM3Day: new Array(11).fill(300) })).toEqual([false, false]);
		// River to dam only in winter (Oct–Nov): a hands-off flow in those months covers it, not the pump.
		const winter = [100, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
		expect(kept({ divertMonthlyM3Day: winter, handsOffM3Day: [300, 300, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] })).toEqual([false, true]);
	});

	it('a pass-inflow release keeps the pump’s take off its target (the EWR, or its monthly amounts above 0), not River to dam’s', () => {
		const n = { supplyRule: 'riverFirst' as const, pumpCapacityM3Day: 100, damCapacityM3: 1e4, divertCapacityM3Day: 50, damReleaseRule: 'passInflow' as const };
		expect(nodeRiverWorks(node(n), crops).map((w) => w.protectsEwr)).toEqual([true, false]);
		expect(nodeRiverWorks(node({ ...n, damReleaseM3Day: new Array(12).fill(400) }), crops)[0]!.protectsEwr).toBe(true);
		expect(nodeRiverWorks(node({ ...n, damReleaseM3Day: [...new Array(11).fill(400), 0] }), crops)[0]!.protectsEwr).toBe(false);
		expect(nodeRiverWorks(node({ ...n, damReleaseRule: 'fixed', damReleaseM3Day: new Array(12).fill(400) }), crops)[0]!.protectsEwr).toBe(false);
	});

	it('an other water user with demand takes from the river, bounded by its pump, and can never keep the EWR; a gauge takes nothing', () => {
		const user = node({ kind: 'user', userDemandM3Day: new Array(12).fill(50) });
		expect(nodeRiverWorks(user, crops)).toEqual([{ kind: 'user', id: 'F', name: 'Farm', bounded: false, protectsEwr: false }]);
		expect(nodeRiverWorks({ ...user, pumpCapacityM3Day: 40 }, crops)[0]!.bounded).toBe(true);
		expect(nodeRiverWorks({ ...user, pumpCapacityM3Day: 0 }, crops)).toEqual([]);
		expect(nodeRiverWorks({ ...user, userDemandM3Day: new Array(12).fill(0) }, crops)).toEqual([]);
		expect(nodeRiverWorks({ ...user, handsOffEwr: true }, crops)[0]!.protectsEwr).toBe(false);
		expect(nodeRiverWorks(node({ kind: 'gauge', supplyRule: 'riverFirst' }), crops)).toEqual([]);
	});
});

describe('offtakeRiverWorks', () => {
	const nodes = [node({ id: 'F', name: 'Upper' }), node({ id: 'H', name: 'Canal head' })];
	it('a river rule with a rate is bounded by it; disabled, all-zero or a dam rule is none', () => {
		expect(offtakeRiverWorks(transfer({}), nodes)).toEqual({ kind: 'offtake', id: 'T1', name: 'Upper → Canal head', bounded: true, protectsEwr: false });
		expect(offtakeRiverWorks(transfer({ enabled: false }), nodes)).toBeNull();
		expect(offtakeRiverWorks(transfer({ monthlyRateM3s: new Array(12).fill(0), months: [], maxRateM3s: 0 }), nodes)).toBeNull();
		expect(offtakeRiverWorks(transfer({ source: 'dam' }), nodes)).toBeNull();
		expect(offtakeRiverWorks(transfer({ source: undefined }), nodes)).toBeNull();
	});
	it('a rate that isn’t a number is unbounded unless a daily cap holds it; its own hands-off flow or the EWR protects it', () => {
		expect(offtakeRiverWorks(transfer({ maxRateM3s: Number.POSITIVE_INFINITY }), nodes)!.bounded).toBe(false);
		expect(offtakeRiverWorks(transfer({ maxRateM3s: Number.POSITIVE_INFINITY, dailyCapM3: 5000 }), nodes)!.bounded).toBe(true);
		expect(offtakeRiverWorks(transfer({ handsOffM3Day: 300 }), nodes)!.protectsEwr).toBe(true);
		expect(offtakeRiverWorks(transfer({ handsOffM3Day: 0 }), nodes)!.protectsEwr).toBe(false);
		expect(offtakeRiverWorks(transfer({ handsOffEwr: true }), nodes)!.protectsEwr).toBe(true);
	});
});

describe('riverWorks and unboundedRiverWorks', () => {
	it('lists nodes in model order then off-takes; the unbounded ones exclude a capped pump and an off-take held by its rate', () => {
		const m = model({
			nodes: [
				node({ id: 'F', name: 'A', supplyRule: 'riverFirst', pumpCapacityM3Day: 100, pctUpstreamToDam: 1 }),
				node({ id: 'U', name: 'Town', kind: 'user', userDemandM3Day: new Array(12).fill(5) })
			],
			cropAreas: crops.cropAreas,
			transfers: [transfer({ toNodeId: 'U' })]
		});
		expect(riverWorks(m).map((w) => `${w.kind}:${w.id}`)).toEqual(['pump:F', 'noDam:F', 'user:U', 'offtake:T1']);
		expect(unboundedRiverWorks(m).map((w) => `${w.kind}:${w.id}`)).toEqual(['noDam:F', 'user:U']);
	});
});

describe('riverWorksTouched and proposedRiverWorks', () => {
	const lookup: RiverWorksLookup = {
		demandObjects: [object()],
		boreholes: [{ id: 'B1', nodeId: 'F' } as never],
		transfers: [transfer({ id: 'DT', source: 'dam', fromNodeId: 'K', toNodeId: 'F' }), transfer({ id: 'RT', toNodeId: 'F' })],
		allocations: [{ id: 'A1', nodeId: 'F', waterSource: 'surface', volumeM3PerYear: 1e5 } as never],
		cropAreas: [{ nodeId: 'F', cropId: 'new', areaM2: 10 }, { nodeId: 'K', cropId: 'new', areaM2: 10 }, { nodeId: 'H', cropId: 'old', areaM2: 10 }]
	};
	const ids = (op: ScenarioOp, m: RiverWorksLookup = lookup) => riverWorksTouched(op, m);
	it('maps each op to the nodes or off-takes whose take it adds or changes', () => {
		expect(ids({ op: 'node.set', nodeId: 'F', field: 'pumpCapacityM3Day', value: 10 })).toEqual({ nodeIds: ['F'], transferIds: [] });
		expect(ids({ op: 'node.set', nodeId: 'F', field: 'name', value: 'B' })).toEqual({ nodeIds: [], transferIds: [] });
		expect(ids({ op: 'cropArea.set', nodeId: 'F', cropId: 'c', areaM2: 1 }).nodeIds).toEqual(['F']);
		expect(ids({ op: 'demandObject.add', demandObject: object({ nodeId: 'K' }) }).nodeIds).toEqual(['K']);
		expect(ids({ op: 'demandObject.set', demandObjectId: 'D1', field: 'monthlyM3Day', value: new Array(12).fill(20) }).nodeIds).toEqual(['F']);
		expect(ids({ op: 'demandObject.set', demandObjectId: 'D1', field: 'note', value: 'meter 4' }).nodeIds).toEqual([]);
		expect(ids({ op: 'demand.scale', factor: 1.2, nodeIds: ['F'] }).nodeIds).toEqual(['F']);
		expect(ids({ op: 'demand.scale', factor: 0.8, nodeIds: ['F'] }).nodeIds).toEqual([]);
		expect(ids({ op: 'transfer.add', transfer: transfer({}) }).transferIds).toEqual(['T1']);
		expect(ids({ op: 'transfer.set', transferId: 'T1', field: 'handsOffEwr', value: false }).transferIds).toEqual(['T1']);
		expect(ids({ op: 'borehole.add', borehole: { id: 'B', nodeId: 'F' } as never })).toEqual({ nodeIds: [], transferIds: [] });
		expect(ids({ op: 'node.remove', nodeId: 'F' })).toEqual({ nodeIds: [], transferIds: [] });
		expect(ids({ op: 'node.add', node: node({ id: 'N' }) }).nodeIds).toEqual(['N']);
		expect(ids({ op: 'node.insert', node: node({ id: 'N' }), upstreamNodeIds: [] }).nodeIds).toEqual(['N']);
		// Moving the applicant's abstraction point is where they propose to take water.
		expect(ids({ op: 'node.move', nodeId: 'F', downstreamNodeId: 'G2' }).nodeIds).toEqual(['F']);
		expect(ids({ op: 'demand.scale', factor: 1.5 }).nodeIds).toEqual([]);
		expect(ids({ op: 'demand.scale', factor: 1, nodeIds: ['F'] }).nodeIds).toEqual([]);
		for (const field of ['name', 'source'] as const) expect(ids({ op: 'demandObject.set', demandObjectId: 'D1', field, value: field === 'name' ? 'Shed' : 'meter' } as ScenarioOp).nodeIds).toEqual([]);
		expect(ids({ op: 'demandObject.set', demandObjectId: 'nope', field: 'monthlyM3Day', value: new Array(12).fill(20) }).nodeIds).toEqual([]);
	});

	it('counts the ops that may raise an existing take: a borehole or a dam transfer in removed, a registered volume set or removed, an added crop changed', () => {
		// The river covers what the borehole supplied.
		expect(ids({ op: 'borehole.remove', boreholeId: 'B1' }).nodeIds).toEqual(['F']);
		expect(ids({ op: 'borehole.add', borehole: { id: 'B2', nodeId: 'F' } as never }).nodeIds).toEqual([]);
		// A dam transfer into the unit removed: its own river take covers it. An off-take removed takes less.
		expect(ids({ op: 'transfer.remove', transferId: 'DT' }).nodeIds).toEqual(['F']);
		expect(ids({ op: 'transfer.remove', transferId: 'RT' })).toEqual({ nodeIds: [], transferIds: [] });
		// A cap lifted or moved: the unit it was on, and the one it goes to.
		expect(ids({ op: 'allocation.remove', allocationId: 'A1' }).nodeIds).toEqual(['F']);
		expect(ids({ op: 'allocation.set', allocation: { id: 'A1', nodeId: 'K', waterSource: 'surface', volumeM3PerYear: 2e5 } as never }).nodeIds).toEqual(['K', 'F']);
		// A crop the scenario added, on every unit growing it.
		expect(ids({ op: 'crop.set', cropId: 'new', field: 'cropFactor', value: new Array(12).fill(1) } as ScenarioOp).nodeIds).toEqual(['F', 'K']);
		expect(ids({ op: 'crop.set', cropId: 'new', field: 'name', value: 'Maize' } as ScenarioOp).nodeIds).toEqual([]);
	});

	it('judges a pump whose borehole the application removes, found in the model the op met', () => {
		const after = model({ nodes: [node({ supplyRule: 'riverFirst', pumpCapacityM3Day: 1000 })], cropAreas: crops.cropAreas });
		const before = { ...after, boreholes: [{ id: 'B1', nodeId: 'F' } as never] };
		expect(proposedRiverWorks([{ op: 'borehole.remove', boreholeId: 'B1' }], ['proposal'], before, after).map((w) => `${w.kind}:${w.protectsEwr}`)).toEqual(['pump:false']);
	});

	it('returns nothing for a touched unit with no river take, and only the open take of two in a mixed case', () => {
		const dry = model({ nodes: [node({ damCapacityM3: 1e4 })], cropAreas: crops.cropAreas });
		expect(proposedRiverWorks([{ op: 'node.set', nodeId: 'F', field: 'damCapacityM3', value: 2e4 }], ['proposal'], dry, dry)).toEqual([]);
		const two = model({
			nodes: [node({ supplyRule: 'riverFirst', pumpCapacityM3Day: 100, handsOffEwr: true }), node({ id: 'K', name: 'Other', supplyRule: 'runOfRiver', pumpCapacityM3Day: 50 })],
			cropAreas: [...crops.cropAreas, { nodeId: 'K', cropId: 'c', areaM2: 500 }]
		});
		const ops: ScenarioOp[] = [
			{ op: 'cropArea.set', nodeId: 'F', cropId: 'c', areaM2: 2000 },
			{ op: 'cropArea.set', nodeId: 'K', cropId: 'c', areaM2: 900 }
		];
		const w = proposedRiverWorks(ops, ['proposal', 'proposal'], two, two);
		expect(w.map((x) => `${x.id}:${x.protectsEwr}`)).toEqual(['F:true', 'K:false']);
	});

	it('counts proposals only, and judges the take as the application ran it', () => {
		const after = model({ nodes: [node({ supplyRule: 'riverFirst', pumpCapacityM3Day: 100 })], cropAreas: crops.cropAreas, demandObjects: [object()] });
		const op: ScenarioOp = { op: 'demandObject.set', demandObjectId: 'D1', field: 'monthlyM3Day', value: new Array(12).fill(20) };
		expect(proposedRiverWorks([op], ['proposal'], after, after).map((w) => w.kind)).toEqual(['pump']);
		expect(proposedRiverWorks([op], ['baseline'], after, after)).toEqual([]);
		// A demand object the application removed is still found in the baseline's model; what is left of its unit is judged.
		const removed = model({ ...after, demandObjects: [] });
		expect(proposedRiverWorks([op], ['proposal'], after, removed).map((w) => w.id)).toEqual(['F']);
	});
});
