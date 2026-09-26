// A project's time zone (058_project_time_zone.sql): an IANA name, South
// Africa's by default. It dates the project's downloads (export file names,
// the report PDF's name) by the calendar day where the catchment is, not UTC's,
// which is a day behind around local midnight (issue #45). Computed from the
// instant with Intl, never the server's own zone (the tests run under a
// skewed TZ).
import { z } from 'zod';
import { isValidTimeZone } from '../reports/due.js';

/** The zone a project starts with, and the date zone of downloads that belong to no project (my-data). */
export const DEFAULT_TIME_ZONE = 'Africa/Johannesburg';

/** A known IANA zone name, as PATCH /projects/:id takes it. */
export const TimeZone = z.string().trim().min(1).max(64).refine(isValidTimeZone, 'not a known time zone');

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The calendar date (YYYY-MM-DD) at `now` in `timeZone`; an unknown zone falls back to DEFAULT_TIME_ZONE. */
export function localDate(now: Date, timeZone: string): string {
	const tz = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
	let f = formatters.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
		formatters.set(tz, f);
	}
	const parts = Object.fromEntries(f.formatToParts(now).map((p) => [p.type, p.value]));
	return `${parts.year}-${parts.month}-${parts.day}`;
}
