// A demand object's daily schedule (engine ≥ 1.16.0, issue #90 Q4 and Q12,
// docs/model.md §2.7f): recurring date windows, each with a factor on the
// object's demand for the days it covers (0 = off). Set by date only (the
// client's answer to Q12), never by river flow. A window covers every day,
// a calendar span each year ('MM-DD' to 'MM-DD', wrapping the year end), a
// one-off date range, or days around Easter (Good Friday is −2, Family Day
// +1), optionally on some weekdays only. Where windows overlap, the later
// one in the list sets the day's factor; a day no window covers runs at 1.
// Pure; the simulation (./demandObjects.ts planObjects) and the self-checks
// (../verify/checks.ts) both read a schedule through scheduleFactors, so a
// stored window means the same thing to each.
import type { DemandScheduleWindow } from '../project';

/** At most this many windows per object (the backend refuses more). */
export const DEMAND_SCHEDULE_MAX_WINDOWS = 24;
/** A window's factor lies in [0, this]: 0 is off, above 1 a peak. */
export const DEMAND_SCHEDULE_MAX_FACTOR = 10;
/** Easter offsets lie in [−this, this] days (Ash Wednesday is −46, Pentecost +49). */
export const DEMAND_SCHEDULE_MAX_EASTER_OFFSET = 60;

const MONTH_DAY = /^(\d{2})-(\d{2})$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** 'MM-DD' → month × 100 + day (Feb 29 allowed), or null. */
function monthDayOrdinal(s: unknown): number | null {
	if (typeof s !== 'string') return null;
	const m = MONTH_DAY.exec(s);
	if (!m) return null;
	const mo = Number(m[1]);
	const d = Number(m[2]);
	if (mo < 1 || mo > 12 || d < 1 || d > DAYS_IN_MONTH[mo - 1]!) return null;
	return mo * 100 + d;
}

