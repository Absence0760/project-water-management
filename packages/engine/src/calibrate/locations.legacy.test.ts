// The legacy guard of calibration locations (engine 1.110.0, issue #659): a
// project saved before them (a calibration site, null = the outlet, plus #555's
// zones) runs and fits as engine 1.109.0 did, to the bit. Each case's run
// series, headline and zone statistics, and each fit step's units, parameters
// and scores are pinned to what engine 1.109.0 gave on the same input
// (fixtures/locations-legacy.golden.json, made by running this file against
// 1.109.0 with GOLDEN_WRITE=1). Through normalizeCalibrationLocations, the
// raw legacy settings and the normalised ones give the same outputs too.
//
// Not a hash of every bit: V8's libm (pow, exp, tanh, ...) gives last-bit
// different floats on macOS arm64 and on Linux x64, which GR4J's pow and
// tanh feed through every store, so a sha256 of the JSON passed on CI and
// failed on a Mac with the behaviour unchanged (testing.md § Golden
// fingerprints). The pins are testing/golden.ts' moments of each series
// and its reportGolden of each fit, at a relative 1e-9: platform noise is
// about 1e-13, a changed day's rain or a moved fit step is 1e-7 or more.
// The fitted parameters are compared to the bit, as prior-calibrate.test.ts
// does: the search takes the same path on both platforms.
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import { gaugeSeriesKey, type ModelInput, type NetworkNode } from '../project';
import { Rng } from '../random';
import { runModel } from '../run';
import type { Gr4jParams } from '../runoff/params';
import { calibrateStepwise } from './stepwise';
import { newCalibrationZone, type CalibrationZone } from './zones';
import { normalizeCalibrationLocations, normalizedInput, withHeadlineParams } from './locations';
import { calibrationZoneFlags, calibrationZonesSection, headlineFitRecord } from '../evidence/calibrationZones';
import { goldenDiff, goldenFingerprint, reportDiff, reportGolden, type GoldenFingerprint, type ReportGolden } from '../testing/golden';
import { sameOutput } from '../testing/invariants';

const apan = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100];
const node = (over: Partial<NetworkNode>): NetworkNode => ({
	id: 'x',
	name: 'x',
	kind: 'farm',
	downstreamNodeId: null,
	sortOrder: 0,
	areaKm2: 0,
	pctUpstreamToDam: 0,
	pctRunoffToDam: 0,
	damCapacityM3: 0,
	damInitialPct: 0,
	damMinPct: 0,
	divertCapacityM3Day: 0,
	irrigationEfficiency: 1,
	returnFlowFraction: 0,
	damAreaFullM2: 0,
	damAreaExponent: 0.7,
	damSeepagePerDay: 0,
	...over
});

function rain(days: number, start: string, seed: number): number[] {
	const rng = new Rng(seed);
	const d0 = toEpochDay(start);
	return Array.from({ length: days }, (_, t) => {
		const m = new Date((d0 + t) * 86_400_000).getUTCMonth() + 1;
		const wet = [5, 6, 7, 8, 9].includes(m) ? 0.35 : 0.08;
		return rng.bool(wet) ? Math.round(rng.logFloat(0.5, rng.bool(0.05) ? 150 : 40) * 10) / 10 : 0;
	});
}

const START = '1990-10-01';
const DAYS = Math.round(4 * 365.25);
const TRUTH_H: Gr4jParams = { x1: 900, x2: 0, x3: 220, x4: 3.1 };
const TRUTH_S: Gr4jParams = { x1: 500, x2: 0, x3: 120, x4: 2.2 };
const TRUTH_G: Gr4jParams = { x1: 220, x2: 0, x3: 50, x4: 1.3 };

const zone = (nodeId: string, over: Partial<CalibrationZone> = {}): CalibrationZone => ({ ...newCalibrationZone(nodeId), enabled: true, ...over });

