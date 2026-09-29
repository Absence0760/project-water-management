// The rain threshold (settings.calibration.rainThresholdMm, docs/model.md §2.3):
// irrigation demand reads rain used at or below it as 0 (run.ts buildDemand).
// Its own module so the series download (backend export/series-columns.ts)
// thresholds a run's rain exactly as the run did.

/** Rain used as irrigation demand reads it: `mm` above the threshold, else 0. */
export function aboveRainThreshold(mm: number, thresholdMm: number): number {
	return mm > thresholdMm ? mm : 0;
}
