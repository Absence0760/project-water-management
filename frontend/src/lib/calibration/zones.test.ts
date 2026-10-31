// The calibration locations in Calibration → Calibration record (issue #659, docs/ui.md § Settings & calibration):
// the table's rows (the outlet among them, none special), a tick, the headline, the rest rule, the fit plan and its
// refusals, and the stepwise fit's steps.
import { describe, expect, it } from 'vitest';
import { defaultProjectSettings, newCalibrationZone, type CalibrationReport, type CalibrationSite, type NetworkNode, type ProjectSettings, type ZoneFitStep } from '@water-management/engine';
import {
	afterText,
	coverageText,
	fitPlanOf,
	headlineView,
	isLegacyLocations,
	locationCoverage,
	locationRows,
	locationsState,
	normalizedLocations,
	runHeadlineSettings,
	stepRows,
	withHeadline,
	withLocationTicked,
	withRest,
	withZoneFields,
	withZoneTicked,
	zoneAtDefaults,
	zoneParamsText,
	zonesError,
	zoneWindowLine
} from './zones';

const node = (id: string, name: string, kind: NetworkNode['kind'], down: string | null, areaKm2 = 0) => ({ id, name, kind, downstreamNodeId: down, areaKm2 }) as NetworkNode;
// Upper farm → Weir → Outlet; Lower farm → Outlet; Side farm → Low weir → Outlet.
const NODES = [
	node('O', 'Outlet', 'gauge', null),
	node('H', 'Weir', 'gauge', 'O'),
	node('L', 'Low weir', 'gauge', 'O'),
	node('U', 'Upper farm', 'farm', 'H', 12),
	node('D', 'Lower farm', 'farm', 'O', 20),
	node('S', 'Side farm', 'farm', 'L', 5)
];
const weir: CalibrationSite = { nodeId: 'H', name: 'Weir', records: ['flow_observed_m3s', 'flow_logger_m3s'] };
const low: CalibrationSite = { nodeId: 'L', name: 'Low weir', records: ['flow_logger_m3s'] };
const fresh = (over: Partial<ProjectSettings> = {}): ProjectSettings => ({ ...defaultProjectSettings(), calibrateAtOutlet: true, calibrationRest: 'nearest', ...over });
const ticked = (id: string) => ({ ...newCalibrationZone(id), enabled: true });

