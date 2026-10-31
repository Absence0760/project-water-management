// Yield and reliability per dam in a cumulative assessment
// (scenario/cumulativeYield.ts): which dams the applications touch, each
// dam's firm yield on each run against firmYield on the same input, and the
// rows' change and interaction arithmetic. Synthetic catchment: invented
// names and values only.
import { describe, expect, it } from 'vitest';
import { runModel } from '../run';
import { firmYield } from '../network/yield';
import type { ModelInput, NetworkNode } from '../project';
import { combineScenarios, scenarioNodeIds } from './combine';
import { applyScenario } from './overrides';
import type { ScenarioOp } from './ops';
import { CUMULATIVE_YIELD_SEARCHES_MAX, cumulativeDamRow, cumulativeDamRows, cumulativeYieldDamsMax, damFirmYields, isCumulativeDam, touchedDams } from './cumulativeYield';

function node(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: `Farm ${id}`,
		kind: 'farm',
		downstreamNodeId: 'G',
		sortOrder: 0,
		areaKm2: 5,
		pctUpstreamToDam: 0.5,
		pctRunoffToDam: 0.8,
		damCapacityM3: 0,
		damInitialPct: 0.5,
		damMinPct: 0,
		divertCapacityM3Day: 5000,
		irrigationEfficiency: 0.8,
		returnFlowFraction: 0,
		damAreaFullM2: null,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

/** Outlet gauge G; A (dam) and B (no dam) drain into it; C (dam) drains into A; D (dam) is nobody's business. */
function base(): ModelInput {
	const days = 400;
	const rain = Array.from({ length: days }, (_, t) => (t % 13 === 0 ? 35 : t % 4 === 0 ? 5 : 0));
	return {
		settings: { apanMm: [150, 180, 210, 220, 190, 160, 110, 80, 60, 60, 80, 110], ewrPragmaticM3PerDay: [500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500] },
		model: {
			nodes: [
				node('G', { name: 'Outlet gauge', kind: 'gauge', downstreamNodeId: null, areaKm2: 0, divertCapacityM3Day: 0 }),
				node('A', { name: 'Avondrust', damCapacityM3: 150_000, sortOrder: 1 }),
				node('B', { name: 'Blouberg', sortOrder: 2 }),
				node('C', { name: 'Cederhof', downstreamNodeId: 'A', damCapacityM3: 60_000, sortOrder: 3 }),
				node('D', { name: 'Doornkloof', damCapacityM3: 80_000, sortOrder: 4 })
			],
			crops: [{ id: 'c1', name: 'Lucerne', cropFactor: [0.8, 0.9, 1, 1, 1, 0.9, 0.8, 0.6, 0.5, 0.5, 0.6, 0.7] }],
			cropAreas: [
				{ nodeId: 'A', cropId: 'c1', areaM2: 300_000 },
				{ nodeId: 'C', cropId: 'c1', areaM2: 150_000 },
				{ nodeId: 'D', cropId: 'c1', areaM2: 100_000 }
			],
			transfers: [],
			landCover: []
		},
		series: { rain_catchment_mm: { startDate: '2020-10-01', values: rain } }
	};
}

const raiseA: ScenarioOp[] = [{ op: 'node.set', nodeId: 'A', field: 'damCapacityM3', value: 250_000 }];
const plantC: ScenarioOp[] = [{ op: 'cropArea.set', nodeId: 'C', cropId: 'c1', areaM2: 400_000 }];
const plantB: ScenarioOp[] = [{ op: 'cropArea.set', nodeId: 'B', cropId: 'c1', areaM2: 200_000 }];

describe('scenarioNodeIds', () => {
	it('names the nodes an op writes, plants on, or adds a unit below', () => {
		const b = base();
		expect(scenarioNodeIds(b, raiseA)).toEqual(['A']);
		expect(scenarioNodeIds(b, plantC)).toEqual(['C']);
		const add: ScenarioOp[] = [{ op: 'node.add', node: node('E', { name: 'Elandskloof', downstreamNodeId: 'D', damCapacityM3: 40_000 }) }];
		expect(scenarioNodeIds(b, add)).toEqual(['E', 'D']);
		expect(scenarioNodeIds(b, [])).toEqual([]);
	});
});

describe('touchedDams', () => {
	it('keeps the touched units with a dam, by name; an untouched dam and a touched unit without one are not among them', () => {
		const b = base();
		const scenarios = [{ ops: plantC }, { ops: raiseA }, { ops: plantB }];
		const combined = combineScenarios(b, scenarios.map((s, i) => ({ id: `s${i}`, ops: s.ops }))).input!;
		const { dams, left } = touchedDams(b, scenarios, combined);
		expect(dams).toEqual([
			{ nodeId: 'A', name: 'Avondrust' },
			{ nodeId: 'C', name: 'Cederhof' }
		]);
		expect(left).toEqual([]);
	});

	it('caps the searches: fewer dams the more applications', () => {
		expect(cumulativeYieldDamsMax(2)).toBe(40);
		expect(cumulativeYieldDamsMax(8)).toBe(16);
		for (let n = 2; n <= 8; n++) expect(cumulativeYieldDamsMax(n) * (n + 2)).toBeLessThanOrEqual(CUMULATIVE_YIELD_SEARCHES_MAX);
	});

	it('takes a dam an application adds, and caps the list, naming the rest', () => {
		const b = base();
		const max = cumulativeYieldDamsMax(2);
		const adds: ScenarioOp[] = Array.from({ length: max }, (_, i) => ({
			op: 'node.add',
			node: node(`N${i}`, { name: `New dam ${i}`, damCapacityM3: 10_000 + i })
		}));
		const scenarios = [{ ops: raiseA }, { ops: adds }];
		const combined = combineScenarios(b, scenarios.map((s, i) => ({ id: `s${i}`, ops: s.ops }))).input!;
		const { dams, left } = touchedDams(b, scenarios, combined);
		// By name: "New dam 10" sorts before "New dam 2".
		const byName = Array.from({ length: max }, (_, i) => `New dam ${i}`).sort();
		expect(dams.map((d) => d.name)).toEqual(['Avondrust', ...byName.slice(0, max - 1)]);
		expect(left.map((d) => d.name)).toEqual([byName[max - 1]]);
	});
});

describe('damFirmYields and cumulativeDamRows', () => {
	it('works out each dam’s firm yield on each run as firmYield does, with the interaction of the changes', () => {
		const b = base();
		const one = applyScenario(b, raiseA).input;
		const two = applyScenario(b, plantC).input;
		const together = combineScenarios(b, [
			{ id: 'a', ops: raiseA },
			{ id: 'c', ops: plantC }
		]).input!;
		const dams = [
			{ nodeId: 'A', name: 'Avondrust' },
			{ nodeId: 'C', name: 'Cederhof' }
		];
		const runs = [b, one, two, together].map((input) => ({ summary: runModel(input).summary, ...damFirmYields(input, dams, 'run') }));
		for (const [i, input] of [b, one, two, together].entries()) {
			expect(runs[i]!.warnings).toEqual([]);
			expect(runs[i]!.yields[0]).toBe(firmYield(input, 'A').yieldM3Year);
			expect(runs[i]!.yields[1]).toBe(firmYield(input, 'C').yieldM3Year);
		}
		// A bigger dam yields at least as much; more lucerne above A's dam leaves less for it.
		expect(runs[1]!.yields[0]!).toBeGreaterThanOrEqual(runs[0]!.yields[0]!);
		const rows = cumulativeDamRows(dams, runs[0]!, [runs[1]!, runs[2]!], runs[3]!);
		expect(rows.map((r) => [r.metric, r.site, r.siteNodeId, r.unit, r.higherIsWorse])).toEqual([
			['dam_firm_yield', 'Avondrust', 'A', 'm³/year', false],
			['dam_reliability', 'Avondrust', 'A', 'fraction', false],
			['dam_firm_yield', 'Cederhof', 'C', 'm³/year', false],
			['dam_reliability', 'Cederhof', 'C', 'fraction', false]
		]);
		for (const r of rows) {
			expect(r.baseline).not.toBeNull();
			expect(r.combinedChange).toBeCloseTo(r.combined! - r.baseline!, 6);
			expect(r.interaction).toBeCloseTo(r.combinedChange! - r.sumOfSingles!, 6);
		}
		const rel = runs[0]!.summary.supplyAssurance!.reliability.find((x) => x.nodeId === 'A')!.annualReliability;
		expect(rows[1]!.baseline).toBe(rel);
		// One row from its values alone (what an assessment fills in once its yield jobs are back) is the same row.
		for (const [i, d] of dams.entries())
			expect(cumulativeDamRow('dam_firm_yield', d, runs[0]!.yields[i]!, [runs[1]!.yields[i]!, runs[2]!.yields[i]!], runs[3]!.yields[i]!)).toEqual(rows[2 * i]);
	});

	it('isCumulativeDam: a unit with land and a dam above 0 m³ only', () => {
		const b = base();
		expect(isCumulativeDam(b, 'A')).toBe(true);
		expect(isCumulativeDam(b, 'nope')).toBe(false);
		expect(isCumulativeDam(applyScenario(b, [{ op: 'node.set', nodeId: 'A', field: 'damCapacityM3', value: 0 }]).input, 'A')).toBe(false);
	});

	it('gives null for a run without the dam, so its changes are not assessed', () => {
		const b = base();
		const add: ScenarioOp[] = [{ op: 'node.add', node: node('E', { name: 'Elandskloof', damCapacityM3: 40_000 }) }];
		const withE = applyScenario(b, add).input;
		const dams = [{ nodeId: 'E', name: 'Elandskloof' }];
		const yb = damFirmYields(b, dams, 'The baseline');
		expect(yb).toEqual({ yields: [null], warnings: [] });
		const ye = damFirmYields(withE, dams, 'All together');
		expect(ye.yields[0]).toBeGreaterThanOrEqual(0);
		const [row] = cumulativeDamRows(dams, { summary: runModel(b).summary, ...yb }, [{ summary: runModel(withE).summary, ...ye }], { summary: runModel(withE).summary, ...ye });
		expect(row).toMatchObject({ baseline: null, combined: ye.yields[0], combinedChange: null, interaction: null });
	});
});
