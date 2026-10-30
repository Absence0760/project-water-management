// The report's calibration zones (evidence-22, issue #555): the fit record's
// scores and the errata versions, read from what a run froze; each location's
// period and each unit's parameter source (evidence-25, issue #659).
import { describe, expect, it } from 'vitest';
import { calibrationZoneFitVersions, calibrationZoneFlags, calibrationZonesSection, headlineFitRecord } from './calibrationZones';

const params = { x1: 500, x2: 0, x3: 100, x4: 2 };
const fit = (engineVersion: string) => ({
	model: 'gr4j',
	fittedAt: '2026-10-28T10:05:00.000Z',
	objective: 'kgePrime',
	seed: 4,
	engineVersion,
	fit: { scores: { kgePrime: 0.81 } },
	splitSample: { validation: { scores: { kgePrime: 0.62 } } },
	differential: null,
	editedParams: ['x3']
});

function run(zoneFit: unknown, siteFit: unknown) {
	return {
		summary: {
			unitRain: {
				zones: [
					{ nodeId: 'H', name: 'Weir', units: ['A', 'C'], params, fitted: true },
					{ nodeId: null, name: 'Outlet', units: ['B'], params: { ...params, x1: 300 }, fitted: true }
				]
			},
			calibration: { days: 100, nse: 0.5, kge: 0.6, pbias: -3, fitStatus: 'fitted' },
			calibrationZones: [{ siteNodeId: 'H', siteName: 'Weir', days: 0, nse: NaN, kge: NaN, pbias: NaN, fitStatus: 'edited' }]
		},
		inputs: {
			settings: { fitRecord: siteFit, calibrationZones: [{ nodeId: 'H', enabled: true, fitRecord: zoneFit }] },
			model: { nodes: [{ id: 'A', areaKm2: 10 }, { id: 'B', areaKm2: 30 }, { id: 'C', areaKm2: 2.5 }] }
		}
	} as never;
}

