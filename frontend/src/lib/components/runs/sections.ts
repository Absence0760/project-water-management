// The Runs & results page's in-page menu: the results panels in page order,
// grouped by the question they answer (the model's quality, the record, then
// digging deeper). Each id is set on its panel (RunsTab.svelte,
// RunCharts.svelte); each group's heading is on the page too. The river and
// unit panels have their own pages (issue #17): the run header links there,
// and their old anchors here are sent on (movedHref).
import type { RunSummary } from '@water-management/engine';
import { riverAnchor, riverHref } from '$lib/components/river/links';
import { supplyAnchor, supplyHref } from '$lib/components/supply/links';

export interface ResultSection {
	id: string;
	label: string;
}

export interface ResultGroup {
	/** The group's heading on the page and in the menu; null for the opening group, which needs none. */
	label: string | null;
	sections: ResultSection[];
}

type SectionInput = Pick<RunSummary, 'farms' | 'runoff' | 'wr2012' | 'plausibility' | 'forecast'>;

export function resultGroups(summary: SectionInput): ResultGroup[] {
	return [
		{
			// The run header says whether the run is the evidence and previews its notes (links to Record).
			label: null,
			// A forecast run's forecast days (WP-2.12) follow the summary, apart from it.
			sections: [{ id: 'res-summary', label: 'Summary' }, ...(summary.forecast ? [{ id: 'res-forecast', label: 'Forecast' }] : [])]
		},
		{
			label: 'Model quality',
			sections: [
				// The hydrograph and the flow-duration curve, compared on every calibration iteration: together.
				{ id: 'res-hydrograph', label: 'Hydrograph' },
				{ id: 'res-fdc', label: 'Flow duration' },
				// The calibration statistics and the fit record.
				{ id: 'res-calibration', label: 'Calibration' },
				// Runoff model balance: conceptual models (GR4J) only.
				...(summary.runoff ? [{ id: 'res-runoff', label: 'Runoff model' }] : []),
				// WR2012 check: only when the project has a reference.
				...(summary.wr2012 ? [{ id: 'res-wr2012', label: 'WR2012 check' }] : []),
				{ id: 'res-ewr-agreement', label: 'EWR vs observed' },
				// Hydrologist plausibility checks: runs made by engine ≥ 0.25.0.
				...(summary.plausibility ? [{ id: 'res-plausibility', label: 'Plausibility checks' }] : [])
			]
		},
		{
			// The run's written explanation, its evidence nomination, its validation statement and its publication: sign-off, after the results.
			label: 'Record',
			sections: [
				{ id: 'res-notes', label: 'Notes & evidence' },
				// The report's validation statement (WP-3.13), collapsed: every run.
				{ id: 'res-validation', label: 'Validation' },
				// Whether the run is the published baseline, publishing it, and the WUA's notice (WP-2.3): every run.
				{ id: 'res-publication', label: 'Publication' }
			]
		},
		{
			label: 'Dig deeper',
			sections: [
				{ id: 'res-checks', label: 'Self-checks' },
				{ id: 'res-explore', label: 'Explore outputs' }
			]
		}
	];
}

/** Every section in page order: the scroll spy's list. */
export const resultSections = (summary: SectionInput): ResultSection[] => resultGroups(summary).flatMap((g) => g.sections);

/**
 * Where a `#res-…` fragment on Runs & results now lives, when it moved: a panel
 * of River & reserve or Units & supply (the same panel there, keeping the run
 * and the curtailment's reporting window), or the link rows those groups left
 * here for a while (`#res-river`, `#res-units`: the page itself). null for a
 * panel that is still on this page.
 */
export function movedHref(hash: string, runId: string | null, window: string | null = null): string | null {
	if (hash === 'res-river') return riverHref(runId);
	if (riverAnchor(hash)) return riverHref(runId, hash);
	if (hash === 'res-units') return supplyHref(runId, { window });
	if (supplyAnchor(hash)) return supplyHref(runId, { window, hash });
	return null;
}
