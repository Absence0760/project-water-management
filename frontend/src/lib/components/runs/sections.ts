// The Runs & results page's in-page menu: the results panels in page order,
// grouped by the question they answer (the run itself, the record, then
// digging deeper). Each id is set on its panel (RunsTab.svelte,
// RunCharts.svelte); each group's heading is on the page too. Model quality
// (the hydrograph to the plausibility checks) moved to Calibration (issue #586
// round 3, runs/modelQuality.ts), and its old anchors here are sent on
// (nav/anchorMoves.ts). Each link says its panel's heading word for word, on
// the bar and in the side index alike (issue #586, D4: the bar's shorter
// names went with Model quality's links, which needed them to fit). The side
// index also has a line for each sub-heading a reader looks for (Changes
// since this run, Trace a day). The river and unit panels have their own pages
// (issue #17), and so has the fit: the run header links there, the side index
// lists the main ones under their pages (otherPageGroups), and their old
// anchors here are sent on.
import type { RunSummary } from '@water-management/engine';
import type { NavGroup, NavSection } from '#lib/components/common/sectionNav.js';
import { calibrationHref } from '#lib/components/calibration/links.js';
import { EWR_MONTHS_HEADING, RESERVE_MONTHS_HEADING, riverHref } from '#lib/components/river/links.js';
import { supplyHref } from '#lib/components/supply/links.js';

export type ResultSection = NavSection;

export interface ResultGroup extends NavGroup {
	/** The group's heading on the page and in the menu; null for the opening group, which needs none. */
	label: string | null;
	sections: ResultSection[];
}

/** A run's summary, or the parts of one a test gives: only `forecast` changes the list. */
type SectionInput = Partial<RunSummary>;

/**
 * The sub-headings with a line of their own in the side index (`rail`), each its heading's id (the heading sets
 * it): the changes to the inputs since the run, under Reproduction (history/RunInputsPanel.svelte), and Trace a day,
 * under Self-checks (SelfChecksPanel.svelte). Not on the bar, which keeps to the panels so it fits two rows.
 */
export const RUN_SUBSECTIONS = { changes: 'res-changes', trace: 'res-trace' } as const;

export function resultGroups(summary: SectionInput, rail = false): ResultGroup[] {
	return [
		{
			// The run header says whether the run is the evidence and previews its notes (links to Record).
			label: null,
			sections: [
				{ id: 'res-summary', label: 'Summary' },
				// A forecast run's forecast days (WP-2.12) follow the summary, apart from it.
				...(summary.forecast ? [{ id: 'res-forecast', label: 'Forecast' }] : []),
				// The water balance per water year, every run (issue #137): it stays here when Model quality moves to
				// Calibration (issue #586 round 3), the table a hydrologist hands a client.
				{ id: 'res-water-balance', label: 'Water balance by water year' }
			]
		},
		{
			// The run's written explanation, its evidence nomination, its reproduction, its validation statement and its
			// publication: sign-off, after the results. A panel each (issue #521).
			label: 'Record',
			sections: [
				{ id: 'res-notes', label: 'Run notes' },
				{ id: 'res-evidence', label: 'Evidence' },
				{ id: 'res-reproduce', label: 'Reproduction' },
				...(rail ? [{ id: RUN_SUBSECTIONS.changes, label: 'Changes since this run' }] : []),
				// The report's validation statement (WP-3.13), collapsed: every run.
				{ id: 'res-validation', label: 'Validation statement' },
				// Whether the run is the published baseline, publishing it, and the WUA's notice (WP-2.3): every run.
				{ id: 'res-publication', label: 'Publication' }
			]
		},
		{
			label: 'Dig deeper',
			sections: [
				{ id: 'res-checks', label: 'Self-checks' },
				...(rail ? [{ id: RUN_SUBSECTIONS.trace, label: 'Trace a day' }] : []),
				{ id: 'res-explore', label: 'Explore any output' }
			]
		}
	];
}

/**
 * The side index's last groups (issue #462): the panels that moved from here
 * to Calibration (issue #586 round 3), EWR and Hydrological units (issue #17),
 * by the same headings those pages give them, linked with the run shown. Only
 * in the rail, which has a line for each: on the bar the run header's links to
 * those pages do it.
 * The main findings only, so the rail fits a laptop's window: each page's own
 * index lists the rest.
 */
export function otherPageGroups(runId: string | null): NavGroup[] {
	const river = (id: string, label: string): NavSection => ({ id: `river-${id}`, label, href: riverHref(runId, id), page: 'EWR' });
	const units = (id: string, label: string): NavSection => ({ id: `units-${id}`, label, href: supplyHref(runId, { hash: id }), page: 'Hydrological units' });
	const fit = (id: string, label: string): NavSection => ({ id: `cal-${id}`, label, href: calibrationHref(runId, id), page: 'Calibration' });
	return [
		{
			label: 'On Calibration',
			sections: [fit('res-hydrograph', 'Hydrograph'), fit('res-calibration', 'Calibration against observed flow')]
		},
		{
			label: 'On EWR',
			sections: [river('res-reserve', RESERVE_MONTHS_HEADING), river('res-ewr-grid', EWR_MONTHS_HEADING), river('res-water-account', 'Water account')]
		},
		{
			label: 'On Hydrological units',
			sections: [units('res-curtailment', 'Curtailment targets'), units('res-assurance', 'Assurance of supply')]
		}
	];
}

/** Every section in page order: the scroll spy's list. */
export const resultSections = (summary: SectionInput, rail = false): ResultSection[] => resultGroups(summary, rail).flatMap((g) => g.sections);
