// Numbers and dates for the farmer view: the pure rules (./numbers.ts, which
// the /share page uses on its own) plus the few that need words from the
// message catalogue ($lib/i18n, WP-2.5). Every farm module imports from here.
import { joinAnd as joinWords, plural, t, tn, type Plural } from '$lib/i18n/locale.svelte';
import { dateLocale, fmtNumber, fmtStampDay, NBSP } from './numbers';

export * from './numbers';

/** "121 m³ a day" (whole m³). */
export function fmtM3Day(m3Day: number): string {
	// i18n-section: farm
	return t('{amount} a day', { amount: `${fmtNumber(Math.round(m3Day))}${NBSP}m³` });
}

// The counted nouns after a number (“3 days”).
// i18n-section: farm.n
export const DAYS = plural({ one: 'day', other: 'days' });
export const WEEKS = plural({ one: 'week', other: 'weeks' });
export const POINTS = plural({ one: 'point', other: 'points' });
export const FARMS = plural({ one: 'hydrological unit', other: 'hydrological units' });

/** A whole-number count with its noun: count(DAYS, 1) → "1 day", count(FARMS, 3) → "3 farms". */
export function count(noun: Plural, n: number): string {
	return `${n}${NBSP}${tn(noun, n)}`;
}

/** A timestamp → "07:42 on 19 Jan 2024", where the viewer is. */
export function fmtStampTime(ts: string | number | Date): string {
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return String(ts);
	const time = new Intl.DateTimeFormat(dateLocale(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
	// i18n-section: farm
	return t('{time} on {date}', { time, date: fmtStampDay(d) });
}

/** "Nov", "Nov and Dec", "Oct, Nov and Dec". */
export const joinAnd = joinWords;
