// EWR compliance as a water-year × month grid: the app's version of the
// workbook's [EWR shortfalls Pivot Data] (VBA sProEp_CollateData) feeding the
// [EWR analysis] pivot.
import { monthOfEpochDay, toEpochDay, waterYearIndex, waterYearOf } from '../calendar';
import type { EwrCompliance, EwrComplianceGrid } from '../project';

/** One site to grid: its daily shortfall in the workbook's sign (≤ 0 = short). */
export interface EwrSite {
	nodeId: string | null;
	name: string;
	shortfallM3Day: ArrayLike<number>;
}

/**
 * How a day is counted as "not met".
 *
 * - `daily` (default, used in RunSummary): the day's own shortfall is < 0.
 * - `runningTotal`: the workbook pivot's rule. sProEp_CollateData adds each
 *   day's shortfall to a running monthly sum and counts the day when *the sum*
 *   is < 0, so once a month has had one short day every later day of that
 *   month counts too. Kept only so the regression test can reproduce the
 *   workbook's pivot numbers.
 */
export type EwrCountMethod = 'daily' | 'runningTotal';

const grid = (rows: number) => Array.from({ length: rows }, () => new Array<number>(12).fill(0));

/**
 * Days not met and shortfall volume per water year × month for each site.
 * Volumes are Σ −shortfall over the month's days (m³/day × 1 day = m³),
 * positive. Cells outside the run have days = 0.
 *
 * @param startDate ISO date of index 0 of every shortfall series
 * @param days      number of simulated days
 */
export function ewrCompliance(
	startDate: string,
	days: number,
	outlet: EwrSite,
	farms: EwrSite[],
	countMethod: EwrCountMethod = 'daily'
): EwrCompliance {
	const d0 = toEpochDay(startDate);
	if (days <= 0) {
		const empty = (s: EwrSite): EwrComplianceGrid => ({ nodeId: s.nodeId, name: s.name, daysNotMet: [], shortfallM3: [] });
		return { waterYears: [], days: [], outlet: empty(outlet), farms: farms.map(empty) };
	}
	const wy0 = waterYearOf(d0);
	const wyN = waterYearOf(d0 + days - 1);
	const rows = wyN - wy0 + 1;
	const row = new Int32Array(days);
	const col = new Uint8Array(days);
	const cellDays = grid(rows);
	for (let t = 0; t < days; t++) {
		row[t] = waterYearOf(d0 + t) - wy0;
		col[t] = waterYearIndex(monthOfEpochDay(d0 + t));
		cellDays[row[t]!]![col[t]!]!++;
	}

	const one = (site: EwrSite): EwrComplianceGrid => {
		const notMet = grid(rows);
		const volume = grid(rows);
		let running = 0;
		for (let t = 0; t < days; t++) {
			const r = row[t]!;
			const c = col[t]!;
			if (t > 0 && (col[t - 1] !== c || row[t - 1] !== r)) running = 0;
			const v = site.shortfallM3Day[t] ?? 0;
			const short = Number.isFinite(v) && v < 0 ? v : 0;
			running += short;
			if (countMethod === 'daily' ? short < 0 : running < 0) notMet[r]![c]!++;
			volume[r]![c]! -= short;
		}
		return { nodeId: site.nodeId, name: site.name, daysNotMet: notMet, shortfallM3: volume };
	};

	return {
		waterYears: Array.from({ length: rows }, (_, i) => wy0 + i),
		days: cellDays,
		outlet: one(outlet),
		farms: farms.map(one)
	};
}
