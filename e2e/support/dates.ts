// Calendar days as the app dates them: on the project's calendar, in its time
// zone (backend src/projects/timeZone.ts localDate; project.time_zone defaults
// to Africa/Johannesburg, migration 058), never UTC's. The e2e browser runs in
// UTC, and South Africa's day is a day ahead of UTC from 22:00 to 24:00 UTC, so
// a spec that dates "today" with toISOString() fails every night in that window.

/** A new project's time zone (migration 058's column default). */
export const DEFAULT_PROJECT_TIME_ZONE = 'Africa/Johannesburg';

/** The project's calendar day at `at` (default now), as YYYY-MM-DD: what the server's localDate writes. */
export function projectDay(timeZone: string = DEFAULT_PROJECT_TIME_ZONE, at: Date = new Date()): string {
	return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}
