// The report's calibration zones (evidence-22, issue #555): the fit record's
// scores and the errata versions, read from what a run froze.
import { describe, expect, it } from 'vitest';
import { calibrationZoneFitVersions, calibrationZoneFlags, calibrationZonesSection } from './calibrationZones';

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

	it('is null when the run applied no zone', () => {
		expect(calibrationZonesSection({ summary: {}, inputs: { settings: {} } } as never)).toBeNull();
		expect(calibrationZoneFlags(null)).toEqual([]);
	});
});
