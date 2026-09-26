// Other water users (WP-1.33, docs/model.md §2.7c): hand-worked cases on a
// fixed natural flow, so every number below can be redone on paper.
import { describe, expect, it } from 'vitest';
import type { ModelInput, NetworkNode } from '../project';
import { runModelWith, withVerification } from '../run';
import { checkInvariants } from '../verify/checks';

const DAYS = 4;
/** Natural flow per day (m³/day): a dry day, a wet day, a middling day, nothing. */
const NATURAL = [1000, 10_000, 3000, 0];

function node(id: string, kind: NetworkNode['kind'], down: string | null, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind,
		downstreamNodeId: down,
		sortOrder: 0,
		areaKm2: kind === 'farm' ? 1 : 0,
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
		lossReturnFraction: 0,
		damAreaFullM2: null,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

/** Flat 12-month demand. */
const flat = (v: number) => new Array(12).fill(v) as number[];

/**
 * A network on a four-day January run with no rain. Farm A (when
 * `farmNeedM3Day` is set) has 31 000 m² of a crop with factor 1, and the
 * January A-pan is set to the need, so its demand is need × 31 000 ÷ 1000 ÷ 31
 * = need m³/day (efficiency 1, no effective rain).
 */
function input(nodes: NetworkNode[], farmNeedM3Day: number | null): ModelInput {
	// January run: A-pan (water-year month 3 = Jan) × crop factor 1 × 1000 m² ÷ 1000 ÷ 31 days = need.
	const apanMm = new Array(12).fill(0);
	apanMm[3] = farmNeedM3Day ?? 0;
	return {
		settings: { apanMm: apanMm as never, effectiveRainFraction: 0, ewrPragmaticM3PerDay: flat(0) as never },
		model: {
			nodes,
			crops: [{ id: 'c', name: 'Crop', cropFactor: flat(1) }],
			cropAreas: farmNeedM3Day === null ? [] : [{ nodeId: 'A', cropId: 'c', areaM2: 31_000 }],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: '2021-01-01', values: new Array(DAYS).fill(0) } }
	};
}

const run = (i: ModelInput) => withVerification(i, runModelWith(i, () => ({ naturalFlowM3Day: NATURAL })));
const col = (o: ReturnType<typeof run>, id: string | null, key: string) => o.series.find((s) => s.nodeId === id && s.key === key)!.values;

