// The daily digest's clock (roadmap WP-2.13): alerts someone chose to get
// daily, and immediate alerts over the daily cap, go out together at 06:00
// South African time. The same boundary starts the cap's day: "5 immediate
// mails a day" counts since the last 06:00 SAST. Computed from the instant,
// never the machine's time zone (digest.test.ts runs under a skewed TZ).

export const DIGEST_TIME_ZONE = 'Africa/Johannesburg';
export const DIGEST_HOUR = 6;

/** At most this many immediate alert mails per person per digest day; the rest wait for the digest. */
export const DEFAULT_DAILY_CAP = 5;

const parts = new Intl.DateTimeFormat('en-US', {
	timeZone: DIGEST_TIME_ZONE,
	hourCycle: 'h23',
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit'
});

/** The zone's wall clock at `at`, read as if it were UTC (ms): minus `at`, the zone's offset. */
function wallMs(at: Date): number {
	const p = Object.fromEntries(parts.formatToParts(at).map((x) => [x.type, x.value]));
	return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
}

/** The instant the zone's wall clock reads `y-m-d h:00`. */
function atWall(y: number, m: number, d: number, h: number, near: Date): Date {
	const guess = Date.UTC(y, m, d, h);
	const offset = wallMs(near) - Math.floor(near.getTime() / 1000) * 1000;
	return new Date(guess - offset);
}

/**
 * The digest day `now` falls in: from the latest 06:00 SAST at or before it
 * (`start`) to the next (`next`).
 */
export function digestWindow(now: Date): { start: Date; next: Date } {
	const wall = new Date(wallMs(now));
	const y = wall.getUTCFullYear();
	const m = wall.getUTCMonth();
	const d = wall.getUTCDate();
	let start = atWall(y, m, d, DIGEST_HOUR, now);
	if (start.getTime() > now.getTime()) start = atWall(y, m, d - 1, DIGEST_HOUR, now);
	const s = new Date(wallMs(start));
	return { start, next: atWall(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate() + 1, DIGEST_HOUR, start) };
}
