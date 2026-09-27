// The plausibility checks of two runs side by side (./compare.ts,
// compare.ts compareRuns().plausibility). End to end on a synthetic
// two-gauge network (as ./gauges.test.ts): run A's record at gauge H fails
// check 1 and check 4, run B's (a "refit" record) passes; the outlet passes in
// both. Then the matching rules and the older-run cases on hand-built checks.
import { describe, expect, it } from 'vitest';
import type { Monthly } from '../calendar';
import { compareRuns, diffInputs, type ComparableRun, type RunInputsSnapshot } from '../compare';
import { gaugeSeriesKey, type ModelInput, type NetworkNode, type RunSummary } from '../project';
import { runModelWith } from '../run';
import { comparePlausibility } from './compare';
import type { PlausibilityChecks } from './index';
import type { NaturalisedCheck } from './naturalised';

const flat = (v: number) => new Array(12).fill(v) as unknown as Monthly;
const days = 730;
const startDate = '2001-10-01';

function node(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: `Node ${id}`,
		kind: 'farm',
		downstreamNodeId: null,
		sortOrder: 0,
		areaKm2: 1,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: 0,
		pctRunoffToDam: 0,
		damCapacityM3: 0,
		damInitialPct: 0,
		damMinPct: 0,
		divertCapacityM3Day: 0,
		irrigationEfficiency: 1,
		lossReturnFraction: 0,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

const natural = Array.from({ length: days }, (_, t) => 3000 + 2000 * Math.sin((2 * Math.PI * t) / 365));

function base(): ModelInput {
	return {
		settings: { ewrPragmaticM3PerDay: flat(1000), apanMm: flat(150) },
		model: {
			nodes: [
				node('A', { downstreamNodeId: 'H' }),
				node('H', { kind: 'gauge', areaKm2: 0, downstreamNodeId: 'G', sortOrder: 1 }),
				node('B', { downstreamNodeId: 'G', sortOrder: 2 }),
				node('G', { kind: 'gauge', areaKm2: 0, sortOrder: 3 })
			],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate, values: new Array(days).fill(1) } }
	};
}

const run = (i: ModelInput) => runModelWith(i, () => ({ naturalFlowM3Day: natural }));

/** A run whose outlet record is its own outflow and whose record at H is H's flow × `scale`. */
function gaugedRun(scale: number): ComparableRun {
	const first = run(base());
	const get = (id: string | null, key: string) => first.series.find((s) => s.nodeId === id && s.key === key)!.values;
	const i = base();
	i.series.flow_observed_m3s = { startDate, values: get(null, 'simulated_outflow').map((v) => v / 86_400) };
	i.series[gaugeSeriesKey('flow_observed_m3s', 'H')] = { startDate, values: get('H', 'outflow').map((v) => (v / 86_400) * scale) };
	const out = run(i);
	return { engineVersion: '1.4.0', startDate, endDate: '2003-09-30', summary: out.summary };
}

describe('the plausibility checks in the run comparison', () => {
	it('shows each site’s failing years and Q90 ratio side by side, before and after', () => {
		const c = compareRuns(gaugedRun(3), gaugedRun(1)).plausibility!;
		expect(c.sites.map((s) => [s.name, s.isOutlet, s.onlyIn])).toEqual([
			['Outlet', true, null],
			['Node H', false, null]
		]);
		const [outlet, h] = c.sites;
		// The outlet passes in both.
		expect(outlet!.naturalised).toMatchObject({ failedA: [], failedB: [], passedA: true, passedB: true, newlyFailing: [], nowPassing: [] });
		expect(outlet!.lowFlow!.withinA).toBe(true);
		// Positive control: at H, A fails both water years and B none of them.
		expect(h!.nodeId).toBe('H');
		expect(h!.naturalised).toMatchObject({ flowKindA: 'flow_observed_m3s', failedA: [2001, 2002], failedB: [], passedA: false, passedB: true, nowPassing: [2001, 2002], newlyFailing: [] });
		expect(h!.naturalised!.judgedYears).toEqual({ a: 2, b: 2, delta: 0 });
		// A's simulated Q90 is a third of its record's; B's matches.
		expect(h!.lowFlow!.ratio.a).toBeCloseTo(1 / 3, 6);
		expect(h!.lowFlow!.ratio.b).toBeCloseTo(1, 9);
		expect(h!.lowFlow!.ratio.delta).toBeCloseTo(2 / 3, 6);
		expect([h!.lowFlow!.withinA, h!.lowFlow!.withinB]).toEqual([false, true]);
		// Constant rain: every year is a good-rain year in both, no split to warn on.
		expect(c.rainSource).toMatchObject({ fallbackYears: { a: 0, b: 0, delta: 0 }, warnsA: null, warnsB: null, fallbackWaterYearsA: [], fallbackWaterYearsB: [] });
		// Two years are too few for the double-mass check in either run.
		expect(c.flowDoubleMass).toBeNull();
	});

	it('names a gauge’s own record by its gauge in the input changes', () => {
		const snap = (keys: string[]): RunInputsSnapshot => ({
			settings: {},
			model: base().model,
			series: Object.fromEntries(keys.map((k) => [k, { startDate, length: days }]))
		});
		const lines = diffInputs(snap(['flow_observed_m3s']), snap(['flow_observed_m3s', gaugeSeriesKey('flow_logger_m3s', 'H')])).map((c) => c.text);
		expect(lines).toEqual(['Observed flow (logger) at gauge Node H series added (2001-10-01 to 2003-09-30)']);
	});
});

