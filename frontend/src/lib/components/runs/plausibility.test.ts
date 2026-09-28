import type { LowFlowCurves, PlausibilityChecks } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import type { RunMeta } from '$lib/api/types';
import { breakHint, curveLabel, findings, gaugeRow, lowFlowChart, otherModelRuns, seasonText, signedPct } from './plausibility';

const meta = (id: string, runoffModel?: string): RunMeta =>
	({ id, label: id, engineVersion: '0.25.0', startDate: '2000-10-01', endDate: '2020-09-30', createdAt: '2026-09-25T00:00:00Z', createdBy: null, legacy: runoffModel !== 'gr4j', runoffModel }) as RunMeta;

const curves = (runoffModel: 'gr4j' | 'legacy', months = [11, 12, 1, 2, 3, 4], k = 1): LowFlowCurves => ({
	season: { months, source: 'flow_observed_m3s' },
	// A stored legacy run's curves say 'legacy' (engine < 1.0.0); the engine's type names only today's model.
	runoffModel: runoffModel as LowFlowCurves['runoffModel'],
	points: [50, 90],
	curves: [
		{ source: 'flow_observed_m3s', pairedWith: null, days: 300, flowsM3s: [2, 1] },
		{ source: 'simulated_outflow', pairedWith: null, days: 900, flowsM3s: [3 * k, 1.5 * k] },
		{ source: 'natural_flow', pairedWith: null, days: 900, flowsM3s: [4, 2] },
		{ source: 'simulated_outflow', pairedWith: 'flow_observed_m3s', days: 300, flowsM3s: [2.5, 1.2] }
	],
	comparison: null
});

describe('curveLabel and seasonText', () => {
	it('names each curve and the season it was drawn from', () => {
		expect(curveLabel({ source: 'flow_logger_m3s', pairedWith: null })).toBe('Logger');
		expect(curveLabel({ source: 'simulated_outflow', pairedWith: 'flow_observed_m3s' })).toBe("Simulated outflow on the gauge's days");
		expect(seasonText({ months: [11, 12, 1, 2, 3, 4], source: 'flow_observed_m3s' })).toBe('Nov–Apr, the six months with the lowest mean flow in the gauge record');
		expect(seasonText({ months: [5, 6, 7, 8, 9, 10], source: 'natural_flow' })).toMatch(/the simulated natural flow$/);
		expect(seasonText(null)).toMatch(/^No dry season/);
	});
});

describe('otherModelRuns', () => {
	it('picks the newest run of each other runoff model, never the shown run or its model', () => {
		const runs = [meta('g2', 'gr4j'), meta('l2', 'legacy'), meta('g1', 'gr4j'), meta('l1'), meta('x', 'ihacres')];
		expect(otherModelRuns(runs, { id: 'g2', runoffModel: 'gr4j' }).map((r) => r.id)).toEqual(['l2', 'x']);
		// An older run shown: its own model's newer run is not "another model".
		expect(otherModelRuns(runs, { id: 'g1', runoffModel: 'gr4j' }).map((r) => r.id)).toEqual(['l2', 'x']);
		// A run without runoffModel is legacy.
		expect(otherModelRuns(runs, { id: 'l1', runoffModel: undefined }).map((r) => r.id)).toEqual(['g2', 'x']);
	});
});

describe('lowFlowChart', () => {
	it('draws the run’s curves with the whole-run simulated outflow, then other models on the same season', () => {
		const c = lowFlowChart(curves('gr4j'), [{ runId: 'l', label: 'Legacy run', lowFlow: curves('legacy', undefined, 2) }]);
		expect(c.x).toEqual([50, 90]);
		expect(c.labels).toEqual(['Gauge', 'Simulated outflow (GR4J, this run)', 'Natural flow', 'Simulated outflow (Legacy (workbook), Legacy run)']);
		expect(c.ys).toEqual([
			[2, 1],
			[3, 1.5],
			[4, 2],
			[6, 3]
		]);
		expect(c.styles).toEqual(['dashed', 'solid', 'solid', 'solid']);
		expect(c.skipped).toEqual([]);
	});

	it('switches the simulated curve to a record’s days, and skips a run made on another dry season or without curves', () => {
		const c = lowFlowChart(
			curves('gr4j'),
			[
				{ runId: 'a', label: 'Winter run', lowFlow: curves('legacy', [5, 6, 7, 8, 9, 10]) },
				{ runId: 'b', label: 'Old run', lowFlow: undefined }
			],
			'flow_observed_m3s'
		);
		expect(c.labels).toEqual(['Gauge', 'Natural flow', "Simulated outflow on the gauge's days (GR4J, this run)"]);
		expect(c.ys[2]).toEqual([2.5, 1.2]);
		expect(c.skipped).toEqual(['Winter run']);
	});
});

