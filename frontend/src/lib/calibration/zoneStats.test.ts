// Calibration zones in a run, the report and an evidence pack (issue #555 round 4): one row per zone, each scored at
// its own gauge and labelled in or out of sample by its own fit.
import { describe, expect, it } from 'vitest';
import { evidenceZoneRows, runZoneRows } from './zoneStats';

const params = { x1: 900, x2: 0, x3: 220, x4: 3.1 };
const summary = {
	unitRain: {
		zones: [
			{ nodeId: 'H', name: 'Weir', units: ['A'], params, fitted: true },
			{ nodeId: 'K', name: 'Kloof', units: ['C', 'D'], params: { x1: 350, x2: 0, x3: 90, x4: 1.7 }, fitted: false },
			{ nodeId: null, name: 'Outlet', units: ['B'], params: { x1: 220, x2: -0.5, x3: 50, x4: 1.3 }, fitted: true }
		]
	},
	calibration: { days: 1000, nse: 0.71, kge: 0.8, pbias: -4.25, fitStatus: 'fitted' },
	calibrationZones: [
		{ siteNodeId: 'H', siteName: 'Weir', days: 365, nse: 0.5, kge: 0.6, pbias: 12.34, fitStatus: 'otherPeriod' },
		{ siteNodeId: 'K', siteName: 'Kloof', days: 0, nse: NaN, kge: NaN, pbias: NaN, fitStatus: 'notFitted' }
	]
} as never;

describe('runZoneRows', () => {
	it('gives each zone its parameters and its own gauge’s scores, upstream first, the site last', () => {
		expect(runZoneRows(summary)).toEqual([
			{ key: 'H', name: 'Weir', what: 'Upstream zone', units: 1, params: 'X1 900 · X2 0.00 · X3 220 · X4 3.10', days: 365, nse: '0.50', kge: '0.60', pbias: '12.3', sample: 'fitted on other days' },
			{ key: 'K', name: 'Kloof', what: 'Upstream zone', units: 2, params: 'X1 350 · X2 0.00 · X3 90.0 · X4 1.70 (the catchment’s: not fitted yet)', days: 0, nse: '–', kge: '–', pbias: '–', sample: null },
			{ key: 'site', name: 'Outlet', what: 'Calibration site', units: 1, params: 'X1 220 · X2 −0.50 · X3 50.0 · X4 1.30', days: 1000, nse: '0.71', kge: '0.80', pbias: '−4.3', sample: 'in-sample' }
		]);
	});

	it('is empty for a run without zones', () => {
		expect(runZoneRows({ calibration: null } as never)).toEqual([]);
	});
});

describe('evidenceZoneRows', () => {
	it('adds each zone’s fit and its validation scores, or says it has none', () => {
		const rows = evidenceZoneRows([
			{
				nodeId: 'H',
				name: 'Weir',
				units: 1,
				areaKm2: 40,
				params,
				fitted: true,
				fit: { description: 'GR4J fit of 2026-10-28 10:05 UTC (KGE′, seed 4)', engineVersion: '1.106.0', objective: 'kgePrime', inSample: 0.81, splitSample: 0.62, dryToWet: null, editedParams: ['x3'] },
				stats: { days: 365, nse: 0.5, kge: 0.6, pbias: 1, fitStatus: 'edited' }
			},
			{ nodeId: null, name: 'Outlet', units: 1, areaKm2: 60, params, fitted: true, fit: null, stats: null }
		]);
		expect(rows[0]!.fit).toEqual({ description: 'GR4J fit of 2026-10-28 10:05 UTC (KGE′, seed 4), edited since (x3)', inSample: '0.81', splitSample: '0.62', dryToWet: 'not run' });
		expect(rows[0]!.sample).toBe('parameters edited since the fit');
		expect(rows[1]).toMatchObject({ key: 'site', what: 'Calibration site', days: 0, sample: null, fit: null });
		expect(evidenceZoneRows(null)).toEqual([]);
	});
});
