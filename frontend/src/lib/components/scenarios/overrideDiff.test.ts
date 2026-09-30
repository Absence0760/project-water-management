// Override mode's diff (overrideDiff.ts): edits made with the model editor's
// own methods (the ones the Network, Crops and Transfers tabs call) come back
// as ops that apply to the model the editor was loaded with and give back the
// edited model; edits no op can express are named, never dropped.
import { applyScenario, withMonthlyRates, type ModelInput, type ProjectModel, type ScenarioOp } from '@water-management/engine';
import { randomInput, randomOps } from '@water-management/engine/testing';
import { describe, expect, it } from 'vitest';
import { ModelEditor, newNode } from '$lib/model/editor.svelte';
import { diffModel } from './overrideDiff';
import { snapshotInput } from './ops';

// Synthetic ids (UUID-shaped, as the backend requires) and invented names.
const G = '00000000-0000-4000-8000-000000000001';
const UP = '00000000-0000-4000-8000-000000000002';
const LO = '00000000-0000-4000-8000-000000000003';
const CROP = '00000000-0000-4000-8000-0000000000c1';
const T = '00000000-0000-4000-8000-0000000000a1';
const P = '00000000-0000-4000-8000-0000000000b1';

function base(): ModelInput {
	const gauge = { ...newNode(0, null), id: G, name: 'Outflow gauge' };
	const upper = { ...newNode(1, G), id: UP, name: 'Upper farm', areaKm2: 12, damCapacityM3: 150_000 };
	const lower = { ...newNode(2, UP), id: LO, name: 'Lower farm', areaKm2: 8, damCapacityM3: 90_000 };
	return snapshotInput(
		{
			nodes: [gauge, upper, lower],
			crops: [{ id: CROP, name: 'Orchard', cropFactor: new Array(12).fill(0.6) }],
			cropAreas: [{ nodeId: UP, cropId: CROP, areaM2: 200_000 }],
			transfers: [{ id: T, fromNodeId: UP, toNodeId: LO, months: [11, 12], maxRateM3s: 0.01, dailyCapM3: null, minStoragePct: 0.2, enabled: true, priority: 0 }],
			landCover: [{ id: P, nodeId: LO, coverClass: 'pine', areaKm2: 1.5, densityPct: 0.5, factors: null }]
		},
		{ flowShareMethod: 'area', simulationStart: null, apanMm: new Array(12).fill(100) }
	);
}

/** An editor loaded with the base's model, as override mode loads it. */
function editing(b: ModelInput) {
	const e = new ModelEditor();
	e.load(b.model);
	return e;
}
const node = (e: ModelEditor, id: string) => e.model.nodes.find((n) => n.id === id)!;

/** The ops apply cleanly and give back the edited model. */
function roundTrips(b: ModelInput, after: ProjectModel) {
	const d = diffModel(b, after);
	expect(d.unsupported).toEqual([]);
	expect(d.problems).toEqual([]);
	const applied = applyScenario(b, d.ops);
	expect(applied.problems).toEqual([]);
	return d.ops;
}