/**
 * Farm A drains to the weir H, H to the site weir S, S to the outlet G; farm D
 * drains to S, farm B to G (beside S), farm C to the bare gauge K, K to G. A
 * record at G (the outlet), H and S, each made by a run with A on TRUTH_H, D
 * on TRUTH_S and B and C on TRUTH_G.
 */
function network(): ModelInput {
	const base = rain(DAYS, START, 17);
	const scaled = (k: number) => ({ startDate: START, values: base.map((v) => v * k) });
	const nodes = [
		node({ id: 'G', name: 'Outlet', kind: 'gauge' }),
		node({ id: 'S', name: 'Site weir', kind: 'gauge', downstreamNodeId: 'G', sortOrder: 1 }),
		node({ id: 'H', name: 'Weir', kind: 'gauge', downstreamNodeId: 'S', sortOrder: 2 }),
		node({ id: 'K', name: 'Bare gauge', kind: 'gauge', downstreamNodeId: 'G', sortOrder: 3 }),
		node({ id: 'A', name: 'Farm A', downstreamNodeId: 'H', areaKm2: 40, sortOrder: 4 }),
		node({ id: 'D', name: 'Farm D', downstreamNodeId: 'S', areaKm2: 30, sortOrder: 5 }),
		node({ id: 'B', name: 'Farm B', downstreamNodeId: 'G', areaKm2: 60, sortOrder: 6 }),
		node({ id: 'C', name: 'Farm C', downstreamNodeId: 'K', areaKm2: 20, sortOrder: 7 })
	];
	const input: ModelInput = {
		settings: { runoffModel: 'gr4j', apanMm: apan as never, gr4j: { ...TRUTH_G, warmupDays: 365 }, unitRain: { mode: 'perUnit' } },
		model: { nodes, crops: [], cropAreas: [], transfers: [] },
		series: {
			rain_catchment_mm: { startDate: START, values: base },
			'rain_catchment_mm@A': scaled(1.4),
			'rain_catchment_mm@D': scaled(1.1),
			'rain_catchment_mm@B': scaled(0.8),
			'rain_catchment_mm@C': scaled(0.9)
		}
	};
	const truth = runModel({ ...input, settings: { ...input.settings, calibrationZones: [zone('H', { gr4j: TRUTH_H }), zone('S', { gr4j: TRUTH_S })] } });
	const at = (nodeId: string | null, key: string) => truth.series.find((s) => s.nodeId === nodeId && s.key === key)!.values;
	input.series[gaugeSeriesKey('flow_observed_m3s', 'H')] = { startDate: START, values: at('H', 'outflow').map((q) => q / 86_400) };
	input.series[gaugeSeriesKey('flow_observed_m3s', 'S')] = { startDate: START, values: at('S', 'outflow').map((q) => q / 86_400) };
	input.series.flow_observed_m3s = { startDate: START, values: at(null, 'simulated_outflow').map((q) => q / 86_400) };
	input.settings.gr4j = { x1: 350, x2: 0, x3: 90, x4: 1.7, warmupDays: 365 };
	return input;
}

/** A GR4J fit record made at `site` on the window from `start`, with the start parameters network() leaves (so not edited). */
const fitAt = (site: string, start: string | null) => ({
	model: 'gr4j',
	objective: 'kgePrime',
	free: ['x1', 'x2', 'x3', 'x4'],
	params: { x1: 350, x2: 0, x3: 90, x4: 1.7 },
	flowKind: 'flow_observed_m3s',
	siteNodeId: site,
	calibrationStart: start,
	calibrationEnd: null,
	exclusions: [],
	engineVersion: '1.109.0',
	fittedAt: '2026-10-01T00:00:00.000Z'
});

