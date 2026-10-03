// Regression tests for the rain → natural flow bugs the engine end-to-end tests found
// (fixed in engine 1.69.0; errata ER-18, ER-19), each pinned by the behaviour docs/model.md specifies.
import { describe, expect, it } from 'vitest';
import type { ModelInput, ModelOutput } from '../project';
import { runModel } from '../run';
import { sensitivityPlan } from '../uncertainty/sensitivity';
import { SENSITIVITY_RANGES } from '../uncertainty/sensitivityVerdict';
import { applyScenario } from '../scenario/overrides';

const APAN = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100];
const NODE = {
	sortOrder: 0,
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
	damSeepagePerDay: 0
};
function catchment(series: ModelInput['series'], settings: Record<string, unknown> = {}): ModelInput {
	return {
		settings: { runoffModel: 'gr4j', apanMm: APAN as never, gr4j: { warmupDays: 0 }, ...settings } as unknown as ModelInput['settings'],
		model: {
			nodes: [
				{ ...NODE, id: 'G', name: 'Outlet gauge', kind: 'gauge', downstreamNodeId: null, areaKm2: 0 },
				// A unit with a farm dam (2 ha full), so rain on the dam (§2.7a) is visible.
				{ ...NODE, id: 'F', name: 'Unit A', kind: 'farm', downstreamNodeId: 'G', areaKm2: 10, damCapacityM3: 50_000, damInitialPct: 0.5, damAreaFullM2: 20_000, pctRunoffToDam: 0.5 }
			] as never,
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series
	};
}
const col = (out: ModelOutput, key: string, nodeId: string | null = null) => out.series.find((s) => s.nodeId === nodeId && s.key === key)?.values;

const PERIOD = {
	start: '2020-01-01',
	end: '2020-01-05',
	series: 'rain_catchment_alt_mm' as const,
	factors: new Array(12).fill(1),
	provenance: { source: 'invented', fittedFrom: '2019-01-01', fittedTo: '2019-12-31', method: 'invented' },
	reason: 'invented: the only gauge is the replacement'
};

/**
 * Fixed in 1.69.0, was: a project whose only rain is a rain-source period's series
 * (rain_catchment_alt_mm, §2.4e) runs GR4J and demand on that rain, but every
 * reader that asks "does the project have a rain series?" checks only
 * rain_catchment_mm / rain_chirps_mm / rain_forecast_mm. prepareRun's window
 * already treats a period's series as a driver (§2.4e "The run window"), so
 * the run is accepted, and then: rain_final is missing (§2.4b table), rain on
 * the dams is 0 (§2.7a reads rain used), the runoff coefficient (W1, §2.4) is
 * null, the "no rainfall value" warning (W2) never fires for its blank days,
 * and the run warns "no rainfall series" although GR4J ran on 35 mm.
 */
describe('fixed in 1.69.0: rain from a rain-source period alone is invisible outside GR4J and demand', () => {
	const alt = [10, 20, 0, null, 5];
	const altOnly = () => runModel(catchment({ rain_catchment_alt_mm: { startDate: '2020-01-01', values: alt as never } }, { rainSource: [PERIOD] }));
	// The same rain as the primary catchment series: the control.
	const primary = () => runModel(catchment({ rain_catchment_mm: { startDate: '2020-01-01', values: alt as never } }));

	it('positive control: the period’s rain reaches GR4J', () => {
		expect(col(altOnly(), 'rain_used')).toEqual([10, 20, 0, 0, 5]);
	});

	it('rain_final holds the period’s rain (§2.4b: final catchment rainfall)', () => {
		expect(col(altOnly(), 'rain_final')).toEqual(col(primary(), 'rain_final'));
	});

	it('rain falls on the farm dam as it does when the same rain is the primary series (§2.7a)', () => {
		const a = col(altOnly(), 'rain_on_dam', 'F')!;
		const b = col(primary(), 'rain_on_dam', 'F')!;
		expect(b[0]).toBeGreaterThan(0);
		expect(a).toEqual(b);
	});

	it('the runoff coefficient (W1) is computed, and the run does not claim there is no rainfall series', () => {
		const out = altOnly();
		expect(out.summary.catchment.runoffCoefficient).toBeCloseTo(primary().summary.catchment.runoffCoefficient!, 12);
		expect(out.summary.warnings.join('\n')).not.toMatch(/no rainfall series/);
	});

	it('the blank day is reported by the W2 "no rainfall value" warning', () => {
		expect(altOnly().summary.warnings.join('\n')).toMatch(/1 of 5 days have no rainfall value/);
	});
});

/**
 * Fixed in 1.69.0, was: the rain sensitivity run (§2.10g: "Rain × 0.9 / × 1.1, every rain
 * series the project has … so the whole forcing moves") scales only
 * rain_catchment_mm, rain_chirps_mm and rain_forecast_mm
 * (uncertainty/sensitivity.ts RAIN_KINDS; scenario/ops.ts
 * SCALABLE_SERIES_KINDS). A rain-source period with fixed factors (§2.4e,
 * "the normal case") reads rain_catchment_alt_mm × its factor, so its days
 * keep the central rain in the "rain × 1.1" case and the rain range is
 * understated over the period.
 */
describe('fixed in 1.69.0: the rain sensitivity case leaves a rain-source period unscaled', () => {
	it('rain × 1.1 moves every day’s rain used by 10 %, inside the period too', () => {
		const n = 31;
		const input = catchment(
			{
				rain_catchment_mm: { startDate: '2020-01-01', values: new Array(n).fill(4) },
				rain_catchment_alt_mm: { startDate: '2020-01-01', values: new Array(n).fill(6) }
			},
			{ rainSource: [{ ...PERIOD, start: '2020-01-10', end: '2020-01-20', factors: new Array(12).fill(1.5) }] }
		);
		const central = runModel(input);
		const { plans } = sensitivityPlan(input, central, SENSITIVITY_RANGES);
		const rain = plans.find((p) => p.factor === 'rain')!;
		expect(rain).toBeDefined();
		const k = rain.high.setting;
		const applied = applyScenario(input, rain.high.ops);
		expect(applied.problems).toEqual([]);
		const high = runModel(applied.input);
		const a = col(central, 'rain_used')!;
		const b = col(high, 'rain_used')!;
		// Positive control outside the period.
		expect(b[0]).toBeCloseTo(a[0]! * k, 12);
		// Inside the period (2020-01-15: alt 6 × 1.5 = 9 mm centrally).
		expect(a[14]).toBeCloseTo(9, 12);
		expect(b[14]).toBeCloseTo(a[14]! * k, 12);
	});
});
