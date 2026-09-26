// When a report schedule fires (report_schedule, 023_reports.sql). Pure: no
// database, no clock but the `now` passed in, and no dependence on the
// process's time zone. A schedule's hour is in its OWN zone (the IANA name
// on the row), so "Monday 07:00 Africa/Johannesburg" is the same instant on a
// server in UTC, in Kiritimati, or on a laptop in Honolulu.
//
//   latestFireAt  the most recent scheduled instant at or before `now`
//   nextFireAt    the first scheduled instant after `now`
//   dueFireAt     the instant to queue now, or null: the latest one, if it
//                 is after the schedule was saved (anchorAt) and after the
//                 last one queued (lastFiredFor)
//
// A time the worker missed (it was down for a day) is still queued once, late;
// older missed times are not replayed: the report is of the latest run anyway.

export interface ScheduleTiming {
	frequency: 'weekly' | 'monthly';
	/** ISO weekday, 1 = Monday … 7 = Sunday (weekly). */
	weekday: number | null;
	/** 1–28 (monthly). */
	monthDay: number | null;
	/** 0–23, in `timezone`. */
	hour: number;
	/** IANA time zone. */
	timezone: string;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
	let f = formatters.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat('en-US', {
			timeZone: tz,
			hourCycle: 'h23',
			year: 'numeric',
			month: 'numeric',
			day: 'numeric',
			hour: 'numeric',
			minute: 'numeric',
			second: 'numeric',
			weekday: 'short'
		});
		formatters.set(tz, f);
	}
	return f;
}

/** Whether `tz` is an IANA zone this runtime knows. */
export function isValidTimeZone(tz: string): boolean {
	if (!tz || tz.length > 64) return false;
	try {
		formatter(tz);
		return true;
	} catch {
		return false;
	}
}

interface Wall {
	y: number;
	m: number;
	d: number;
	h: number;
	mi: number;
	s: number;
	weekday: number;
}

/** The wall clock in `tz` at an instant. */
function wallClock(ms: number, tz: string): Wall {
	const parts = Object.fromEntries(formatter(tz).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
	return {
		y: Number(parts.year),
		m: Number(parts.month),
		d: Number(parts.day),
		h: Number(parts.hour),
		mi: Number(parts.minute),
		s: Number(parts.second),
		weekday: WEEKDAYS[parts.weekday!]!
	};
}

/** The zone's offset from UTC at an instant, in ms. */
function offsetAt(ms: number, tz: string): number {
	const w = wallClock(ms, tz);
	return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant a wall-clock time in `tz` happens. Months and days overflow as
 * Date.UTC does (day 0 = the previous month's last). A time skipped by a DST
 * change lands just after the gap.
 */
export function zonedTimeToUtc(y: number, m: number, d: number, h: number, tz: string): number {
	const guess = Date.UTC(y, m - 1, d, h);
	const first = guess - offsetAt(guess, tz);
	const second = guess - offsetAt(first, tz);
	return second;
}

/** A calendar date `days` after y-m-d, as y, m, d. */
function addDays(y: number, m: number, d: number, days: number): [number, number, number] {
	const t = new Date(Date.UTC(y, m - 1, d + days));
	return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}

/** The scheduled instant in the period `k` periods after the one holding `now`'s wall-clock date. */
function fireInPeriod(t: ScheduleTiming, now: Wall, k: number): number {
	if (t.frequency === 'weekly') {
		const back = (now.weekday - (t.weekday ?? 1) + 7) % 7;
		const [y, m, d] = addDays(now.y, now.m, now.d, -back + 7 * k);
		return zonedTimeToUtc(y, m, d, t.hour, t.timezone);
	}
	return zonedTimeToUtc(now.y, now.m + k, t.monthDay ?? 1, t.hour, t.timezone);
}

/** The most recent scheduled instant at or before `now`. */
export function latestFireAt(t: ScheduleTiming, now: Date): Date {
	const ms = now.getTime();
	const wall = wallClock(ms, t.timezone);
	const here = fireInPeriod(t, wall, 0);
	return new Date(here <= ms ? here : fireInPeriod(t, wall, -1));
}

/** The first scheduled instant after `now`. */
export function nextFireAt(t: ScheduleTiming, now: Date): Date {
	const ms = now.getTime();
	const wall = wallClock(ms, t.timezone);
	const here = fireInPeriod(t, wall, 0);
	return new Date(here > ms ? here : fireInPeriod(t, wall, 1));
}

export interface ScheduleState extends ScheduleTiming {
	/** Saved (or its timing changed) at: times before this never fire. */
	anchorAt: Date;
	/** The last scheduled time queued. */
	lastFiredFor: Date | null;
}

/** The scheduled instant to queue now, or null when nothing is due. */
export function dueFireAt(s: ScheduleState, now: Date): Date | null {
	const fire = latestFireAt(s, now);
	if (fire.getTime() <= s.anchorAt.getTime()) return null;
	if (s.lastFiredFor && fire.getTime() <= s.lastFiredFor.getTime()) return null;
	return fire;
}
