// Calibration locations in a run, the report and an evidence pack (issue #555 round 4; issue #659): one row per
// group, the headline first, each scored at its own location and labelled in or out of sample by its own fit, with
// the units that borrow its parameters or came by the rest rule named.
import { describe, expect, it } from 'vitest';
import { evidenceZoneRows, runZoneRows } from './zoneStats';

const params = { x1: 900, x2: 0, x3: 220, x4: 3.1 };
/** A run from before engine 1.110.0: the site's own zone (nodeId null, no kind) last. */
const legacy = {
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
	it('gives each location its parameters and its own scores, the headline (a legacy run’s site) first', () => {
		expect(runZoneRows(legacy)).toEqual([
			{ key: 'site', name: 'Outlet', what: 'Headline · gauge', units: 1, sources: '', params: 'X1 220 · X2 −0.50 · X3 50.0 · X4 1.30', scored: true, days: 1000, nse: '0.71', kge: '0.80', pbias: '−4.3', sample: 'in-sample' },
			{ key: 'H', name: 'Weir', what: 'Gauge', units: 1, sources: '', params: 'X1 900 · X2 0.00 · X3 220 · X4 3.10', scored: true, days: 365, nse: '0.50', kge: '0.60', pbias: '12.3', sample: 'fitted on other days' },
			{ key: 'K', name: 'Kloof', what: 'Gauge', units: 2, sources: '', params: 'X1 350 · X2 0.00 · X3 90.0 · X4 1.70 (the catchment’s: not fitted yet)', scored: true, days: 0, nse: '–', kge: '–', pbias: '–', sample: null }
		]);
	});

	it('reads engine 1.110.0’s groups: a headline gauge, the outlet scored as another location, borrowed and rest units named, the catchment-parameter units last', () => {
		const rows = runZoneRows({
			unitRain: {
				units: [
					{ nodeId: 'A', name: 'Upper' },
					{ nodeId: 'B', name: 'Lower' },
					{ nodeId: 'C', name: 'Across' },
					{ nodeId: 'D', name: 'Dry' },
					{ nodeId: 'E', name: 'Below' }
				],
				zones: [
					{ nodeId: null, name: 'Outlet', units: ['B'], params, fitted: true, kind: 'outlet', borrowed: [], rest: [] },
					{ nodeId: 'H', name: 'Weir', units: ['A', 'C', 'E'], params, fitted: true, kind: 'gauge', headline: true, borrowed: ['C'], rest: ['E'] },
					{ nodeId: null, name: 'Catchment parameters', units: ['D'], params, fitted: true, kind: 'default' }
				],
				paramSource: { A: { from: 'H', how: 'zone' }, B: { from: null, how: 'zone' }, C: { from: 'H', how: 'assigned' }, D: { from: null, how: 'default' }, E: { from: 'H', how: 'rest' } }
			},
			calibration: { days: 400, nse: 0.6, kge: 0.7, pbias: 2, fitStatus: 'fitted', siteNodeId: 'H', siteName: 'Weir' },
			calibrationZones: [{ siteNodeId: 'G', siteName: 'Outlet', days: 300, nse: 0.4, kge: 0.5, pbias: 1, fitStatus: 'notFitted' }]
		} as never);
		expect(rows.map((r) => [r.key, r.what, r.sources, r.days, r.scored, r.sample])).toEqual([
			['H', 'Headline · gauge', 'Borrowed: Across · Outside every location: Below', 400, true, 'in-sample'],
			['outlet', 'Outlet', '', 300, true, 'parameters not from an automatic fit'],
			['default', 'No location', '', 0, false, null]
		]);
		expect(rows[2]!.params).toBe('X1 900 · X2 0.00 · X3 220 · X4 3.10 (the catchment’s)');
	});

	it('is empty for a run without zones', () => {
		expect(runZoneRows({ calibration: null } as never)).toEqual([]);
	});
});

describe('evidenceZoneRows', () => {
	it('adds each location’s period, fit and its validation scores, or says it has none', () => {
		const rows = evidenceZoneRows([
			{
				nodeId: 'H',
				name: 'Weir',
				units: 2,
				areaKm2: 40,
				params,
				fitted: true,
				fit: { description: 'GR4J fit of 2026-10-28 10:05 UTC (KGE′, seed 4)', engineVersion: '1.106.0', objective: 'kgePrime', inSample: 0.81, splitSample: 0.62, dryToWet: null, editedParams: ['x3'] },
				stats: { days: 365, nse: 0.5, kge: 0.6, pbias: 1, fitStatus: 'edited' },
				kind: 'gauge',
				window: { start: '2010-10-01', end: null },
				members: [
					{ nodeId: 'C', name: 'Across', how: 'assigned' },
					{ nodeId: 'A', name: 'Upper', how: 'zone' }
				]
			},
			{ nodeId: null, name: 'Outlet', units: 1, areaKm2: 60, params, fitted: true, fit: null, stats: null, kind: 'outlet', headline: true, window: { start: null, end: null } }
		]);
		expect(rows.map((r) => [r.key, r.what, r.period, r.sources])).toEqual([
			['outlet', 'Headline · outlet', 'start of record – end of record', ''],
			['H', 'Gauge', '2010-10-01 – end of record', 'Own zone: Upper · Borrowed: Across']
		]);
		expect(rows[1]!.fit).toEqual({ description: 'GR4J fit of 2026-10-28 10:05 UTC (KGE′, seed 4), edited since (x3)', inSample: '0.81', splitSample: '0.62', dryToWet: 'not run' });
		expect(rows[1]!.sample).toBe('parameters edited since the fit');
		expect(rows[0]).toMatchObject({ days: 0, sample: null, fit: null });
		// A pack before evidence-25 has no periods: the column isn't shown.
		expect(evidenceZoneRows([{ nodeId: 'H', name: 'Weir', units: 1, areaKm2: 1, params, fitted: true, fit: null, stats: null }])[0]!.period).toBeUndefined();
		expect(evidenceZoneRows(null)).toEqual([]);
	});
});