describe('the locations table', () => {
	it('lists the outlet (with a record) first, then every gauge with a record, each with its tick and row', () => {
		const s = fresh({ calibrationZones: [ticked('H')] });
		const rows = locationRows(NODES, [weir, low], ['flow_observed_m3s'], s);
		expect(rows.map((r) => [r.key, r.name, r.kind, r.ticked])).toEqual([
			[null, 'Outlet', 'outlet', true],
			['H', 'Weir', 'gauge', true],
			['L', 'Low weir', 'gauge', false]
		]);
		expect(rows[0]!.params).toEqual(expect.objectContaining({ x1: s.gr4j.x1 }));
		expect(rows[2]!.zone).toBeNull();
	});

	it('leaves the outlet out when it has no record and isn’t ticked, and keeps it (flagged) when it is ticked', () => {
		expect(locationRows(NODES, [weir], [], fresh({ calibrateAtOutlet: false })).map((r) => r.key)).toEqual(['H']);
		const rows = locationRows(NODES, [weir], [], fresh());
		expect(rows[0]).toEqual(expect.objectContaining({ key: null, ticked: true, problem: 'no flow record at the outlet yet' }));
	});

	it('keeps a ticked row whose gauge is gone or lost its record, so it can be unticked', () => {
		const rows = locationRows(NODES, [], [], fresh({ calibrateAtOutlet: false, calibrationZones: [ticked('H'), ticked('gone')] }));
		expect(rows.map((r) => [r.name, r.problem, r.unusable])).toEqual([
			['Weir', 'it has no flow record', false],
			['A gauge no longer in the model', 'its gauge is no longer in the model', true]
		]);
		// A run still uses the weir's location (it just can't be fitted); the gone gauge it leaves out.
		expect(locationsState(NODES, rows, fresh({ calibrateAtOutlet: false, calibrationZones: [ticked('H'), ticked('gone')] })).ticked).toEqual(['H']);
	});

	it('a first tick adds the row; an untick keeps its settings; a field edit makes an unticked row', () => {
		const on = withZoneTicked(undefined, 'H', true);
		expect(on).toEqual([ticked('H')]);
		const off = withZoneTicked(withZoneFields(on, 'H', { calibrationStart: '2001-10-01' }), 'H', false);
		expect(off).toEqual([{ ...newCalibrationZone('H'), calibrationStart: '2001-10-01' }]);
		expect(withZoneTicked(undefined, 'H', false)).toEqual([]);
		expect(withZoneFields([], 'L', { calibrationFlowKind: 'flow_logger_m3s' })).toEqual([{ ...newCalibrationZone('L'), calibrationFlowKind: 'flow_logger_m3s' }]);
		expect(on[0]!.calibrationStart).toBeNull();
	});

	it('ticks the outlet through calibrateAtOutlet, and an untick of the headline puts it back to auto', () => {
		expect(withLocationTicked(fresh(), NODES, null, false).calibrateAtOutlet).toBe(false);
		expect(withLocationTicked(fresh(), NODES, 'H', true).calibrationZones).toEqual([ticked('H')]);
		const picked = withHeadline(fresh({ calibrationZones: [ticked('H')] }), 'H');
		expect(withLocationTicked(picked, NODES, 'H', false).calibrationSiteNodeId).toBeNull();
		// The outlet picked by its node: unticking the outlet clears it too; unticking another location doesn't.
		const atOutlet = withHeadline(fresh({ calibrationZones: [ticked('H')] }), 'O');
		expect(withLocationTicked(atOutlet, NODES, null, false).calibrationSiteNodeId).toBeNull();
		expect(withLocationTicked(atOutlet, NODES, 'H', false).calibrationSiteNodeId).toBe('O');
		expect(withRest(fresh(), 'default').calibrationRest).toBe('default');
	});

	it('names the first row whose window can’t be saved', () => {
		const zones = [newCalibrationZone('L'), { ...newCalibrationZone('H'), calibrationStart: '2005-10-01', calibrationEnd: '2001-09-30' }];
		expect(zonesError(zones, (id) => (id === 'H' ? 'Weir' : 'x'))).toBe('Calibration location at Weir: Calibration start must be before the end.');
		expect(zonesError(undefined, () => '')).toBeNull();
	});

	it('coverage: complete water years of the record the row fits, the outlet’s at no site', () => {
		const series = [
			{ name: 'a', kind: 'flow_observed_m3s', siteNodeId: 'H', startDate: '2021-05-01', length: 900, lastValueDate: '2023-09-30' },
			{ name: 'b', kind: 'flow_logger_m3s', siteNodeId: 'H', startDate: '2015-10-01', length: 3653, lastValueDate: null },
			{ name: 'c', kind: 'flow_observed_m3s', siteNodeId: null, startDate: '2010-10-01', length: 1826, lastValueDate: null }
		];
		expect(locationCoverage(series, 'H', weir.records, null)).toBe(2);
		expect(locationCoverage(series, 'H', weir.records, 'flow_logger_m3s')).toBe(10);
		expect(locationCoverage(series, null, ['flow_observed_m3s'], null)).toBe(5);
		expect(locationCoverage(series, 'L', low.records, null)).toBeNull();
		expect(locationCoverage(null, 'H', weir.records, null)).toBeNull();
		expect([coverageText(1), coverageText(2), coverageText(null)]).toEqual(['1 water year (too short)', '2 water years', '–']);
	});

	it('folds a gauge row to its window line, closed while it is at its defaults', () => {
		const z = newCalibrationZone('H');
		expect(zoneAtDefaults(z)).toBe(true);
		expect(zoneWindowLine(z)).toBe('start of record – end of record');
		const set = { ...z, calibrationStart: '2001-10-01', calibrationExclusions: [{ waterYear: 2004, reason: 'r' }], qualityFlags: { suspect: 'exclude' as const } };
		expect(zoneAtDefaults(set)).toBe(false);
		expect(zoneWindowLine(set)).toBe('2001-10-01 – end of record · 1 exclusion · suspect days left out');
	});

	it('shows a location’s parameters, or that it has none yet', () => {
		expect(zoneParamsText({ x1: 900, x2: 0, x3: 220.4, x4: 3.14 })).toBe('X1 900 · X2 0.00 · X3 220 · X4 3.14');
		expect(zoneParamsText(null)).toMatch(/Not fitted yet/);
	});
});

