// Days below the reserve, each water year (issue #17, board A4 "Compare
// runs"): per water year (Oct–Sep) of a run, how many days the simulated
// outflow fell short of the pragmatic EWR at the outlet. Read from the run's
// `ewr_shortfall` series (negative = not met), so it is the very test behind
// summary.catchment.ewrDaysNotMet (run.ts): the years' counts add up to it.
//
// A view over a run's series: not part of runModel, so ENGINE_VERSION
// doesn't move. Pure: no I/O.
//
// Every water year the run touches is listed, including a part year at
// either end (`complete: false`), so a short run still has a bar; a part
// year's count covers only its simulated days, and the caller says so. A
// missing (null / non-finite) day is counted in `missing`, never as met.
import { toEpochDay, waterYearOf } from '../calendar';

export interface ReserveYear {
	/** Water year, labelled by the year it starts in (2016 = Oct 2016 – Sep 2017). */
	waterYear: number;
	/** Simulated days of this water year inside the run. */
	days: number;
	/** Days the outflow fell short of the EWR (ewr_shortfall < 0). */
	below: number;
	/** Days with no value. */
	missing: number;
	/** All of 1 Oct … 30 Sep is inside the run. */
	complete: boolean;
}

const yearLength = (wy: number) => toEpochDay(`${wy + 1}-10-01`) - toEpochDay(`${wy}-10-01`);

export function reserveDaysByWaterYear(startDate: string, shortfall: ArrayLike<number | null>): ReserveYear[] {
	const d0 = toEpochDay(startDate);
	const out: ReserveYear[] = [];
	let cur: ReserveYear | null = null;
	for (let t = 0; t < shortfall.length; t++) {
		const wy = waterYearOf(d0 + t);
		if (!cur || cur.waterYear !== wy) {
			cur = { waterYear: wy, days: 0, below: 0, missing: 0, complete: false };
			out.push(cur);
		}
		cur.days++;
		const v = shortfall[t];
		if (v === null || v === undefined || !Number.isFinite(v)) cur.missing++;
		else if (v < 0) cur.below++;
	}
	for (const y of out) y.complete = y.days === yearLength(y.waterYear);
	return out;
}
