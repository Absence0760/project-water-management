// The applicant's view of the published baseline (applicant.ts, WP-3.3, D2's
// recommended default pending the client): their own farms and the gauges in
// full, every other node by kind and an anonymous name with its values
// blanked, and the engine's messages renamed to match.
import { applyScenario, type ModelInput, type NetworkNode } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { applicantRedactor, projectBaseForApplicant } from './applicant.js';

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

describe('applicantRedactor', () => {
	const view = projectBaseForApplicant(base, [MINE]);
	const redact = applicantRedactor(base, view);

	it('renames anonymised nodes in the engine’s messages, longest name first and ignoring case', () => {
		expect(redact('"Waterval Estate" drains into itself')).toBe('"Farm 2" drains into itself');
		expect(redact('the network has a loop through "Waterval"')).toBe('the network has a loop through "Farm 1"');
		expect(redact('duplicate node name "waterval"')).toBe('duplicate node name "Farm 1"');
		// Their own farm and the gauge keep their names.
		expect(redact('"Rooikloof" is fine, "Gauge" too')).toBe('"Rooikloof" is fine, "Gauge" too');
	});

	it('covers what applyScenario actually says about another node', () => {
		const { problems } = applyScenario(base, [{ op: 'node.set', nodeId: MINE, field: 'name', value: 'WATERVAL' }]);
		expect(problems.join(' ').toLowerCase()).toContain('waterval');
		for (const p of problems.map(redact)) expect(p.toLowerCase()).not.toContain('waterval');
	});
});
