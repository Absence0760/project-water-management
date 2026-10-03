// Order invariance to the last bit (engine ≥ 0.26.1, docs/model.md §6): every
// sum that feeds the daily balance runs in id order, not list order. Each case
// uses values whose float sum depends on the order they are added in
// ((0.1 + 0.2) + 0.3 = 0.6000000000000001, (0.3 + 0.2) + 0.1 = 0.6), so a
// list-order sum would give different bits for the two orders. The fuzz soak
// found these through dams that sat exactly at their drought trigger (seed
// 3899) or ran dry in one order and not the other (7094, 15208, …).
import { describe, expect, it } from 'vitest';
import { cmpStr } from './order';
import type { CropArea, LandCoverPatch, ModelInput, NetworkNode } from './project';
import { runModel, runModelWith } from './run';
import { resolveCatchmentAreaKm2 } from './runoff/area';
import { attributeEwrShortfall } from './network/attribution';
import { resolveLandCover } from './network/landcover';
import { flowShares } from './network/shares';
import { buildTopology, canonicalOrder } from './network/topology';

function node(id: string, kind: NetworkNode['kind'], down: string | null, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind,
		downstreamNodeId: down,
		sortOrder: 0,
		areaKm2: 0,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: 1,
		pctRunoffToDam: 1,
		damCapacityM3: 0,
		damInitialPct: 0,
		damMinPct: 0,
		divertCapacityM3Day: 0,
		irrigationEfficiency: 1,
		returnFlowFraction: 0,
		damAreaFullM2: null,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

/** Three farms of 0.1, 0.2 and 0.3 km² above gauge G: Σ area depends on the order it is added in. */
const farms = () => [node('G', 'gauge', null), node('a', 'farm', 'G', { areaKm2: 0.1, areaHiKm2: 0.1, areaLoKm2: 0.3 }), node('b', 'farm', 'G', { areaKm2: 0.2, areaHiKm2: 0.2, areaLoKm2: 0.2 }), node('c', 'farm', 'G', { areaKm2: 0.3, areaHiKm2: 0.3, areaLoKm2: 0.1 })];
const reversed = <T>(xs: T[]) => [...xs].reverse();
const byId = (nodes: readonly NetworkNode[], v: ArrayLike<number>) => Object.fromEntries(nodes.map((n, i) => [n.id, v[i]!]));

describe('cmpStr', () => {
	it('orders by code unit, the same in every locale', () => {
		expect(['n10', 'n2', 'N1', 'n1'].sort(cmpStr)).toEqual(['N1', 'n1', 'n10', 'n2']);
		expect(cmpStr('a', 'a')).toBe(0);
	});
});

describe('sums over lists run in id order', () => {
	it('the values used here do add up differently in another order', () => {
		expect(0.1 + 0.2 + 0.3).not.toBe(0.3 + 0.2 + 0.1);
	});

	it('flow shares (area and hi/lo) are bit-identical whatever the node order', () => {
		for (const method of ['area', 'hiLo'] as const) {
			const a = farms();
			const b = reversed(a);
			const sa = flowShares(a, method, { hi: 0.6, lo: 0.4 });
			const sb = flowShares(b, method, { hi: 0.6, lo: 0.4 });
			expect(byId(b, sb.share), method).toEqual(byId(a, sa.share));
			expect(sb.sum, method).toBe(sa.sum);
		}
	});

	it('the catchment area (Σ farm area) is bit-identical whatever the node order', () => {
		const input = (nodes: NetworkNode[]) => ({ model: { nodes } }) as unknown as ModelInput;
		const cal = { catchmentAreaKm2: null };
		expect(resolveCatchmentAreaKm2(cal, input(reversed(farms())))).toBe(resolveCatchmentAreaKm2(cal, input(farms())));
	});

	it('a farm’s land-cover weights are bit-identical whatever the patch order', () => {
		const nodes = [node('G', 'gauge', null), node('A', 'farm', 'G', { areaKm2: 1 })];
		const patch = (id: string, areaKm2: number, mar: number): LandCoverPatch => ({ id, nodeId: 'A', coverClass: 'pine', areaKm2, densityPct: 1, factors: { mar, lowFlow: mar } });
		const patches = [patch('p1', 0.1, 0.1), patch('p2', 0.2, 1), patch('p3', 0.3, 0.7)];
		const a = resolveLandCover({ nodes, landCover: patches }, [])[1]!;
		const b = resolveLandCover({ nodes, landCover: reversed(patches) }, [])[1]!;
		expect(b).toEqual(a);
		expect([b.mar, b.lowFlow]).toEqual([a.mar, a.lowFlow]);
	});

	/** A four-day January run with a farm growing three crops (0.1, 0.2, 0.3 of its area) and two senior users below it. */
	function human(nodes: NetworkNode[], cropAreas: CropArea[], crops = [0.1, 0.2, 0.3]): ModelInput {
		const apan = new Array(12).fill(0);
		apan[3] = 100;
		return {
			settings: { apanMm: apan as never, effectiveRainFraction: 0, ewrPragmaticM3PerDay: new Array(12).fill(0) as never },
			model: {
				nodes,
				crops: crops.map((f, k) => ({ id: `c${k}`, name: `c${k}`, cropFactor: new Array(12).fill(f) })),
				cropAreas,
				transfers: []
			},
			series: { rain_catchment_mm: { startDate: '2021-01-01', values: [0, 0, 0, 0] } }
		};
	}
	const humanNodes = () => [
		node('G', 'gauge', null),
		node('u1', 'user', 'G', { userDemandM3Day: new Array(12).fill(0.1) }),
		node('u2', 'user', 'u1', { userDemandM3Day: new Array(12).fill(0.2) }),
		node('u3', 'user', 'u2', { userDemandM3Day: new Array(12).fill(0.3) }),
		...farms()
			.slice(1)
			.map((n) => ({ ...n, downstreamNodeId: 'u3' }))
	];
	const areas: CropArea[] = [
		{ nodeId: 'a', cropId: 'c0', areaM2: 0.1 },
		{ nodeId: 'a', cropId: 'c1', areaM2: 0.2 },
		{ nodeId: 'a', cropId: 'c2', areaM2: 0.3 },
		{ nodeId: 'a', cropId: 'c2', areaM2: 0.3 }
	];
	const series = (o: ReturnType<typeof runModel>) => Object.fromEntries(o.series.map((s) => [`${s.nodeId}|${s.key}`, s.values]));
	const natural = () => ({ naturalFlowM3Day: [0.1, 0.2, 0.3, 0.6] });

	it('demand (crops and crop areas) and senior users’ claims are bit-identical whatever the list order', () => {
		const a = human(humanNodes(), areas);
		const b = human(reversed(humanNodes()), reversed(areas));
		b.model.crops.reverse();
		const oa = runModelWith(a, natural);
		const ob = runModelWith(b, natural);
		// The farm's demand and every senior claim on it, to the last bit.
		expect(series(ob)['a|demand']).toEqual(series(oa)['a|demand']);
		expect(series(ob)['a|senior_requirement']).toEqual(series(oa)['a|senior_requirement']);
		expect(series(ob)).toEqual(series(oa));
	});

	it('transfer rules of one priority into one farm add up in id order', () => {
		const nodes = [
			node('G', 'gauge', null),
			node('d', 'farm', 'G', { areaKm2: 1, damCapacityM3: 10 }),
			...['s1', 's2', 's3'].map((id) => node(id, 'farm', 'G', { areaKm2: 1, damCapacityM3: 10, damInitialPct: 1 }))
		];
		const rule = (id: string, from: string, cap: number) => ({ id, fromNodeId: from, toNodeId: 'd', months: [1], maxRateM3s: 1, dailyCapM3: cap, minStoragePct: 0, enabled: true, priority: 0 });
		const a = human(nodes, []);
		a.model.transfers = [rule('t1', 's1', 0.1), rule('t2', 's2', 0.2), rule('t3', 's3', 0.3)];
		const b = { ...a, model: { ...a.model, nodes: reversed(nodes), transfers: reversed(a.model.transfers) } };
		expect(series(runModelWith(b, natural))).toEqual(series(runModelWith(a, natural)));
	});
});

describe('canonicalOrder', () => {
	// G ← x ← {p, q}, G ← y ← r: two branches of different depth.
	const nodes = () => [node('G', 'gauge', null), node('y', 'gauge', 'G', { sortOrder: 5 }), node('x', 'gauge', 'G', { sortOrder: -5 }), node('r', 'farm', 'y'), node('q', 'farm', 'x', { sortOrder: 9 }), node('p', 'farm', 'x')];
	const ids = (ns: NetworkNode[]) => Array.from(canonicalOrder(ns, buildTopology(ns)), (i) => ns[i]!.id);

	it('is furthest from the outflow first, then by id, whatever the array order and sortOrder', () => {
		expect(ids(nodes())).toEqual(['p', 'q', 'r', 'x', 'y', 'G']);
		const shuffled = [nodes()[4]!, nodes()[0]!, nodes()[3]!, nodes()[1]!, nodes()[5]!, nodes()[2]!].map((n, k) => ({ ...n, sortOrder: -k }));
		expect(ids(shuffled)).toEqual(['p', 'q', 'r', 'x', 'y', 'G']);
	});

	it('puts every node after all of its upstream nodes', () => {
		const ns = nodes();
		const order = Array.from(canonicalOrder(ns, buildTopology(ns)));
		ns.forEach((n, i) => {
			if (n.downstreamNodeId === null) return;
			const d = ns.findIndex((m) => m.id === n.downstreamNodeId);
			expect(order.indexOf(i), n.id).toBeLessThan(order.indexOf(d));
		});
	});

	it('gives the EWR attribution an order to sum impacts in: its farms follow it', () => {
		const run = (order: number[]) =>
			attributeEwrShortfall({
				days: 1,
				kind: ['gauge', 'farm', 'farm', 'farm'],
				upstream: [Int32Array.from([1, 2, 3]), new Int32Array(0), new Int32Array(0), new Int32Array(0)],
				order: Int32Array.from(order),
				inflow: [[0.6], [0], [0], [0]],
				runoff: [[0], [0.1], [0.2], [0.3]],
				outflow: [[0], [0], [0], [0]],
				supplied: [[0], [0.1], [0.2], [0.3]],
				consumptivePerSupplied: [1, 1, 1, 1],
				transfers: [],
				sites: [{ node: 0, shortfall: [-0.5] }]
			});
		expect(Array.from(run([1, 2, 3, 0]).sites[0]!.farms)).toEqual([1, 2, 3]);
		expect(Array.from(run([3, 2, 1, 0]).sites[0]!.farms)).toEqual([3, 2, 1]);
	});

	it('so the EWR charges are bit-identical whatever the node order', () => {
		// Three farms taking 0.1, 0.2 and 0.3 m³/day above a gauge whose EWR they leave short.
		const ns = [node('G', 'gauge', null), node('c', 'farm', 'G', { areaKm2: 0.3 }), node('a', 'farm', 'G', { areaKm2: 0.1 }), node('b', 'farm', 'G', { areaKm2: 0.2 })];
		const apan = new Array(12).fill(0);
		apan[3] = 31;
		const input = (nodes: NetworkNode[]): ModelInput => ({
			settings: { apanMm: apan as never, effectiveRainFraction: 0, ewrPragmaticM3PerDay: new Array(12).fill(10) as never },
			model: {
				nodes,
				crops: [{ id: 'c', name: 'c', cropFactor: new Array(12).fill(1) }],
				cropAreas: [
					{ nodeId: 'a', cropId: 'c', areaM2: 100 },
					{ nodeId: 'b', cropId: 'c', areaM2: 200 },
					{ nodeId: 'c', cropId: 'c', areaM2: 300 }
				],
				transfers: []
			},
			series: { rain_catchment_mm: { startDate: '2021-01-01', values: [0, 0, 0, 0] } }
		});
		const col = (o: ReturnType<typeof runModel>) => Object.fromEntries(o.series.filter((s) => s.key.startsWith('ewr_charge')).map((s) => [`${s.nodeId}|${s.key}`, s.values]));
		const nat = () => ({ naturalFlowM3Day: [0.6, 0.6, 0.6, 0.6] });
		const a = col(runModelWith(input(ns), nat));
		expect(a['a|ewr_charge']![0]).toBeLessThan(0);
		expect(col(runModelWith(input(reversed(ns)), nat))).toEqual(a);
	});
});
