// A farm dam's storage figures for the run summary (engine ≥ 1.2.0, issue
// #55): storage at the end of the run and DAM_AGO_DAYS before it, the lowest
// in the run's last DAM_YEAR_DAYS days and its first day, and the days in that
// window at or below the minimum operating level. The Summary's Dams today
// card and the Network's colour by dam level read these instead of fetching
// every dam's daily series. Same rules as the frontend's damLevel()
// (overview/damLevels.ts), which still reduces the series of an older run.
import { fromEpochDay, toEpochDay } from '../calendar';

/** The window "the last year" covers: 365 days ending on the last day with a value. */
export const DAM_YEAR_DAYS = 365;
/** "Dams today" compares the end of the run with this many days before it. */
export const DAM_AGO_DAYS = 30;

export interface DamFigures {
	/** Storage on the last day with a value, m³. */
	damEndM3: number;
	/** Storage DAM_AGO_DAYS before that day, m³; null when the run is shorter or has no value then. */
	damAgoM3: number | null;
	/** Lowest storage in the last DAM_YEAR_DAYS days, m³, and its first day (ISO). */
	damLowM3: number;
	damLowDate: string;
	/** Days in that window at or below the minimum operating level (0 when the dam has none). */
	damDaysAtMin: number;
}

/**
 * One dam's figures from its daily storage (m³, day 0 = `startDate`), or null
 * when the dam has no capacity or the storage no finite value. `minFrac` is
 * the minimum operating level as a fraction of capacity (NetworkNode.damMinPct).
 * `capacityOn` (engine ≥ 1.27.0): the capacity on run day i when it changes
 * over the run (sediment, an in-service date; network/development.ts), so
 * the minimum level is a share of the day's capacity.
 */
export function damFigures(storage: ArrayLike<number | null>, capacityM3: number, minFrac: number, startDate: string, capacityOn?: (i: number) => number): DamFigures | null {
	if (!(capacityM3 >= 1)) return null;
	const finite = (x: number | null | undefined): x is number => x != null && Number.isFinite(x);
	let last = -1;
	for (let i = storage.length - 1; i >= 0; i--) {
		if (finite(storage[i])) {
			last = i;
			break;
		}
	}
	if (last < 0) return null;
	const minPct = minFrac > 0 ? minFrac * 100 : 0;
	const from = Math.max(0, last - DAM_YEAR_DAYS + 1);
	// The first day of the lowest level: scan forward, replace only on a lower value.
	let low = -1;
	let daysAtMin = 0;
	for (let i = from; i <= last; i++) {
		const x = storage[i];
		if (!finite(x)) continue;
		if (low < 0 || x < (storage[low] as number)) low = i;
		// A small tolerance (in % of capacity): the engine holds a dam at its minimum as a float.
		const cap = capacityOn ? capacityOn(i) : capacityM3;
		if (minPct > 0 && cap > 0 && (x / cap) * 100 <= minPct + 1e-6) daysAtMin++;
	}
	const ago = last - DAM_AGO_DAYS >= 0 ? storage[last - DAM_AGO_DAYS] : null;
	const start = toEpochDay(startDate);
	return {
		damEndM3: storage[last] as number,
		damAgoM3: finite(ago) ? ago : null,
		damLowM3: storage[low] as number,
		damLowDate: fromEpochDay(start + low),
		damDaysAtMin: daysAtMin
	};
}
