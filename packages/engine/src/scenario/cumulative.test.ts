// Cumulative impact report (roadmap WP-3.11): the baseline, each scenario
// alone and all together, read from real runs of a synthetic catchment.
// Invented names and values only.
import { describe, expect, it } from 'vitest';
import { blankEwrRuleTable } from '../reserve/rules';
import { runModel } from '../run';
import type { ModelInput, NetworkNode } from '../project';
import { combineScenarios } from './combine';
import { cumulativeImpact, type CumulativeReport, type CumulativeRun } from './cumulative';
import { applyScenario } from './overrides';
import type { ScenarioOp } from './ops';

function node(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: `Farm ${id}`,
		kind: 'farm',
		downstreamNodeId: null,
		sortOrder: 0,
		areaKm2: 5,
		areaHiKm2: 2.5,
		areaLoKm2: 2.5,
		flowShareManual: null,
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

function base(): ModelInput {
	const days = 730;
	const rain = Array.from({ length: days }, (_, t) => (t % 17 === 0 ? 40 : t % 5 === 0 ? 6 : 0));
	return {
		settings: {
			apanMm: [150, 180, 210, 220, 190, 160, 110, 80, 60, 60, 80, 110],
			ewrPragmaticM3PerDay: [3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000],
			ewrRules: [blankEwrRuleTable(null)]
		},
		model: {
			nodes: [
				node('G', { name: 'Outlet gauge', kind: 'gauge', areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0, divertCapacityM3Day: 0 }),
				node('A', { downstreamNodeId: 'G', damCapacityM3: 200_000, sortOrder: 1 }),
				node('B', { downstreamNodeId: 'G', sortOrder: 2 }),
				node('C', { downstreamNodeId: 'A', sortOrder: 3 })
			],
			crops: [{ id: 'c1', name: 'Lucerne', cropFactor: [0.8, 0.9, 1, 1, 1, 0.9, 0.8, 0.6, 0.5, 0.5, 0.6, 0.7] }],
			cropAreas: [
				{ nodeId: 'A', cropId: 'c1', areaM2: 400_000 },
				{ nodeId: 'B', cropId: 'c1', areaM2: 100_000 },
				{ nodeId: 'C', cropId: 'c1', areaM2: 200_000 }
			],
			transfers: [],
			landCover: []
		},
		series: { rain_catchment_mm: { startDate: '2020-10-01', values: rain } }
	};
}

const run = (x: ModelInput): CumulativeRun => {
	const o = runModel(x);
	return { summary: o.summary, startDate: o.startDate, endDate: o.endDate };
};

/** Two applications: more lucerne on B, more on C. */
const moreB: ScenarioOp[] = [{ op: 'cropArea.set', nodeId: 'B', cropId: 'c1', areaM2: 600_000 }];
const moreC: ScenarioOp[] = [{ op: 'cropArea.set', nodeId: 'C', cropId: 'c1', areaM2: 900_000 }];

function report(): { r: CumulativeReport; b: ModelInput } {
	const b = base();
	const combined = combineScenarios(b, [
		{ id: 'b', name: 'More on B', ops: moreB },
		{ id: 'c', name: 'More on C', ops: moreC }
	]);
	expect(combined.input).not.toBeNull();
	const r = cumulativeImpact(
		run(b),
		[
			{ id: 'b', name: 'More on B', ...run(applyScenario(b, moreB).input) },
			{ id: 'c', name: 'More on C', ...run(applyScenario(b, moreC).input) }
		],
		run(combined.input!)
	);
	return { r, b };
}

describe('cumulativeImpact', () => {
	it('each row: changes against the baseline, and the interaction is the combined change less their sum', () => {
		const { r } = report();
		expect(r.scenarios.map((s) => s.name)).toEqual(['More on B', 'More on C']);
		expect(r.warnings).toEqual([]);
		for (const row of r.rows) {
			if (row.baseline === null) continue;
			row.singles.forEach((v, i) => expect(row.singleChanges[i]).toBe(v === null ? null : v - row.baseline!));
			expect(row.combinedChange).toBe(row.combined! - row.baseline);
			expect(row.interaction).toBeCloseTo(row.combinedChange! - row.sumOfSingles!, 9);
		}
		expect(r.rows.map((x) => x.metric)).toEqual(
			// No Reserve rows: the blank rule table has no points, so no run has a Reserve assurance (next test has them).
			['ewr_days_not_met', 'ewr_shortfall', 'outlet_flow', 'existing_supplied', 'existing_reliability']
		);
	});

	it('the outlet rows come first and say so; more irrigation leaves less at the outlet, more so together', () => {
		const { r } = report();
		expect(r.rows[0]).toMatchObject({ metric: 'ewr_days_not_met', isOutlet: true, siteNodeId: null, higherIsWorse: true });
		const flow = r.rows.find((x) => x.metric === 'outlet_flow')!;
		expect(flow.singleChanges.every((v) => v! < 0)).toBe(true);
		expect(flow.combinedChange!).toBeLessThan(Math.min(...flow.singleChanges.map((v) => v!)));
		const days = r.rows.find((x) => x.metric === 'ewr_days_not_met' && x.isOutlet)!;
		expect(days.combinedChange!).toBeGreaterThanOrEqual(Math.max(...days.singleChanges.map((v) => v!)));
	});

	it('an empty scenario changes nothing, and alone with one other the interaction is zero', () => {
		const b = base();
		const r = cumulativeImpact(
			run(b),
			[
				{ id: 'e', name: 'Empty', ...run(applyScenario(b, []).input) },
				{ id: 'b', name: 'More on B', ...run(applyScenario(b, moreB).input) }
			],
			run(combineScenarios(b, [{ id: 'e', ops: [] }, { id: 'b', ops: moreB }]).input!)
		);
		for (const row of r.rows) {
			if (row.baseline === null) continue;
			expect(row.singleChanges[0]).toBe(0);
			expect(row.interaction).toBeCloseTo(0, 9);
		}
	});

	it('existing users are the baseline’s units: a farm a scenario adds is left out of every column', () => {
		const b = base();
		const add: ScenarioOp[] = [{ op: 'node.add', node: node('N', { name: 'New farm', downstreamNodeId: 'G', areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0 }) }];
		const single = run(applyScenario(b, add).input);
		const r = cumulativeImpact(run(b), [{ id: 'n', name: 'New farm', ...single }], single);
		const supplied = r.rows.find((x) => x.metric === 'existing_supplied')!;
		const ids = ['A', 'B', 'C'];
		const sum = ids.reduce((t, id) => t + single.summary.farms.find((f) => f.nodeId === id)!.avgSuppliedM3Day, 0);
		expect(supplied.singles[0]).toBeCloseTo(sum, 9);
	});

	it('reads each Reserve site’s months met and deficit, outlet first, a site missing from a run as null', () => {
		const b = run(base());
		const site = (nodeId: string | null, met: number, deficitM3: number) =>
			({ nodeId, name: nodeId ?? 'Outlet', isOutlet: nodeId === null, overall: { months: 24, met, rate: met / 24, deficitM3, longestNotMetRun: 0, meanShortfallPct: null } }) as never;
		const withSites = (sites: never[]): CumulativeRun => ({ ...b, summary: { ...b.summary, ewrAssurance: sites } });
		const r = cumulativeImpact(withSites([site('G2', 20, 10), site(null, 22, 5)]), [{ id: 'x', name: 'X', ...withSites([site(null, 20, 9)]) }], withSites([site(null, 18, 30), site('G2', 19, 12)]));
		const rows = r.rows.filter((x) => x.metric.startsWith('reserve_'));
		expect(rows.map((x) => [x.metric, x.siteNodeId, x.baseline, x.singles[0], x.combined, x.interaction])).toEqual([
			['reserve_months_met', null, 22, 20, 18, -2],
			['reserve_deficit', null, 5, 9, 30, 21],
			['reserve_months_met', 'G2', 20, null, 19, null],
			['reserve_deficit', 'G2', 10, null, 12, null]
		]);
		expect(rows[0]!.higherIsWorse).toBe(false);
	});

	it('warns when a run’s window differs from the baseline’s', () => {
		const b = run(base());
		const r = cumulativeImpact(b, [{ id: 'x', name: 'Shorter', ...b, endDate: '2021-09-30' }], b);
		expect(r.warnings).toEqual([`"Shorter" ran over ${b.startDate} to 2021-09-30, the baseline over ${b.startDate} to ${b.endDate}: its day and month counts don't line up with the baseline's.`]);
	});
});
