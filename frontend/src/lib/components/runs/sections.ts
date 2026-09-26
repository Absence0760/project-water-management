// The Runs & results page's in-page menu: the results panels in page order,
// grouped by the question they answer (the river, the farms, the model's
// quality, then digging deeper). Each id is set on its panel (RunsTab.svelte,
// RunCharts.svelte); each group's heading is on the page too.
import type { RunSummary } from '@water-management/engine';

export interface ResultSection {
	id: string;
	label: string;
}

export interface ResultGroup {
	/** The group's heading on the page and in the menu; null for the opening group, which needs none. */
	label: string | null;
	sections: ResultSection[];
}

type SectionInput = Pick<RunSummary, 'farms' | 'runoff' | 'wr2012' | 'ewrAssurance' | 'plausibility'>;

export function resultGroups(summary: SectionInput): ResultGroup[] {
	return [
		{
			// The run header says whether the run is the evidence and previews its notes (links to Record).
			label: null,
			sections: [{ id: 'res-summary', label: 'Summary' }]
		},
		{
			label: 'River & Reserve',
			sections: [
				// Reserve compliance by month: only when the project has a rule table (engine ≥ 0.21.0).
				...(summary.ewrAssurance?.length ? [{ id: 'res-reserve', label: 'Reserve compliance' }] : []),
				{ id: 'res-ewr', label: 'EWR vs outflow' },
				{ id: 'res-ewr-grid', label: 'EWR by month' },
				// The 5–95 % range on the EWR and Reserve findings (issue #4 phase 9): every run, beside the findings it qualifies.
				{ id: 'res-uncertainty', label: 'Uncertainty bands' }
			]
		},
		{
			label: 'Farms & users',
			sections: [
				{ id: 'res-curtailment', label: 'Curtailment' },
				// Farm detail is only drawn when the run has farms.
				...(summary.farms?.length ? [{ id: 'res-farm', label: 'Farm detail' }] : [])
			]
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
			// The run's written explanation, its evidence nomination and its publication: sign-off, after the results.
			label: 'Record',
			sections: [
				{ id: 'res-notes', label: 'Notes & evidence' },
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
 * The section being read, for the rail's scroll spy: the last one whose top
 * has scrolled up to `line` (px from the viewport top, just under the sticky
 * header), else the first. At the bottom of the page it is the last section,
 * since a short final panel may never reach the line. `tops` are viewport
 * offsets in page order; sections not rendered yet are simply absent.
 */
export function activeSectionId(tops: { id: string; top: number }[], line: number, atBottom = false): string | null {
	if (!tops.length) return null;
	if (atBottom) return tops[tops.length - 1]!.id;
	let current = tops[0]!.id;
	for (const t of tops) {
		if (t.top <= line) current = t.id;
		else break;
	}
	return current;
}
