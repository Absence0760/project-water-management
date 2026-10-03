// The seasonal outlook's calendar (issue #53 R5, docs/model.md §2.15): the
// season (decision date → season end), the default season, and which
// historical stretch of the record each analogue year supplies.
//
// Pure date arithmetic on UTC epoch days, so no result depends on the
// machine's time zone.
//
// Day mapping (model.md §2.15): an analogue is a contiguous stretch of the
// record as long as the season. Analogue water year W starts on the decision
// date's month and day in W's calendar year (October–December in W, January–
// September in W + 1, so waterYearOf(start) = W; 29 February becomes
// 28 February in a common year), and season day i takes the analogue's day i.
// So the weather keeps its own day-to-day sequence (no day repeated or
// dropped), a season that crosses 1 October draws on two water years of the
// record in order, and when only one of the season and the analogue spans a
// 29 February the analogue's calendar drifts by one day by the season's end.
import { fromEpochDay, toEpochDay, waterYearLabel, waterYearOf, isIsoDate as isRealDate } from '../calendar';

/** A season: the decision date (its first day) to the season end, inclusive. */
export interface OutlookSeason {
	/** The first day of the season (ISO): the state the members start from is the end of the day before. */
	decisionDate: string;
	/** The last day of the season (ISO), inclusive. */
	seasonEnd: string;
}

/** A resolved season: its epoch days and length. */
export interface ResolvedSeason extends OutlookSeason {
	from: number;
	to: number;
	days: number;
}

/**
 * The default irrigation season: 1 October to 30 April (the summer irrigation
 * months of a winter-rainfall catchment, and 1 October is the start of the
 * water year, when the wet season's storage is known). Confirmed by the
 * client (O3, issue #90; plan.md § Decision-support outputs); a project may
 * set its own (settings.outlook.season).
 */
export const DEFAULT_OUTLOOK_SEASON: Readonly<{ startMonth: number; startDay: number; endMonth: number; endDay: number }> = Object.freeze({ startMonth: 10, startDay: 1, endMonth: 4, endDay: 30 });

/** The longest season: a year (a longer one would draw an analogue's days twice). */
export const OUTLOOK_SEASON_MAX_DAYS = 366;

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const iso = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
/** Month and day (1-based) of an ISO date, and its year. */
const parts = (date: string) => {
	const [y, m, d] = date.split('-').map(Number) as [number, number, number];
	return { y, m, d };
};

/**
 * The default season (DEFAULT_OUTLOOK_SEASON) whose decision date is the
 * first 1 October on or after `asOf` (ISO): from 2026-09-26, 2026-10-01 to
 * 2027-04-30; from 2026-10-01 itself, that season; from 2026-10-02, the next
 * one.
 */
export function defaultOutlookSeason(asOf: string): OutlookSeason {
	const day = toEpochDay(asOf);
	const { startMonth, startDay, endMonth, endDay } = DEFAULT_OUTLOOK_SEASON;
	let y = parts(fromEpochDay(day)).y;
	if (toEpochDay(iso(y, startMonth, startDay)) < day) y++;
	const endYear = endMonth < startMonth || (endMonth === startMonth && endDay < startDay) ? y + 1 : y;
	return { decisionDate: iso(y, startMonth, startDay), seasonEnd: iso(endYear, endMonth, endDay) };
}

/** Check a season and work out its days. Throws on a date that isn't one, an end before the start, or a season longer than a year. */
export function resolveSeason(season: OutlookSeason): ResolvedSeason {
	for (const k of ['decisionDate', 'seasonEnd'] as const) {
		const v = season[k];
		if (!isRealDate(v)) throw new RangeError(`${k} "${String(v)}" is not an ISO date (YYYY-MM-DD)`);
	}
	const from = toEpochDay(season.decisionDate);
	const to = toEpochDay(season.seasonEnd);
	if (to < from) throw new RangeError(`the season ends (${season.seasonEnd}) before its decision date (${season.decisionDate})`);
	const days = to - from + 1;
	if (days > OUTLOOK_SEASON_MAX_DAYS) throw new RangeError(`the season is ${days} days; at most ${OUTLOOK_SEASON_MAX_DAYS} (a year)`);
	return { decisionDate: season.decisionDate, seasonEnd: season.seasonEnd, from, to, days };
}

/** One analogue: the stretch of the record that drives the season in it. */
export interface OutlookAnalogue {
	/** The water year its first day falls in (by the calendar year its 1 October is in). */
	waterYear: number;
	/** "2016/17". */
	label: string;
	/** Its first and last day (ISO), as long as the season. */
	from: string;
	to: string;
}

/**
 * The first day of analogue water year `waterYear` for a season starting on
 * `decisionDate`: the decision date's month and day in the calendar year
 * that puts it in that water year (29 February → 28 February in a common
 * year). Epoch day.
 */
export function analogueStart(decisionDate: string, waterYear: number): number {
	const { m, d } = parts(decisionDate);
	const y = m >= 10 ? waterYear : waterYear + 1;
	return toEpochDay(iso(y, m, m === 2 && d === 29 && !isLeap(y) ? 28 : d));
}

/** Analogue water year `waterYear` for a season: its first and last day. */
export function outlookAnalogue(season: ResolvedSeason, waterYear: number): OutlookAnalogue {
	const a = analogueStart(season.decisionDate, waterYear);
	return { waterYear, label: waterYearLabel(waterYear), from: fromEpochDay(a), to: fromEpochDay(a + season.days - 1) };
}

/** The water year the season itself is in (its decision date's): the analogue that is the season. */
export const seasonWaterYear = (season: OutlookSeason) => waterYearOf(toEpochDay(season.decisionDate));