describe('the headline and the rest rule', () => {
	const rows = (s: ProjectSettings) => locationRows(NODES, [weir, low], ['flow_observed_m3s'], s);

	it('auto: the outlet when it is ticked, else the ticked gauge with the largest area above it', () => {
		const s = fresh({ calibrationZones: [ticked('H'), ticked('L')] });
		expect(locationsState(NODES, rows(s), s)).toEqual(expect.objectContaining({ ticked: [null, 'H', 'L'], headline: null, headlineName: 'Outlet', auto: true }));
		const off = fresh({ calibrateAtOutlet: false, calibrationZones: [ticked('H'), ticked('L')] });
		expect(locationsState(NODES, rows(off), off)).toEqual(expect.objectContaining({ headline: 'H', headlineName: 'Weir', auto: true }));
	});

	it('a picked headline, the outlet’s by its node; a pointer to an unticked location reads as auto', () => {
		const s = withHeadline(fresh({ calibrationZones: [ticked('H')] }), 'H');
		expect(locationsState(NODES, rows(s), s)).toEqual(expect.objectContaining({ headline: 'H', auto: false }));
		const o = withHeadline(fresh({ calibrationZones: [ticked('H')] }), 'O');
		expect(locationsState(NODES, rows(o), o)).toEqual(expect.objectContaining({ headline: null, auto: false }));
		const stale = withHeadline(fresh(), 'L');
		expect(locationsState(NODES, rows(stale), stale)).toEqual(expect.objectContaining({ headline: null, auto: true }));
	});

	it('counts the units the rest rule reaches: nearest sends them up their river, default keeps them on the catchment parameters', () => {
		// Only the weir ticked: the lower farm and the side farm have no ticked location downstream.
		const s = fresh({ calibrateAtOutlet: false, calibrationZones: [ticked('H')] });
		expect(locationsState(NODES, rows(s), s)).toEqual(expect.objectContaining({ rest: 'nearest', restUnits: 2, defaultUnits: 0 }));
		const d = withRest(s, 'default');
		expect(locationsState(NODES, rows(d), d)).toEqual(expect.objectContaining({ rest: 'default', restUnits: 0, defaultUnits: 2 }));
		// None ticked: every land unit runs on the catchment parameters.
		const none = fresh({ calibrateAtOutlet: false });
		expect(locationsState(NODES, rows(none), none)).toEqual(expect.objectContaining({ ticked: [], defaultUnits: 3 }));
	});
});

describe('settings from before engine 1.110.0', () => {
	const legacy = { ...defaultProjectSettings(), calibrationSiteNodeId: 'H', calibrationStart: '2003-10-01' } as ProjectSettings;
	delete (legacy as Partial<ProjectSettings>).calibrateAtOutlet;

	it('are read as locations: an inner site becomes its ticked row and the headline, the outlet unticked', () => {
		expect(isLegacyLocations(legacy)).toBe(true);
		const n = normalizedLocations(legacy, NODES, true);
		expect(n.calibrateAtOutlet).toBe(false);
		expect(n.calibrationZones).toEqual([expect.objectContaining({ nodeId: 'H', enabled: true, calibrationStart: '2003-10-01' })]);
		expect(n.calibrationSiteNodeId).toBe('H');
		// Already in the new shape: the same object back.
		expect(normalizedLocations(n, NODES, true)).toBe(n);
		// An outlet site without an outlet record is not ticked.
		const atOutlet = { ...legacy, calibrationSiteNodeId: null };
		expect(normalizedLocations(atOutlet, NODES, false)).toEqual(expect.objectContaining({ calibrateAtOutlet: false, calibrationRest: 'default' }));
	});

	it('every reader of “the site” reads the headline: a legacy project as before, a new one at its headline', () => {
		const fr = { engineVersion: '1.0.0' } as ProjectSettings['fitRecord'];
		expect(headlineView({ ...legacy, fitRecord: fr }, NODES)).toEqual(expect.objectContaining({ calibrationSiteNodeId: 'H', calibrationStart: '2003-10-01', fitRecord: fr }));
		const s = withHeadline(fresh({ calibrationZones: [{ ...ticked('H'), calibrationStart: '2010-10-01', fitRecord: fr }] }), 'H');
		expect(headlineView(s, NODES)).toEqual(expect.objectContaining({ calibrationStart: '2010-10-01', fitRecord: fr }));
		// No nodes (a run that kept no model): as it is.
		expect(headlineView(s, undefined)).toBe(s);
		expect(runHeadlineSettings({ settings: s, model: { nodes: NODES } })?.calibrationStart).toBe('2010-10-01');
		expect(runHeadlineSettings({})).toBeNull();
	});
});

