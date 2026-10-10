// One day of a series set or cleared by hand (issue #477 (a); PUT
// …/series/:seriesId/days/:date, 212_series_hand_days.sql): what the day
// holds now, whether a date is one the series has, how a typed value reads,
// and which days are marked as edited by hand.
import { fromEpochDay, toEpochDay } from '@water-management/engine';
import { parseNum } from '$lib/format/number';

export interface DailyValues {
	startDate: string;
	values: readonly (number | null)[];
}

/** The series' last day (startDate + length − 1). */
export const lastDay = (s: { startDate: string; length: number }): string => fromEpochDay(toEpochDay(s.startDate) + s.length - 1);

/** The stored value on `date` (null: a gap), or undefined when the series doesn't reach it. */
export function valueOn(s: DailyValues, date: string): number | null | undefined {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
	const i = toEpochDay(date) - toEpochDay(s.startDate);
	return i >= 0 && i < s.values.length ? (s.values[i] ?? null) : undefined;
}

export type TypedValue = { ok: true; value: number | null } | { ok: false; error: string };

/**
 * A value typed for the day: blank clears it (no reading); a number with a
 * decimal point or comma (12.5, 12,5), never below zero (rain, flow and
 * evaporation never are: a file's negative is a gap).
 */
export function readTypedValue(text: string): TypedValue {
	if (!text.trim()) return { ok: true, value: null };
	const n = parseNum(text);
	if (n === null) return { ok: false, error: 'Type a number, such as 12.5, or leave it blank to clear the day.' };
	if (n < 0) return { ok: false, error: 'A day’s value is never below zero. Leave it blank for “no reading”.' };
	return { ok: true, value: n };
}

/** Whether `date` is one of the hand-edited ranges (inclusive [from, to] ISO pairs). */
export const isHandDay = (ranges: readonly (readonly [string, string])[] | null | undefined, date: string): boolean =>
	!!ranges?.some(([from, to]) => date >= from && date <= to);

/** How many days the hand-edited ranges hold. */
export const handDayCount = (ranges: readonly (readonly [string, string])[] | null | undefined): number =>
	(ranges ?? []).reduce((n, [from, to]) => n + toEpochDay(to) - toEpochDay(from) + 1, 0);

/** The hand-edited days as a chart line of points: the stored value on each, null elsewhere (null when none has a value). */
export function handPoints(s: DailyValues, ranges: readonly (readonly [string, string])[] | null | undefined): { startDate: string; values: (number | null)[] } | null {
	if (!ranges?.length) return null;
	const s0 = toEpochDay(s.startDate);
	const values: (number | null)[] = new Array(s.values.length).fill(null);
	let any = false;
	for (const [from, to] of ranges) {
		for (let d = Math.max(toEpochDay(from), s0); d <= Math.min(toEpochDay(to), s0 + s.values.length - 1); d++) {
			const v = s.values[d - s0] ?? null;
			values[d - s0] = v;
			if (v !== null) any = true;
		}
	}
	return any ? { startDate: s.startDate, values } : null;
}

/** The ranges in words: "2021-10-02", "2021-10-02 to 2021-10-05", joined. */
export const handRangesText = (ranges: readonly (readonly [string, string])[] | null | undefined): string =>
	(ranges ?? []).map(([from, to]) => (from === to ? from : `${from} to ${to}`)).join(', ');
