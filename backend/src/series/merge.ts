import { fromEpochDay, toEpochDay } from '@water-management/engine';

export interface Daily {
	startDate: string;
	values: (number | null)[];
}

/**
 * Merge `incoming` into `existing` by date: incoming values win on overlapping
 * days (a corrected or re-sent reading), the series extends in either
 * direction, and days in a gap between the two are null ("no reading").
 * `null` in `incoming` also overwrites — send only the days you have.
 */
export function mergeDaily(existing: Daily | null, incoming: Daily): Daily {
	if (!existing || existing.values.length === 0) return { startDate: incoming.startDate, values: [...incoming.values] };
	const e0 = toEpochDay(existing.startDate);
	const i0 = toEpochDay(incoming.startDate);
	const start = Math.min(e0, i0);
	const end = Math.max(e0 + existing.values.length, i0 + incoming.values.length); // exclusive
	const out: (number | null)[] = new Array(end - start).fill(null);
	existing.values.forEach((v, k) => (out[e0 - start + k] = v));
	incoming.values.forEach((v, k) => (out[i0 - start + k] = v));
	return { startDate: fromEpochDay(start), values: out };
}