describe('the fit plan', () => {
	it('fits the locations in dependency order, the headline last, and names what each step waits for', () => {
		const r = fitPlanOf(fresh({ calibrationZones: [ticked('H')] }), NODES);
		expect(r.error).toBeNull();
		expect(r.plan!.map((x) => [x.zoneNodeId, x.headline ?? false])).toEqual([
			['H', false],
			[null, true]
		]);
		expect(afterText(r.plan![1]!, NODES)).toBe('after Weir');
		expect(afterText(r.plan![0]!, NODES)).toBeNull();
		const two = fitPlanOf(fresh({ calibrationZones: [ticked('H'), ticked('L')] }), NODES);
		expect(afterText(two.plan!.find((x) => x.zoneNodeId === null)!, NODES)).toBe('after Low weir and Weir');
	});

	it('refuses, before any worker starts, when none is ticked, a group has no unit draining through it, or units borrow in a cycle', () => {
		const none = fitPlanOf(fresh({ calibrateAtOutlet: false }), NODES);
		expect(none.error).toMatch(/^No calibration location is ticked/);
		expect(none.none).toBe(true);
		// Every unit above the weir borrows the low weir's parameters: the weir's group drains through nothing of its own.
		const empty = fitPlanOf(fresh({ calibrationZones: [ticked('H'), ticked('L')], unitParamsFrom: { U: 'L' } }), NODES);
		expect(empty.error).toMatch(/Weir/);
		expect(empty.none).toBe(false);
		const ok = fitPlanOf(
			fresh({ calibrateAtOutlet: false, calibrationRest: 'default', calibrationZones: [ticked('H'), ticked('L')], unitParamsFrom: {} }),
			[...NODES, node('U2', 'Upper farm 2', 'farm', 'H', 3), node('S2', 'Side farm 2', 'farm', 'L', 3)]
		);
		expect(ok.error).toBeNull();
		const looped = fitPlanOf(
			fresh({ calibrateAtOutlet: false, calibrationRest: 'default', calibrationZones: [ticked('H'), ticked('L')], unitParamsFrom: { U2: 'L', S2: 'H' } }),
			[...NODES, node('U2', 'Upper farm 2', 'farm', 'H', 3), node('S2', 'Side farm 2', 'farm', 'L', 3)]
		);
		expect(looped.error).toMatch(/^The units above "(Weir|Low weir)" borrow/);
		expect(looped.error).toMatch(/\.$/);
	});
});

describe('the stepwise fit’s steps', () => {
	it('one row per step, in dependency order, with what it waits for, its borrowed units and its scores', () => {
		const rep = (x1: number, fit: number, split: number | null): CalibrationReport =>
			({
				objective: 'kgePrime',
				params: { x1, x2: 0, x3: 90, x4: 1.7 },
				fit: { scores: { kgePrime: fit } },
				splitSample: split === null ? null : { validation: { scores: { kgePrime: split } } },
				differential: null,
				notes: [`note ${x1}`]
			}) as unknown as CalibrationReport;
		const steps: ZoneFitStep[] = [
			{ zoneNodeId: 'H', name: 'Weir', units: ['U', 'S'], borrowed: ['S'], deps: [], report: rep(900, 0.91, 0.8) },
			{ zoneNodeId: null, name: 'Outlet', units: ['D'], borrowed: [], deps: ['H'], headline: true, report: rep(220, 0.85, null) }
		];
		expect(stepRows(steps, NODES)).toEqual([
			{ key: 'H', step: 1, name: 'Weir', what: 'Location', after: null, units: 2, borrowed: 1, params: 'X1 900 · X2 0.00 · X3 90.0 · X4 1.70', fit: 0.91, split: 0.8, dsst: null, notes: ['note 900'] },
			{ key: 'outlet', step: 2, name: 'Outlet', what: 'Headline', after: 'after Weir', units: 1, borrowed: 0, params: 'X1 220 · X2 0.00 · X3 90.0 · X4 1.70', fit: 0.85, split: null, dsst: null, notes: ['note 220'] }
		]);
	});
});
