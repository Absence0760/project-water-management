import { describe, expect, it } from 'vitest';
import { extractCalibration, extractCalibrationWindow, summerMonthsNote } from './calibration';
import { InvalidWorkbookError } from './errors';
import { syntheticB023 } from './testWorkbook';
import { B023Workbook } from './workbook';

const wbOf = (b = syntheticB023()) => new B023Workbook(b.build());

describe('extractCalibration', () => {
	it('reads every parameter from its named range, keys in the Python order', () => {
		const c = extractCalibration(wbOf());
		expect(Object.keys(c)).toEqual([
			'a',
			'b',
			'rainThresholdMm',
			'summerFactor',
			'winterFactor',
			'summerMonths',
			'baseFlowInitial',
			'catchmentAreaKm2',
			'baseResetRatio',
			'winterTodayRainMm',
			'winterNextDayRainMm',
			'shiftPeakIndexLo',
			'shiftPeakIndexHi',
			'amplitudeM3Day',
			'recessionDaysMax',
			'recessionFactors',
			'recessionCurveM3Day'
		]);
		expect(c).toMatchObject({ a: 0.09, b: 1.2, summerMonths: [1, 2, 3, 10, 11, 12], baseFlowInitial: 250, catchmentAreaKm2: 12, recessionDaysMax: 5 });
		expect(c.recessionFactors).toEqual([0.9, 0.92, 0.94, 0.96, 0.98]);
		expect(c.recessionCurveM3Day).toEqual([5000, 4000, 3000, 2000, 1000]);
	});

	it('reads blanks as 0 but stops on text that is not a number (the Python raises)', () => {
		expect(extractCalibration(wbOf(syntheticB023().set('Flow Calibration Cfg', 'D20', null))).a).toBe(0);
		expect(() => extractCalibration(wbOf(syntheticB023().set('Flow Calibration Cfg', 'D20', 'n/a')))).toThrow(
			"[Flow Calibration Cfg] rCalibration_PeakCoef_a: expected a number, got 'n/a'"
		);
	});

	it("stops a table at the sheet's last row, as openpyxl's read-only rows do", () => {
		// The recession table's range runs past the sheet's used range: the Python gets the rows that exist.
		const b = syntheticB023().name('rCalibration_RecessionFactors', "'Flow Calibration Cfg'!$F$20:$F$60");
		const factors = extractCalibration(wbOf(b)).recessionFactors;
		const lastRow = wbOf(b).lastRow('Flow Calibration Cfg');
		expect(factors.length).toBe(lastRow - 19);
		expect(factors.slice(0, 5)).toEqual([0.9, 0.92, 0.94, 0.96, 0.98]);
	});
});

describe('summerMonthsNote', () => {
	it('notes the months the substring match adds', () => {
		expect(summerMonthsNote(wbOf())).toBeNull();
		const note = summerMonthsNote(wbOf(syntheticB023().set('Flow Calibration Cfg', 'D32', '10,11,12,3,')));
		expect(note?.message).toBe("summer months '10,11,12,3,': the workbook's substring match also makes months [1, 2] summer; the app uses the listed months only (audit M1)");
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