describe('other water users (WP-1.33)', () => {
	it('a user above a farm reduces that farm’s river supply by exactly the user’s take', () => {
		// H → U → A → G: U (wants 500) takes from H's runoff before A (dam-less, needs 2000) sees it.
		const nodes = [node('G', 'gauge', null), node('A', 'farm', 'G'), node('U', 'user', 'A', { userDemandM3Day: flat(500) }), node('H', 'farm', 'U', { sortOrder: 1 })];
		const base = [node('G', 'gauge', null), node('A', 'farm', 'G'), node('H', 'farm', 'A', { sortOrder: 1 })];
		const withUser = run(input(nodes, 2000));
		const without = run(input(base, 2000));
		expect(withUser.summary.verification!.passed, JSON.stringify(withUser.summary.verification)).toBe(true);
		// H and A split natural flow 50/50. A sees H's outflow (its runoff, H has no demand) plus its own half.
		const sA = col(withUser, 'A', 'supplied');
		const s0 = col(without, 'A', 'supplied');
		const took = col(withUser, 'U', 'supplied');
		// Day 0: 500 + 500 available to A without U; U takes 500 of H's 500, so A gets 500 instead of 1000.
		// Day 2: 1500 + 1500 without U; with it 1000 + 1500, still above A's 2000.
		expect(took).toEqual([500, 500, 500, 0]);
		expect(s0).toEqual([1000, 2000, 2000, 0]);
		expect(sA).toEqual([500, 2000, 2000, 0]);
		// On the day the farm was short, its supply fell by exactly what the user took.
		expect(s0[0]! - sA[0]!).toBe(took[0]);
	});

	it('priority both ways: a senior user below a farm gets its demand first; a junior one gets what the farm leaves', () => {
		// A (dam-less, needs 2000 m³/day, all the natural flow) drains into U (wants 800), then G.
		const nodes = (priority: 'senior' | 'junior') => [node('G', 'gauge', null), node('U', 'user', 'G', { userDemandM3Day: flat(800), userPriority: priority }), node('A', 'farm', 'U')];
		const senior = run(input(nodes('senior'), 2000));
		const junior = run(input(nodes('junior'), 2000));
		for (const o of [senior, junior]) expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification)).toBe(true);
		// Senior: A must pass MIN(800, I) before taking any: day 0 I = 1000 → A takes 200, U 800.
		expect(col(senior, 'A', 'supplied')).toEqual([200, 2000, 2000, 0]);
		expect(col(senior, 'U', 'supplied')).toEqual([800, 800, 800, 0]);
		expect(col(senior, 'A', 'passed_for_senior')).toEqual([800, 800, 800, 0]);
		expect(col(senior, 'U', 'senior_requirement')).toEqual([0, 0, 0, 0]);
		// Junior: A takes first, U gets the rest.
		expect(col(junior, 'A', 'supplied')).toEqual([1000, 2000, 2000, 0]);
		expect(col(junior, 'U', 'supplied')).toEqual([0, 800, 800, 0]);
		expect(junior.series.some((s) => s.key === 'senior_requirement')).toBe(false);
		expect(col(junior, 'U', 'deficit')).toEqual([800, 0, 0, 800]);
	});

	it('the return share reappears downstream the same day, and the outlet falls by the net take when there is enough flow', () => {
		const nodes = [node('G', 'gauge', null), node('U', 'user', 'G', { userDemandM3Day: flat(2000), userReturnPct: 0.25 }), node('A', 'farm', 'U')];
		const o = run(input(nodes, null));
		expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification)).toBe(true);
		expect(col(o, 'U', 'supplied')).toEqual([1000, 2000, 2000, 0]);
		expect(col(o, 'U', 'return_flow')).toEqual([250, 500, 500, 0]);
		// Outlet = natural − take + return: 1000 − 1000 + 250; 10 000 − 2000 + 500; 3000 − 2000 + 500.
		expect(col(o, null, 'simulated_outflow')).toEqual([250, 8500, 1500, 0]);
		expect(o.summary.users![0]).toMatchObject({ nodeId: 'U', priority: 'senior', avgDemandM3Day: 2000, avgSuppliedM3Day: 1250, avgReturnedM3Day: 312.5 });
		const wb = o.summary.waterBalance!.total;
		// Taken 5000, returned 1250.
		expect(wb.otherUseM3).toBeCloseTo(5000 - 1250, 9);
		expect(Math.abs(wb.residualM3)).toBeLessThan(1e-9);
	});

	it('a senior user’s demand is fragmented to the farms above it by flow share, and each passes its part', () => {
		// Two farms of 1 and 3 km² above U (wants 400): A passes 100, B 300 (area shares 1/4, 3/4).
		const nodes = [
			node('G', 'gauge', null),
			node('U', 'user', 'G', { userDemandM3Day: flat(400) }),
			node('A', 'farm', 'U', { areaKm2: 1 }),
			node('B', 'farm', 'U', { areaKm2: 3, sortOrder: 1 })
		];
		const i = input(nodes, 1e6);
		i.model.cropAreas.push({ nodeId: 'B', cropId: 'c', areaM2: 31_000 });
		const o = run(i);
		expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification)).toBe(true);
		expect(col(o, 'A', 'senior_requirement')).toEqual([100, 100, 100, 100]);
		expect(col(o, 'B', 'senior_requirement')).toEqual([300, 300, 300, 300]);
		// Day 0: A's runoff 250 → takes 150, passes 100; B's 750 → takes 450, passes 300. U gets 400.
		expect(col(o, 'A', 'supplied')[0]).toBe(150);
		expect(col(o, 'B', 'supplied')[0]).toBe(450);
		expect(col(o, 'U', 'supplied')).toEqual([400, 400, 400, 0]);
	});

	it('users are charged for the EWR by net impact; a senior user is not curtailed, a junior one is', () => {
		const nodes = (p: 'senior' | 'junior') => [node('G', 'gauge', null), node('U', 'user', 'G', { userDemandM3Day: flat(600), userReturnPct: 0.5, userPriority: p }), node('A', 'farm', 'U')];
		for (const p of ['senior', 'junior'] as const) {
			const i = input(nodes(p), null);
			i.settings.ewrPragmaticM3PerDay = flat(1000) as never;
			const o = run(i);
			expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification)).toBe(true);
			// Day 0: 1000 arrives, U takes 600 and returns 300: outlet 700, 300 short, all U's net impact.
			expect(col(o, 'U', 'ewr_charge')[0]).toBe(-300);
			const row = o.summary.curtailment!.otherUsers![0]!;
			// Days 0 and 3 are short (day 3: nothing flows, natural). Mean charge = −300 / 4.
			expect(row.ewrChargeM3Day).toBe(-75);
			if (p === 'senior') {
				expect(row).toMatchObject({ curtailed: false, supplyCutM3Day: 0, uncurtailedChargeM3Day: -75 });
			} else {
				// Taking 150 less removes 150 × (1 − 0.5) = 75 of use.
				expect(row).toMatchObject({ curtailed: true, supplyCutM3Day: -150, uncurtailedChargeM3Day: 0 });
			}
			// Other users are outside the irrigation benchmark.
			expect(o.summary.curtailment!.farms.map((f) => f.nodeId)).toEqual(['A']);
		}
	});

	it('a network without users runs exactly as before: no new series or summary fields', () => {
		const o = run(input([node('G', 'gauge', null), node('A', 'farm', 'G')], 500));
		expect(o.summary.users).toBeUndefined();
		expect(o.summary.curtailment!.otherUsers).toBeUndefined();
		expect(o.summary.waterBalance!.total.otherUseM3).toBeUndefined();
		expect(o.series.some((s) => ['senior_requirement', 'passed_for_senior'].includes(s.key))).toBe(false);
	});

	it('warns when a senior user has no farm with a flow share above it', () => {
		const o = run(input([node('U', 'user', null, { userDemandM3Day: flat(100) }), node('A', 'farm', 'U', { areaKm2: 0 })], null));
		expect(o.summary.warnings.some((w) => w.includes('senior user "U" has no farm with a flow share upstream'))).toBe(true);
	});

	it('the self-checks catch a user that breaks its balance or takes a senior user’s water', () => {
		const nodes = [node('G', 'gauge', null), node('J', 'user', 'S', { userDemandM3Day: flat(5000), userPriority: 'junior' }), node('S', 'user', 'G', { userDemandM3Day: flat(800) }), node('A', 'farm', 'J')];
		const i = input(nodes, null);
		const o = run(i);
		expect(checkInvariants(i, o)).toBeNull();
		// J (junior) leaves S's 800 on day 0: takes 200 of the 1000.
		expect(col(o, 'J', 'supplied')[0]).toBe(200);
		const broken = structuredClone(o);
		col(broken, 'J', 'outflow')[1]! += 1;
		expect(checkInvariants(i, broken)).toMatch(/user|routed/);
		const greedy = structuredClone(o);
		col(greedy, 'J', 'supplied')[0] = 1000;
		expect(checkInvariants(i, greedy)).toMatch(/J day 0: user took 1000/);
		const report = structuredClone(o);
		report.summary.curtailment!.otherUsers![0]!.supplyCutM3Day = -1;
		expect(checkInvariants(i, report)).toMatch(/curtailment user/);
	});
});