describe('comparePlausibility matching', () => {
	const nat = (failed: number[]): NaturalisedCheck => ({
		flowKind: 'flow_observed_m3s',
		tolerance: 0.1,
		floor: 0.01,
		minDays: 300,
		years: [2001, 2002, 2003].map((waterYear) => ({ waterYear, days: 365, judged: true, passed: !failed.includes(waterYear) }) as NaturalisedCheck['years'][number]),
		judgedYears: 3,
		failedYears: failed
	});
	const checks = (gauges: { nodeId: string; name: string; failed: number[] }[] = [], outletFailed: number[] | null = []): PlausibilityChecks => ({
		drySeason: null,
		naturalised: outletFailed ? nat(outletFailed) : null,
		rainSource: null,
		flowDoubleMass: null,
		lowFlow: null,
		...(gauges.length
			? { gauges: gauges.map((g) => ({ nodeId: g.nodeId, name: g.name, flowKind: 'flow_observed_m3s' as const, naturalShare: 0.5, naturalised: nat(g.failed), lowFlow: null })) }
			: {})
	});

	it('is null when neither run has checks, and a run before engine 0.25.0 is its side’s null', () => {
		expect(comparePlausibility(undefined, undefined)).toBeNull();
		const c = comparePlausibility(undefined, checks([], [2002]))!;
		expect(c.sites).toHaveLength(1);
		expect(c.sites[0]).toMatchObject({ isOutlet: true, onlyIn: 'b' });
		expect(c.sites[0]!.naturalised).toMatchObject({ failedA: null, failedB: [2002], passedA: null, passedB: false, newlyFailing: [], nowPassing: [] });
		expect(c.sites[0]!.naturalised!.judgedYears).toEqual({ a: null, b: 3, delta: null });
	});

	it('matches a gauge by node id through a rename, then by name across a copy; a gauge only one run has is listed alone', () => {
		const a = checks([
			{ nodeId: 'h1', name: 'Upper weir', failed: [2001] },
			{ nodeId: 'k1', name: 'Lower weir', failed: [] },
			{ nodeId: 'x1', name: 'Old site', failed: [] }
		]);
		const b = checks([
			{ nodeId: 'h1', name: 'Upper weir (renamed)', failed: [2001, 2003] },
			{ nodeId: 'k2', name: 'lower weir', failed: [2002] },
			{ nodeId: 'n2', name: 'New site', failed: [] }
		]);
		const c = comparePlausibility(a, b)!;
		expect(c.sites.map((s) => [s.name, s.nameA, s.nodeId, s.onlyIn])).toEqual([
			['Outlet', null, null, null],
			['New site', null, 'n2', 'b'],
			['Old site', null, 'x1', 'a'],
			['Upper weir (renamed)', 'Upper weir', 'h1', null],
			['lower weir', 'Lower weir', 'k2', null]
		]);
		const upper = c.sites.find((s) => s.nodeId === 'h1')!;
		expect(upper.naturalised).toMatchObject({ newlyFailing: [2003], nowPassing: [] });
		const lower = c.sites.find((s) => s.nodeId === 'k2')!;
		expect(lower.naturalised).toMatchObject({ failedA: [], failedB: [2002], newlyFailing: [2002] });
	});

	it('leaves out a site neither run could check, and keeps the catchment-wide checks', () => {
		const s = (x: PlausibilityChecks): RunSummary['plausibility'] => x;
		const c = comparePlausibility(s(checks([], null)), s(checks([], null)))!;
		expect(c.sites).toEqual([]);
		expect(c.rainSource).toBeNull();
	});
});
