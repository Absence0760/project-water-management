// Links to the Calibration page (`?tab=calibration`, issue #586), as river/links.ts
// and supply/links.ts are to EWR and Hydrological units: for a run (`run=`, so
// the page's run picker shows it) and a panel's anchor. Model quality's panels
// keep the `res-…` ids they had on Runs & results (runs/modelQuality.ts).

/** A link to the Calibration page, for the run `runId` when given, landing on `anchor` (without the `#`) when given. */
export function calibrationHref(runId?: string | null, anchor?: string | null): string {
	return `?tab=calibration${runId ? `&run=${encodeURIComponent(runId)}` : ''}${anchor ? `#${anchor}` : ''}`;
}
