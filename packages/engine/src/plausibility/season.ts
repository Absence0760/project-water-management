// The dry season the plausibility checks use (engine ≥ 0.25.0, docs/model.md
// §2.10d): the six consecutive calendar months with the lowest mean flow.
//
// South African practice splits the year into a wet and a dry half (the
// Reserve's wet- and dry-season low flows, WR2012's seasonal index), and the
// halves differ by region: summer-rainfall catchments are low from about May
// to October, winter-rainfall ones from about December to May. So the season
// is found from the catchment's own flow, not fixed. It comes from the first
// record that covers every calendar month well enough: the calibration
// record, then the other observed record, then the run's simulated natural
// flow. Observed flow comes first because it doesn't depend on the runoff
// model, so runs of different models (and their low-flow curves) share the
// same months.
import { monthOfEpochDay } from '../calendar';
import type { CalibrationFlowKind } from '../project';

/** Months in the dry season. */
export const DRY_SEASON_MONTHS = 6;
/** A record sets the season only when every calendar month has at least this many valid days. */
export const DRY_SEASON_MIN_DAYS_PER_MONTH = 28;

export type DrySeasonSource = CalibrationFlowKind | 'natural_flow';

export interface DrySeason {
	/** Calendar months (1–12) of the dry season, in order from its first month (wrapping past December). */
	months: number[];
	/** The record the season was found from. */
	source: DrySeasonSource;
}

/** A valid flow value: present, finite and not negative. */
export const isFlow = (v: number | null | undefined): v is number => v != null && Number.isFinite(v) && v >= 0;

/**
 * The dry season from the first candidate whose every calendar month has
 * DRY_SEASON_MIN_DAYS_PER_MONTH valid days: the window of DRY_SEASON_MONTHS
 * consecutive months (wrapping) with the lowest sum of mean daily flows. A
 * tie keeps the window starting earliest in the water year (October first),
 * so the answer never depends on float noise in another month. `values[t]` is
 * run day t, epoch day `start + t`. null when no candidate qualifies.
 */
export function drySeason(candidates: readonly { source: DrySeasonSource; values: ArrayLike<number | null> }[], start: number): DrySeason | null {
	for (const c of candidates) {
		const sum = new Float64Array(13);
		const n = new Int32Array(13);
		for (let t = 0; t < c.values.length; t++) {
			const v = c.values[t];
			if (!isFlow(v)) continue;
			const m = monthOfEpochDay(start + t);
			sum[m]! += v;
			n[m]!++;
		}
		let ok = true;
		for (let m = 1; m <= 12; m++) if (n[m]! < DRY_SEASON_MIN_DAYS_PER_MONTH) ok = false;
		if (!ok) continue;
		const mean = (m: number) => sum[m]! / n[m]!;
		let best = -1;
		let bestSum = Infinity;
		// Water-year order: October (10) first.
		for (let k = 0; k < 12; k++) {
			const first = ((9 + k) % 12) + 1;
			let s = 0;
			for (let j = 0; j < DRY_SEASON_MONTHS; j++) s += mean(((first - 1 + j) % 12) + 1);
			// Relative tolerance: a tie in exact arithmetic keeps the earlier window.
			if (best < 0 || s < bestSum - 1e-12 * Math.max(1, Math.abs(bestSum))) {
				best = first;
				bestSum = s;
			}
		}
		const months = Array.from({ length: DRY_SEASON_MONTHS }, (_, j) => ((best - 1 + j) % 12) + 1);
		return { months, source: c.source };
	}
	return null;
}

/** 1 on run days whose calendar month is in the season. */
export function seasonMask(season: DrySeason | null, start: number, days: number): Uint8Array {
	const mask = new Uint8Array(days);
	if (!season) return mask;
	const inSeason = new Uint8Array(13);
	for (const m of season.months) inSeason[m] = 1;
	for (let t = 0; t < days; t++) mask[t] = inSeason[monthOfEpochDay(start + t)]!;
	return mask;
}
