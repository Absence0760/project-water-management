// Calibration statistics at each calibration zone's gauge (issue #555 round 4,
// docs/model.md §2.10n, RunSummary.calibrationZones): each ticked gauge's record
// against its simulated outflow on the zone's own window, in or out of sample by
// the zone's own fit record.
import { describe, expect, it } from 'vitest';
import { gaugeSeriesKey, type ModelInput, type NetworkNode } from './project';
import { mergeSettings } from './prepare';
import { runModel } from './run';
import { calibrate } from './calibrate/calibrate';
import { fitRecordFromReport } from './calibrate/provenance';
import { newCalibrationZone, zoneCalibrationSettings, type CalibrationZone } from './calibrate/zones';
import { ENGINE_VERSION } from './version';

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

const START = '2000-10-01';
const DAYS = 3 * 365;
const rainMm = Array.from({ length: DAYS }, (_, t) => (t % 9 === 0 ? 25 : t % 4 === 0 ? 4 : 0));
const zone = (nodeId: string, over: Partial<CalibrationZone> = {}): CalibrationZone => ({ ...newCalibrationZone(nodeId), enabled: true, ...over });

/** Farm A drains to the weir H (a zone's gauge), farm B to the outlet G. H and G have records (synthetic). */
function input(zones: CalibrationZone[] | undefined, mode: 'perUnit' | null = 'perUnit'): ModelInput {
	const flow = Array.from({ length: DAYS }, (_, t) => 0.2 + (t % 30) / 100);
	return {
		settings: {
			runoffModel: 'gr4j',
			apanMm: [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100] as never,
			gr4j: { x1: 350, x2: 0, x3: 90, x4: 1.7, warmupDays: 0 },
			...(mode ? { unitRain: { mode } } : {}),
			...(zones ? { calibrationZones: zones } : {})
		},
		model: {
			nodes: [
				node({ id: 'G', name: 'Outlet', kind: 'gauge' }),
				node({ id: 'H', name: 'Weir', kind: 'gauge', downstreamNodeId: 'G', sortOrder: 1 }),
				node({ id: 'A', name: 'Farm A', downstreamNodeId: 'H', areaKm2: 40, sortOrder: 2 }),
				node({ id: 'B', name: 'Farm B', downstreamNodeId: 'G', areaKm2: 60, sortOrder: 3 })
			],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: {
			rain_catchment_mm: { startDate: START, values: rainMm },
			flow_observed_m3s: { startDate: START, values: flow },
			[gaugeSeriesKey('flow_observed_m3s', 'H')]: { startDate: START, values: flow.map((q) => q / 2) }
		}
	};
}

describe('calibration statistics at each zone’s gauge (RunSummary.calibrationZones)', () => {
	it('is absent without a zone and with the only row unticked; settings without unitRain score it as Per unit does', () => {
		expect(runModel(input(undefined)).summary.calibrationZones).toBeUndefined();
		expect(runModel(input([zone('H')], null)).summary.calibrationZones).toEqual(runModel(input([zone('H')])).summary.calibrationZones);
		expect(runModel(input([zone('H', { enabled: false })])).summary.calibrationZones).toBeUndefined();
	});

	it('scores the zone’s gauge on its own window, against the gauge’s simulated outflow', () => {
		const out = runModel(input([zone('H', { calibrationStart: '2001-10-01', calibrationEnd: '2002-09-30', gr4j: { x1: 500, x2: 0, x3: 100, x4: 2 } })]));
		const [s] = out.summary.calibrationZones!;
		expect(out.summary.calibrationZones).toHaveLength(1);
		expect(s).toMatchObject({ siteNodeId: 'H', siteName: 'Weir', flowKind: 'flow_observed_m3s', simulatedKey: 'simulated_outflow', windowStart: '2001-10-01', windowEnd: '2002-09-30', days: 365 });
		// Its parameters were set by hand: out of sample (no fit record).
		expect(s!.fitStatus).toBe('notFitted');
		// The site's own statistics are unchanged in kind: the outlet's record, its own window (the whole record).
		expect(out.summary.calibration?.siteNodeId).toBeUndefined();
		expect(out.summary.calibration?.days).toBe(DAYS);
		// The simulated mean is the gauge's own outflow (only farm A above it), not the outlet's.
		const hOut = out.series.find((x) => x.nodeId === 'H' && x.key === 'outflow')!.values;
		const inWindow = hOut.slice(365, 730);
		expect(s!.meanSimulatedM3s).toBeCloseTo(inWindow.reduce((a, b) => a + b, 0) / inWindow.length / 86_400, 9);
	});

	it('is in sample by the zone’s own fit record, and out of sample once its window moves', () => {
		const base = input([zone('H')]);
		const settings = mergeSettings(base.settings, []);
		const zs = zoneCalibrationSettings(settings, 'H');
		const r = calibrate(base, { zone: 'H', budget: 20, validate: false, seed: 1 });
		const record = fitRecordFromReport(r, { settings: zs, validate: false, validationRecord: null, engineVersion: ENGINE_VERSION, fittedAt: '2026-10-28T00:00:00.000Z' });
		const fitted = zone('H', { gr4j: { x1: r.params.x1!, x2: r.params.x2!, x3: r.params.x3!, x4: r.params.x4! }, fitRecord: record });
		expect(runModel(input([fitted])).summary.calibrationZones![0]!.fitStatus).toBe('fitted');
		// The site's own statistics have no fit record: the zone's doesn't count for them.
		expect(runModel(input([fitted])).summary.calibration?.fitStatus).toBe('notFitted');
		expect(runModel(input([{ ...fitted, calibrationStart: '2001-10-01' }])).summary.calibrationZones![0]!.fitStatus).toBe('otherPeriod');
		expect(runModel(input([{ ...fitted, gr4j: { ...fitted.gr4j!, x1: fitted.gr4j!.x1 + 1 } }])).summary.calibrationZones![0]!.fitStatus).toBe('edited');
	});

	it('lists the outlet as a location beside a headline gauge, and the headline gauge as `calibration` (engine 1.110.0, issue #659)', () => {
		const base = input([zone('H', { calibrationStart: '2001-10-01' })]);
		const out = runModel({ ...base, settings: { ...base.settings, calibrateAtOutlet: true, calibrationRest: 'headline', calibrationSiteNodeId: 'H', calibrationEnd: '2002-09-30' } });
		// The headline is the weir: its record, its window.
		expect(out.summary.calibration).toMatchObject({ siteNodeId: 'H', siteName: 'Weir', windowStart: '2001-10-01', windowEnd: '2003-09-30' });
		// The outlet is the other ticked location: its own record and the top-level window, by the outlet node's id.
		expect(out.summary.calibrationZones).toHaveLength(1);
		expect(out.summary.calibrationZones![0]).toMatchObject({ siteNodeId: 'G', siteName: 'Outlet', flowKind: 'flow_observed_m3s', windowStart: '2000-10-01', windowEnd: '2002-09-30', days: 730 });
		const outlet = runModel({ ...base, settings: { ...base.settings, calibrateAtOutlet: true, calibrationEnd: '2002-09-30' } });
		expect(out.summary.calibrationZones![0]!.nse).toBe(outlet.summary.calibration!.nse);
		// The headline auto: the outlet when it is ticked, so the weir is the zone.
		expect(outlet.summary.calibrationZones!.map((z) => z.siteNodeId)).toEqual(['H']);
		// Without the outlet ticked the auto headline is the weir, and nothing else is listed.
		const inner = runModel({ ...base, settings: { ...base.settings, calibrateAtOutlet: false } });
		expect(inner.summary.calibration?.siteNodeId).toBe('H');
		expect(inner.summary.calibrationZones).toBeUndefined();
	});
});
