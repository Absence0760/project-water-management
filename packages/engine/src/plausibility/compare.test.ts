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
import type { RecessionCheck } from '../recession/check';
import { RECESSION_DEFAULTS } from '../recession/segments';
import { ECKHARDT_FILTER, HUGHES_FILTER } from '../reserve/baseflow';
import { BFI_WARN_DIFF, FDC_LOW_WARN_PCT, type ValidationSignatures } from './signatures';

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

	it('sets each run’s stored recession diagnostics and validation signatures side by side, recomputing nothing', () => {
		const a = gaugedRun(3);
		const b = gaugedRun(1);
		const c = compareRuns(a, b).plausibility!;
		const sa = a.summary.plausibility!.signatures!;
		const sb = b.summary.plausibility!.signatures!;
		// Both runs score the outlet's gauge record: comparable, and every number is the run's own.
		expect(c.signatures).toMatchObject({ comparable: true, missingA: null, missingB: null, flowKindA: 'flow_observed_m3s', siteNodeIdA: null, siteNodeIdB: null });
		expect(c.signatures!.hughes.simulated).toEqual({ a: sa.baseflow!.hughes!.simulated, b: sb.baseflow!.hughes!.simulated, delta: sb.baseflow!.hughes!.simulated - sa.baseflow!.hughes!.simulated });
		expect(c.signatures!.eckhardt.difference.a).toBe(sa.baseflow!.eckhardt!.difference);
		expect(c.signatures!.slopeBiasPct.b).toBe(sb.lowFlowFdc!.slopeBiasPct);
		expect(c.signatures!.lowVolumeBiasPct.a).toBe(sa.lowFlowFdc!.lowVolumeBiasPct);
		// The outlet's record is the run's own outflow in both runs: the simulated BFI matches the observed.
		expect(c.signatures!.hughes.difference.b).toBeCloseTo(0, 9);
		expect(c.signatures!.hughes.withinB).toBe(true);
		// The recession diagnostics: present in both (engine ≥ 1.19.0), on the same record.
		expect(c.recession).toMatchObject({ comparable: true, missingA: null, missingB: null, agreesA: a.summary.plausibility!.recession!.agrees });
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

describe('comparePlausibility: the recession diagnostics and the validation signatures', () => {
	const bare: PlausibilityChecks = { drySeason: null, naturalised: null, rainSource: null, flowDoubleMass: null, lowFlow: null };
	const fit = (b: number) => ({ a: 0.05, b, points: 40, segments: 10, minQM3s: 0.1, maxQM3s: 3 });
	const rec = (over: Partial<RecessionCheck> = {}): RecessionCheck => ({
		flowKind: 'flow_observed_m3s',
		options: { ...RECESSION_DEFAULTS },
		segments: Array.from({ length: 10 }, (_, i) => [i * 20, i * 20 + 8] as [number, number]),
		observed: fit(1.5),
		simulated: fit(1.8),
		referenceFlowM3s: 0.5,
		observedRate: 0.04,
		simulatedRate: 0.06,
		rateRatio: 1.5,
		bDiff: 0.3,
		agrees: true,
		...over
	});
	const sig = (over: { hughesDiff?: number; slope?: number | null; flv?: number | null; skill?: number | null; agrees?: boolean | null } & Partial<ValidationSignatures> = {}): ValidationSignatures => {
		const { hughesDiff = 0.05, slope = 20, flv = -10, skill = 0.4, agrees = true, ...rest } = over;
		return {
			flowKind: 'flow_observed_m3s',
			baseflow: {
				hughesFilter: { ...HUGHES_FILTER },
				eckhardtFilter: { ...ECKHARDT_FILTER },
				days: 1000,
				runs: 2,
				hughes: { observed: 0.4, simulated: 0.4 + hughesDiff, difference: hughesDiff },
				eckhardt: { observed: 0.2, simulated: 0.22, difference: 0.02 },
				withinLimit: Math.abs(hughesDiff) <= BFI_WARN_DIFF
			},
			lowFlowFdc: {
				days: 1000,
				range: [70, 95],
				observedQ70M3s: 0.5,
				observedQ95M3s: 0.1,
				simulatedQ70M3s: 0.5,
				simulatedQ95M3s: 0.08,
				observedSlope: 6.4,
				simulatedSlope: 7.3,
				slopeBiasPct: slope,
				lowVolumeBiasPct: flv,
				withinLimit: true
			},
			recessionHoldout: {
				every: 3,
				segments: 12,
				heldOut: [],
				law: null,
				days: 30,
				modelSegments: 4,
				modelDays: 30,
				modelSkill: skill,
				lawSkill: 0.6,
				modelLogRmse: 0.1,
				lawLogRmse: 0.08,
				agrees
			},
			...rest
		};
	};

	it('gives each run’s rate ratio, b difference and verdict, and the change in each', () => {
		const c = comparePlausibility({ ...bare, recession: rec({ rateRatio: 2.6, bDiff: 0.7, agrees: false }) }, { ...bare, recession: rec() })!;
		expect(c.recession).toMatchObject({ comparable: true, agreesA: false, agreesB: true, simulatedFitA: true, minSegments: 8 });
		expect(c.recession!.rateRatio.a).toBe(2.6);
		expect(c.recession!.rateRatio.delta).toBeCloseTo(-1.1, 12);
		expect(c.recession!.bDiff.delta).toBeCloseTo(-0.4, 12);
		expect(c.recession!.segments).toEqual({ a: 10, b: 10, delta: 0 });
	});

	it('says why a side has no recession diagnostics: an older run, or none to make', () => {
		// A run from engine 1.4.0 (checks, but no recession key) against a current one.
		const older = comparePlausibility(bare, { ...bare, recession: rec() })!;
		expect(older.recession).toMatchObject({ missingA: 'older', missingB: null, comparable: false, agreesA: null, simulatedFitA: null });
		expect(older.recession!.rateRatio).toEqual({ a: null, b: 1.5, delta: null });
		// A run before engine 0.25.0 has no checks at all: older too.
		expect(comparePlausibility(undefined, { ...bare, recession: rec() })!.recession!.missingA).toBe('older');
		// null: the run had no record or no rain.
		expect(comparePlausibility({ ...bare, recession: null }, { ...bare, recession: rec() })!.recession!.missingA).toBe('none');
		// Neither run has diagnostics: nothing to set side by side.
		expect(comparePlausibility({ ...bare, recession: null }, bare)!.recession).toBeNull();
	});

	it('gives no change between two different kinds of record', () => {
		const c = comparePlausibility({ ...bare, recession: rec({ flowKind: 'flow_logger_m3s' }) }, { ...bare, recession: rec() })!;
		expect(c.recession).toMatchObject({ comparable: false, flowKindA: 'flow_logger_m3s', flowKindB: 'flow_observed_m3s' });
		expect(c.recession!.rateRatio).toEqual({ a: 1.5, b: 1.5, delta: null });
		expect(c.recession!.bDiff.delta).toBeNull();
	});

	it('sets the BFI by both filters, the low-flow biases and the held-out skill side by side, each with pass or fail', () => {
		const c = comparePlausibility(
			{ ...bare, signatures: sig({ hughesDiff: 0.2, slope: 70, flv: -60, skill: -0.2, agrees: false }) },
			{ ...bare, signatures: sig() }
		)!;
		const s = c.signatures!;
		expect(s).toMatchObject({ comparable: true, missingA: null, missingB: null, baseflowA: true, lowFlowFdcA: true, recessionHoldoutA: true });
		// Positive control: B is within every limit; A outside the Hughes BFI, both low-flow limits and the held-out skill.
		expect([s.hughes.withinA, s.hughes.withinB]).toEqual([false, true]);
		expect([s.eckhardt.withinA, s.eckhardt.withinB]).toEqual([true, true]);
		expect([s.slopeWithinA, s.slopeWithinB, s.lowVolumeWithinA, s.lowVolumeWithinB]).toEqual([false, true, false, true]);
		expect([s.holdoutAgreesA, s.holdoutAgreesB]).toEqual([false, true]);
		expect(s.hughes.difference.delta).toBeCloseTo(-0.15, 12);
		expect(s.hughes.observed.delta).toBe(0);
		expect(s.slopeBiasPct).toEqual({ a: 70, b: 20, delta: -50 });
		expect(s.lowVolumeBiasPct).toEqual({ a: -60, b: -10, delta: 50 });
		expect(s.holdoutModelSkill.delta).toBeCloseTo(0.6, 12);
		expect(s.holdoutLawSkill).toEqual({ a: 0.6, b: 0.6, delta: 0 });
		expect([s.bfiLimit, s.lowFlowLimitPct, s.holdoutMinSegments]).toEqual([BFI_WARN_DIFF, FDC_LOW_WARN_PCT, 8]);
	});

	it('leaves a slope bias the run couldn’t compute unjudged, not failed', () => {
		const s = comparePlausibility({ ...bare, signatures: sig({ slope: null }) }, { ...bare, signatures: sig() })!.signatures!;
		expect(s.slopeBiasPct).toEqual({ a: null, b: 20, delta: null });
		expect([s.slopeWithinA, s.slopeWithinB]).toEqual([null, true]);
	});

	it('says why a side has no signatures, and gives no change against it', () => {
		// Engine 1.54.0: checks, but no signatures key.
		const older = comparePlausibility(bare, { ...bare, signatures: sig() })!.signatures!;
		expect(older).toMatchObject({ missingA: 'older', missingB: null, comparable: false, baseflowA: null, lowFlowFdcA: null, recessionHoldoutA: null });
		expect(older.hughes).toEqual({
			observed: { a: null, b: 0.4, delta: null },
			simulated: { a: null, b: 0.45, delta: null },
			difference: { a: null, b: 0.05, delta: null },
			withinA: null,
			withinB: true
		});
		// null: no observed record to score.
		const none = comparePlausibility({ ...bare, signatures: sig() }, { ...bare, signatures: null })!.signatures!;
		expect(none).toMatchObject({ missingA: null, missingB: 'none', comparable: false });
		expect(none.slopeBiasPct.delta).toBeNull();
		// Neither: nothing to set side by side.
		expect(comparePlausibility({ ...bare, signatures: null }, bare)!.signatures).toBeNull();
	});

	it('gives no change between signatures of different records: another kind, or another site', () => {
		const kind = comparePlausibility({ ...bare, signatures: sig({ flowKind: 'flow_logger_m3s' }) }, { ...bare, signatures: sig() })!.signatures!;
		expect(kind.comparable).toBe(false);
		expect(kind.hughes.simulated).toEqual({ a: 0.45, b: 0.45, delta: null });
		const site = comparePlausibility({ ...bare, signatures: sig() }, { ...bare, signatures: sig({ siteNodeId: 'w1', siteName: 'Middle weir' }) })!.signatures!;
		expect(site).toMatchObject({ comparable: false, siteNodeIdA: null, siteNodeIdB: 'w1', siteNameB: 'Middle weir' });
		expect(site.holdoutModelSkill.delta).toBeNull();
		// The same gauge in both: comparable.
		const same = comparePlausibility({ ...bare, signatures: sig({ siteNodeId: 'w1', siteName: 'Weir' }) }, { ...bare, signatures: sig({ siteNodeId: 'w1', siteName: 'Middle weir' }) })!;
		expect(same.signatures!.comparable).toBe(true);
	});
});
