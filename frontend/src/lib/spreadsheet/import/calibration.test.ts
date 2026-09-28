import { describe, expect, it } from 'vitest';
import { extractCalibration, extractCalibrationWindow } from './calibration';
import { InvalidWorkbookError } from './errors';
import { syntheticB023 } from './testWorkbook';
import { B023Workbook } from './workbook';

const wbOf = (b = syntheticB023()) => new B023Workbook(b.build());

describe('extractCalibration', () => {
	it('reads the rain threshold and catchment area from their named ranges, keys in the Python order', () => {
		const c = extractCalibration(wbOf());
		expect(Object.keys(c)).toEqual(['rainThresholdMm', 'catchmentAreaKm2']);
		expect(c).toEqual({ rainThresholdMm: 2, catchmentAreaKm2: 12 });
	});

	it('reads blanks as 0 but stops on text that is not a number (the Python raises)', () => {
		// D22 is the rain threshold in the test workbook.
		const at = (v: string | null) => extractCalibration(wbOf(syntheticB023().set('Flow Calibration Cfg', 'D22', v)));
		expect(at(null).rainThresholdMm).toBe(0);
		expect(() => at('n/a')).toThrow("[Flow Calibration Cfg] rCalibration_RainThreshold: expected a number, got 'n/a'");
	});

	it('no longer reads the legacy runoff model’s cells (engine 1.0.0): text in one does not stop the import', () => {
		// D20 is the legacy peak-flow coefficient a in the test workbook.
		expect(extractCalibration(wbOf(syntheticB023().set('Flow Calibration Cfg', 'D20', 'n/a')))).toEqual({ rainThresholdMm: 2, catchmentAreaKm2: 12 });
	});
});

describe('extractCalibrationWindow', () => {
	it('reads the window and the flow record', () => {
		expect(extractCalibrationWindow(wbOf())).toEqual({ calibrationStart: '2010-01-01', calibrationEnd: '2010-01-05', calibrationFlowKind: 'flow_observed_m3s' });
	});

	it('maps rUseFlow 1/2/3 (a float or TRUE too) and reads anything else as unset', () => {
		const kind = (v: number | string | boolean | null) => extractCalibrationWindow(wbOf(syntheticB023().set('Flow data', 'P13', v))).calibrationFlowKind;
		expect([kind(1), kind(2), kind(3), kind(3.7), kind(true), kind(4), kind('2'), kind(null)]).toEqual([
			'flow_pitman_m3s',
			'flow_observed_m3s',
			'flow_logger_m3s',
			'flow_logger_m3s',
			'flow_pitman_m3s',
			null,
			null,
			null
		]);
	});

	it('drops a reversed window, a non-date and missing names without failing', () => {
		const reversed = syntheticB023().set('Flow Calibration Cfg', 'D11', { date: '2011-01-01' });
		expect(extractCalibrationWindow(wbOf(reversed))).toMatchObject({ calibrationStart: null, calibrationEnd: null });
		const text = syntheticB023().set('Flow Calibration Cfg', 'D11', 'start');
		expect(extractCalibrationWindow(wbOf(text)).calibrationStart).toBeNull();
		const missing = syntheticB023().unname('zCalibration_Date1').unname('rUseFlow').name('zCalibration_DateN', 'Nowhere!$A$1');
		expect(extractCalibrationWindow(wbOf(missing))).toEqual({ calibrationStart: null, calibrationEnd: null, calibrationFlowKind: null });
	});

	it('still stops on a range below the end of its sheet (the Python IndexError)', () => {
		const off = syntheticB023().name('rUseFlow', "'Flow data'!$P$9000");
		expect(() => extractCalibrationWindow(wbOf(off))).toThrow(InvalidWorkbookError);
	});
});