describe('calibrationZonesSection', () => {
	it('reads each zone’s fit record and statistics; a gauge with no scored day has none', () => {
		const z = calibrationZonesSection(run(fit('1.106.0'), fit('1.105.0')))!;
		expect(z.map((x) => [x.nodeId, x.units, x.areaKm2, x.params.x1])).toEqual([
			['H', 2, 12.5, 500],
			[null, 1, 30, 300]
		]);
		expect(z[0]!.fit).toEqual({ description: 'GR4J fit of 2026-10-28 10:05 UTC (KGE′, seed 4)', engineVersion: '1.106.0', objective: 'kgePrime', inSample: 0.81, splitSample: 0.62, dryToWet: null, editedParams: ['x3'] });
		expect(z[0]!.stats).toBeNull();
		expect(z[1]!.stats).toEqual({ days: 100, nse: 0.5, kge: 0.6, pbias: -3, fitStatus: 'fitted' });
		expect(calibrationZoneFitVersions(z)).toEqual(['1.106.0', '1.105.0']);
		expect(calibrationZoneFlags(z)).toEqual([]);
	});

	it('judges the parameters edited since the fit against those the units ran on, not the stored list', () => {
		const record = { ...fit('1.106.0'), free: ['x1', 'x2', 'x3', 'x4'], params: { ...params }, editedParams: ['x3'] };
		expect(calibrationZonesSection(run(record, null))![0]!.fit!.editedParams).toEqual([]);
		expect(calibrationZonesSection(run({ ...record, params: { ...params, x1: 501 } }, null))![0]!.fit!.editedParams).toEqual(['x1']);
	});

	it('flags a zone above the site with no fit record, not the site’s own zone', () => {
		const z = calibrationZonesSection(run(null, null));
		expect(z![0]!.fit).toBeNull();
		expect(calibrationZoneFlags(z).map((f) => f.key)).toEqual(['zoneNoFit']);
		expect(calibrationZoneFitVersions(z)).toEqual([]);
	});

	it('gives each location its period and each unit where its parameters come from (evidence-25, issue #659)', () => {
		// Engine 1.110.0: the weir H (own unit A, C borrowed from the outlet's side), the outlet G the headline, D on the catchment parameters.
		const r = {
			summary: {
				unitRain: {
					zones: [
						{ nodeId: 'H', name: 'Weir', units: ['A', 'C'], params, fitted: true, kind: 'gauge', borrowed: ['C'], rest: [] },
						{ nodeId: null, name: 'Outlet', units: ['B'], params, fitted: true, kind: 'outlet', headline: true, borrowed: [], rest: [] },
						{ nodeId: null, name: 'Catchment parameters', units: ['D'], params, fitted: true, kind: 'default' }
					],
					paramSource: { A: { from: 'H', how: 'zone' }, C: { from: 'H', how: 'assigned' }, B: { from: null, how: 'zone' }, D: { from: null, how: 'default' } }
				},
				calibration: { days: 100, nse: 0.5, kge: 0.6, pbias: -3, fitStatus: 'fitted' }
			},
			inputs: {
				settings: {
					calibrateAtOutlet: true,
					calibrationRest: 'default',
					calibrationStart: '2001-10-01',
					calibrationEnd: null,
					unitParamsFrom: { C: 'H' },
					calibrationZones: [{ nodeId: 'H', enabled: true, calibrationStart: '2010-10-01', calibrationEnd: '2015-09-30', fitRecord: null }]
				},
				model: {
					nodes: [
						{ id: 'G', name: 'Outlet', kind: 'gauge', downstreamNodeId: null, areaKm2: 0 },
						{ id: 'H', name: 'Weir', kind: 'gauge', downstreamNodeId: 'G', areaKm2: 0 },
						{ id: 'A', name: 'Upper', kind: 'farm', downstreamNodeId: 'H', areaKm2: 10 },
						{ id: 'B', name: 'Lower', kind: 'farm', downstreamNodeId: 'G', areaKm2: 30 },
						{ id: 'C', name: 'Across', kind: 'farm', downstreamNodeId: 'G', areaKm2: 2.5 },
						{ id: 'D', name: 'Dry', kind: 'farm', downstreamNodeId: 'G', areaKm2: 1 }
					]
				}
			}
		} as never;
		const z = calibrationZonesSection(r)!;
		expect(z.map((x) => [x.name, x.window ?? null, x.members])).toEqual([
			[
				'Weir',
				{ start: '2010-10-01', end: '2015-09-30' },
				[
					{ nodeId: 'C', name: 'Across', how: 'assigned' },
					{ nodeId: 'A', name: 'Upper', how: 'zone' }
				]
			],
			['Outlet', { start: '2001-10-01', end: null }, [{ nodeId: 'B', name: 'Lower', how: 'zone' }]],
			['Catchment parameters', null, [{ nodeId: 'D', name: 'Dry', how: 'default' }]]
		]);
		// A run from before engine 1.110.0 has no paramSource: a gauge's units are its own zone's, and so are the site's at the outlet.
		expect(calibrationZonesSection(run(null, null))!.map((x) => x.members!.map((m) => m.how))).toEqual([['zone', 'zone'], ['zone']]);
		// With its site at a gauge, the site's zone held the units draining through it and, as the rest, those beside it.
		const legacyAtGauge = {
			summary: { unitRain: { zones: [{ nodeId: 'K', name: 'Kloof', units: ['C'], params, fitted: true }, { nodeId: null, name: 'Weir', units: ['A', 'B'], params, fitted: true }] } },
			inputs: {
				settings: { calibrationSiteNodeId: 'H', calibrationZones: [{ nodeId: 'K', enabled: true, fitRecord: null }] },
				model: {
					nodes: [
						{ id: 'G', name: 'Outlet', kind: 'gauge', downstreamNodeId: null, areaKm2: 0 },
						{ id: 'H', name: 'Weir', kind: 'gauge', downstreamNodeId: 'G', areaKm2: 0 },
						{ id: 'K', name: 'Kloof', kind: 'gauge', downstreamNodeId: 'H', areaKm2: 0 },
						{ id: 'A', name: 'Above', kind: 'farm', downstreamNodeId: 'H', areaKm2: 10 },
						{ id: 'B', name: 'Beside', kind: 'farm', downstreamNodeId: 'G', areaKm2: 5 },
						{ id: 'C', name: 'Crest', kind: 'farm', downstreamNodeId: 'K', areaKm2: 3 }
					]
				}
			}
		} as never;
		expect(calibrationZonesSection(legacyAtGauge)!.map((x) => x.members!.map((m) => [m.name, m.how]))).toEqual([
			[['Crest', 'zone']],
			[
				['Above', 'zone'],
				['Beside', 'rest']
			]
		]);
	});

	it('reads the headline location’s fit record, a legacy inner site’s included (issue #659)', () => {
		const nodes = [
			{ id: 'G', name: 'Outlet', kind: 'gauge', downstreamNodeId: null, areaKm2: 0 },
			{ id: 'H', name: 'Weir', kind: 'gauge', downstreamNodeId: 'G', areaKm2: 0 },
			{ id: 'A', name: 'Upper', kind: 'farm', downstreamNodeId: 'H', areaKm2: 10 }
		];
		const record = fit('1.104.0');
		// Before engine 1.110.0: the site at the weir, its window and fit record at the top level.
		const legacy = { settings: { calibrationSiteNodeId: 'H', calibrationStart: '2004-10-01', calibrationEnd: '2012-09-30', fitRecord: record }, model: { nodes } } as never;
		expect(headlineFitRecord(legacy)).toEqual(record);
		// Engine 1.110.0: the weir's row is the headline, the outlet's top level is the outlet record's.
		const row = { nodeId: 'H', enabled: true, calibrationStart: '2010-10-01', calibrationEnd: null, calibrationFlowKind: null, calibrationExclusions: [], qualityFlags: null, gr4j: params, fitRecord: record };
		const now = { settings: { calibrateAtOutlet: false, calibrationSiteNodeId: 'H', calibrationStart: '2001-10-01', fitRecord: null, calibrationZones: [row] }, model: { nodes } } as never;
		expect(headlineFitRecord(now)).toEqual(record);
		// No network to read it by: as stored.
		expect(headlineFitRecord({ settings: { fitRecord: record } } as never)).toEqual(record);
	});

	it('is null when the run applied no zone', () => {
		expect(calibrationZonesSection({ summary: {}, inputs: { settings: {} } } as never)).toBeNull();
		expect(calibrationZoneFlags(null)).toEqual([]);
	});
});
