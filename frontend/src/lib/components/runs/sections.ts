// The Runs & results page's in-page menu: the results panels in page order,
// grouped by the question they answer (the run itself, the record, then
// digging deeper). Each id is set on its panel (RunsTab.svelte,
// RunCharts.svelte); each group's heading is on the page too. Model quality
// (the hydrograph to the plausibility checks) moved to Calibration (issue #586
// Round 3, runs/modelQuality.ts). Each link says
// its panel's heading, and on the bar a shorter name where the heading is long
// (issue #462). The river and unit panels have their own pages (issue #17):
// the run header links there, the side index lists the main ones under their
// pages (otherPageGroups), and their old anchors here are sent on (nav/anchorMoves.ts).
import type { RunSummary } from '@water-management/engine';
import type { NavGroup, NavSection } from '#lib/components/common/sectionNav.js';
import { EWR_MONTHS_HEADING, RESERVE_MONTHS_HEADING, riverHref } from '#lib/components/river/links.js';
import { supplyHref } from '#lib/components/supply/links.js';

export type ResultSection = NavSection;

export interface ResultGroup extends NavGroup {
	/** The group's heading on the page and in the menu; null for the opening group, which needs none. */
	label: string | null;
	sections: ResultSection[];
}

type SectionInput = Pick<RunSummary, 'farms' | 'runoff' | 'wr2012' | 'plausibility' | 'forecast' | 'unitRain' | 'stations'> & { calibration?: Pick<NonNullable<RunSummary['calibration']>, 'siteNodeId'> | null };

/**
 * `rail`: the side index, with a line for each panel. On the bar (which must
 * keep every link on two rows at 1280 px, section-nav.spec.ts) the Record
 * group's Run notes, Evidence and Reproduction are one link, "Notes &
 * evidence", landing on Run notes and standing for the three (`covers`).
 */
export function resultGroups(summary: SectionInput, rail = false): ResultGroup[] {
	return [
		{
			// The run header says whether the run is the evidence and previews its notes (links to Record).
			label: null,
			// A forecast run's forecast days (WP-2.12) follow the summary, apart from it.
			sections: [
				{ id: 'res-summary', label: 'Summary' },
				...(summary.forecast ? [{ id: 'res-forecast', label: 'Forecast' }] : []),
				// The water balance per water year, every run (issue #137): it stays here when Model quality moves to
				// Calibration (issue #586 Round 3, runs/modelQuality.ts), the table a hydrologist hands a client.
				{ id: 'res-water-balance', label: 'Water balance by water year', bar: 'Water balance' }
			]
		},
		{
			// The run's written explanation, its evidence nomination, its validation statement and its publication: sign-off, after the results.
			label: 'Record',
			sections: [
				// The run's notes, its evidence nomination, and its reproduction with the input changes since: a panel each (issue #521),
				// one link on the bar.
				...(rail
					? [
							{ id: 'res-notes', label: 'Run notes' },
							{ id: 'res-evidence', label: 'Evidence' },
							{ id: 'res-reproduce', label: 'Reproduction' }
						]
					: [{ id: 'res-notes', label: 'Run notes & evidence', bar: 'Notes & evidence', covers: ['res-evidence', 'res-reproduce'] }]),
				// The report's validation statement (WP-3.13), collapsed: every run.
				{ id: 'res-validation', label: 'Validation statement', bar: 'Validation' },
				// Whether the run is the published baseline, publishing it, and the WUA's notice (WP-2.3): every run.
				{ id: 'res-publication', label: 'Publication' }
			]
		},
		{
			label: 'Dig deeper',
			sections: [
				{ id: 'res-checks', label: 'Self-checks' },
				// "Outputs" on the bar: with Water balance added, a longer word pushed the last link
				// into More at 1280 px beside the runs rail (issue #137).
				{ id: 'res-explore', label: 'Explore any output', bar: 'Outputs' }
			]
		}
	];
}

/**
 * The side index's last groups (issue #462): the panels that moved from here
 * to EWR and Hydrological units (issue #17), by the same headings
 * those pages give them, linked with the run shown. Only in the rail, which has
 * a line for each: on the bar the run header's links to the two pages do it.
 * The main findings only, so the rail fits a laptop's window: each page's own
 * index lists the rest.
 */
export function otherPageGroups(runId: string | null): NavGroup[] {
	const river = (id: string, label: string): NavSection => ({ id: `river-${id}`, label, href: riverHref(runId, id), page: 'EWR' });
	const units = (id: string, label: string): NavSection => ({ id: `units-${id}`, label, href: supplyHref(runId, { hash: id }), page: 'Hydrological units' });
	return [
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
