// The seasonal outlook's project settings (settings.outlook, issue #53 R5;
// backend projects/outlookSettings.ts, docs/ui.md § Seasonal outlook): the
// season and the planning share, null = the engine's defaults pending the
// client. Small on purpose: the Settings tab imports it to block Save, and
// its section is a lazy chunk.
import type { OutlookSeasonSetting, OutlookSettings } from '$lib/api/types';

/** settings.outlook over the defaults (an older API sends none). A fresh object: the form edits it. */
export function resolveOutlook(settings: { outlook?: Partial<OutlookSettings> } | null | undefined): OutlookSettings {
	const o = settings?.outlook;
	return { season: o?.season ? { ...o.season } : null, planningShare: o?.planningShare ?? null };
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
	const p = o.planningShare;
	if (p !== null && !(Number.isFinite(p) && p > 0 && p <= 1)) return 'Seasonal outlook: the planning share must be more than 0 % and at most 100 %.';
	return null;
}