describe('breakHint, signedPct and findings', () => {
	it('names a rise, and formats signed percentages', () => {
		expect(breakHint({ hint: 'gauge', unexplained: 0.4 })).toMatch(/^A rise/);
		expect(breakHint({ hint: 'gauge', unexplained: -0.4 })).toMatch(/^Points to the gauge/);
		expect(breakHint({ hint: 'newUse', unexplained: -0.4 })).toMatch(/new use upstream/);
		expect(signedPct(-0.304)).toBe('−30 %');
		expect(signedPct(0.5)).toBe('+50 %');
		expect(signedPct(-0.001)).toBe('+0 %');
		expect(signedPct(null)).toBe('–');
	});

	it('sums up each check: not checked, no finding, or a finding', () => {
		const none: PlausibilityChecks = { drySeason: null, naturalised: null, rainSource: null, flowDoubleMass: null, lowFlow: null };
		expect(findings(none).map((f) => f.ok)).toEqual([null, null, null, null]);
		const p = {
			...none,
			naturalised: { judgedYears: 3, failedYears: [2001] },
			rainSource: { good: { fractionNotMet: 0.1 }, fallback: { years: 2, fractionNotMet: 0.15 } },
			flowDoubleMass: { breaks: [{ hint: 'rain' }] },
			lowFlow: { comparison: { withinFactor: false } }
		} as unknown as PlausibilityChecks;
		expect(findings(p).map((f) => f.ok)).toEqual([false, true, true, false]);
	});

	it('adds a recessions line from engine 1.19.0 only (null = not checked or not judged)', () => {
		const none: PlausibilityChecks = { drySeason: null, naturalised: null, rainSource: null, flowDoubleMass: null, lowFlow: null };
		expect(findings(none)).toHaveLength(4);
		expect(findings({ ...none, recession: null }).at(-1)).toEqual({ label: 'Recessions', ok: null });
		const r = (agrees: boolean | null) => ({ ...none, recession: { agrees } }) as unknown as PlausibilityChecks;
		expect(findings(r(true)).at(-1)!.ok).toBe(true);
		expect(findings(r(false)).at(-1)!.ok).toBe(false);
		expect(findings(r(null)).at(-1)!.ok).toBeNull();
	});

	it('adds a gauges line only when a gauge has its own record (engine ≥ 1.4.0), failing when one gauge fails', () => {
		const none: PlausibilityChecks = { drySeason: null, naturalised: null, rainSource: null, flowDoubleMass: null, lowFlow: null };
		const g = (failed: number[], within: boolean | null) =>
			({
				nodeId: `g${failed.length}`,
				name: 'Upper weir',
				flowKind: 'flow_logger_m3s',
				naturalShare: 0.4,
				naturalised: { judgedYears: 3, failedYears: failed },
				lowFlow: within === null ? null : { comparison: { ratio: within ? 1.2 : 0.3, withinFactor: within } }
			}) as unknown as NonNullable<PlausibilityChecks['gauges']>[number];
		expect(findings({ ...none, gauges: [g([], true)] }).map((f) => [f.label, f.ok]).at(-1)).toEqual(['At gauges in the network', true]);
		expect(findings({ ...none, gauges: [g([], true), g([2002], null)] }).at(-1)!.ok).toBe(false);
		expect(findings({ ...none, gauges: [g([], false)] }).at(-1)!.ok).toBe(false);
		expect(gaugeRow(g([2002], false))).toEqual({
			nodeId: 'g1',
			name: 'Upper weir',
			record: 'Logger',
			naturalShare: 0.4,
			judgedYears: 3,
			failedYears: [2002],
			q90Ratio: 0.3,
			withinFactor: false,
			ok: [false, false]
		});
	});
});
