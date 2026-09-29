// The seasonal outlook's project settings (settings.outlook, issue #53 R5;
// backend projects/outlookSettings.ts, docs/ui.md § Seasonal outlook): the
// season, the planning share and the review date (R6), null = the engine's
// defaults. Small on purpose: the Settings tab imports it to block Save, and
// its section is a lazy chunk.
import { DEFAULT_OUTLOOK_SEASON } from '@water-management/engine';
import type { OutlookSeasonSetting, OutlookSettings } from '$lib/api/types';

/** settings.outlook over the defaults (an older API sends none). A fresh object: the form edits it. */
export function resolveOutlook(settings: { outlook?: Partial<OutlookSettings> } | null | undefined): OutlookSettings {
	const o = settings?.outlook;
	return { season: o?.season ? { ...o.season } : null, planningShare: o?.planningShare ?? null, review: o?.review ? { ...o.review } : null };
}

/** Days in each month of a common year (29 February is not a setting: the backend refuses it). */
export const DAYS_IN_MONTH: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Why the Settings group can't be saved (as the backend checks it), or null. */
export function outlookError(o: OutlookSettings): string | null {
	const s: OutlookSeasonSetting | null = o.season;
	if (s) {
		const bad = (m: number, d: number) => !Number.isInteger(m) || m < 1 || m > 12 || !Number.isInteger(d) || d < 1 || d > DAYS_IN_MONTH[m - 1]!;
		if (bad(s.startMonth, s.startDay)) return 'Seasonal outlook: the decision date is not a day of the year (29 February can’t be used).';
		if (bad(s.endMonth, s.endDay)) return 'Seasonal outlook: the season end is not a day of the year (29 February can’t be used).';
		if (s.startMonth === s.endMonth && s.startDay === s.endDay) return 'Seasonal outlook: the season ends on its decision date; give it at least two days.';
	}
	const r = o.review;
	if (r) {
		if (!Number.isInteger(r.month) || r.month < 1 || r.month > 12 || !Number.isInteger(r.day) || r.day < 1 || r.day > DAYS_IN_MONTH[r.month - 1]!)
			return 'Seasonal outlook: the review date is not a day of the year (29 February can’t be used).';
		if (!inSeason(s ?? DEFAULT_OUTLOOK_SEASON, r.month, r.day)) return 'Seasonal outlook: the review date must fall after the decision date and on or before the season end.';
	}
	const p = o.planningShare;
	if (p !== null && !(Number.isFinite(p) && p > 0 && p <= 1)) return 'Seasonal outlook: the planning share must be more than 0 % and at most 100 %.';
	return null;
}

/** Whether a month and day falls inside a season (after its decision date, on or before its end), across the new year too. */
export function inSeason(s: OutlookSeasonSetting, month: number, day: number): boolean {
	const key = (m: number, d: number) => m * 100 + d;
	const [a, b, x] = [key(s.startMonth, s.startDay), key(s.endMonth, s.endDay), key(month, day)];
	return a < b ? x > a && x <= b : x > a || x <= b;
}
