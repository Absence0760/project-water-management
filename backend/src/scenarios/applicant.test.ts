// The applicant's view of the published baseline (applicant.ts, WP-3.3, D2's
// recommended default pending the client): their own farms and the gauges in
// full, every other node by kind and an anonymous name with its values
// blanked, and the names an application's ops meet (applicationMask).
import { applyScenario, type ModelInput, type NetworkNode } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { applicationMask, projectBaseForApplicant } from './applicant.js';

const monthly = (v: number) => new Array(12).fill(v);
const node = (id: string, name: string, kind: NetworkNode['kind'], downstreamNodeId: string | null, sortOrder: number, extra: Partial<NetworkNode> = {}) =>
	({
		id,
		name,
		kind,
		downstreamNodeId,
		sortOrder,
		areaKm2: 12,
		areaHiKm2: 1,
		areaLoKm2: 1,
		flowShareManual: null,
		pctUpstreamToDam: 0,
		pctRunoffToDam: 0.5,
		damCapacityM3: 80_000,
		damInitialPct: 0.5,
		damMinPct: 0.1,
		divertCapacityM3Day: 0,
		irrigationEfficiency: 0.8,
		lossReturnFraction: 0.5,
		damAreaFullM2: null,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		userDemandM3Day: null,
		userPriority: 'senior',
		...extra
	}) as NetworkNode;

const G = '00000000-0000-4000-8000-000000000001';
const MINE = '00000000-0000-4000-8000-000000000002';
const N1 = '00000000-0000-4000-8000-000000000003';
const N2 = '00000000-0000-4000-8000-000000000004';
const U1 = '00000000-0000-4000-8000-000000000005';
const C1 = '00000000-0000-4000-8000-0000000000c1';
const C2 = '00000000-0000-4000-8000-0000000000c2';

const base: ModelInput = {
	settings: { apanMm: monthly(150) } as unknown as ModelInput['settings'],
	model: {
		nodes: [
			node(G, 'Gauge', 'gauge', null, 0),
			node(N2, 'Waterval Estate', 'farm', G, 3, { damCapacityM3: 250_000 }),
			node(MINE, 'Rooikloof', 'farm', G, 1),
			node(N1, 'Waterval', 'farm', G, 2),
			node(U1, 'Town', 'user', G, 4, { userDemandM3Day: monthly(500), userPriority: 'junior' })
		],
		crops: [
			{ id: C1, name: 'Citrus', cropFactor: monthly(0.7) },
			{ id: C2, name: 'Lucerne', cropFactor: monthly(0.9) }
		],
		cropAreas: [
			{ nodeId: MINE, cropId: C1, areaM2: 50_000 },
			{ nodeId: N1, cropId: C2, areaM2: 30_000 }
		],
		transfers: [
			{ id: 't1', fromNodeId: MINE, toNodeId: N1, months: [1], maxRateM3s: 0.01, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0 },
			{ id: 't2', fromNodeId: N1, toNodeId: N2, months: [1], maxRateM3s: 0.01, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0 }
		],
		landCover: [
			{ id: 'p1', nodeId: MINE, coverClass: 'pine', areaKm2: 1, densityPct: 0.5, factors: null },
			{ id: 'p2', nodeId: N2, coverClass: 'pine', areaKm2: 2, densityPct: 0.5, factors: null }
		]
	} as unknown as ModelInput['model'],
	series: {}
};

describe('projectBaseForApplicant', () => {
	const view = projectBaseForApplicant(base, [MINE]);
	const byId = new Map(view.model.nodes.map((n) => [n.id, n]));

	it('keeps their own farm and the gauge as they are', () => {
		expect(byId.get(MINE)).toEqual(base.model.nodes.find((n) => n.id === MINE));
		expect(byId.get(G)).toEqual(base.model.nodes.find((n) => n.id === G));
	});

	it('names every other node by kind and order, and blanks its values', () => {
		expect(byId.get(N1)!.name).toBe('Farm 1');
		expect(byId.get(N2)!.name).toBe('Farm 2');
		expect(byId.get(U1)!.name).toBe('Water user 1');
		for (const id of [N1, N2, U1]) {
			const n = byId.get(id)!;
			expect(n.areaKm2).toBe(0);
			expect(n.damCapacityM3).toBe(0);
			expect(n.userDemandM3Day).toBeNull();
			// Where it sits stays: a new dam can be placed below it.
			expect(n.downstreamNodeId).toBe(G);
		}
		expect(byId.get(U1)!.userPriority).toBe('junior');
		expect(view.anonymisedNodeIds.sort()).toEqual([N1, N2, U1].sort());
		// The base's order is kept.
		expect(view.model.nodes.map((n) => n.id)).toEqual(base.model.nodes.map((n) => n.id));
	});

	it('keeps only what is on their own farm: crops, crop areas, transfers, land cover', () => {
		expect(view.model.crops.map((c) => c.id)).toEqual([C1]);
		expect(view.model.cropAreas).toEqual([{ nodeId: MINE, cropId: C1, areaM2: 50_000 }]);
		expect(view.model.transfers.map((t) => t.id)).toEqual(['t1']);
		expect((view.model.landCover ?? []).map((p) => p.id)).toEqual(['p1']);
	});

	it('names no other node anywhere in the view', () => {
		const text = JSON.stringify(view);
		for (const name of ['Waterval', 'Town', 'Lucerne']) expect(text).not.toContain(name);
		expect(text).toContain('Rooikloof');
	});

	it('with no own nodes, shows only the gauges', () => {
		const none = projectBaseForApplicant(base, []);
		expect(none.model.nodes.filter((n) => !none.anonymisedNodeIds.includes(n.id)).map((n) => n.id)).toEqual([G]);
		expect(none.model.crops).toEqual([]);
	});
});

