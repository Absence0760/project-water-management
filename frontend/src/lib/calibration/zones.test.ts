// Calibrate at several gauges in Settings & calibration (issue #555, docs/ui.md § Settings & calibration).
import { describe, expect, it } from 'vitest';
import { newCalibrationZone, type CalibrationReport, type CalibrationSite, type ZoneFitStep } from '@water-management/engine';
import { coverageText, stepRows, withZoneFields, withZoneTicked, zoneCoverage, zoneParamsText, zoneRows, zonesError } from './zones';

const weir: CalibrationSite = { nodeId: 'H', name: 'Weir', records: ['flow_observed_m3s', 'flow_logger_m3s'] };
const low: CalibrationSite = { nodeId: 'L', name: 'Low weir', records: ['flow_logger_m3s'] };

describe('the gauges table', () => {
	it('lists every gauge with a record but the calibration site, each with its stored row', () => {
		const zones = [{ ...newCalibrationZone('H'), enabled: true }];
		expect(zoneRows([weir, low], zones, null)).toEqual([
			{ site: weir, zone: zones[0] },
			{ site: low, zone: null }
		]);
		expect(zoneRows([weir, low], undefined, 'H')).toEqual([{ site: low, zone: null }]);
	});

	it('a first tick adds the row; an untick keeps its settings; a field edit makes an unticked row', () => {
		const on = withZoneTicked(undefined, 'H', true);
		expect(on).toEqual([{ ...newCalibrationZone('H'), enabled: true }]);
		const dated = withZoneFields(on, 'H', { calibrationStart: '2001-10-01' });
		const off = withZoneTicked(dated, 'H', false);
		expect(off).toEqual([{ ...newCalibrationZone('H'), calibrationStart: '2001-10-01' }]);
		expect(withZoneTicked(undefined, 'H', false)).toEqual([]);
		expect(withZoneFields([], 'L', { calibrationFlowKind: 'flow_logger_m3s' })).toEqual([{ ...newCalibrationZone('L'), calibrationFlowKind: 'flow_logger_m3s' }]);
		// The input is never changed in place.
		expect(on[0]!.calibrationStart).toBeNull();
	});

	it('names the first row whose window can’t be saved', () => {
		const zones = [newCalibrationZone('L'), { ...newCalibrationZone('H'), calibrationStart: '2005-10-01', calibrationEnd: '2001-09-30' }];
		expect(zonesError(zones, (id) => (id === 'H' ? 'Weir' : 'x'))).toBe('Calibration zone at Weir: Calibration start must be before the end.');
		expect(zonesError([newCalibrationZone('H')], () => 'Weir')).toBeNull();
		expect(zonesError(undefined, () => '')).toBeNull();
	});

	it('coverage: complete water years spanned by the record the row fits', () => {
		const series = [
			{ kind: 'flow_observed_m3s', siteNodeId: 'H', startDate: '2021-05-01', length: 900, lastValueDate: '2023-09-30' },
			{ kind: 'flow_logger_m3s', siteNodeId: 'H', startDate: '2015-10-01', length: 3653, lastValueDate: null }
		];
		expect(zoneCoverage(series, weir, null)).toBe(2);
		expect(zoneCoverage(series, weir, 'flow_logger_m3s')).toBe(10);
		expect(zoneCoverage(series, low, null)).toBeNull();
		expect(zoneCoverage(null, weir, null)).toBeNull();
		expect([coverageText(1), coverageText(2), coverageText(null)]).toEqual(['1 water year (too short)', '2 water years', '–']);
	});

	it('shows a zone’s parameters, or that it has none yet', () => {
		expect(zoneParamsText({ x1: 900, x2: 0, x3: 220.4, x4: 3.14 })).toBe('X1 900 · X2 0.00 · X3 220 · X4 3.14');
		expect(zoneParamsText(null)).toMatch(/Not fitted yet/);
	});
});

describe('the stepwise fit’s steps', () => {
	it('one row per step, upstream first, with its scores on the fit’s objective', () => {
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
			{ zoneNodeId: 'H', name: 'Weir', units: ['A'], report: rep(900, 0.91, 0.8) },
			{ zoneNodeId: null, name: 'Outlet', units: ['B', 'C'], report: rep(220, 0.85, null) }
		];
		expect(stepRows(steps)).toEqual([
			{ key: 'H', step: 1, name: 'Weir', what: 'Upstream zone', units: 1, params: 'X1 900 · X2 0.00 · X3 90.0 · X4 1.70', fit: 0.91, split: 0.8, dsst: null, notes: ['note 900'] },
			{ key: 'site', step: 2, name: 'Outlet', what: 'Calibration site', units: 2, params: 'X1 220 · X2 0.00 · X3 90.0 · X4 1.70', fit: 0.85, split: null, dsst: null, notes: ['note 220'] }
		]);
	});
});
