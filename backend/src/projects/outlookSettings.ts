// The seasonal outlook's project settings (issue #53 R5; docs/api.md
// § Projects, docs/data-model.md § Projects, docs/ui.md § Seasonal outlook):
// the season (decision date and season end, as a month and day), the
// planning share, and the review date (a month and day inside the season, R6). Stored in project.settings.outlook, a sibling of
// settings.outcomes (R4). Like those it is **no model input**: it says how an
// outlook is set up, not how the model runs, so runs don't record it
// (runs/execute.ts) and saving it alone leaves updated_at alone
// (projects/routes.ts).
//
// Both defaults are the engine's, confirmed by the client (issue #90): the
// season DEFAULT_OUTLOOK_SEASON, 1 October – 30 April (O3), and the planning
// share DEFAULT_PLANNING_SHARE, 80 % (O6), and the review date
// defaultReviewDate, 1 January for that season (O3). A null field uses the
// default; a project may set its own.
import { DEFAULT_OUTLOOK_SEASON, defaultReviewDate, fromEpochDay, OUTLOOK_SEASON_MAX_DAYS, toEpochDay } from '@water-management/engine';
import { z } from 'zod';

/** A season as a month and day each end: the decision date (the season's first day) and the season end (inclusive). */
export interface OutlookSeasonSetting {
	startMonth: number;
	startDay: number;
	endMonth: number;
	endDay: number;
}

export interface OutlookSettings {
	/** null = the engine's DEFAULT_OUTLOOK_SEASON (O3). */
	season: OutlookSeasonSetting | null;
	/** Share of analogue years the planning figure's level must meet the requirement in, (0, 1]; null = DEFAULT_PLANNING_SHARE (O6). */
	planningShare: number | null;
	/** The review date's month and day (issue #53 R6); null = the engine's defaultReviewDate for the season (O3: 1 January). */
	review: { month: number; day: number } | null;
}

export const OUTLOOK_DEFAULTS: Readonly<OutlookSettings> = Object.freeze({ season: null, planningShare: null, review: null });

/** Days in a month of a common year: 29 February is not a setting (it would move every other year). */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Why a month and day isn't one (29 February included), or null. */
export function monthDayError(month: number, day: number): string | null {
	if (!Number.isInteger(month) || month < 1 || month > 12) return 'the month must be 1–12';
	if (!Number.isInteger(day) || day < 1 || day > DAYS_IN_MONTH[month - 1]!) return `day ${day} is not a day of month ${month} (29 February can't be a setting)`;
	return null;
}

/** Why a season setting isn't valid, or null: each end a real month and day, and not the same day (a one-day season). */
export function seasonError(s: OutlookSeasonSetting): string | null {
	const e = monthDayError(s.startMonth, s.startDay) ?? monthDayError(s.endMonth, s.endDay);
	if (e) return e;
	if (s.startMonth === s.endMonth && s.startDay === s.endDay) return 'the season ends on its decision date: give it at least two days';
	return null;
}

const MonthDay = z.number().int();
const SeasonSetting = z
	.object({ startMonth: MonthDay, startDay: MonthDay, endMonth: MonthDay, endDay: MonthDay })
	.strict()
	.superRefine((s, ctx) => {
		const e = seasonError(s);
		if (e) ctx.addIssue({ code: 'custom', message: e });
	});
const ReviewSetting = z
	.object({ month: MonthDay, day: MonthDay })
	.strict()
	.superRefine((r, ctx) => {
		const e = monthDayError(r.month, r.day);
		if (e) ctx.addIssue({ code: 'custom', message: e });
	});
const Share = z.number().finite().gt(0, 'the planning share must be more than 0').max(1, 'the planning share is at most 1 (every year)');

/** The settings patch's shape for `outlook` (projects/settings.ts): either field, each a value or null (the default). */
export const OutlookPatch = z.object({ season: SeasonSetting.nullable(), planningShare: Share.nullable(), review: ReviewSetting.nullable() }).partial().strict();

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** settings.outlook over the defaults; a stored field that isn't valid falls back to its default (as resolveOutcomes). */
export function resolveOutlook(settings: unknown): OutlookSettings {
	const raw = isObj(settings) && isObj(settings.outlook) ? settings.outlook : {};
	const s = SeasonSetting.safeParse(raw.season);
	const p = Share.safeParse(raw.planningShare);
	const r = ReviewSetting.safeParse(raw.review);
	return { season: s.success ? s.data : null, planningShare: p.success ? p.data : null, review: r.success ? r.data : null };
}

/**
 * The review date of a season (ISO): the setting's month and day, the first
 * one after the decision date, which must fall on or before the season end;
 * with no setting, the engine's defaultReviewDate. An error in words when the
 * month and day aren't inside the season (checked when an outlook is asked
 * for: the season may come from the request, not the setting).
 */
export function reviewDateFor(review: { month: number; day: number } | null, season: { decisionDate: string; seasonEnd: string }): { date: string } | { error: string } {
	if (!review) {
		try {
			return { date: defaultReviewDate(season) };
		} catch (err) {
			return { error: (err as Error).message };
		}
	}
	const from = toEpochDay(season.decisionDate);
	let y = Number(season.decisionDate.slice(0, 4));
	if (toEpochDay(iso(y, review.month, review.day)) <= from) y++;
	const at = toEpochDay(iso(y, review.month, review.day));
	if (at > toEpochDay(season.seasonEnd)) {
		return { error: `the review date (${review.day}/${review.month}) is not inside the season ${season.decisionDate} to ${season.seasonEnd}: it must fall after the decision date and on or before the season end` };
	}
	return { date: fromEpochDay(at) };
}

const iso = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * The season an outlook on a base run takes from the setting: the latest
 * decision date (the setting's month and day) whose day before the base run
 * holds, so the season starts from the run's newest state, and after the
 * run's first day; the season end the first of its month and day on or after
 * the decision date. Null when the run is too short to hold a decision date
 * with a day before it.
 */
export function outlookSeasonFor(setting: OutlookSeasonSetting | null, runStart: string, runEnd: string): { decisionDate: string; seasonEnd: string } | null {
	const s = setting ?? DEFAULT_OUTLOOK_SEASON;
	const first = toEpochDay(runStart);
	const last = toEpochDay(runEnd);
	// The latest decision date d with d − 1 ≤ runEnd, i.e. d ≤ runEnd + 1.
	let y = Number(fromEpochDay(last + 1).slice(0, 4));
	if (toEpochDay(iso(y, s.startMonth, s.startDay)) > last + 1) y--;
	const decision = toEpochDay(iso(y, s.startMonth, s.startDay));
	if (decision <= first) return null;
	const endBefore = s.endMonth < s.startMonth || (s.endMonth === s.startMonth && s.endDay < s.startDay);
	const seasonEnd = iso(endBefore ? y + 1 : y, s.endMonth, s.endDay);
	// A month-day pair is never more than a year apart; the engine's own cap, checked anyway.
	if (toEpochDay(seasonEnd) - decision + 1 > OUTLOOK_SEASON_MAX_DAYS) return null;
	return { decisionDate: fromEpochDay(decision), seasonEnd };
}
