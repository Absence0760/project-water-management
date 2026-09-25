// Excel serial numbers → dates, the way openpyxl reads them.
//
// openpyxl turns a number into a datetime when its cell's number format is a
// date format (openpyxl.styles.numbers.is_date_format), into a timedelta for
// a duration format ([h]:mm), and into a time of day for a date-formatted
// value in [0, 1). The arithmetic here is on whole days and milliseconds only,
// never on local-time Date objects, so the result doesn't depend on the time
// zone of the browser that runs the import (tested under a skewed TZ).
import { fromEpochDay } from '@water-management/engine';
import { XlDateTime, XlDuration, XlTime } from './cells';

// openpyxl LITERAL_GROUP | LOCALE_GROUP: quoted text, and [...] other than [h] [m] [s].
const STRIP_RE = /".*?"|\[(?!hh?\]|mm?\]|ss?\])[^\]]*\]/g;
const DATE_RE = /(?<![_\\])[dmhysDMHYS]/;
const TIMEDELTA_RE = /\[hh?\](:mm(:ss(\.0*)?)?)?|\[mm?\](:ss(\.0*)?)?|\[ss?\](\.0*)?/i;

/** openpyxl is_date_format(): the first section of the format, literals and locale tags removed, has a date/time letter. */
export function isDateFormat(fmt: string | undefined): boolean {
	if (fmt === undefined) return false;
	return DATE_RE.test(fmt.split(';')[0]!.replace(STRIP_RE, ''));
}

/** openpyxl is_timedelta_format(). */
export function isTimedeltaFormat(fmt: string | undefined): boolean {
	if (fmt === undefined) return false;
	return TIMEDELTA_RE.test(fmt.split(';')[0]!);
}

/** Epoch day (days since 1970-01-01) of 1899-12-30 and 1904-01-01, the two Excel epochs. */
const WINDOWS_EPOCH_DAY = -25569;
const MAC_EPOCH_DAY = -24107;
/** Python datetime's range, 0001-01-01 … 9999-12-31, as epoch days. */
const MIN_EPOCH_DAY = -719162;
const MAX_EPOCH_DAY = 2932896;

/** Python round(): half to even. */
function roundHalfEven(x: number): number {
	const r = Math.round(x);
	return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/**
 * openpyxl from_excel(): a date-formatted serial as a datetime, or a time of
 * day for 0 ≤ value < 1. The fraction is rounded to the millisecond (half to
 * even), which can carry into the next day. Serials 1–59 are shifted a day,
 * as openpyxl does for Excel's fictitious 1900-02-29. Out of Python's date
 * range, openpyxl marks the cell as the error '#VALUE!'.
 */
export function fromExcelSerial(value: number, date1904 = false): XlDateTime | XlTime | string {
	let day = Math.floor(value);
	// Python: round(fraction * SECS_PER_DAY * 1000), evaluated left to right.
	const fractionMs = roundHalfEven(((value - day) * 86_400) * 1000);
	if (value >= 0 && value < 1 && fractionMs < 86_400_000) return new XlTime(fractionMs);
	if (!date1904 && value > 0 && value < 60) day += 1;
	const totalMs = day * 86_400_000 + fractionMs;
	const days = Math.floor(totalMs / 86_400_000);
	const epochDay = (date1904 ? MAC_EPOCH_DAY : WINDOWS_EPOCH_DAY) + days;
	if (!Number.isFinite(epochDay) || epochDay < MIN_EPOCH_DAY || epochDay > MAX_EPOCH_DAY) return '#VALUE!';
	return new XlDateTime(fromEpochDay(epochDay), totalMs - days * 86_400_000);
}

/** openpyxl from_excel(timedelta=True): the value as a duration (days). */
export function durationFromExcel(value: number): XlDuration {
	return new XlDuration(value);
}