describe('diffModel', () => {
	it('turns demand objects into demandObject.add / .set / .remove, and lets a removed unit take its objects (engine 1.39.0)', () => {
		const b = base();
		const e = editing(b);
		const town = e.addDemandObject(UP, 'municipal');
		town.name = 'Village';
		town.monthlyM3Day = new Array(12).fill(300);
		let ops = roundTrips(b, e.snapshot());
		expect(ops).toEqual([{ op: 'demandObject.add', demandObject: expect.objectContaining({ id: town.id, nodeId: UP, name: 'Village', monthlyM3Day: new Array(12).fill(300) }) }]);
		// Recorded, then edited in place: one demandObject.set per field, next to each other (one edit group),
		// so a switch to a count × litres records as it is, the save rules checked once after the last.
		const withTown = applyScenario(b, ops).input;
		const e2 = editing(withTown);
		const o = e2.model.demandObjects![0]!;
		Object.assign(o, { sizing: 'perUnit', count: 1200, litresPerUnitDay: 230, returnPct: 0.3, note: 'Census 2022' });
		o.schedule = [{ label: 'Weekends', span: 'always', from: null, to: null, easterFrom: null, easterTo: null, weekdays: [6, 7], factor: 0.5 }];
		ops = roundTrips(withTown, e2.snapshot());
		expect(ops.map((x) => (x.op === 'demandObject.set' ? x.field : x.op))).toEqual(['sizing', 'count', 'litresPerUnitDay', 'returnPct', 'schedule', 'note']);
		expect(ops.every((x) => x.op === 'demandObject.set' && x.demandObjectId === town.id)).toBe(true);
		// A schedule of none, null or [] is the same: clearing one that was never set records nothing.
		const e3 = editing(withTown);
		e3.model.demandObjects![0]!.schedule = [];
		expect(diffModel(withTown, e3.snapshot())).toEqual({ ops: [], unsupported: [], problems: [] });
		// Moved to another unit: removed and added again. Removed: demandObject.remove.
		e3.model.demandObjects![0]!.nodeId = LO;
		expect(roundTrips(withTown, e3.snapshot()).map((x) => x.op)).toEqual(['demandObject.remove', 'demandObject.add']);
		e3.removeDemandObject(town.id);
		expect(roundTrips(withTown, e3.snapshot())).toEqual([{ op: 'demandObject.remove', demandObjectId: town.id }]);
		// An edit that breaks a save rule (a return from water piped out) is a problem, and nothing is recorded as something else.
		const e4 = editing(withTown);
		Object.assign(e4.model.demandObjects![0]!, { destination: 'external', returnPct: 0.4 });
		expect(diffModel(withTown, e4.snapshot()).problems).toEqual([expect.stringMatching(/^ops 1–2 \(demandObject\.set, "Village"\): .*piped out of the catchment/)]);
		// A unit removed takes its objects with it: a node.remove, no object op.
		const e5 = editing(withTown);
		e5.removeNode(UP);
		const removed = roundTrips(withTown, e5.snapshot());
		expect(removed.some((x) => x.op === 'node.remove')).toBe(true);
		expect(removed.some((x) => x.op.startsWith('demandObject.'))).toBe(false);
	});

	it('records nothing when nothing changed, or only the row order did', () => {
		const b = base();
		const e = editing(b);
		expect(diffModel(b, e.snapshot())).toEqual({ ops: [], unsupported: [], problems: [] });
		e.model.nodes.reverse();
		e.model.nodes.forEach((n, i) => (n.sortOrder = i));
		expect(diffModel(b, e.snapshot())).toEqual({ ops: [], unsupported: [], problems: [] });
	});

	it('turns each node field edited in the Network table into node.set', () => {
		const b = base();
		const e = editing(b);
		node(e, UP).damCapacityM3 = 180_000;
		node(e, UP).damMinPct = 0.1;
		node(e, G).name = 'Weir';
		expect(roundTrips(b, e.snapshot())).toEqual([
			{ op: 'node.set', nodeId: G, field: 'name', value: 'Weir' },
			{ op: 'node.set', nodeId: UP, field: 'damCapacityM3', value: 180_000 },
			{ op: 'node.set', nodeId: UP, field: 'damMinPct', value: 0.1 },
			// The capacity op resizes the dam's area (engine 1.10.0); the table records the area it shows.
			{ op: 'node.set', nodeId: UP, field: 'damAreaFullM2', value: null }
		]);
	});

	it('a capacity edit in the table keeps the area it shows, and refuses a survey-curve dam (engine 1.10.0)', () => {
		const b = base();
		const e = editing(b);
		node(e, UP).damCapacityM3 = 180_000;
		node(e, UP).damAreaFullM2 = 40_000;
		const ops = roundTrips(b, e.snapshot());
		expect(ops.at(-1)).toEqual({ op: 'node.set', nodeId: UP, field: 'damAreaFullM2', value: 40_000 });
		expect(applyScenario(b, ops).input.model.nodes.find((n) => n.id === UP)!.damAreaFullM2).toBe(40_000);
		const curved = structuredClone(b);
		const up = curved.model.nodes.find((n) => n.id === UP)!;
		up.damCurve = [
			{ levelM: 0, areaM2: 0, volumeM3: 0 },
			{ levelM: 5, areaM2: 50_000, volumeM3: up.damCapacityM3 }
		];
		const e2 = editing(curved);
		node(e2, UP).damCapacityM3 = up.damCapacityM3 * 1.2;
		expect(diffModel(curved, e2.snapshot()).unsupported).toEqual([expect.stringMatching(/dam, which has a survey curve: .*add it as a change instead/)]);
	});

	it('records a survey curve edit as node.set, after the capacity when the dam is raised with it (engine 1.20.0)', () => {
		const b = base();
		const up = b.model.nodes.find((n) => n.id === UP)!;
		up.damCurve = [
			{ levelM: 0, areaM2: 0, volumeM3: 0 },
			{ levelM: 5, areaM2: 50_000, volumeM3: up.damCapacityM3 }
		];
		const surveyed = [
			{ levelM: 0, areaM2: 0, volumeM3: 0 },
			{ levelM: 4, areaM2: 40_000, volumeM3: 100_000 },
			{ levelM: 8, areaM2: 70_000, volumeM3: 240_000 }
		];
		// The curve alone.
		const e = editing(b);
		node(e, LO).damCurve = surveyed.map((r) => ({ ...r, volumeM3: (r.volumeM3 * 90_000) / 240_000 }));
		expect(roundTrips(b, e.snapshot())).toEqual([{ op: 'node.set', nodeId: LO, field: 'damCurve', value: node(e, LO).damCurve }]);
		// A raise with the enlarged dam's own survey: the curve lands as entered, not resized along the old one.
		const e2 = editing(b);
		node(e2, UP).damCapacityM3 = 240_000;
		node(e2, UP).damCurve = surveyed;
		const ops = roundTrips(b, e2.snapshot());
		expect(ops.map((o) => (o.op === 'node.set' ? o.field : o.op))).toEqual(['damCapacityM3', 'damAreaFullM2', 'damCurve']);
		expect(applyScenario(b, ops).input.model.nodes.find((n) => n.id === UP)!.damCurve).toEqual(surveyed);
	});

	it('turns a supply rule and river pump edit into node.set (WP-3.8): river first at 1,200 m³/day', () => {
		const b = base();
		const e = editing(b);
		node(e, LO).supplyRule = 'riverFirst';
		node(e, LO).pumpCapacityM3Day = 1200;
		expect(roundTrips(b, e.snapshot())).toEqual([
			{ op: 'node.set', nodeId: LO, field: 'supplyRule', value: 'riverFirst' },
			{ op: 'node.set', nodeId: LO, field: 'pumpCapacityM3Day', value: 1200 }
		]);
	});

	it('records a node\'s supply edit as one edit group, whatever the save rules tie together (docs/scenarios.md § Edit groups)', () => {
		const fields = (ops: readonly ScenarioOp[]) => ops.map((o) => (o.op === 'node.set' ? o.field : o.op));
		// Upper farm on the trigger rule (it has a dam): straight to run of river with its dam emptied, no riverFirst detour.
		const trig = applyScenario(base(), [{ op: 'node.set', nodeId: UP, field: 'supplyRule', value: 'trigger' }]).input;
		let e = editing(trig);
		node(e, UP).damCapacityM3 = 0;
		node(e, UP).supplyRule = 'runOfRiver';
		node(e, UP).pumpCapacityM3Day = 1500;
		expect(fields(roundTrips(trig, e.snapshot())).sort()).toEqual(['damCapacityM3', 'pumpCapacityM3Day', 'supplyRule']);
		// Both levels raised past the stop level (60 %): either would break stop ≥ trigger alone.
		e = editing(trig);
		node(e, UP).supplyTriggerPct = 0.7;
		node(e, UP).supplyStopPct = 0.9;
		expect(fields(roundTrips(trig, e.snapshot())).sort()).toEqual(['supplyStopPct', 'supplyTriggerPct']);
		// A dam-less farm given a dam and the trigger rule.
		const ror = applyScenario(base(), [{ op: 'node.set', nodeId: LO, field: 'damCapacityM3', value: 0 }]).input;
		e = editing(ror);
		node(e, LO).damCapacityM3 = 20_000;
		node(e, LO).supplyRule = 'trigger';
		expect(fields(roundTrips(ror, e.snapshot())).sort()).toEqual(['damCapacityM3', 'supplyRule']);
	});

	it('keeps one node\'s ops next to each other, in a deterministic order', () => {
		const b = base();
		const e = editing(b);
		node(e, UP).supplyRule = 'riverFirst';
		node(e, LO).damCapacityM3 = 80_000;
		node(e, UP).damCapacityM3 = 160_000;
		node(e, LO).name = 'Bottom farm';
		const ops = roundTrips(b, e.snapshot());
		const nodes = ops.map((o) => (o.op === 'node.set' ? o.nodeId : null));
		// Each node's run is unbroken: a node never reappears after another's ops.
		expect(nodes.filter((id, i) => i === 0 || id !== nodes[i - 1])).toEqual([UP, LO]);
		expect(diffModel(b, e.snapshot()).ops).toEqual(ops);
	});

	it('reports a node edit that still breaks a save rule once, naming every op of it', () => {
		// The trigger rule on a farm left without a dam never fits, in any order.
		const b = base();
		let e = editing(b);
		node(e, LO).damCapacityM3 = 0;
		node(e, LO).supplyRule = 'trigger';
		node(e, LO).pumpCapacityM3Day = 900;
		expect(diffModel(b, e.snapshot()).problems).toEqual([expect.stringMatching(/^ops 1–3 \(node\.set, "Lower farm"\): .*the trigger supply rule needs a farm dam/)]);
		// One op alone reads as always.
		e = editing(b);
		node(e, LO).supplyRule = 'runOfRiver';
		expect(diffModel(b, e.snapshot()).problems).toEqual([expect.stringMatching(/^op 1 \(node\.set\): .*run of river has no dam/)]);
	});

	it('round-trips any supply rule, pump, levels and dam the save rules allow, from any starting one (fuzz)', () => {
		// A fixed LCG, so every run checks the same cases.
		let x = 7;
		const rnd = () => (x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
		const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
		const RULES = ['damFirst', 'riverFirst', 'trigger', 'runOfRiver'] as const;
		/** A farm state the save rules accept: trigger needs a dam, run of river none, stop ≥ trigger. */
		const valid = () => {
			const supplyRule = pick(RULES);
			const damCapacityM3 = supplyRule === 'runOfRiver' ? 0 : supplyRule === 'trigger' ? pick([20_000, 150_000]) : pick([0, 20_000, 150_000]);
			const supplyTriggerPct = pick([0.2, 0.4, 0.7]);
			return { supplyRule, damCapacityM3, pumpCapacityM3Day: pick([null, 0, 1200]), supplyTriggerPct, supplyStopPct: Math.min(1, supplyTriggerPct + pick([0, 0.2, 0.3])) };
		};
		for (let i = 0; i < 80; i++) {
			// The starting state is itself one edit group on the base's Upper farm.
			const start = applyScenario(
				base(),
				Object.entries(valid()).map(([field, value]) => ({ op: 'node.set', nodeId: UP, field, value }) as ScenarioOp)
			);
			expect(start.problems, `case ${i} start`).toEqual([]);
			const e = editing(start.input);
			Object.assign(node(e, UP), valid());
			const d = diffModel(start.input, e.snapshot());
			expect(d.unsupported, `case ${i}`).toEqual([]);
			expect(d.problems, `case ${i}`).toEqual([]);
		}
	});

	it('turns a new node and a removed one into node.add and node.remove, re-linking as the editor does', () => {
		const b = base();
		const e = editing(b);
		const added = e.addNode();
		added.damCapacityM3 = 40_000;
		const user = e.addUser();
		user.userDemandM3Day = new Array(12).fill(250);
		// Lower farm drains into Upper farm: removing Upper re-links it to the gauge, and drops Upper's crop area and transfer.
		e.removeNode(UP);
		const ops = roundTrips(b, e.snapshot());
		expect(ops.map((o) => o.op)).toEqual(['node.remove', 'node.add', 'node.add']);
		expect(ops[1]).toMatchObject({ op: 'node.add', node: { id: added.id, name: 'Farm 3', downstreamNodeId: G, damCapacityM3: 40_000 } });
		expect(ops[2]).toMatchObject({ op: 'node.add', node: { id: user.id, kind: 'user', userDemandM3Day: new Array(12).fill(250) } });
	});

	it('adds a node that drains into another new node after it', () => {
		const b = base();
		const e = editing(b);
		const first = e.addNode();
		const second = e.addNode();
		second.downstreamNodeId = first.id;
		// The editor lists the child first; the ops still add its downstream node first.
		e.model.nodes = [e.model.nodes.find((n) => n.id === second.id)!, ...e.model.nodes.filter((n) => n.id !== second.id)];
		const ops = roundTrips(b, e.snapshot());
		expect(ops.map((o) => (o.op === 'node.add' ? o.node.id : o.op))).toEqual([first.id, second.id]);
	});

	it('turns the Crops table into crop.add and cropArea.set, 0 removing a row', () => {
		const b = base();
		const e = editing(b);
		const c = e.addCrop();
		c.cropFactor = new Array(12).fill(0.8);
		e.setCropArea(UP, CROP, 0);
		e.setCropArea(UP, c.id, 150_000);
		e.setCropArea(LO, CROP, 50_000);
		expect(roundTrips(b, e.snapshot())).toEqual([
			{ op: 'crop.add', crop: { id: c.id, name: 'Crop 2', cropFactor: new Array(12).fill(0.8) } },
			{ op: 'cropArea.set', nodeId: UP, cropId: CROP, areaM2: 0 },
			{ op: 'cropArea.set', nodeId: UP, cropId: c.id, areaM2: 150_000 },
			{ op: 'cropArea.set', nodeId: LO, cropId: CROP, areaM2: 50_000 }
		]);
	});

	it('turns the Transfers table into transfer.add, transfer.set per field and transfer.remove', () => {
		const b = base();
		const e = editing(b);
		const t = e.model.transfers[0]!;
		t.months = [12, 1, 11];
		t.enabled = false;
		const added = e.addTransfer();
		added.fromNodeId = LO;
		added.toNodeId = UP;
		added.months = [6];
		added.maxRateM3s = 0.02;
		let ops = roundTrips(b, e.snapshot());
		expect(ops).toEqual([
			{ op: 'transfer.add', transfer: expect.objectContaining({ id: added.id, fromNodeId: LO, toNodeId: UP, months: [6], priority: 1 }) },
			{ op: 'transfer.set', transferId: T, field: 'months', value: [1, 11, 12] },
			{ op: 'transfer.set', transferId: T, field: 'enabled', value: false }
		]);
		e.removeTransfer(T);
		ops = roundTrips(b, e.snapshot());
		expect(ops[0]).toEqual({ op: 'transfer.remove', transferId: T });
	});

	it('turns a month\'s rate edited on the Transfers tab into one transfer.set of the monthly rates (engine 1.14.0)', () => {
		const b = base();
		const e = editing(b);
		const t = e.model.transfers[0]!;
		// What the Transfers tab writes when November's rate changes on the Nov–Dec rule at 0.01 m³/s.
		Object.assign(t, withMonthlyRates([0, 0.03, 0.01, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
		const ops = roundTrips(b, e.snapshot());
		expect(ops).toEqual([{ op: 'transfer.set', transferId: T, field: 'monthlyRateM3s', value: [0, 0.03, 0.01, 0, 0, 0, 0, 0, 0, 0, 0, 0] }]);
	});

	it('turns land cover into landCover.add and .remove, a patch edited in place into landCover.set (engine ≥ 1.35.0), one moved to another unit removed and added', () => {
		const b = base();
		const e = editing(b);
		e.model.landCover![0]!.areaKm2 = 2;
		e.model.landCover![0]!.densityPct = 0.25;
		const added = e.addLandCover(UP);
		added.areaKm2 = 0.5;
		expect(roundTrips(b, e.snapshot())).toEqual([
			{ op: 'landCover.add', patch: expect.objectContaining({ id: added.id, nodeId: UP, areaKm2: 0.5 }) },
			{ op: 'landCover.set', patchId: P, field: 'areaKm2', value: 2 },
			{ op: 'landCover.set', patchId: P, field: 'densityPct', value: 0.25 }
		]);
		const e2 = editing(b);
		e2.model.landCover![0]!.nodeId = UP;
		expect(roundTrips(b, e2.snapshot()).map((o) => o.op)).toEqual(['landCover.remove', 'landCover.add']);
	});

	it('turns a crop edited in the Crops tab into crop.set per field, and a removed crop into crop.remove (engine ≥ 1.35.0)', () => {
		const b = base();
		const e = editing(b);
		e.model.crops[0]!.cropFactor[0] = 0.9;
		e.model.crops[0]!.name = 'Stone fruit';
		const ops = roundTrips(b, e.snapshot());
		expect(ops).toEqual([
			{ op: 'crop.set', cropId: CROP, field: 'name', value: 'Stone fruit' },
			{ op: 'crop.set', cropId: CROP, field: 'cropFactor', value: [0.9, ...new Array(11).fill(0.6)] }
		]);
		// Removed: one op, which drops its areas too (so no cropArea.set rides along).
		const e2 = editing(b);
		e2.removeCrop(CROP);
		expect(roundTrips(b, e2.snapshot())).toEqual([{ op: 'crop.remove', cropId: CROP }]);
		// A new crop given the removed one's name: the removal goes first, so the name is free.
		const e3 = editing(b);
		e3.removeCrop(CROP);
		const c = e3.addCrop();
		c.name = 'Orchard';
		expect(roundTrips(b, e3.snapshot()).map((o) => o.op)).toEqual(['crop.remove', 'crop.add']);
	});

	it('turns what a node drains into into node.move, and a new node existing nodes now drain into into node.insert (engine ≥ 1.35.0)', () => {
		const b = base();
		// Lower farm drains into Upper farm: move it to drain into the gauge.
		const e = editing(b);
		node(e, LO).downstreamNodeId = G;
		expect(roundTrips(b, e.snapshot())).toEqual([{ op: 'node.move', nodeId: LO, downstreamNodeId: G }]);
		// A new weir between the upper farm and the gauge: node.insert, taking the upper farm (and the lower behind it).
		const e2 = editing(b);
		const w = e2.addNode();
		Object.assign(w, { name: 'New weir', downstreamNodeId: G });
		node(e2, UP).downstreamNodeId = w.id;
		const ops = roundTrips(b, e2.snapshot());
		expect(ops).toEqual([{ op: 'node.insert', node: expect.objectContaining({ id: w.id, downstreamNodeId: G }), upstreamNodeIds: [UP] }]);
		// Reversing the two farms' order: each move lands where it ends up, nearest the outlet first, so neither makes a loop.
		const e3 = editing(b);
		node(e3, LO).downstreamNodeId = G;
		node(e3, UP).downstreamNodeId = LO;
		expect(roundTrips(b, e3.snapshot())).toEqual([
			{ op: 'node.move', nodeId: LO, downstreamNodeId: G },
			{ op: 'node.move', nodeId: UP, downstreamNodeId: LO }
		]);
	});

	it('turns individual boreholes into borehole.add and .remove; one edited in place is removed and added again', () => {
		const b = base();
		const e = editing(b);
		const bore = e.addBorehole(UP);
		bore.capacityM3Day = 300;
		let ops = roundTrips(b, e.snapshot());
		expect(ops).toEqual([{ op: 'borehole.add', borehole: expect.objectContaining({ id: bore.id, nodeId: UP, capacityM3Day: 300 }) }]);
		// Recorded, then edited: the next diff (from the model with it) removes and re-adds it.
		const withBore = applyScenario(b, ops).input;
		const e2 = editing(withBore);
		e2.model.boreholes![0]!.capacityM3Day = 500;
		ops = roundTrips(withBore, e2.snapshot());
		expect(ops.map((o) => o.op)).toEqual(['borehole.remove', 'borehole.add']);
		e2.removeBorehole(bore.id);
		expect(roundTrips(withBore, e2.snapshot())).toEqual([{ op: 'borehole.remove', boreholeId: bore.id }]);
	});

	it('names every edit no op can express, and records none of them', () => {
		const b = base();
		const e = editing(b);
		node(e, LO).downstreamNodeId = null;
		node(e, UP).kind = 'user';
		node(e, G).areaKm2 = 3;
		const d = diffModel(b, e.snapshot());
		expect(d.unsupported).toEqual([
			"Area on “Outflow gauge”: a scenario can't set that on a gauge.",
			"Changing “Upper farm” from a farm to a user: a scenario can't change a node's kind. Remove it and add a new node.",
			"Making “Lower farm” drain nowhere: the catchment keeps its outflow node, which a scenario can't move."
		]);
		expect(d.ops.some((o) => o.op === 'node.move')).toBe(false);
	});

	it('refuses a value the engine refuses, in the form’s words', () => {
		const b = base();
		const e = editing(b);
		node(e, UP).damMinPct = 1.5;
		node(e, LO).name = '';
		const d = diffModel(b, e.snapshot());
		expect(d.problems).toEqual(['“Upper farm”, Dam minimum operating level: Must be at most 100 %', '“Lower farm”, Name: Must be a name of 1–100 characters']);
	});

	it('round-trips any model edit the engine’s own random ops make (fuzz)', () => {
		for (let seed = 1; seed <= 150; seed++) {
			const input = randomInput(seed);
			// Settings, series and demand factors aren't the model editor's: only model ops.
			const ops = randomOps(input, seed).filter((o) => o.op !== 'settings.set' && o.op !== 'series.scale' && o.op !== 'demand.scale');
			const after = applyScenario(input, ops).input.model;
			const d = diffModel(input, after);
			expect(d.unsupported, `seed ${seed}`).toEqual([]);
			expect(d.problems, `seed ${seed}`).toEqual([]);
		}
	});

	it('keeps a demand factor an earlier demand.scale set, and records only the edit made (issue #53 R1)', () => {
		const scaled = applyScenario(base(), [{ op: 'demand.scale', factor: 0.85, nodeIds: [UP], months: [12, 1] }]).input;
		const e = editing(scaled);
		node(e, UP).damCapacityM3 = 180_000;
		expect(roundTrips(scaled, e.snapshot())).toEqual([
			{ op: 'node.set', nodeId: UP, field: 'damCapacityM3', value: 180_000 },
			{ op: 'node.set', nodeId: UP, field: 'damAreaFullM2', value: null }
		]);
		expect(node(e, UP).demandFactor).toEqual(scaled.model.nodes.find((n) => n.id === UP)!.demandFactor);
	});

	it('reports an edit the engine won’t apply, such as a duplicate name', () => {
		const b = base();
		const e = editing(b);
		node(e, LO).name = 'Upper farm';
		const d = diffModel(b, e.snapshot());
		expect(d.problems).toHaveLength(1);
		expect(d.problems[0]).toMatch(/^op 1 \(node\.set\): /);
	});
});
