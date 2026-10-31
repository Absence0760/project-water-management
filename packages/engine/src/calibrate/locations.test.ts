// Calibration locations (engine 1.110.0, issue #659, docs/model.md §2.10n):
// every gauge and the outlet are equals, none is required, a unit can take a
// gauge's parameters though it isn't upstream of it, and the fit runs in
// dependency order. The legacy guard is ./locations.legacy.test.ts.
import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import { gaugeSeriesKey, type Gr4jSettings, type ModelInput, type NetworkNode } from '../project';
import { mergeSettings } from '../prepare';
import { Rng } from '../random';
import { runModel } from '../run';
import type { Gr4jParams } from '../runoff/params';
import { checkAll } from '../testing/invariants';
import { ensembleContext, resolveEnsembleOptions } from '../uncertainty/ensemble';
import { planAutoCalibration } from './auto';
import { calibrate } from './calibrate';
import { fitGroupChanged, fitRecordZone } from './provenance';
import {
	calibrationLocationsError,
	headlineCalibrationSettings,
	headlineLocation,
	locationFitPlan,
	normalizeCalibrationLocations,
	resolveLocations,
	unitParamsFromError,
	withLocationParams
} from './locations';
import { applyStepwise, calibrateStepwise } from './stepwise';
import { newCalibrationZone, type CalibrationZone } from './zones';

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
const zone = (nodeId: string, over: Partial<CalibrationZone> = {}): CalibrationZone => ({ ...newCalibrationZone(nodeId), enabled: true, ...over });
const P: Gr4jParams = { x1: 350, x2: 0, x3: 90, x4: 1.7 };

/**
 * A branched network (no records; resolution only):
 *   U1 → G1 (Upper weir) → G2 (Middle weir) → O (Outlet); U2, U4 → G2;
 *   U5, U10 → K (Bravo weir) → O; U11 → G1; U3 → O;
 *   U9 → W (Side weir) → U8 → O; U7 → U8.
 */
const NODES: NetworkNode[] = [
	node({ id: 'O', name: 'Outlet', kind: 'gauge' }),
	node({ id: 'G2', name: 'Middle weir', kind: 'gauge', downstreamNodeId: 'O' }),
	node({ id: 'G1', name: 'Upper weir', kind: 'gauge', downstreamNodeId: 'G2' }),
	node({ id: 'K', name: 'Bravo weir', kind: 'gauge', downstreamNodeId: 'O' }),
	node({ id: 'W', name: 'Side weir', kind: 'gauge', downstreamNodeId: 'U8' }),
	node({ id: 'U1', name: 'Unit 1', downstreamNodeId: 'G1', areaKm2: 10 }),
	node({ id: 'U11', name: 'Unit 11', downstreamNodeId: 'G1', areaKm2: 1 }),
	node({ id: 'U2', name: 'Unit 2', downstreamNodeId: 'G2', areaKm2: 20 }),
	node({ id: 'U4', name: 'Unit 4', downstreamNodeId: 'G2', areaKm2: 5 }),
	node({ id: 'U5', name: 'Unit 5', downstreamNodeId: 'K', areaKm2: 15 }),
	node({ id: 'U10', name: 'Unit 10', downstreamNodeId: 'K', areaKm2: 2 }),
	node({ id: 'U3', name: 'Unit 3', downstreamNodeId: 'O', areaKm2: 30 }),
	node({ id: 'U8', name: 'Unit 8', downstreamNodeId: 'O', areaKm2: 8 }),
	node({ id: 'U7', name: 'Unit 7', downstreamNodeId: 'U8', areaKm2: 7 }),
	node({ id: 'U9', name: 'Unit 9', downstreamNodeId: 'W', areaKm2: 9 })
];
const ROWS = ['G1', 'G2', 'K', 'W'].map((id) => zone(id, { gr4j: { ...P, x1: 100 + id.length } }));
const settingsOf = (over: Partial<ModelInput['settings']>) => mergeSettings({ calibrateAtOutlet: false, calibrationZones: ROWS, ...over } as ModelInput['settings'], [], NODES);
const groups = (over: Partial<ModelInput['settings']>, warnings: string[] = []) => {
	const a = resolveLocations(NODES, settingsOf(over), P, warnings);
	return a && Object.fromEntries([...a.locations.map((l) => [l.key ?? 'outlet', l.units] as const), ['default', a.defaultUnits] as const]);
};
const planOf = (over: Partial<ModelInput['settings']>) =>
	locationFitPlan({ settings: { calibrateAtOutlet: true, calibrationZones: [zone('G1'), zone('K')], ...over } as ModelInput['settings'], model: { nodes: NODES, crops: [], cropAreas: [], transfers: [] }, series: {} } as ModelInput);

