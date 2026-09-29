// How old data is, said one way everywhere (issue #162 items 19–20): the
// staleness threshold, "31 Dec 2024 (20 months ago)", and the wording of a
// window that ends on the data's last day ("this week" while the data is
// current, "the week to 31 Dec 2024" once it is stale). A phrase like
// "today" or "last 30 days" is only true while the data reaches today, so
// anything tied to a data date goes through here. Dates are calendar days
// (YYYY-MM-DD), read from the string, so no time zone can shift them; the
// caller says what "today" is (the project's day, or the viewer's).
// English only: the farmer pages word their own through the catalogue
// (farm/format.ts), with the same threshold.
import { FARM_VIEW_STALE_DAYS } from '@water-management/engine';
import { fmtDay } from './number';

/**
 * Data whose last day is more than this many days before today is stale:
 * relative words ("this week", "today") give way to its date. The engine's
 * limit, which the backend's portfolio and farm view count stale by too.
 */
export const STALE_DAYS = FARM_VIEW_STALE_DAYS;

const epochDay = (iso: string) => {
	const [y, m, d] = iso.slice(0, 10).split('-').map(Number) as [number, number, number];
	return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
};

/** Whole calendar days from `iso` to `todayIso` (both YYYY-MM-DD); negative when `iso` is later. */
export const daysBetween = (iso: string, todayIso: string): number => epochDay(todayIso) - epochDay(iso);

/** More than STALE_DAYS old. */
export const isStale = (ageDays: number, limit = STALE_DAYS): boolean => ageDays > limit;

/**
 * How an age of 2 days or more is counted: days under 60, months under 730
 * days, then years. At least 2 of either: 60 days is under two 30.44-day
 * months and 730 under two years, which would read "1 months" / "1 years".
 * The farmer pages count with it too (farm/format.ts agoWords), in their words.
 */
export function ageSpan(days: number): { unit: 'day' | 'month' | 'year'; n: number } {
	if (days < 60) return { unit: 'day', n: days };
	if (days < 730) return { unit: 'month', n: Math.max(2, Math.floor(days / 30.44)) };
	return { unit: 'year', n: Math.max(2, Math.floor(days / 365.25)) };
}

/** 0 → "today", 1 → "yesterday", 12 → "12 days ago", 75 → "2 months ago", 800 → "2 years ago". */
export function agoText(days: number): string {
	if (days < 0) return 'in the future';
	if (days === 0) return 'today';
	if (days === 1) return 'yesterday';
	const s = ageSpan(days);
	return `${s.n} ${s.unit}s ago`;
}

/** A data date and its age: "31 Dec 2024 (20 months ago)", "29 Sep 2026 (today)". */
export const dateAge = (day: string, ageDays: number): string => `${fmtDay(day)} (${agoText(ageDays)})`;

/** A data window's last day and its age (days to the project's or viewer's today). */
export interface DataEnd {
	end: string;
	age: number;
}

/** Where the data ends, from a last day and today; null without data. */
export const dataEndOf = (end: string | null | undefined, today: string): DataEnd | null =>
	end ? { end, age: daysBetween(end, today) } : null;

/**
 * A window ending on the data's last day, worded for how old that day is:
 * `recent` while it is current (or unknown), `dated` with `{date}` filled in
 * once it is stale. windowText(e, 'this week', 'in the week to {date}').
 */
export function windowText(e: DataEnd | null, recent: string, dated: string): string {
	return e && isStale(e.age) ? dated.replace('{date}', fmtDay(e.end)) : recent;
}

/**
 * One label over several catchments' windows (a column header, a total):
 * `recent` when none is stale, `dated` when every one with data ends on the
 * same stale day, otherwise `mixed` (each row then says its own date).
 */
export function sharedWindowText(ends: readonly (DataEnd | null)[], recent: string, dated: string, mixed: string): string {
	const known = ends.filter((e): e is DataEnd => e !== null);
	if (!known.some((e) => isStale(e.age))) return recent;
	const first = known[0]!;
	return known.every((e) => e.end === first.end) ? windowText(first, recent, dated) : mixed;
}
