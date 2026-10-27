// Links to the Calibration page (`?tab=calibration`, issue #586), as river/links.ts
// and supply/links.ts are to EWR and Hydrological units: for a run (`run=`, so
// the page's run picker shows it) and a panel's anchor. Model quality's panels
// keep the `res-…` ids they had on Runs & results (runs/modelQuality.ts): listed
// here, light, for the forwarding table every page loads (nav/anchorMoves.ts).

/** A link to the Calibration page, for the run `runId` when given, landing on `anchor` (without the `#`) when given. */
export function calibrationHref(runId?: string | null, anchor?: string | null): string {
	return `?tab=calibration${runId ? `&run=${encodeURIComponent(runId)}` : ''}${anchor ? `#${anchor}` : ''}`;
}

/** Every anchor a Model quality panel can have, in page order (some only on some runs). */
export const MODEL_QUALITY_ANCHORS = [
	'res-hydrograph',
	'res-fdc',
	'res-gauges',
	'res-calibration',
	'res-runoff',
	'res-unit-rain',
	'res-gap-rain',
	'res-wr2012',
	'res-ewr-agreement',
	'res-plausibility'
] as const;

export type ModelQualityAnchor = (typeof MODEL_QUALITY_ANCHORS)[number];

export const isModelQualityAnchor = (id: string): id is ModelQualityAnchor => (MODEL_QUALITY_ANCHORS as readonly string[]).includes(id);
