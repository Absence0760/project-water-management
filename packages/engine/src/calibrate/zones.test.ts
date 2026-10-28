// Calibration zones and the stepwise fit (engine 1.106.0, issue #555,
// docs/model.md §2.10n): each ticked gauge's land units on their own GR4J
// parameters, fitted upstream first.
import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import { gaugeSeriesKey, type Gr4jSettings, type ModelInput, type NetworkNode } from '../project';
import { mergeSettings } from '../prepare';
import { Rng } from '../random';
import { runModel } from '../run';
import { sameOutput } from '../testing/invariants';
import type { Gr4jParams } from '../runoff/params';
import { calibrate, prepareCalibration, zoneNote } from './calibrate';
import { applyStepwise, calibrateStepwise, zoneFitPlan } from './stepwise';
import {
	calibrationZoneError,
	calibrationZonesError,
	newCalibrationZone,
	resolveZones,
	sanitizeCalibrationZones,
	spannedWaterYears,
	zoneCalibrationSettings,
	zoneCompleteWaterYears,
	zoneCoverageNotes,
	type CalibrationZone
} from './zones';

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
const DAYS = Math.round(6 * 365.25);
/** The upstream zone's truth (farm A, above the weir H) and the outlet zone's (farm B), far apart. */
const TRUTH_H: Gr4jParams = { x1: 900, x2: 0, x3: 220, x4: 3.1 };
const TRUTH_G: Gr4jParams = { x1: 220, x2: 0, x3: 50, x4: 1.3 };
const START_P: Gr4jSettings = { x1: 350, x2: 0, x3: 90, x4: 1.7, warmupDays: 365 };

const zone = (nodeId: string, over: Partial<CalibrationZone> = {}): CalibrationZone => ({ ...newCalibrationZone(nodeId), enabled: true, ...over });

/**
 * Farm A (40 km²) drains to the weir H, which drains to the outlet G; farm B
 * (60 km²) and farm C (20 km², on the bare gauge K) drain to G. Per unit flow
 * generation on the catchment rain (each unit with its own wetter or drier
 * gauge, so the zones see different rain). H's and G's records are the truth:
 * A on TRUTH_H, B and C on TRUTH_G.
 */