describe('resolving the locations', () => {
	it('gives each unit the first ticked location on its path, the outlet counting when ticked', () => {
		expect(groups({ calibrateAtOutlet: true })).toEqual({ G1: ['U1', 'U11'], G2: ['U2', 'U4'], K: ['U10', 'U5'], W: ['U9'], outlet: ['U3', 'U7', 'U8'], default: [] });
		const a = resolveLocations(NODES, settingsOf({ calibrateAtOutlet: true }), P, [])!;
		// Upstream first (more ticked locations below), then by name; the outlet, the headline when ticked, last.
		expect(a.locations.map((l) => l.key)).toEqual(['G1', 'K', 'G2', 'W', null]);
		expect(a.headline).toBeNull();
		expect(a.paramSource.U3).toEqual({ from: null, how: 'zone' });
	});

	it('sends the units outside every location by the rest rule: nearest upstream, the headline, or settings.gr4j', () => {
		// Nearest: U3 meets G2 and K one hop up from the outlet (by name: Bravo); U7 and U8 meet the side weir first.
		const warnings: string[] = [];
		expect(groups({ calibrationRest: 'nearest' }, warnings)).toEqual({ G1: ['U1', 'U11'], K: ['U10', 'U3', 'U5'], G2: ['U2', 'U4'], W: ['U7', 'U8', 'U9'], default: [] });
		expect(warnings).toContain('2 land units outside every calibration location take the parameters of "Side weir", the nearest ticked location upstream on their river');
		// Headline (the read-time default): the largest area above it, the middle weir.
		expect(groups({})).toEqual({ G1: ['U1', 'U11'], K: ['U10', 'U5'], W: ['U9'], G2: ['U2', 'U3', 'U4', 'U7', 'U8'], default: [] });
		expect(groups({ calibrationRest: 'headline' })).toEqual(groups({}));
		expect(groups({ calibrationRest: 'default' })).toEqual({ G1: ['U1', 'U11'], K: ['U10', 'U5'], G2: ['U2', 'U4'], W: ['U9'], default: ['U3', 'U7', 'U8'] });
		const a = resolveLocations(NODES, settingsOf({ calibrationRest: 'nearest' }), P, [])!;
		expect(a.paramSource.U3).toEqual({ from: 'K', how: 'rest' });
		expect(a.locations.find((l) => l.key === 'K')!.rest).toEqual(['U3']);
	});

	it('keeps a unit whose id is a prototype key as a plain entry of paramSource (CodeQL js/remote-property-injection)', () => {
		const hostile = JSON.parse(JSON.stringify(NODES).replaceAll('"U3"', '"__proto__"')) as typeof NODES;
		const a = resolveLocations(hostile, settingsOf({ calibrationRest: 'nearest' }), P, [])!;
		expect(Object.getPrototypeOf(a.paramSource)).toBe(Object.prototype);
		expect(Object.prototype.hasOwnProperty.call(a.paramSource, '__proto__')).toBe(true);
		expect(Object.getOwnPropertyDescriptor(a.paramSource, '__proto__')!.value).toEqual({ from: 'K', how: 'rest' });
		expect(a.locations.find((l) => l.key === 'K')!.rest).toEqual(['__proto__']);
	});

	it('nearest breaks a tie of hops by name, then id, and walks only downstream', () => {
		const renamed = NODES.map((n) => (n.id === 'K' ? { ...n, name: 'Zulu weir' } : n));
		const a = resolveLocations(renamed, mergeSettings({ calibrateAtOutlet: false, calibrationZones: ROWS, calibrationRest: 'nearest' } as ModelInput['settings'], [], renamed), P, [])!;
		expect(a.paramSource.U3).toEqual({ from: 'G2', how: 'rest' });
		// Same name: by id.
		const same = NODES.map((n) => (n.id === 'K' ? { ...n, name: 'Middle weir' } : n));
		expect(resolveLocations(same, mergeSettings({ calibrateAtOutlet: false, calibrationZones: ROWS, calibrationRest: 'nearest' } as ModelInput['settings'], [], same), P, [])!.paramSource.U3).toEqual({ from: 'G2', how: 'rest' });
	});

	it('takes a unit’s Parameters from, and warns of one naming no ticked location', () => {
		const warnings: string[] = [];
		const a = resolveLocations(NODES, settingsOf({ calibrateAtOutlet: true, unitParamsFrom: { U5: 'G1', U3: 'gone', U4: 'G2', U7: 'O' } }), P, warnings)!;
		expect(a.locations.find((l) => l.key === 'G1')).toMatchObject({ own: ['U1', 'U11'], borrowed: ['U5'], units: ['U1', 'U11', 'U5'] });
		// Naming its own zone (U4 → G2, U7 → the outlet) is no borrowing.
		expect([a.paramSource.U5, a.paramSource.U4, a.paramSource.U7, a.paramSource.U3]).toEqual([
			{ from: 'G1', how: 'assigned' },
			{ from: 'G2', how: 'zone' },
			{ from: null, how: 'zone' },
			{ from: null, how: 'zone' }
		]);
		expect(warnings.filter((w) => w.startsWith('Parameters from'))).toEqual(['Parameters from: "Unit 3" takes its parameters from the node gone, which is not a ticked calibration location, so it takes its own zone\'s']);
		// The outlet unticked: a unit naming it takes its own zone (here the rest rule), with the warning.
		const w2: string[] = [];
		resolveLocations(NODES, settingsOf({ unitParamsFrom: { U7: 'O' } }), P, w2);
		expect(w2.some((w) => w.includes('"Unit 7" takes its parameters from "Outlet"'))).toBe(true);
	});

	it('with no ticked location every unit runs on settings.gr4j', () => {
		expect(resolveLocations(NODES, settingsOf({ calibrationZones: [] }), P, [])).toBeNull();
		expect(resolveLocations(NODES, settingsOf({ calibrationZones: ROWS.map((z) => ({ ...z, enabled: false })) }), P, [])).toBeNull();
		// The outlet alone runs on settings.gr4j too: no gauge location applies.
		expect(resolveLocations(NODES, settingsOf({ calibrateAtOutlet: true, calibrationZones: [] }), P, [])).toBeNull();
	});

	it('picks the headline: the pointer when ticked, else the outlet when ticked, else the largest area above', () => {
		expect(headlineLocation(NODES, settingsOf({}))).toBe('G2');
		expect(headlineLocation(NODES, settingsOf({ calibrateAtOutlet: true }))).toBeNull();
		expect(headlineLocation(NODES, settingsOf({ calibrateAtOutlet: true, calibrationSiteNodeId: 'K' }))).toBe('K');
		const warnings: string[] = [];
		expect(headlineLocation(NODES, settingsOf({ calibrationSiteNodeId: 'K', calibrationZones: ROWS.filter((z) => z.nodeId !== 'K') }), warnings)).toBe('G2');
		expect(warnings).toEqual([
			'Headline location: "Bravo weir" is not a ticked calibration location, so the headline is picked automatically (the outlet when it is ticked, else the ticked gauge with the largest area above it)'
		]);
		// Its settings are the funnel every reader of "the site" goes through.
		const hs = headlineCalibrationSettings(settingsOf({ calibrationSiteNodeId: 'K' }), NODES);
		expect([hs.calibrationSiteNodeId, hs.gr4j.x1]).toEqual(['K', 101]);
		expect(headlineCalibrationSettings(settingsOf({ calibrateAtOutlet: true }), NODES).calibrationSiteNodeId).toBeNull();
	});

	it('checks a save: rows, the headline pointer and the units’ Parameters from', () => {
		expect(calibrationLocationsError(NODES, { calibrationZones: ROWS, calibrationSiteNodeId: 'G2' })).toBeNull();
		expect(calibrationLocationsError(NODES, { calibrationZones: [zone('U1')], calibrationSiteNodeId: null })).toMatch(/not a gauge/);
		expect(calibrationLocationsError(NODES, { calibrationZones: [zone('O')], calibrationSiteNodeId: null })).toMatch(/is the outlet/);
		expect(calibrationLocationsError(NODES, { calibrationZones: [zone('G1', { enabled: false })], calibrationSiteNodeId: 'G1' })).toMatch(/"Upper weir" is not a ticked calibration location/);
		expect(unitParamsFromError(NODES, { calibrationZones: ROWS, unitParamsFrom: { U5: 'G1', U3: 'O' } })).toBeNull();
		expect(unitParamsFromError(NODES, { calibrationZones: ROWS, unitParamsFrom: { G1: 'G2' } })).toMatch(/"Upper weir" is not a land unit/);
		expect(unitParamsFromError(NODES, { calibrationZones: ROWS, unitParamsFrom: { U5: 'U1' } })).toMatch(/"Unit 1", which is not a calibration location/);
		expect(unitParamsFromError(NODES, { calibrationZones: [], unitParamsFrom: { U5: 'G1' } })).toMatch(/not a calibration location/);
	});
});