/** Legacy settings: a site (null = the outlet) and #555's zones, each case with its own window and exclusions at the site. */
const CASES: Record<string, Partial<ModelInput['settings']>> = {
	outlet: { calibrationStart: '1991-10-01', calibrationExclusions: [{ waterYear: 1992, reason: 'invented' }] },
	innerSite: { calibrationSiteNodeId: 'S', calibrationStart: '1991-10-01', calibrationExclusions: [{ waterYear: 1992, reason: 'invented' }] },
	outletAndZones: { calibrationZones: [zone('H', { gr4j: TRUTH_H }), zone('S', { calibrationStart: '1991-10-01' }), zone('K', { enabled: false })] as never },
	innerSiteAndZoneWithOrphans: {
		calibrationSiteNodeId: 'S',
		calibrationEnd: '1993-09-30',
		qualityFlags: { suspect: 'include' } as never,
		calibrationZones: [zone('H', { calibrationStart: '1991-10-01' })] as never,
		fitRecord: null
	},
	innerSiteWithRowsAtAndBelow: { calibrationSiteNodeId: 'H', calibrationZones: [zone('H', { gr4j: TRUTH_S }), zone('S', { gr4j: TRUTH_S })] as never },
	staleSite: { calibrationSiteNodeId: 'gone', calibrationZones: [zone('H', { gr4j: TRUTH_H })] as never },
	// A stored fit record at the site: the run's fit status reads it (in sample, edited or another period).
	innerSiteFitted: { calibrationSiteNodeId: 'S', calibrationStart: '1991-10-01', fitRecord: fitAt('S', '1991-10-01') as never, calibrationZones: [zone('H')] as never },
	// A site at a gauge with no record: the run's statistics fall back to the outlet's record.
	siteWithoutRecord: { calibrationSiteNodeId: 'K', fitRecord: fitAt('K', null) as never, calibrationZones: [zone('H', { gr4j: TRUTH_H })] as never }
};

/** A fit's pin: its parameters to the bit and its report golden, or a refusal's message. */
type FitPin = { params: unknown; golden: ReportGolden } | string;
interface Pin {
	run: GoldenFingerprint;
	fit: FitPin;
}

/** What the fixture file holds: a series with a NaN day (ewr_binding_site) has NaN moments, which JSON keeps as null. */
const viaJson = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** Every series by its own moments, and the headline and zone statistics as the summary. */
function runPin(input: ModelInput): GoldenFingerprint {
	const out = runModel(input);
	return goldenFingerprint(out, /./, { calibration: out.summary.calibration, zones: out.summary.calibrationZones ?? [] });
}

/** Each step's site, parameters and scores, in fit order (a refusal by its message). */
function fitPin(input: ModelInput): FitPin {
	try {
		const r = calibrateStepwise(input, { budget: 40, validate: false, seed: 5 });
		return {
			params: r.steps.map((s) => s.report.params),
			golden: reportGolden(r.steps.map((s) => [s.report.siteNodeId ?? null, s.report.params, s.report.startParams, s.report.fit.scores, s.report.before.scores, s.report.marPenalty ?? null]))
		};
	} catch (e) {
		return `refused: ${(e as Error).message}`;
	}
}

function fitDiff(got: FitPin, want: FitPin): string[] {
	if (typeof got === 'string' || typeof want === 'string') return got === want ? [] : [`${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`];
	return JSON.stringify(got.params) === JSON.stringify(want.params) ? reportDiff(got.golden, want.golden) : [`params ${JSON.stringify(got.params)} ≠ ${JSON.stringify(want.params)}`];
}

/**
 * What engine 1.109.0 gave, per case: this file run against 3aa2338af (engine 1.109.0; 1.108.0 at eccb44252 gives the
 * same) with GOLDEN_WRITE=1, on macOS arm64, and checked on Linux x64 (Node 24) where it also passes. Rewrite only
 * for a change that is meant to move a legacy project. staleSite's fit is the one exception, taken from 1.110.0:
 * its documented change (CZ2).
 */
