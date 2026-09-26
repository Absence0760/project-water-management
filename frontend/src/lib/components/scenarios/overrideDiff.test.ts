// Override mode's diff (overrideDiff.ts): edits made with the model editor's
// own methods (the ones the Network, Crops and Transfers tabs call) come back
// as ops that apply to the model the editor was loaded with and give back the
// edited model; edits no op can express are named, never dropped.
import { applyScenario, type ModelInput, type ProjectModel } from '@water-management/engine';
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
			{ op: 'node.set', nodeId: UP, field: 'damMinPct', value: 0.1 }
		]);
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

	it('orders a node\'s edits so each one applies: the supply rule before an emptied dam, the stop level before a raised trigger', () => {
		// Upper farm on the trigger rule (it has a dam): moving it to river first and emptying the dam applies only rule first.
		const trig = applyScenario(base(), [{ op: 'node.set', nodeId: UP, field: 'supplyRule', value: 'trigger' }]).input;
		let e = editing(trig);
		node(e, UP).damCapacityM3 = 0;
		node(e, UP).supplyRule = 'riverFirst';
		expect(roundTrips(trig, e.snapshot()).map((o) => o.op === 'node.set' && o.field)).toEqual(['supplyRule', 'damCapacityM3']);
		// Raising both levels past the stop level (60 %) applies only stop first.
		e = editing(trig);
		node(e, UP).supplyTriggerPct = 0.7;
		node(e, UP).supplyStopPct = 0.9;
		expect(roundTrips(trig, e.snapshot()).map((o) => o.op === 'node.set' && o.field)).toEqual(['supplyStopPct', 'supplyTriggerPct']);
		// Positive control: a dam-less farm given a dam and the trigger rule takes the dam first, the natural order.
		const ror = applyScenario(base(), [{ op: 'node.set', nodeId: LO, field: 'damCapacityM3', value: 0 }]).input;
		e = editing(ror);
		node(e, LO).damCapacityM3 = 20_000;
		node(e, LO).supplyRule = 'trigger';
		expect(roundTrips(ror, e.snapshot()).map((o) => o.op === 'node.set' && o.field)).toEqual(['damCapacityM3', 'supplyRule']);
	});

	it('reports a supply edit no order makes fit, one op at a time', () => {
		// The trigger rule on a farm left without a dam never fits.
		const b = base();
		let e = editing(b);
		node(e, LO).damCapacityM3 = 0;
		node(e, LO).supplyRule = 'trigger';
		expect(diffModel(b, e.snapshot()).problems).toEqual([expect.stringMatching(/the trigger supply rule needs a farm dam/)]);
		// Trigger straight to run of river with the dam emptied: each step alone breaks a rule (trigger needs the dam,
		// run of river has none), so it is reported; recorded through river first, it applies.
		const trig = applyScenario(base(), [{ op: 'node.set', nodeId: UP, field: 'supplyRule', value: 'trigger' }]).input;
		e = editing(trig);
		node(e, UP).damCapacityM3 = 0;
		node(e, UP).supplyRule = 'runOfRiver';
		expect(diffModel(trig, e.snapshot()).problems.length).toBeGreaterThan(0);
		const via = applyScenario(trig, [
			{ op: 'node.set', nodeId: UP, field: 'supplyRule', value: 'riverFirst' },
			{ op: 'node.set', nodeId: UP, field: 'damCapacityM3', value: 0 },
			{ op: 'node.set', nodeId: UP, field: 'supplyRule', value: 'runOfRiver' }
		]);
		expect(via.problems).toEqual([]);
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

	it('turns land cover into landCover.add and .remove; a patch edited in place is removed and added again', () => {
		const b = base();
		const e = editing(b);
		e.model.landCover![0]!.areaKm2 = 2;
		const added = e.addLandCover(UP);
		added.areaKm2 = 0.5;
		expect(roundTrips(b, e.snapshot()).map((o) => o.op)).toEqual(['landCover.remove', 'landCover.add', 'landCover.add']);
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
		node(e, LO).downstreamNodeId = G;
		node(e, UP).kind = 'user';
		e.model.crops[0]!.cropFactor[0] = 0.9;
		node(e, G).areaKm2 = 3;
		const d = diffModel(b, e.snapshot());
		expect(d.unsupported).toEqual([
			"Editing the crop “Orchard” (its name or crop factors): a scenario can't change a crop yet. Add a new crop and move the areas to it.",
			"Area on “Outflow gauge”: a scenario can't set that on a gauge.",
			"Changing “Upper farm” from a farm to a user: a scenario can't change a node's kind. Remove it and add a new node.",
			"Moving “Lower farm” (what it drains into): a scenario can't move a node yet. Remove it and add a new one where it should drain."
		]);
		e.removeCrop(CROP);
		expect(diffModel(b, e.snapshot()).unsupported[0]).toBe("Removing the crop “Orchard”: a scenario can't remove a crop yet. Set its areas to 0 instead.");
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
		expect(roundTrips(scaled, e.snapshot())).toEqual([{ op: 'node.set', nodeId: UP, field: 'damCapacityM3', value: 180_000 }]);
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
