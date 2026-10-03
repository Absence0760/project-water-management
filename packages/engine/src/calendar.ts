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
	// Date.parse rolls an impossible day over (2001-02-29 → 1 March, 2001-04-31 → 1 May): refused as not a date
	// (engine ≥ 1.69.0), so a window or period never moves silently.
	if (Number.isNaN(ms) || new Date(ms).getUTCDate() !== Number(iso.slice(8, 10))) throw new RangeError(`not an ISO date: ${iso}`);
	return Math.round(ms / 86_400_000);
}

/** A real calendar date written `YYYY-MM-DD` (not 2001-02-29, not month 13); never throws. */
export function isIsoDate(v: unknown): v is string {
	if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
	const ms = Date.parse(`${v}T00:00:00Z`);
	return !Number.isNaN(ms) && new Date(ms).getUTCDate() === Number(v.slice(8, 10));
}

/** UTC epoch day number → ISO `YYYY-MM-DD`. */
export function fromEpochDay(day: number): string {
	return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

// monthOfEpochDay and waterYearOf run once per day in many of a run's loops
// (hundreds of thousands of calls a run), so an integer day is converted with
// integer arithmetic (H. Hinnant's days-from-civil inverse, the proleptic
// Gregorian calendar Date uses) instead of allocating a Date. Anything else
// (a fraction, NaN, a day outside Date's range) takes the Date path, so the
// answer is always Date's (calendar.test.ts compares them day by day).
const FAST_DAY_LIMIT = 100_000_000; // Date's range: ±8.64e15 ms = ±1e8 days.
const fastDay = (day: number) => Number.isInteger(day) && day >= -FAST_DAY_LIMIT && day <= FAST_DAY_LIMIT;

/** March-based year and month of an integer epoch day: mp 0 = March … 11 = February; yMar = the year that March is in. */
function marchYearMonth(day: number): { yMar: number; mp: number } {
	const z = day + 719_468;
	const era = Math.floor(z / 146_097);
	const doe = z - era * 146_097; // [0, 146096]
	const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365); // [0, 399]
	const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)); // [0, 365]
	return { yMar: yoe + era * 400, mp: Math.floor((5 * doy + 2) / 153) };
}

/** Calendar month 1–12 of an epoch day. */
export function monthOfEpochDay(day: number): number {
	if (!fastDay(day)) return new Date(day * 86_400_000).getUTCMonth() + 1;
	const { mp } = marchYearMonth(day);
	return mp < 10 ? mp + 3 : mp - 9;
}

/** South African water year (Oct–Sep) of an epoch day, labelled by the year it starts in. */
export function waterYearOf(epochDay: number): number {
	if (!fastDay(epochDay)) {
		const year = new Date(epochDay * 86_400_000).getUTCFullYear();
		return new Date(epochDay * 86_400_000).getUTCMonth() + 1 >= 10 ? year : year - 1;
	}
	// October (mp 7) … February (mp 11) belong to the water year starting in yMar; March … September to the one before.
	const { yMar, mp } = marchYearMonth(epochDay);
	return mp >= 7 ? yMar : yMar - 1;
}

/** "2016/17" for water year 2016. */
export const waterYearLabel = (wy: number) => `${wy}/${String((wy + 1) % 100).padStart(2, '0')}`;
