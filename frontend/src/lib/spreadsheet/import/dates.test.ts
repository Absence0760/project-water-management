import { afterEach, describe, expect, it } from 'vitest';
import { XlDateTime, XlTime } from './cells';
import { fromExcelSerial, isDateFormat, isTimedeltaFormat } from './dates';

describe('date formats (openpyxl is_date_format)', () => {
	it('spots date and time formats, ignoring quoted text and locale tags', () => {
		for (const f of ['yyyy/mm/dd;@', 'm/d/yy', 'd-mmm-yy', 'h:mm', '[$-409]mmmm d, yyyy', '[h]:mm:ss', 'yyyy-mm-dd']) expect(isDateFormat(f), f).toBe(true);
		for (const f of ['General', '#,##0.000', '0.00%', '"days" 0', '[Red]0.0', '0.0_d', '@', '\\d0']) expect(isDateFormat(f), f).toBe(false);
		expect(isDateFormat(undefined)).toBe(false);
		// Only the first section counts.
		expect(isDateFormat('0.0;yyyy')).toBe(false);
	});

	it('spots duration formats', () => {
		expect(isTimedeltaFormat('[h]:mm:ss')).toBe(true);
		expect(isTimedeltaFormat('[mm]:ss')).toBe(true);
		expect(isTimedeltaFormat('h:mm')).toBe(false);
	});
});

describe('fromExcelSerial (openpyxl from_excel)', () => {
	it('reads serials in the 1900 and 1904 systems', () => {
		expect(fromExcelSerial(40188)).toEqual(new XlDateTime('2010-01-10', 0));
		expect(fromExcelSerial(1)).toEqual(new XlDateTime('1900-01-01', 0));
		// openpyxl shifts serials below 60 by a day (Excel's fictitious 1900-02-29 is 60).
		expect(fromExcelSerial(59)).toEqual(new XlDateTime('1900-02-28', 0));
		expect(fromExcelSerial(61)).toEqual(new XlDateTime('1900-03-01', 0));
		expect(fromExcelSerial(0, true)).toEqual(new XlTime(0));
		expect(fromExcelSerial(38726, true)).toEqual(new XlDateTime('2010-01-10', 0));
	});

	it('keeps the time of day, rounded to the millisecond, carrying into the next day', () => {
		expect(fromExcelSerial(40188.5)).toEqual(new XlDateTime('2010-01-10', 43_200_000));
		expect(fromExcelSerial(40188.99999999999)).toEqual(new XlDateTime('2010-01-11', 0));
		expect(fromExcelSerial(0.25)).toEqual(new XlTime(21_600_000));
	});

	it("marks a serial outside Python's date range as #VALUE!", () => {
		expect(fromExcelSerial(1e9)).toBe('#VALUE!');
		expect(fromExcelSerial(-700_000)).toBe('#VALUE!');
	});

	describe('under a skewed time zone', () => {
		const tz = process.env.TZ;
		afterEach(() => {
			process.env.TZ = tz;
		});
		it('gives the same calendar date east and west of UTC', () => {
			for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Australia/Lord_Howe']) {
				process.env.TZ = zone;
				expect(fromExcelSerial(40188), zone).toEqual(new XlDateTime('2010-01-10', 0));
				expect(fromExcelSerial(40999.75), zone).toEqual(new XlDateTime('2012-03-31', 64_800_000));
			}
		});
	});
});