describe('applicationMask', () => {
	const mask = applicationMask(base, [MINE]);
	const rename = (value: string) => ({ op: 'node.set' as const, nodeId: MINE, field: 'name' as const, value });
	const apply = (ops: Parameters<typeof applyScenario>[1]) => applyScenario(base, ops, { maskedNames: mask });

	it('masks every node and crop the projection hides, under the names the applicant sees', () => {
		const view = projectBaseForApplicant(base, [MINE]);
		expect(mask.nodes).toEqual(Object.fromEntries(view.anonymisedNodeIds.map((id) => [id, view.model.nodes.find((n) => n.id === id)!.name])));
		expect(Object.keys(mask.nodes!).sort()).toEqual([N1, N2, U1].sort());
		expect(mask.crops).toEqual({ [C2]: `crop ${C2}` });
	});

	it('answers a rename to a hidden name exactly as a rename to a free one (the oracle closed)', () => {
		// Positive control: unmasked (an editor's own scenario), the collision is a problem.
		expect(applyScenario(base, [rename('WATERVAL')]).problems).toEqual(['op 1 (node.set): duplicate node name "waterval"']);
		const hidden = apply([rename('WATERVAL')]);
		const free = apply([rename('Somewhere else')]);
		expect(hidden.problems).toEqual([]);
		expect(free.problems).toEqual([]);
		expect(hidden.applied.map((a) => a.notes)).toEqual(free.applied.map((a) => a.notes));
		// The input keeps both, the neighbour's suffixed for the assessor.
		expect(hidden.input.model.nodes.find((n) => n.id === MINE)!.name).toBe('WATERVAL');
		expect(hidden.input.model.nodes.find((n) => n.id === N1)!.name).toBe('Waterval (2)');
		expect(hidden.renamed).toEqual([{ kind: 'node', id: N1, name: 'Waterval', as: 'Waterval (2)' }]);
		expect(free.renamed).toEqual([]);
		// Every other hidden node is itself again.
		expect(free.input.model.nodes.map((n) => n.name)).toEqual(['Gauge', 'Waterval Estate', 'Somewhere else', 'Waterval', 'Town']);
	});

	it('collides with the anonymous names the applicant does see, as they would expect', () => {
		expect(apply([rename('farm 1')]).problems).toEqual(['op 1 (node.set): duplicate node name "farm 1"']);
		expect(apply([rename('Gauge')]).problems).toEqual(['op 1 (node.set): duplicate node name "gauge"']);
	});

	it('answers a new crop named like a hidden one as it does a free name', () => {
		const crop = (name: string) => ({ op: 'crop.add' as const, crop: { id: crypto.randomUUID(), name, cropFactor: monthly(0.5) } });
		expect(applyScenario(base, [crop('lucerne')]).problems).toHaveLength(1);
		const hidden = apply([crop('lucerne')]);
		expect(hidden.problems).toEqual([]);
		expect(hidden.renamed).toEqual([{ kind: 'crop', id: C2, name: 'Lucerne', as: 'Lucerne (2)' }]);
		expect(apply([crop('Pecans')]).renamed).toEqual([]);
		// A crop they see still collides.
		expect(apply([crop('citrus')]).problems).toHaveLength(1);
	});

	it('quotes no hidden name in anything it says about another node', () => {
		const r = apply([
			{ op: 'cropArea.set', nodeId: U1, cropId: C1, areaM2: 10 },
			{ op: 'landCover.add', patch: { id: 'p9', nodeId: U1, coverClass: 'pine', areaKm2: 1, densityPct: 0.5, factors: null } },
			rename('Town')
		]);
		expect(r.problems).toEqual([
			'op 1 (cropArea.set): crops grow on farms; "Water user 1" is a user',
			'op 2 (landCover.add): land cover lies on a farm; "Water user 1" is a user'
		]);
		// Their own farm renamed to the hidden user's name: applied, and quoted as theirs.
		expect(r.applied.map((a) => a.index)).toEqual([2]);
		expect(r.renamed).toEqual([{ kind: 'node', id: U1, name: 'Town', as: 'Town (2)' }]);
	});

	it('leaves a hidden node an op renamed under the op’s name', () => {
		const r = apply([{ op: 'node.set', nodeId: N1, field: 'name', value: 'Renamed by applicant' }]);
		expect(r.input.model.nodes.find((n) => n.id === N1)!.name).toBe('Renamed by applicant');
	});
});