const PINNED_FILE = new URL('../../fixtures/locations-legacy.golden.json', import.meta.url);
const PINNED: Record<string, Pin> = process.env.GOLDEN_WRITE ? {} : JSON.parse(readFileSync(PINNED_FILE, 'utf8'));
// The one intended change: engine 1.109.0 refused the fit at a stale site ("the calibration site is no longer in
// the model"); since 1.110.0 the stale site is read as the outlet, so the fit scores there as the run always did
// (docs/model.md §2.10n, engine-audit.md CZ2). The run is 1.109.0's, as outletAndZones without S.

describe('legacy calibration settings run and fit as engine 1.109.0 did', () => {
	const base = network();
	for (const [name, over] of Object.entries(CASES)) {
		it(name, { timeout: 60_000 }, () => {
			const input = { ...base, settings: { ...base.settings, ...over } } as ModelInput;
			const got: Pin = { run: runPin(input), fit: fitPin(input) };
			if (process.env.GOLDEN_WRITE) {
				PINNED[name] = got;
				writeFileSync(PINNED_FILE, `${JSON.stringify(PINNED, null, '\t')}\n`);
				return;
			}
			expect(goldenDiff(viaJson(got.run), PINNED[name]!.run), `${name} run`).toEqual([]);
			expect(fitDiff(got.fit, PINNED[name]!.fit), `${name} fit`).toEqual([]);
		});
	}

	it('the ensemble and automated calibration move a legacy site’s parameters as engines before did (gr4j, unfitted rows too)', () => {
		const input = { ...base, settings: { ...base.settings, ...CASES.innerSiteAndZoneWithOrphans } } as ModelInput;
		const p: Gr4jParams = { x1: 700, x2: 0, x3: 150, x4: 2.5 };
		const before = { ...input, settings: { ...input.settings, gr4j: { ...input.settings.gr4j!, ...p } } } as ModelInput;
		expect(sameOutput(runModel(withHeadlineParams(input, 'S', p)), runModel(before))).toBe(true);
		// In the locations' shape only the headline's row moves: the unfitted row above it keeps settings.gr4j.
		const located = normalizedInput(input);
		const moved = withHeadlineParams(located, 'S', p);
		expect([moved.settings.gr4j, moved.settings.calibrationZones!.find((z) => z.nodeId === 'S')!.gr4j]).toEqual([located.settings.gr4j, p]);
	});

	it('the evidence report reads a legacy site’s fit record and statistics as the headline’s', () => {
		const at = (name: string) => {
			const input = { ...base, settings: { ...base.settings, ...CASES[name] } } as ModelInput;
			const out = runModel(input);
			return { summary: out.summary, inputs: { settings: input.settings, model: input.model } as never };
		};
		// A site with no zone is one parameter set, as before: no zones section.
		expect(calibrationZonesSection(at('innerSite'))).toBeNull();
		const run = at('innerSiteFitted');
		expect(headlineFitRecord(run.inputs)).toEqual(fitAt('S', '1991-10-01'));
		const section = calibrationZonesSection(run)!;
		expect(section.map((z) => [z.nodeId, z.headline ?? false, !!z.fit, z.stats?.days === run.summary.calibration!.days])).toEqual([
			['H', false, false, false],
			['S', true, true, true]
		]);
		// Only the unfitted row above is flagged, never the headline.
		expect(calibrationZoneFlags(section).map((f) => f.text)).toEqual(['Validation not assessed for the calibration zone at Weir: its parameters don’t come from a stored automatic fit.']);
	});

	it('raw legacy settings and their normalised form run and fit alike', { timeout: 60_000 }, () => {
		for (const name of ['innerSite', 'innerSiteAndZoneWithOrphans']) {
			const input = { ...base, settings: { ...base.settings, ...CASES[name] } } as ModelInput;
			const norm = { ...input, settings: normalizeCalibrationLocations(input.settings, input.model.nodes) };
			expect(norm.settings).not.toBe(input.settings);
			expect(norm.settings.calibrateAtOutlet).toBe(false);
			expect(sameOutput(runModel(input), runModel(norm)), name).toBe(true);
			expect(fitDiff(fitPin(norm), PINNED[name]!.fit), name).toEqual([]);
		}
	});
});