describe('reading settings from before calibration locations (normalizeCalibrationLocations)', () => {
	const fit = { model: 'gr4j', free: ['x1'], params: { x1: 400 } } as never;
	it('moves an inner site’s settings into its own ticked row, the fit record with them', () => {
		const raw = {
			calibrationSiteNodeId: 'G2',
			calibrationStart: '2001-10-01',
			calibrationEnd: '2001-09-30',
			calibrationFlowKind: 'flow_logger_m3s',
			calibrationExclusions: [{ waterYear: 2003, reason: 'invented' }],
			qualityFlags: { suspect: 'include', zeroFlowMonths: [1, 2] },
			gr4j: { x1: 400, x2: 0.5, x3: 80, x4: 2, warmupDays: 365 },
			fitRecord: fit,
			calibrationZones: [zone('G2', { enabled: false, gr4j: P }), zone('G1'), zone('K')]
		} as unknown as ModelInput['settings'];
		const n = normalizeCalibrationLocations(raw, NODES) as Record<string, unknown>;
		expect([n.calibrateAtOutlet, n.calibrationRest, n.calibrationSiteNodeId, n.fitRecord]).toEqual([false, 'headline', 'G2', null]);
		const rows = n.calibrationZones as CalibrationZone[];
		// The reversed window was read as none before, so the row has none; the rows above it keep theirs.
		expect(rows.find((z) => z.nodeId === 'G2')).toEqual({
			nodeId: 'G2',
			enabled: true,
			calibrationStart: null,
			calibrationEnd: null,
			calibrationFlowKind: 'flow_logger_m3s',
			calibrationExclusions: [{ waterYear: 2003, reason: 'invented' }],
			qualityFlags: { suspect: 'include', zeroFlowMonths: [1, 2] },
			gr4j: { x1: 400, x2: 0.5, x3: 80, x4: 2 },
			fitRecord: fit
		});
		expect(rows.filter((z) => z.nodeId === 'G2')).toHaveLength(1);
		expect(rows.find((z) => z.nodeId === 'G1')!.enabled).toBe(true);
		// The top level keeps its values (the outlet record's settings).
		expect([n.calibrationStart, n.gr4j]).toEqual(['2001-10-01', raw.gr4j]);
		// Idempotent: settings that have calibrateAtOutlet are returned as they are.
		expect(normalizeCalibrationLocations(n as never, NODES)).toBe(n);
	});

	it('unticks the rows at or below an inner site (engines before left them out)', () => {
		const n = normalizeCalibrationLocations({ calibrationSiteNodeId: 'G1', calibrationZones: [zone('G2'), zone('K')] } as never, NODES) as { calibrationZones: CalibrationZone[] };
		expect(n.calibrationZones.map((z) => [z.nodeId, z.enabled])).toEqual([
			['G2', false],
			['K', true],
			['G1', true]
		]);
	});

	it('reads the outlet, and a stale site, as the outlet location; without an outlet record the rest take settings.gr4j', () => {
		for (const site of [null, 'gone', 'U1', 'O']) {
			const warnings: string[] = [];
			const n = normalizeCalibrationLocations({ calibrationSiteNodeId: site, fitRecord: fit } as never, NODES, true, warnings) as Record<string, unknown>;
			expect([n.calibrateAtOutlet, n.calibrationRest, n.calibrationSiteNodeId, n.fitRecord], String(site)).toEqual([true, 'headline', null, fit]);
			expect(warnings.length, String(site)).toBe(site === null ? 0 : 1);
		}
		const none = normalizeCalibrationLocations({} as never, NODES, false) as Record<string, unknown>;
		expect([none.calibrateAtOutlet, none.calibrationRest]).toEqual([false, 'default']);
		expect(normalizeCalibrationLocations(null as never, NODES)).toBeNull();
	});
});

