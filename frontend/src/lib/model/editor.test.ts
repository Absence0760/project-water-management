import { describe, expect, it } from 'vitest';
import { OPERATING_DEFAULTS } from '@water-management/engine';
import { validateModel } from './validate';
import { ModelEditor, newTransfer, nextFreeName, transferIsBlank } from './editor.svelte';

describe('nextFreeName', () => {
	it('skips numbers a node already has, case and spaces aside', () => {
		expect(nextFreeName('Unit', [{ name: 'Outflow gauge' }], 1)).toBe('Unit 1');
		expect(nextFreeName('Unit', [{ name: ' unit 2 ' }, { name: 'Unit 3' }], 2)).toBe('Unit 4');
	});
});

describe('ModelEditor', () => {
	it('names a new node after a removal without repeating a name the save would refuse', () => {
		const ed = new ModelEditor();
		ed.load({ nodes: [], crops: [], cropAreas: [], transfers: [] });
		ed.addNode(); // Outflow gauge
		const u1 = ed.addNode(); // Unit 1
		ed.addNode(); // Unit 2
		ed.removeNode(u1.id);
		const added = ed.addNode();
		expect(added.name).toBe('Unit 3');
		expect(validateModel(ed.model).some((i) => /used 2 times/.test(i.message))).toBe(false);
		ed.addUser();
		ed.model.nodes.find((n) => n.name === 'Other user 1')!.name = 'Other user 2';
		expect(ed.addUser().name).toBe('Other user 3');
	});

	it('is not dirty before anything is loaded', () => {
		// A project page that 404s never calls load(); leaving it must not
		// trigger the "unsaved changes" prompt.
		expect(new ModelEditor().dirty).toBe(false);
	});

	it('tracks dirty state against the loaded snapshot and reverts', () => {
		const ed = new ModelEditor();
		ed.load({ nodes: [], crops: [], cropAreas: [], transfers: [] });
		expect(ed.dirty).toBe(false);
		ed.addNode();
		expect(ed.dirty).toBe(true);
		expect(ed.model.nodes[0]!.downstreamNodeId).toBeNull();
		ed.revert();
		expect(ed.dirty).toBe(false);
		expect(ed.model.nodes).toHaveLength(0);
	});

	it("savedModel is the model as loaded, a fresh copy, whatever is unsaved (the preview's before)", () => {
		const ed = new ModelEditor();
		ed.load({ nodes: [], crops: [], cropAreas: [], transfers: [] });
		ed.addNode();
		const saved = ed.savedModel();
		expect(saved.nodes).toHaveLength(0);
		saved.nodes.push(ed.snapshot().nodes[0]!);
		expect(ed.savedModel().nodes).toHaveLength(0);
		expect(ed.model.nodes).toHaveLength(1);
	});

	it('knows which nodes the server has: the loaded ones, not one added since (notes go only on those)', () => {
		const ed = new ModelEditor();
		ed.load({ nodes: [], crops: [], cropAreas: [], transfers: [] });
		const outlet = ed.addNode();
		expect(ed.savedNodeIds.has(outlet.id)).toBe(false);
		ed.load(ed.snapshot());
		expect(ed.savedNodeIds.has(outlet.id)).toBe(true);
	});

	it('starts a new node with no development over the run (engine 1.30.0): every field null, the model valid', () => {
		const ed = new ModelEditor();
		ed.load({ nodes: [], crops: [], cropAreas: [], transfers: [] });
		ed.addNode();
		const farm = ed.addNode();
		const user = ed.addUser();
		for (const n of [farm, user]) expect(n).toMatchObject({ damSurveyDate: null, damSedimentPctPerYear: null, damInServiceFrom: null, abstractionFrom: null });
		expect(validateModel(ed.model)).toEqual([]);
	});

	it('starts a new node with no hands-off flow and River to dam at the one value all year (engine 1.32.0)', () => {
		const ed = new ModelEditor();
		ed.load({ nodes: [], crops: [], cropAreas: [], transfers: [] });
		ed.addNode();
		const farm = ed.addNode();
		const user = ed.addUser();
		for (const n of [farm, user]) expect(n).toMatchObject(OPERATING_DEFAULTS);
		expect(OPERATING_DEFAULTS).toEqual({ handsOffM3Day: null, handsOffEwr: false, divertMonthlyM3Day: null });
		expect(validateModel(ed.model)).toEqual([]);
	});

	it('starts a new farm with all upstream inflow entering its dam (Q1: 1 = on-river dam)', () => {
		// Since engine 0.9.0 the share means water INTO the dam; 0 would make a
		// new farm's dam an off-channel one that only the diversion fills.
		const ed = new ModelEditor();
		ed.load({ nodes: [], crops: [], cropAreas: [], transfers: [] });
		ed.addNode();
		const farm = ed.addNode();
		expect(farm.kind).toBe('farm');
		expect(farm.pctUpstreamToDam).toBe(1);
	});

	it('starts a new farm on drip irrigation (90 %, issue #90) with half its losses returning, and leaves a loaded farm as saved', () => {
		const ed = new ModelEditor();
		ed.load({ nodes: [], crops: [], cropAreas: [], transfers: [] });
		ed.addNode();
		const farm = ed.addNode();
		expect([farm.irrigationEfficiency, farm.returnFlowFraction]).toEqual([0.9, 0.1]);
		farm.irrigationEfficiency = 0.65;
		ed.load(ed.snapshot());
		expect(ed.model.nodes.find((n) => n.id === farm.id)!.irrigationEfficiency).toBe(0.65);
	});

	it('re-routes children and drops references when a node is removed', () => {
		const ed = new ModelEditor();
		const g = ed.addNode();
		const a = ed.addNode();
		const b = ed.addNode();
		b.downstreamNodeId = a.id;
		const crop = ed.addCrop();
		ed.setCropArea(a.id, crop.id, 500);
		const t = ed.addTransfer();
		t.toNodeId = a.id;
		ed.removeNode(a.id);
		expect(ed.model.nodes.find((n) => n.id === b.id)!.downstreamNodeId).toBe(g.id);
		expect(ed.model.cropAreas).toEqual([]);
		expect(ed.model.transfers).toEqual([]);
		expect(ed.issues).toEqual([]);
	});

	it('an off-take whose seepage rejoined below a removed node returns none (engine 1.42.0)', () => {
		const ed = new ModelEditor();
		const g = ed.addNode();
		const low = ed.addNode();
		const up = ed.addNode();
		const canal = ed.addNode();
		low.downstreamNodeId = g.id;
		up.downstreamNodeId = low.id;
		canal.downstreamNodeId = g.id;
		const t = ed.addTransfer();
		Object.assign(t, { fromNodeId: up.id, toNodeId: canal.id, source: 'river', lossPct: 0.2, lossReturnPct: 0.5, lossReturnNodeId: low.id });
		ed.removeNode(low.id);
		expect(ed.model.transfers.find((x) => x.id === t.id)).toMatchObject({ lossReturnPct: 0, lossReturnNodeId: null });
	});

	it('a crop supply table that drew on a removed unit’s dam keeps its share and loses the unit, which the save rules then ask for (engine 1.73.0)', () => {
		const ed = new ModelEditor();
		const g = ed.addNode();
		const a = ed.addNode();
		const b = ed.addNode();
		a.downstreamNodeId = g.id;
		b.downstreamNodeId = a.id;
		b.damCapacityM3 = 10_000;
		Object.assign(a, { cropShareDam: 0.6, cropShareRiver: 0, cropShareRemote: 0.4, cropRemoteNodeId: b.id });
		// Positive control: a valid table, no problem.
		expect(validateModel(ed.model).filter((i) => i.itemId === a.id)).toEqual([]);
		ed.removeNode(b.id);
		expect(ed.model.nodes.find((n) => n.id === a.id)).toMatchObject({ cropShareRemote: 0.4, cropRemoteNodeId: null });
		expect(validateModel(ed.model).filter((i) => i.itemId === a.id).map((i) => i.message)).toEqual([`"${a.name}": the crops' share from another unit's dam needs that unit`]);
	});

	it('keeps crop areas sparse', () => {
		const ed = new ModelEditor();
		const g = ed.addNode();
		const c = ed.addCrop();
		ed.setCropArea(g.id, c.id, 100);
		ed.setCropArea(g.id, c.id, 250);
		expect(ed.cropArea(g.id, c.id)).toBe(250);
		expect(ed.model.cropAreas).toHaveLength(1);
		ed.setCropArea(g.id, c.id, 0);
		expect(ed.model.cropAreas).toHaveLength(0);
	});

	it('loads nodes and crops in their saved display order', () => {
		const ed = new ModelEditor();
		const node = (id: string, sortOrder: number) => ({ ...ed.addNode(), id, name: id, sortOrder });
		const nodes = [node('b', 2), node('a', 0), node('c', 1)];
		ed.load({
			nodes,
			crops: [
				{ id: 'y', name: 'y', cropFactor: [], sortOrder: 1 },
				{ id: 'x', name: 'x', cropFactor: [], sortOrder: 0 }
			],
			cropAreas: [],
			transfers: []
		});
		expect(ed.model.nodes.map((n) => n.id)).toEqual(['a', 'c', 'b']);
		expect(ed.model.crops.map((c) => c.id)).toEqual(['x', 'y']);
		expect(ed.dirty).toBe(false);
	});

	it('gives a new crop the next display position', () => {
		const ed = new ModelEditor();
		ed.load({ nodes: [], crops: [{ id: 'x', name: 'x', cropFactor: [], sortOrder: 4 }], cropAreas: [], transfers: [] });
		expect(ed.addCrop().sortOrder).toBe(5);
	});

	it('adds an other water user draining into the outlet, with no demand yet (WP-1.33)', () => {
		const ed = new ModelEditor();
		ed.load({ nodes: [], crops: [], cropAreas: [], transfers: [] });
		const outlet = ed.addNode();
		const u = ed.addUser();
		expect(u).toMatchObject({ kind: 'user', downstreamNodeId: outlet.id, name: 'Other user 1', userReturnPct: 0, userPriority: 'senior' });
		expect(u.userDemandM3Day).toEqual(new Array(12).fill(0));
		// A new farm carries the inert user defaults.
		expect(ed.addNode()).toMatchObject({ kind: 'farm', userDemandM3Day: null, userReturnPct: 0, userPriority: 'senior' });
	});

	it('adds and removes land cover on a farm, and removing the farm removes its patches (WP-1.35)', () => {
		const ed = new ModelEditor();
		ed.load({ nodes: [], crops: [], cropAreas: [], transfers: [] });
		expect(ed.model.landCover).toEqual([]);
		ed.addNode();
		const farm = ed.addNode();
		const p = ed.addLandCover(farm.id);
		expect(p).toMatchObject({ nodeId: farm.id, coverClass: 'invasive', densityPct: 1, factors: null });
		ed.addLandCover(farm.id);
		ed.removeLandCover(p.id);
		expect(ed.model.landCover).toHaveLength(1);
		ed.removeNode(farm.id);
		expect(ed.model.landCover).toEqual([]);
	});

	it('adds demand objects with their category’s defaults, and removing the unit removes them (engine 1.7.0)', () => {
		const ed = new ModelEditor();
		ed.load({ nodes: [], crops: [], cropAreas: [], transfers: [] });
		expect(ed.model.demandObjects).toBeUndefined();
		ed.addNode();
		const unit = ed.addNode();
		const town = ed.addDemandObject(unit.id, 'municipal');
		expect(ed.model.demandObjects).toHaveLength(1);
		expect(ed.model.demandObjects![0]).toMatchObject({ nodeId: unit.id, name: 'Demand 1', category: 'municipal', sizing: 'monthly', monthlyM3Day: new Array(12).fill(0), returnPct: 0.5, priority: 'first', destination: 'internal', enabled: true, source: null, rank: null });
		const homes = ed.addDemandObject(unit.id, 'domestic');
		expect(homes).toMatchObject({ name: 'Demand 2', sizing: 'perUnit', count: 0, litresPerUnitDay: 230, monthlyM3Day: null });
		expect(ed.addDemandObject(unit.id, 'external')).toMatchObject({ destination: 'external', returnPct: 0 });
		// A new object's model is one the API accepts.
		expect(validateModel(ed.snapshot()).filter((i) => /demand object/i.test(i.message))).toEqual([]);
		// The supply order closes up when one goes (engine 1.64.0): homes ranked 2 after the town becomes the lone 'first'.
		homes.priority = 'first';
		homes.rank = 2;
		town.rank = 1;
		ed.removeDemandObject(town.id);
		expect(ed.model.demandObjects).toHaveLength(2);
		expect(ed.model.demandObjects!.find((o) => o.id === homes.id)!.rank).toBeNull();
		ed.removeNode(unit.id);
		expect(ed.model.demandObjects).toEqual([]);
	});

	it('adds and removes individual boreholes, the first one included, and removing the node removes them (WP-3.9)', () => {
		const ed = new ModelEditor();
		ed.load({ nodes: [], crops: [], cropAreas: [], transfers: [] });
		// An older document, or one without boreholes, has none and doesn't grow the key on load.
		expect(ed.model.boreholes).toBeUndefined();
		ed.addNode();
		const farm = ed.addNode();
		const b = ed.addBorehole(farm.id);
		// The very first borehole lands in the state (a `??=` on the state would drop it).
		expect(ed.model.boreholes).toHaveLength(1);
		expect(ed.model.boreholes![0]).toMatchObject({ nodeId: farm.id, name: 'Borehole 1', mode: 'supplemental', target: 'direct', annualCapM3: null });
		expect(ed.addBorehole(farm.id).name).toBe('Borehole 2');
		ed.removeBorehole(b.id);
		expect(ed.model.boreholes).toHaveLength(1);
		ed.removeNode(farm.id);
		expect(ed.model.boreholes).toEqual([]);
	});

	it('addTransfer picks the first two hydrological units, never the outflow gauge or an other water user', () => {
		const ed = new ModelEditor();
		ed.load({ nodes: [], crops: [], cropAreas: [], transfers: [] });
		ed.addNode(); // the outflow gauge, first in the list
		ed.addUser();
		const a = ed.addNode();
		const b = ed.addNode();
		const t = ed.addTransfer();
		expect([t.fromNodeId, t.toNodeId]).toEqual([a.id, b.id]);
		expect(validateModel(ed.model).filter((i) => i.area === 'transfers')).toEqual([]);
		// The next rule is served after it (Q18).
		expect(ed.addTransfer().priority).toBe(t.priority + 1);
	});

	it('transferIsBlank: only a rule as + Add transfer made it, whatever its ends and priority', () => {
		const t = newTransfer('a', 'b');
		expect(transferIsBlank({ ...t, priority: 4, fromNodeId: 'x' })).toBe(true);
		// An older rule without the off-take fields is blank too.
		const { source: _s, lossPct: _l, ...legacy } = t;
		expect(transferIsBlank(legacy as typeof t)).toBe(true);
		for (const changed of [
			{ months: [1], maxRateM3s: 0.01 },
			{ monthlyRateM3s: [0.01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], months: [10], maxRateM3s: 0.01 },
			{ dailyCapM3: 400 },
			{ minStoragePct: 0.2 },
			{ enabled: false },
			{ source: 'river' as const },
			{ handsOffM3Day: 250 },
			{ lossPct: 0.1 },
			{ handsOffEwr: true }
		])
			expect(transferIsBlank({ ...t, ...changed }), JSON.stringify(changed)).toBe(false);
		// Every month cleared again: blank.
		expect(transferIsBlank({ ...t, monthlyRateM3s: new Array(12).fill(0) })).toBe(true);
	});
});
