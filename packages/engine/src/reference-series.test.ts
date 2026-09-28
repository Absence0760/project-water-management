// A reference gauge (flow_reference_m3s) is a gauge on a different river: a
// regional wet/dry index only (docs/model.md §2.10). These tests pin that the
// engine never uses it as an observed or calibration record, never compares it
// with the logger, and never lets it touch the EWR results. Its one use, ranking
// the dry → wet test's water years, is pinned (never scored) in calibrate.test.ts.
import { describe, expect, it } from 'vitest';
import { calibrate } from './calibrate/calibrate';
import { CALIBRATION_FLOW_KINDS, SERIES_KINDS, type ModelInput, type NetworkNode } from './project';
import { OBSERVED_FLOW_KINDS } from './quality';
import { DEFAULT_GAUGE_PICK_WARNING, pickObservedKind, runModelWith } from './run';

const DAYS = 400;
const START = '2019-10-01';
const zeros = new Array(12).fill(0);

const node = (over: Partial<NetworkNode>): NetworkNode => ({
	id: 'x',
	name: 'x',
	kind: 'farm',
	downstreamNodeId: null,
	sortOrder: 0,
	areaKm2: 10,
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
});

// Natural flow that sometimes falls below a flat EWR, so EWR shortfalls exist.
const natural = Array.from({ length: DAYS }, (_, t) => 50_000 + 40_000 * Math.sin(t / 20));
const reference = Array.from({ length: DAYS }, (_, t) => (t % 7 === 0 ? null : 3 + Math.cos(t / 11)));

function input(extra: ModelInput['series'] = {}, settings: Partial<ModelInput['settings']> = {}): ModelInput {
	return {
		settings: { ewrPragmaticM3PerDay: new Array(12).fill(30_000) as never, apanMm: zeros as never, ...settings },
		model: {
			nodes: [node({ id: 'G', name: 'Gauge', kind: 'gauge', areaKm2: 0 }), node({ id: 'F', name: 'Farm', downstreamNodeId: 'G', sortOrder: 1 })],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: START, values: new Array(DAYS).fill(1) }, ...extra }
	};
}
const run = (i: ModelInput) => runModelWith(i, () => ({ naturalFlowM3Day: natural }));

describe('reference gauge (flow_reference_m3s) is never an observed record', () => {
	it('is a series kind, but not a calibration or agreement kind', () => {
		expect(SERIES_KINDS).toContain('flow_reference_m3s');
		expect(CALIBRATION_FLOW_KINDS as readonly string[]).not.toContain('flow_reference_m3s');
		expect(OBSERVED_FLOW_KINDS as readonly string[]).not.toContain('flow_reference_m3s');
	});

	it('pickObservedKind never picks it, and it does not trigger the default-pick warning', () => {
		const s = { startDate: START, values: [1] };
		const w: string[] = [];
		expect(pickObservedKind(null, { flow_reference_m3s: s }, w)).toBeNull();
		expect(pickObservedKind(null, { flow_reference_m3s: s, flow_logger_m3s: s }, w)).toBe('flow_logger_m3s');
		expect(w).toEqual([]);
		// Positive control: a real gauge series is picked.
		expect(pickObservedKind(null, { flow_reference_m3s: s, flow_observed_m3s: s }, w)).toBe('flow_observed_m3s');
	});

	it('leaves a run without an observed record when it is the only flow series', () => {
		const out = run(input({ flow_reference_m3s: { startDate: START, values: reference } }));
		expect(out.summary.calibration).toBeNull();
		expect(out.series.some((s) => s.key === 'observed_flow')).toBe(false);
		expect(out.summary.warnings).toContain('no observed flow series: calibration statistics not computed');
		expect(out.summary.dataQuality!.observedAgreement).toBeNull();
		// The outlet EWR test against an observed record doesn't run on it.
		expect(out.summary.catchment.ewrAgreement ?? null).toBeNull();
	});

	it('does not change the calibration record, the scores or the gauge-vs-logger agreement', () => {
		const logger = { startDate: START, values: natural.map((q) => (q / 86_400) * 1.1) };
		const base = run(input({ flow_logger_m3s: logger }));
		const withRef = run(input({ flow_logger_m3s: logger, flow_reference_m3s: { startDate: START, values: reference } }));
		expect(withRef.summary.calibration).toEqual(base.summary.calibration);
		expect(withRef.summary.calibration!.flowKind).toBe('flow_logger_m3s');
		expect(withRef.summary.warnings).not.toContain(DEFAULT_GAUGE_PICK_WARNING);
		expect(withRef.summary.dataQuality!.observedAgreement).toBeNull();
		// The EWR test on the observed record uses the logger, exactly as without the reference.
		expect(base.summary.catchment.ewrAgreement).toBeTruthy();
		expect(withRef.summary.catchment.ewrAgreement).toEqual(base.summary.catchment.ewrAgreement);
	});

	it('does not touch the EWR comparison or any simulated output', () => {
		const base = run(input());
		const withRef = run(input({ flow_reference_m3s: { startDate: START, values: reference } }));
		expect(base.summary.catchment.ewrDaysNotMet).toBeGreaterThan(0); // the fixture has EWR shortfalls to compare
		expect(withRef.series).toEqual(base.series);
		expect(withRef.summary.ewrCompliance).toEqual(base.summary.ewrCompliance);
		expect(withRef.summary.catchment).toEqual(base.summary.catchment);
		expect(withRef.summary.farms).toEqual(base.summary.farms);
		expect(withRef.summary.curtailment).toEqual(base.summary.curtailment);
	});

	it('is not something automatic calibration can fit to', () => {
		// With A-pan, so the only thing missing is an observed record.
		const i = input({ flow_reference_m3s: { startDate: START, values: reference } }, { runoffModel: 'gr4j', apanMm: new Array(12).fill(150) as never });
		expect(() => calibrate(i, { budget: 10, validate: false })).toThrow(/no observed flow series to calibrate against/);
	});
});