describe('the fit plan (dependency order)', () => {
	it('fits a borrowed unit’s donor first, even when it isn’t upstream', () => {
		// By name the Bravo weir would go first; a unit above it borrows the Upper weir's parameters.
		expect(planOf({}).map((s) => s.zoneNodeId)).toEqual(['K', 'G1', null]);
		const plan = planOf({ unitParamsFrom: { U5: 'G1' } });
		expect(plan.map((s) => [s.zoneNodeId, s.units, s.borrowed, s.deps])).toEqual([
			['G1', ['U1', 'U11', 'U5'], ['U5'], []],
			['K', ['U10'], [], ['G1']],
			[null, ['U2', 'U3', 'U4', 'U7', 'U8', 'U9'], [], ['G1', 'K']]
		]);
		expect(plan.at(-1)!.headline).toBe(true);
	});

	it('refuses a cycle, naming both gauges', () => {
		expect(() => planOf({ unitParamsFrom: { U5: 'G1', U1: 'K' } })).toThrow(
			'the units above "Bravo weir" borrow "Upper weir"\'s parameters and the units above "Upper weir" borrow "Bravo weir"\'s, so neither can be fitted first: change one unit\'s Parameters from'
		);
	});

	it('refuses a group with no unit draining through its location', () => {
		expect(() => planOf({ unitParamsFrom: { U5: 'G1', U10: 'G1' } })).toThrow(/"Bravo weir" has no land unit in its group/);
		expect(() => planOf({ unitParamsFrom: { U1: 'K', U11: 'K', U3: 'G1' } })).toThrow(/none of the land units in the group of "Upper weir" drains through it/);
	});

	it('refuses no ticked location', () => {
		expect(() => planOf({ calibrateAtOutlet: false, calibrationZones: [] })).toThrow(/no calibration location is ticked/);
		// The outlet alone: one step, every unit.
		expect(planOf({ calibrationZones: [] }).map((s) => [s.zoneNodeId, s.units.length])).toEqual([[null, 10]]);
	});
});

