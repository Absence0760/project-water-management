// Model quality's panels (ModelQuality.svelte, issue #586): how well one run
// fits the record, on the Calibration page under "How the shown run fits"
// since Round 3 moved them there from Runs & results. Each id is set on its
// panel and keeps the `res-…` it had on Runs, so a link to one reads the same
// on both pages: Runs & results sends an old `?tab=runs#res-fdc` on to
// Calibration (nav/anchorMoves.ts), and Calibration lands on it once the run
// is shown (calibration/CalibrationResults.svelte). Each label is the panel's
// heading, word for word. Water balance by water year stays on Runs & results
// (runs/sections.ts).
import type { RunSummary } from '@water-management/engine';
import type { NavSection } from '#lib/components/common/sectionNav.js';
import { runoffModelName } from './runoff';
import { unitRainOf } from './unitRain';
import { stationsOf } from './stationRain';
import { isModelQualityAnchor } from '#lib/components/calibration/links.js';

type SectionInput = Pick<RunSummary, 'runoff' | 'wr2012' | 'plausibility' | 'unitRain' | 'stations' | 'gapRain'> & {
	calibration?: Pick<NonNullable<RunSummary['calibration']>, 'siteNodeId'> | null;
};

// The anchors live with the Calibration page's links (calibration/links.ts), so the forwarding table, which every
// page loads, needn't load this module's helpers.
export { MODEL_QUALITY_ANCHORS, isModelQualityAnchor, type ModelQualityAnchor } from '#lib/components/calibration/links.js';

/**
 * The panels ModelQuality draws after the hydrograph has been painted (the hydrograph and the flow-duration curve
 * come first): a link to one of them (`#res-plausibility`) has them drawn at once, so it has somewhere to land.
 */
export const isLowerAnchor = (id: string): boolean =>
	(isModelQualityAnchor(id) && id !== 'res-hydrograph' && id !== 'res-fdc') ||
	// Calibration against observed flow's sub-headings with an index line (calibration/page.ts CAL_SUBSECTIONS).
	id === 'res-calibration-check' ||
	id === 'res-fit-provenance';

/** The run checks a gauge inside the network that it doesn't score: GaugeCheckFlows draws it under the flow-duration curve (checkGauges.ts checksOnlyGauges, from the same summary fields). */
const hasCheckGauges = (summary: SectionInput) => (summary.plausibility?.gauges ?? []).some((g) => g.nodeId !== (summary.calibration?.siteNodeId ?? null));

/** The WR2012 panel's heading (Wr2012Panel): the check and the quaternary it compares with. */
export function wr2012Heading(report: NonNullable<RunSummary['wr2012']>): string {
	return report.quaternary ? `WR2012 check: ${report.quaternary}` : 'WR2012 check';
}

/** The panels this run's Model quality draws, in page order, each by its heading. */
export function modelQualitySections(summary: SectionInput): NavSection[] {
	return [
		{ id: 'res-hydrograph', label: 'Hydrograph' },
		{ id: 'res-fdc', label: 'Flow-duration curve' },
		// The checks-only gauges' flows (issue #554).
		...(hasCheckGauges(summary) ? [{ id: 'res-gauges', label: 'Flow at gauges in the network (checks only)' }] : []),
		{ id: 'res-calibration', label: 'Calibration against observed flow' },
		// Runoff model balance: conceptual models (GR4J) only.
		...(summary.runoff ? [{ id: 'res-runoff', label: `Runoff model: ${runoffModelName(summary.runoff)}` }] : []),
		// Rain for each unit: runs with settings.unitRain perUnit (issue #482), or rainfall stations (issue #553).
		...(unitRainOf(summary) ? [{ id: 'res-unit-rain', label: 'Rain for each unit' }] : stationsOf(summary) ? [{ id: 'res-unit-rain', label: 'Rain from rainfall stations' }] : []),
		// The gap-filling products: runs whose settings.gapRain chose ERA5-Land or IMERG Late (engine ≥ 1.101.0, issue #604).
		...(summary.gapRain ? [{ id: 'res-gap-rain', label: 'Rain gaps filled from other products' }] : []),
		// WR2012 check: only when the project has a reference.
		...(summary.wr2012 ? [{ id: 'res-wr2012', label: wr2012Heading(summary.wr2012) }] : []),
		{ id: 'res-ewr-agreement', label: 'EWR test: model against observed flow' },
		// Hydrologist plausibility checks: runs made by engine ≥ 0.25.0.
		...(summary.plausibility ? [{ id: 'res-plausibility', label: 'Plausibility checks' }] : [])
	];
}
