// Calendar helpers shared by every part of the model.
//
// The WBT works in *water years* (October–September), and every monthly table
// (crop factors, A-pan evaporation, farm demand, pragmatic EWR) is stored in
// that order: index 0 = October … index 11 = September.

export type Monthly = readonly [
	number, number, number, number, number, number,
	number, number, number, number, number, number
];

/** Water-year month index (0 = Oct … 11 = Sep) for a calendar month 1–12. */
export function waterYearIndex(calendarMonth: number): number {
	if (!Number.isInteger(calendarMonth) || calendarMonth < 1 || calendarMonth > 12) {
		throw new RangeError(`calendar month must be 1–12, got ${calendarMonth}`);
	}
	// Equivalent of the workbook's MOD(m+2,12)+1, zero-based.
	return (calendarMonth + 2) % 12;
}

/**
 * Days used to turn a monthly volume into m³/day, in water-year order.
 * The workbook uses 28.25 for February (AppSettings `zAppSet_MonthDays`) so a
 * month-average stays stable across leap and non-leap years.
 */
export function daysPerMonth(februaryDays = 28.25): Monthly {
	return [31, 30, 31, 31, februaryDays, 31, 30, 31, 30, 31, 31, 30];
}

/** ISO `YYYY-MM-DD` → UTC epoch day number (days since 1970-01-01). */
export function toEpochDay(iso: string): number {
	const ms = Date.parse(`${iso}T00:00:00Z`);
	if (Number.isNaN(ms)) throw new RangeError(`not an ISO date: ${iso}`);
	return Math.round(ms / 86_400_000);
}

/** UTC epoch day number → ISO `YYYY-MM-DD`. */
export function fromEpochDay(day: number): string {
	return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/** Calendar month 1–12 of an epoch day. */
export function monthOfEpochDay(day: number): number {
	return new Date(day * 86_400_000).getUTCMonth() + 1;
}

/** South African water year (Oct–Sep) of an epoch day, labelled by the year it starts in. */
export function waterYearOf(epochDay: number): number {
	const year = new Date(epochDay * 86_400_000).getUTCFullYear();
	return monthOfEpochDay(epochDay) >= 10 ? year : year - 1;
}

/** "2016/17" for water year 2016. */
export const waterYearLabel = (wy: number) => `${wy}/${String((wy + 1) % 100).padStart(2, '0')}`;
