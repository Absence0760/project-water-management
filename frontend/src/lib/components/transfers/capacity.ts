// The Transfers page's "When water moves" strip: for each month of the water
// year, how many enabled rules run and the most they could move in a day
// together. That is each rule's own ceiling, min(max rate × 86 400, daily
// cap), summed: an upper bound, since on the day the engine also stops at the
// source dam's minimum and the destination's room (help: Add a transfer).
import { WATER_YEAR_CALENDAR, WATER_YEAR_MONTHS } from '$lib/format/months';

type Rule = { months: readonly number[]; maxRateM3s: number; dailyCapM3: number | null; enabled: boolean };

/** One rule's most in a day, m³: its rate over a day, or its daily cap if lower. */
export function dailyCeilingM3(t: Pick<Rule, 'maxRateM3s' | 'dailyCapM3'>): number {
	const byRate = Math.max(0, t.maxRateM3s || 0) * 86_400;
	return t.dailyCapM3 === null ? byRate : Math.min(byRate, Math.max(0, t.dailyCapM3));
}

export interface MonthCapacity {
	/** Short month name, water-year order (Oct … Sep). */
	month: (typeof WATER_YEAR_MONTHS)[number];
	/** Enabled rules that run in the month. */
	rules: number;
	/** The sum of their daily ceilings, m³/day. */
	maxM3Day: number;
}

/** The twelve months Oct … Sep, with the enabled rules running in each and their combined daily ceiling. */
export function monthCapacity(transfers: readonly Rule[]): MonthCapacity[] {
	const on = transfers.filter((t) => t.enabled);
	return WATER_YEAR_CALENDAR.map((m, i) => {
		const here = on.filter((t) => t.months.includes(m));
		return { month: WATER_YEAR_MONTHS[i]!, rules: here.length, maxM3Day: here.reduce((s, t) => s + dailyCeilingM3(t), 0) };
	});
}