/** 'YYYY-MM-DD' (a real calendar date) → epoch day, or null. */
function isoEpochDay(s: unknown): number | null {
	if (typeof s !== 'string' || !ISO_DATE.test(s)) return null;
	const ms = Date.parse(`${s}T00:00:00Z`);
	if (Number.isNaN(ms)) return null;
	const day = Math.round(ms / 86_400_000);
	// Date.parse rolls 2021-02-30 over to March; refuse it.
	return new Date(ms).toISOString().slice(0, 10) === s ? day : null;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/**
 * What is wrong with a window, in words, or null when it runs as entered.
 * The backend refuses a model with one (modelRuleProblems); the run skips
 * such a window with a warning.
 */
export function scheduleWindowProblem(w: DemandScheduleWindow): string | null {
	if (!(typeof w.factor === 'number' && Number.isFinite(w.factor) && w.factor >= 0 && w.factor <= DEMAND_SCHEDULE_MAX_FACTOR))
		return `its factor ${String(w.factor)} is not a number from 0 to ${DEMAND_SCHEDULE_MAX_FACTOR}`;
	if (w.weekdays !== null && w.weekdays !== undefined) {
		if (!Array.isArray(w.weekdays) || w.weekdays.length === 0 || w.weekdays.some((d) => !isInt(d) || d < 1 || d > 7)) return 'its weekdays must be 1 (Monday) to 7 (Sunday), at least one';
	}
	switch (w.span) {
		case 'always':
			return null;
		case 'yearly':
			if (monthDayOrdinal(w.from) === null || monthDayOrdinal(w.to) === null) return `a yearly span needs its first and last day as MM-DD (got ${String(w.from)} to ${String(w.to)})`;
			return null;
		case 'range': {
			const a = isoEpochDay(w.from);
			const b = isoEpochDay(w.to);
			if (a === null || b === null) return `a date range needs its first and last day as YYYY-MM-DD (got ${String(w.from)} to ${String(w.to)})`;
			if (b < a) return `its date range ends (${w.to}) before it starts (${w.from})`;
			return null;
		}
		case 'easter': {
			const lim = DEMAND_SCHEDULE_MAX_EASTER_OFFSET;
			if (!isInt(w.easterFrom) || !isInt(w.easterTo) || Math.abs(w.easterFrom) > lim || Math.abs(w.easterTo) > lim)
				return `an Easter span needs whole days from Easter Sunday, −${lim} to ${lim} (got ${String(w.easterFrom)} to ${String(w.easterTo)})`;
			if (w.easterTo < w.easterFrom) return `its Easter span ends (${w.easterTo}) before it starts (${w.easterFrom})`;
			return null;
		}
		default:
			return `unknown span "${String((w as { span: unknown }).span)}"`;
	}
}

/** Easter Sunday of a Gregorian year as an epoch day (the anonymous Gregorian computus, Meeus/Jones/Butcher). */
export function easterSunday(year: number): number {
	const a = year % 19;
	const b = Math.floor(year / 100);
	const c = year % 100;
	const d = Math.floor(b / 4);
	const e = b % 4;
	const f = Math.floor((b + 8) / 25);
	const g = Math.floor((b - f + 1) / 3);
	const h = (19 * a + b - d - g + 15) % 30;
	const i = Math.floor(c / 4);
	const k = c % 4;
	const l = (32 + 2 * e + 2 * i - h - k) % 7;
	const m = Math.floor((a + 11 * h + 22 * l) / 451);
	const month = Math.floor((h + l - 7 * m + 114) / 31);
	const day = ((h + l - 7 * m + 114) % 31) + 1;
	return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
}

/** ISO weekday (1 = Monday … 7 = Sunday) of an epoch day; 1970-01-01 was a Thursday. */
export function isoWeekday(epochDay: number): number {
	return ((((epochDay + 3) % 7) + 7) % 7) + 1;
}

/**
 * The schedule's factor on each run day (`day0` = the run's first epoch
 * day): the last window covering the day sets it, 1 where none does. Null
 * without a window that runs (no schedule, an empty one, or only windows
 * with a problem, each skipped with a warning naming `who`), so an object
 * without a schedule costs nothing.
 */
export function scheduleFactors(schedule: readonly DemandScheduleWindow[] | null | undefined, day0: number, days: number, warnings: string[], who: string): Float64Array | null {
	if (!Array.isArray(schedule) || schedule.length === 0) return null;
	const usable: DemandScheduleWindow[] = [];
	schedule.forEach((w, i) => {
		const bad = scheduleWindowProblem(w);
		if (bad) warnings.push(`${who}: schedule window ${i + 1}${w.label ? ` ("${w.label}")` : ''} is skipped: ${bad}`);
		else usable.push(w);
	});
	if (schedule.length > DEMAND_SCHEDULE_MAX_WINDOWS) warnings.push(`${who}: its schedule has ${schedule.length} windows, more than ${DEMAND_SCHEDULE_MAX_WINDOWS}; all of them run`);
	if (!usable.length) return null;
	const out = new Float64Array(days).fill(1);
	const easterOf = new Map<number, number>();
	for (let t = 0; t < days; t++) {
		const day = day0 + t;
		const date = new Date(day * 86_400_000);
		const year = date.getUTCFullYear();
		const md = (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
		const wd = isoWeekday(day);
		for (const w of usable) {
			if (w.weekdays && !w.weekdays.includes(wd)) continue;
			let hit: boolean;
			switch (w.span) {
				case 'always':
					hit = true;
					break;
				case 'yearly': {
					const a = monthDayOrdinal(w.from)!;
					const b = monthDayOrdinal(w.to)!;
					hit = a <= b ? md >= a && md <= b : md >= a || md <= b;
					break;
				}
				case 'range':
					hit = day >= isoEpochDay(w.from)! && day <= isoEpochDay(w.to)!;
					break;
				case 'easter': {
					// Offsets reach at most 60 days, so only this year's Easter can cover the day.
					let e = easterOf.get(year);
					if (e === undefined) easterOf.set(year, (e = easterSunday(year)));
					hit = day >= e + w.easterFrom! && day <= e + w.easterTo!;
					break;
				}
				default:
					hit = false;
			}
			if (hit) out[t] = w.factor;
		}
	}
	return out;
}