function network(): ModelInput {
	const base = rain(DAYS, START, 11);
	const scaled = (k: number) => ({ startDate: START, values: base.map((v) => v * k) });
	const input: ModelInput = {
		settings: { runoffModel: 'gr4j', apanMm: apan as never, gr4j: { ...TRUTH_G, warmupDays: 365 }, unitRain: { mode: 'perUnit' } },
		model: {
			nodes: [
				node({ id: 'G', name: 'Outlet', kind: 'gauge' }),
				node({ id: 'H', name: 'Weir', kind: 'gauge', downstreamNodeId: 'G', sortOrder: 1 }),
				node({ id: 'K', name: 'Bare gauge', kind: 'gauge', downstreamNodeId: 'G', sortOrder: 2 }),
				node({ id: 'A', name: 'Farm A', downstreamNodeId: 'H', areaKm2: 40, sortOrder: 3 }),
				node({ id: 'B', name: 'Farm B', downstreamNodeId: 'G', areaKm2: 60, sortOrder: 4 }),
				node({ id: 'C', name: 'Farm C', downstreamNodeId: 'K', areaKm2: 20, sortOrder: 5 })
			],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: {
			rain_catchment_mm: { startDate: START, values: base },
			'rain_catchment_mm@A': scaled(1.4),
			'rain_catchment_mm@B': scaled(0.8),
			'rain_catchment_mm@C': scaled(0.9)
		}
	};
	const truth = runModel({ ...input, settings: { ...input.settings, calibrationZones: [zone('H', { gr4j: TRUTH_H })] } });
	const at = (nodeId: string | null, key: string) => truth.series.find((s) => s.nodeId === nodeId && s.key === key)!.values;
	input.series[gaugeSeriesKey('flow_observed_m3s', 'H')] = { startDate: START, values: at('H', 'outflow').map((q) => q / 86_400) };
	input.series.flow_observed_m3s = { startDate: START, values: at(null, 'simulated_outflow').map((q) => q / 86_400) };
	input.settings.gr4j = { ...START_P };
	return input;
}
const withZones = (input: ModelInput, zones: CalibrationZone[] | null | undefined, over: Partial<ModelInput['settings']> = {}): ModelInput => ({
	...input,
	settings: { ...input.settings, calibrationZones: zones as never, ...over }
});
const unitRunoff = (out: ReturnType<typeof runModel>, id: string) => out.series.find((s) => s.nodeId === id && s.key === 'runoff_natural')!.values;

describe('calibration zone settings', () => {
	it('absent, null, [] and every row unticked read as no zone; a stored list is sanitised', () => {
		expect(mergeSettings({}, []).calibrationZones).toBeUndefined();
		expect(mergeSettings({ calibrationZones: [] } as never, []).calibrationZones).toBeUndefined();
		expect(mergeSettings({ calibrationZones: null } as never, []).calibrationZones).toBeUndefined();
		const warnings: string[] = [];
		const z = sanitizeCalibrationZones(
			[{ nodeId: 'H', enabled: true, gr4j: { x1: 5, x2: 0, x3: 1, x4: 1 } }, { nodeId: 'H', enabled: false }, { enabled: true }, { nodeId: 'K', enabled: 'yes', calibrationStart: 'soon', calibrationFlowKind: 'flow_logger_m3s' }],
			warnings
		);
		expect(z.map((x) => [x.nodeId, x.enabled, x.gr4j, x.calibrationStart, x.calibrationFlowKind])).toEqual([
			['H', true, null, null, null],
			['K', false, null, null, 'flow_logger_m3s']
		]);
		expect(warnings).toHaveLength(3);
		expect(warnings[0]).toMatch(/X1 must be 10–3000 mm/);
	});

	it('refuses a row that is gone, not a gauge, the outlet, the site, or below the site, and a repeat', () => {
		const { nodes } = network().model;
		expect(calibrationZoneError(nodes, null, 'gone')).toMatch(/no longer in the model/);
		expect(calibrationZoneError(nodes, null, 'A')).toMatch(/not a gauge/);
		expect(calibrationZoneError(nodes, null, 'G')).toMatch(/is the outlet/);
		expect(calibrationZoneError(nodes, 'H', 'H')).toMatch(/is the calibration site/);
		const below = [...nodes, node({ id: 'L', name: 'Low weir', kind: 'gauge', downstreamNodeId: 'G' })].map((n) => (n.id === 'H' ? { ...n, downstreamNodeId: 'L' } : n));
		expect(calibrationZoneError(below, 'H', 'L')).toMatch(/below the calibration site/);
		expect(calibrationZoneError(nodes, null, 'H')).toBeNull();
		expect(calibrationZonesError(nodes, null, [zone('H'), zone('H', { enabled: false })])).toMatch(/two rows/);
		expect(calibrationZonesError(nodes, null, [{ nodeId: 'A', enabled: false }])).toBeNull();
		expect(calibrationZonesError(nodes, null, [{ nodeId: 'A', enabled: true }])).toMatch(/not a gauge/);
	});

	it('assigns each land unit to the first ticked gauge below it, upstream first, the rest to the site', () => {
		const input = network();
		const s = mergeSettings(withZones(input, [zone('K'), zone('H', { gr4j: TRUTH_H })]).settings, []);
		const a = resolveZones(input.model.nodes, s, START_P, [])!;
		// Neither drains through the other: by name.
		expect(a.zones.map((z) => [z.nodeId, z.units, z.fitted])).toEqual([
			['K', ['C'], false],
			['H', ['A'], true]
		]);
		expect(a.primaryUnits).toEqual(['B']);
		// A gauge above another comes first.
		const chain = input.model.nodes.map((n) => (n.id === 'K' ? { ...n, downstreamNodeId: 'H' } : n));
		expect(resolveZones(chain, s, START_P, [])!.zones.map((z) => [z.nodeId, z.units])).toEqual([
			['K', ['C']],
			['H', ['A']]
		]);
		// Unticking merges into the next ticked gauge down: with K off, C is in the site's zone.
		const off = mergeSettings(withZones(input, [zone('K', { enabled: false }), zone('H')]).settings, []);
		expect(resolveZones(chain, off, START_P, [])!.zones.map((z) => [z.nodeId, z.units])).toEqual([['H', ['A', 'C']]]);
	});

	it('under Fragmentation ticked rows warn and apply nothing', () => {
		const input = network();
		const warnings: string[] = [];
		const s = mergeSettings(withZones(input, [zone('H', { gr4j: TRUTH_H })], { unitRain: null }).settings, []);
		expect(resolveZones(input.model.nodes, s, START_P, warnings)).toBeNull();
		expect(warnings[0]).toMatch(/need Per unit flow generation/);
	});

	it('a zone fit reads the zone’s own window, exclusions, record and start parameters', () => {
		const s = mergeSettings(
			withZones(network(), [zone('H', { calibrationStart: '1991-10-01', calibrationEnd: '1994-09-30', calibrationExclusions: [{ waterYear: 1992, reason: 'weir rebuilt' }], gr4j: TRUTH_H, qualityFlags: { suspect: 'include' } })]).settings,
			[]
		);
		const v = zoneCalibrationSettings(s, 'H');
		expect([v.calibrationSiteNodeId, v.calibrationStart, v.calibrationEnd, v.calibrationExclusions.length, v.qualityFlags.suspect, v.gr4j.x1, v.gr4j.warmupDays]).toEqual(['H', '1991-10-01', '1994-09-30', 1, 'include', 900, 365]);
		expect(zoneCalibrationSettings(s, null)).toBe(s);
		expect(() => zoneCalibrationSettings(s, 'K')).toThrow(/no calibration zone/);
	});

	it('coverage: complete water years scored, the span of a record, and the notes', () => {
		const d0 = toEpochDay('2000-10-01');
		const year = Array.from({ length: 365 }, (_, t) => t);
		expect(zoneCompleteWaterYears('2000-10-01', [...year, ...year.slice(0, 300).map((t) => t + 365)])).toEqual([2000]);
		expect(d0).toBeGreaterThan(0);
		expect(spannedWaterYears('2021-05-01', '2023-09-30')).toBe(2);
		expect(spannedWaterYears('2021-10-01', '2023-09-29')).toBe(1);
		expect(spannedWaterYears(null, '2023-09-30')).toBe(0);
		expect(zoneCoverageNotes('Weir', 1, false)).toHaveLength(2);
		expect(zoneCoverageNotes('Weir', 2, true)).toEqual([]);
	});
});

describe('runs under calibration zones', () => {
	it('no ticked zone runs bit-identically to no zones at all (absent, [], unticked rows)', () => {
		const input = network();
		const bare = runModel(input);
		for (const z of [null, [], [zone('H', { enabled: false, gr4j: TRUTH_H })]]) expect(sameOutput(bare, runModel(withZones(input, z as never))), JSON.stringify(z)).toBe(true);
		expect(bare.summary.unitRain?.zones).toBeUndefined();
	});

	it('a ticked zone runs its units on its parameters and the rest on settings.gr4j; the summary says so', () => {
		const input = network();
		const bare = runModel(input);
		const zoned = runModel(withZones(input, [zone('H', { gr4j: TRUTH_H })]));
		expect(unitRunoff(zoned, 'B')).toEqual(unitRunoff(bare, 'B'));
		expect(unitRunoff(zoned, 'C')).toEqual(unitRunoff(bare, 'C'));
		expect(unitRunoff(zoned, 'A')).not.toEqual(unitRunoff(bare, 'A'));
		// A on TRUTH_H is the run with TRUTH_H everywhere, unit by unit.
		const all = runModel({ ...input, settings: { ...input.settings, gr4j: { ...TRUTH_H, warmupDays: 365 } } });
		expect(unitRunoff(zoned, 'A')).toEqual(unitRunoff(all, 'A'));
		expect(zoned.summary.unitRain?.zones).toEqual([
			{ nodeId: 'H', name: 'Weir', units: ['A'], params: TRUTH_H, fitted: true },
			{ nodeId: null, name: 'Outlet', units: ['B', 'C'], params: { x1: 350, x2: 0, x3: 90, x4: 1.7 }, fitted: true }
		]);
	});

	it('a zone with no parameters yet runs on the catchment’s, with a warning; Fragmentation ignores zones with one', () => {
		const input = network();
		const bare = runModel(input);
		const unfitted = runModel(withZones(input, [zone('H')]));
		expect(unitRunoff(unfitted, 'A')).toEqual(unitRunoff(bare, 'A'));
		expect(unfitted.summary.warnings.some((w) => /"Weir" has no parameters of its own yet/.test(w))).toBe(true);
		const frag = withZones(input, null, { unitRain: null });
		const fragZoned = runModel(withZones(frag, [zone('H', { gr4j: TRUTH_H })]));
		const fragBare = runModel(frag);
		expect(fragZoned.series.find((s) => s.key === 'simulated_outflow')!.values).toEqual(fragBare.series.find((s) => s.key === 'simulated_outflow')!.values);
		expect(fragZoned.summary.warnings.some((w) => /need Per unit flow generation/.test(w))).toBe(true);
	});
});

describe('the stepwise fit', () => {
	it('without a ticked zone it is one step, calibrate() itself to the bit', () => {
		const input = network();
		expect(zoneFitPlan(input)).toBeNull();
		const one = calibrate(input, { budget: 60, validate: false, seed: 2 });
		const step = calibrateStepwise(withZones(input, []), { budget: 60, validate: false, seed: 2 });
		expect(step.steps).toHaveLength(1);
		expect(step.steps[0]!.report).toEqual(one);
	});

	it('plans upstream first and refuses a zone, or a site, with no land unit', () => {
		const input = network();
		expect(zoneFitPlan(withZones(input, [zone('H')]))!.map((s) => [s.zoneNodeId, s.name, s.units])).toEqual([
			['H', 'Weir', ['A']],
			[null, 'Outlet', ['B', 'C']]
		]);
		const empty = { ...input, model: { ...input.model, nodes: input.model.nodes.map((n) => (n.id === 'A' ? { ...n, downstreamNodeId: 'G' } : n)) } };
		expect(() => zoneFitPlan(withZones(empty, [zone('H')]))).toThrow(/"Weir" has no land unit/);
		const allUp = { ...input, model: { ...input.model, nodes: input.model.nodes.map((n) => (n.id === 'B' || n.id === 'C' ? { ...n, downstreamNodeId: 'H' } : n)) } };
		expect(() => zoneFitPlan(withZones(allUp, [zone('H')]))).toThrow(/nothing of its own to fit/);
	});

	it('a zone fit moves only its own units and scores its own gauge', () => {
		const input = withZones(network(), [zone('H')]);
		const pb = prepareCalibration(input, [], undefined, 'H');
		expect([pb.siteNodeId, pb.zoneNodeId, pb.zoneUnits, pb.marPenalty]).toEqual(['H', 'H', ['A'], null]);
		const site = prepareCalibration(input);
		expect([site.siteNodeId, site.zoneNodeId, site.zoneUnits]).toEqual([null, null, ['B', 'C']]);
		// B and C don't reach the weir: their parameters can't change its score.
		const a = pb.simulate({ ...TRUTH_H });
		const b = prepareCalibration(withZones(network(), [zone('H')], { gr4j: { x1: 1500, x2: 0, x3: 400, x4: 6, warmupDays: 365 } }), [], undefined, 'H').simulate({ ...TRUTH_H });
		expect(Array.from(b)).toEqual(Array.from(a));
		expect(() => prepareCalibration(input, [], undefined, 'K')).toThrow(/no ticked calibration zone/);
		// The truth reproduces the weir's record on every scored day.
		for (const t of pb.scoredDays) expect(a[t]).toBeCloseTo(pb.observed[t]!, 6);
	});

	it('recovers each zone’s true parameters, upstream first, and applies them as one', { timeout: 120_000 }, () => {
		const input = withZones(network(), [zone('H')]);
		const r = calibrateStepwise(input, { budget: 1200, validate: false, seed: 3 });
		expect(r.cancelled).toBe(false);
		expect(r.steps.map((s) => s.zoneNodeId)).toEqual(['H', null]);
		const [h, g] = r.steps.map((s) => s.report);
		expect(h!.siteNodeId).toBe('H');
		expect(h!.notes).toContain(zoneNote('Weir', 1));
		expect(g!.siteNodeId).toBeNull();
		for (const [rep, truth] of [
			[h!, TRUTH_H],
			[g!, TRUTH_G]
		] as const) {
			expect(rep.fit.scores.kgePrime).toBeGreaterThan(0.99);
			expect(Math.abs(rep.params.x1! - truth.x1) / truth.x1).toBeLessThan(0.1);
			expect(Math.abs(rep.params.x3! - truth.x3) / truth.x3).toBeLessThan(0.15);
			expect(Math.abs(rep.params.x4! - truth.x4)).toBeLessThan(0.3);
		}
		const applied = applyStepwise(mergeSettings(input.settings, []), r, (s) => ({ step: s.zoneNodeId }) as never);
		expect(applied.gr4j.x1).toBe(g!.params.x1);
		expect(applied.gr4j.warmupDays).toBe(365);
		expect(applied.calibrationZones![0]!.gr4j!.x1).toBe(h!.params.x1);
		expect(applied.fitRecord).toEqual({ step: null });
		expect(applied.calibrationZones![0]!.fitRecord).toEqual({ step: 'H' });
		// The applied settings run each zone at its fit's scores.
		const out = runModel({ ...input, settings: applied as unknown as ModelInput['settings'] });
		expect(out.summary.calibration?.nse).toBeGreaterThan(0.99);
	});

	it('a cancelled step stops the fit, and it is never applied', () => {
		const input = withZones(network(), [zone('H')]);
		const r = calibrateStepwise(input, { budget: 50, validate: false, seed: 1, onProgress: (p) => p.step === 1 && p.evaluations > 5 });
		expect(r.cancelled).toBe(true);
		expect(r.steps).toHaveLength(1);
		expect(() => applyStepwise(mergeSettings(input.settings, []), r, () => ({}) as never)).toThrow(/cancelled/);
	});

	it('warns at a ticked gauge with a short record or no dry year', () => {
		const input = withZones(network(), [zone('H', { calibrationStart: '1991-10-01', calibrationEnd: '1992-09-30' })]);
		const r = calibrate(input, { zone: 'H', budget: 30, seed: 1 });
		expect(r.notes.some((n) => /record at "Weir" has 1 complete water year/.test(n))).toBe(true);
		expect(r.notes.some((n) => /record at "Weir" has no dry year/.test(n))).toBe(true);
	});
});