// A runnable chain: U1 (40 km²) → G1 → G2 → O; U2 (50) and U4 (20) → G2; U3 (120) → O. Records at G1, G2 and O.
const START = '1990-10-01';
const DAYS = Math.round(5 * 365.25);
const T1: Gr4jParams = { x1: 900, x2: 0, x3: 220, x4: 3.1 };
const T2: Gr4jParams = { x1: 450, x2: 0, x3: 110, x4: 2.0 };
const T3: Gr4jParams = { x1: 220, x2: 0, x3: 50, x4: 1.3 };
const START_P: Gr4jSettings = { x1: 350, x2: 0, x3: 90, x4: 1.7, warmupDays: 365 };

function rain(seed: number): number[] {
	const rng = new Rng(seed);
	const d0 = toEpochDay(START);
	return Array.from({ length: DAYS }, (_, t) => {
		const m = new Date((d0 + t) * 86_400_000).getUTCMonth() + 1;
		const wet = [5, 6, 7, 8, 9].includes(m) ? 0.35 : 0.08;
		return rng.bool(wet) ? Math.round(rng.logFloat(0.5, rng.bool(0.05) ? 150 : 40) * 10) / 10 : 0;
	});
}

/** The chain with records made by `truth` (each location's parameters, U4 borrowing G1's when `borrow`). */
function chain(borrow: boolean): ModelInput {
	const base = rain(23);
	const scaled = (k: number) => ({ startDate: START, values: base.map((v) => v * k) });
	const input: ModelInput = {
		settings: {
			runoffModel: 'gr4j',
			apanMm: [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100] as never,
			gr4j: { ...T3, warmupDays: 365 },
			unitRain: { mode: 'perUnit' },
			calibrateAtOutlet: true,
			calibrationRest: 'nearest',
			...(borrow ? { unitParamsFrom: { U4: 'G1' } } : {})
		},
		model: {
			nodes: [
				node({ id: 'O', name: 'Outlet', kind: 'gauge' }),
				node({ id: 'G2', name: 'Middle weir', kind: 'gauge', downstreamNodeId: 'O', sortOrder: 1 }),
				node({ id: 'G1', name: 'Upper weir', kind: 'gauge', downstreamNodeId: 'G2', sortOrder: 2 }),
				node({ id: 'U1', name: 'Unit 1', downstreamNodeId: 'G1', areaKm2: 40, sortOrder: 3 }),
				node({ id: 'U2', name: 'Unit 2', downstreamNodeId: 'G2', areaKm2: 50, sortOrder: 4 }),
				node({ id: 'U4', name: 'Unit 4', downstreamNodeId: 'G2', areaKm2: 20, sortOrder: 5 }),
				node({ id: 'U3', name: 'Unit 3', downstreamNodeId: 'O', areaKm2: 120, sortOrder: 6 })
			],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: {
			rain_catchment_mm: { startDate: START, values: base },
			'rain_catchment_mm@U1': scaled(1.4),
			'rain_catchment_mm@U2': scaled(1.1),
			'rain_catchment_mm@U4': scaled(0.7),
			'rain_catchment_mm@U3': scaled(0.8)
		}
	};
	const truth = runModel({ ...input, settings: { ...input.settings, calibrationZones: [zone('G1', { gr4j: T1 }), zone('G2', { gr4j: T2 })] } });
	const at = (nodeId: string | null, key: string) => truth.series.find((s) => s.nodeId === nodeId && s.key === key)!.values;
	for (const g of ['G1', 'G2']) input.series[gaugeSeriesKey('flow_observed_m3s', g)] = { startDate: START, values: at(g, 'outflow').map((q) => q / 86_400) };
	input.series.flow_observed_m3s = { startDate: START, values: at(null, 'simulated_outflow').map((q) => q / 86_400) };
	input.settings.gr4j = { ...START_P };
	input.settings.calibrationZones = [zone('G1'), zone('G2', { calibrationStart: '1991-10-01' })];
	return input;
}

const close = (got: Record<string, number>, truth: Gr4jParams) => {
	expect(Math.abs(got.x1! - truth.x1) / truth.x1).toBeLessThan(0.1);
	expect(Math.abs(got.x3! - truth.x3) / truth.x3).toBeLessThan(0.15);
	expect(Math.abs(got.x4! - truth.x4)).toBeLessThan(0.3);
};

describe('the stepwise fit at every gauge (issue #659)', () => {
	it('option 1 recovers each gauge’s true parameters in a three-gauge chain; option 2 borrows and still recovers them', { timeout: 240_000 }, () => {
		const opts = { budget: 1500, starts: 2, validate: false, seed: 3 } as const;
		const one = calibrateStepwise(chain(false), opts);
		expect(one.steps.map((s) => [s.zoneNodeId, s.units])).toEqual([
			['G1', ['U1']],
			['G2', ['U2', 'U4']],
			[null, ['U3']]
		]);
		for (const [s, truth] of one.steps.map((s, i) => [s, [T1, T2, T3][i]!] as const)) {
			expect(s.report.fit.scores.kgePrime).toBeGreaterThan(0.99);
			close(s.report.params, truth);
		}
		// Each location on its own window: the middle weir's starts a year in.
		expect(one.steps[1]!.report.fit.start >= '1991-10-01').toBe(true);

		// Option 2: U4, beside the upper weir, takes its parameters. The upper weir is still fitted first, and its fit is
		// the same to the bit (U4's flow never reaches it); the middle weir still recovers its own units' parameters.
		const two = calibrateStepwise(chain(true), opts);
		expect(two.steps.map((s) => [s.zoneNodeId, s.units, s.borrowed])).toEqual([
			['G1', ['U1', 'U4'], ['U4']],
			['G2', ['U2'], []],
			[null, ['U3'], []]
		]);
		expect(two.steps[0]!.report.params).toEqual(one.steps[0]!.report.params);
		expect(two.steps[0]!.report.zoneBorrowed).toEqual(['U4']);
		close(two.steps[1]!.report.params, T2);
		close(two.steps[2]!.report.params, T3);
		// Applied as one: each gauge's row, the outlet's into settings.gr4j.
		const applied = applyStepwise(mergeSettings(chain(true).settings, [], chain(true).model.nodes), two, (s) => ({ step: s.zoneNodeId }) as never);
		expect(applied.calibrationZones!.map((z) => [z.nodeId, z.gr4j!.x1, z.fitRecord])).toEqual([
			['G1', two.steps[0]!.report.params.x1, { step: 'G1' }],
			['G2', two.steps[1]!.report.params.x1, { step: 'G2' }]
		]);
		expect([applied.gr4j.x1, applied.fitRecord]).toEqual([two.steps[2]!.report.params.x1, { step: null }]);
	});

	it('with no ticked location the fit refuses before it starts, and the run goes on, saying so', () => {
		const input = chain(false);
		const none = { ...input, settings: { ...input.settings, calibrateAtOutlet: false, calibrationZones: [] } };
		expect(() => calibrateStepwise(none, { budget: 20 })).toThrow(/no calibration location is ticked/);
		const out = runModel(none);
		const coded = (out.summary.warningCodes ?? []).find((c) => c.code === 'calibration.zone.noneTicked');
		expect(coded?.params).toEqual({ records: 3 });
		// Every unit on settings.gr4j: the run without any location, scored at the outlet.
		expect(out.summary.unitRain?.zones).toBeUndefined();
		expect(out.summary.calibration?.siteNodeId).toBeUndefined();
	});

	it('holds the engine invariants with a borrowed unit and the nearest rule (mass balance, order invariance)', () => {
		const input = chain(true);
		input.settings.calibrationZones = [zone('G1', { gr4j: T1 }), zone('G2', { gr4j: T2 })];
		expect(checkAll({ ...input, settings: { ...input.settings, calibrateAtOutlet: false } })).toBeNull();
		expect(checkAll(input)).toBeNull();
	});
});

describe('the headline’s readers', () => {
	/** The chain without the outlet ticked: the middle weir is the headline (the largest area above it). */
	const inner = () => {
		const input = chain(false);
		input.settings = { ...input.settings, calibrateAtOutlet: false, calibrationZones: [zone('G1', { gr4j: T1 }), zone('G2', { gr4j: T2, calibrationStart: '1991-10-01' })] };
		return input;
	};

	it('a lone fit, automated calibration and the uncertainty ensemble act on the headline location', () => {
		const input = inner();
		const r = calibrate(input, { budget: 20, validate: false, seed: 1 });
		expect([r.siteNodeId, r.zoneNodeId, r.zoneUnits]).toEqual(['G2', 'G2', ['U2', 'U3', 'U4']]);
		expect(r.startParams).toMatchObject(T2);
		expect(planAutoCalibration(input).siteNodeId).toBe('G2');
		const { options } = resolveEnsembleOptions(input, { members: 30 });
		const ctx = ensembleContext(input, options);
		expect(ctx.siteNodeId).toBe('G2');
		expect(ctx.startParams).toMatchObject(T2);
	});

	it('the run scores the headline gauge and its signatures follow it; summary.unitRain lists the groups', () => {
		const out = runModel(inner());
		expect(out.summary.calibration).toMatchObject({ siteNodeId: 'G2', siteName: 'Middle weir', windowStart: '1991-10-01' });
		expect(out.summary.plausibility?.signatures?.siteNodeId).toBe('G2');
		expect(out.summary.unitRain?.zones?.map((z) => [z.nodeId, z.kind, z.headline ?? false, z.units, z.rest])).toEqual([
			['G1', 'gauge', false, ['U1'], []],
			['G2', 'gauge', true, ['U2', 'U3', 'U4'], ['U3']]
		]);
		expect(out.summary.unitRain?.paramSource?.U3).toEqual({ from: 'G2', how: 'rest' });
		// Under 'default' the leftover unit is settings.gr4j's group.
		const d = runModel({ ...inner(), settings: { ...inner().settings, calibrationRest: 'default' } });
		expect(d.summary.unitRain?.zones?.at(-1)).toMatchObject({ nodeId: null, kind: 'default', units: ['U3'], params: { x1: 350, x2: 0, x3: 90, x4: 1.7 } });
	});

	it('writes a location’s parameters where they live: a row, or settings.gr4j for the outlet', () => {
		const input = inner();
		expect(withLocationParams(input, 'G1', T3).settings.calibrationZones![0]!.gr4j).toEqual(T3);
		expect(withLocationParams(input, null, T1).settings.gr4j).toEqual({ ...START_P, ...T1 });
		expect(() => withLocationParams(input, 'K', T1)).toThrow(/no calibration location at gauge node K/);
	});
});

describe('a fit record’s location (provenance)', () => {
	it('reads a record moved into a row as that row’s, and flags a group that changed', () => {
		expect(fitRecordZone(null, 'G2')).toEqual({ nodeId: 'G2', units: null, borrowed: [] });
		expect(fitRecordZone({ zone: { nodeId: null, units: ['U2'] } }, 'G2')).toEqual({ nodeId: 'G2', units: ['U2'], borrowed: [] });
		expect(fitRecordZone({ zone: { nodeId: null, units: ['U3'] } }, null)).toEqual({ nodeId: null, units: ['U3'], borrowed: [] });
		const rec = { zone: { nodeId: 'G1', units: ['U1', 'U4'], borrowed: ['U4'] } };
		expect(fitGroupChanged(rec, 'G1', { units: ['U4', 'U1'], borrowed: ['U4'] })).toBe(false);
		// U4's Parameters from was cleared: the group the fit moved is gone.
		expect(fitGroupChanged(rec, 'G1', { units: ['U1'], borrowed: [] })).toBe(true);
		// A record that names no group (a fit without a gauge location) is stale once the group isn't every unit.
		expect(fitGroupChanged({}, null, { units: ['U3'], allUnits: ['U1', 'U3'] })).toBe(true);
		expect(fitGroupChanged({}, null, { units: ['U1', 'U3'], allUnits: ['U3', 'U1'] })).toBe(false);
	});
});

describe('the location warnings’ codes', () => {
	it('codes a stale Parameters from, the nearest rule, no location ticked and a headline that isn’t ticked', () => {
		const input = chain(true);
		input.settings = { ...input.settings, calibrateAtOutlet: false, calibrationSiteNodeId: 'O', unitParamsFrom: { U4: 'G1', U2: 'gone' } };
		const codes = (runModel(input).summary.warningCodes ?? []).map((c) => c.code);
		expect(codes).toEqual(expect.arrayContaining(['calibration.zone.assignStale', 'calibration.zone.restNearest', 'calibration.site.notTicked']));
		// 'calibration.zone.noneTicked' is asserted above, on a run with no location ticked.
	});
});
