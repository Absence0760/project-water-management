/** Water-year month labels (index 0 = October … 11 = September). */
export const WATER_YEAR_MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'] as const;

/** Calendar month (1–12) in water-year display order. */
export const WATER_YEAR_CALENDAR = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function monthName(calendarMonth: number): string {
	return SHORT[calendarMonth - 1] ?? String(calendarMonth);
}

/** [10,11,12,1] → "Oct–Jan"; [1,3,4,5] → "Jan, Mar–May"; all 12 → "All year". Water-year order. */
export function describeMonths(months: number[]): string {
	const set = new Set(months);
	if (set.size === 0) return 'None';
	if (set.size === 12) return 'All year';
	const order = WATER_YEAR_CALENDAR.filter((m) => set.has(m));
	const runs: number[][] = [];
	for (const m of order) {
		const last = runs[runs.length - 1];
		const prevIdx = last ? WATER_YEAR_CALENDAR.indexOf(last[last.length - 1] as (typeof WATER_YEAR_CALENDAR)[number]) : -2;
		if (last && WATER_YEAR_CALENDAR.indexOf(m) === prevIdx + 1) last.push(m);
		else runs.push([m]);
	}
	return runs
		.map((r) => (r.length > 2 ? `${monthName(r[0]!)}–${monthName(r[r.length - 1]!)}` : r.map(monthName).join(', ')))
		.join(', ');
}
