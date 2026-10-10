// The Runs & results page's in-page menu: the results panels in page order,
// grouped by the question they answer (the model's quality, the record, then
// digging deeper). Each id is set on its panel (RunsTab.svelte,
// RunCharts.svelte); each group's heading is on the page too. Each link says
// its panel's heading, and on the bar a shorter name where the heading is long
// (issue #462). The river and unit panels have their own pages (issue #17):
// the run header links there, the side index lists the main ones under their
// pages (otherPageGroups), and their old anchors here are sent on (movedHref).
import type { RunSummary } from '@water-management/engine';
import type { NavGroup, NavSection } from '$lib/components/common/sectionNav';
import { EWR_MONTHS_HEADING, RESERVE_MONTHS_HEADING, riverAnchor, riverHref } from '$lib/components/river/links';
import { supplyAnchor, supplyHref } from '$lib/components/supply/links';
import { runoffModelName } from './runoff';
import { unitRainOf } from './unitRain';

export type ResultSection = NavSection;

export interface ResultGroup extends NavGroup {
	/** The group's heading on the page and in the menu; null for the opening group, which needs none. */
	label: string | null;
	sections: ResultSection[];
}

type SectionInput = Pick<RunSummary, 'farms' | 'runoff' | 'wr2012' | 'plausibility' | 'forecast' | 'unitRain'>;

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
				{ id: 'res-fdc', label: 'Flow-duration curve', bar: 'Flow duration' },
				// The calibration statistics and the fit record.
				{ id: 'res-calibration', label: 'Calibration against observed flow', bar: 'Calibration' },
				// The water balance per water year, every run (issue #137; it was only under Self-checks).
				{ id: 'res-water-balance', label: 'Water balance by water year', bar: 'Water balance' },
				// Runoff model balance: conceptual models (GR4J) only.
				...(summary.runoff ? [{ id: 'res-runoff', label: `Runoff model: ${runoffModelName(summary.runoff)}`, bar: 'Runoff model' }] : []),
				// Rain for each unit: runs with settings.unitRain perUnit only (issue #482).
				...(unitRainOf(summary) ? [{ id: 'res-unit-rain', label: 'Rain for each unit', bar: 'Unit rain' }] : []),
				// WR2012 check: only when the project has a reference.
				...(summary.wr2012 ? [{ id: 'res-wr2012', label: wr2012Heading(summary.wr2012), bar: 'WR2012 check' }] : []),
				{ id: 'res-ewr-agreement', label: 'EWR test: model against observed flow', bar: 'EWR vs observed' },
				// Hydrologist plausibility checks: runs made by engine ≥ 0.25.0.
				// "Plausibility" on the bar, as the Summary's model-checks line says it: the shorter word keeps the
				// whole bar on two rows at 1280 px beside the runs rail (issue #137).
				...(summary.plausibility ? [{ id: 'res-plausibility', label: 'Plausibility checks', bar: 'Plausibility' }] : [])
			]
		},
		{
			// The run's written explanation, its evidence nomination, its validation statement and its publication: sign-off, after the results.
			label: 'Record',
			sections: [
				// The run's notes, then its evidence nomination, reproduction and inputs: one entry (its first heading is "Run notes").
				{ id: 'res-notes', label: 'Run notes & evidence', bar: 'Notes & evidence' },
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

/** The WR2012 panel's heading (Wr2012Panel): the check and the quaternary it compares with. */
function wr2012Heading(report: NonNullable<RunSummary['wr2012']>): string {
	return report.quaternary ? `WR2012 check: ${report.quaternary}` : 'WR2012 check';
}

/**
 * The side index's last groups (issue #462): the panels that moved from here
 * to River & reserve and Hydrological units (issue #17), by the same headings
 * those pages give them, linked with the run shown. Only in the rail, which has
 * a line for each: on the bar the run header's links to the two pages do it.
 * The main findings only, so the rail fits a laptop's window: each page's own
 * index lists the rest.
 */
export function otherPageGroups(runId: string | null): NavGroup[] {
	const river = (id: string, label: string): NavSection => ({ id: `river-${id}`, label, href: riverHref(runId, id), page: 'River & reserve' });
	const units = (id: string, label: string): NavSection => ({ id: `units-${id}`, label, href: supplyHref(runId, { hash: id }), page: 'Hydrological units' });
	return [
		{
			label: 'On River & reserve',
			sections: [river('res-reserve', RESERVE_MONTHS_HEADING), river('res-ewr-grid', EWR_MONTHS_HEADING), river('res-water-account', 'Water account')]
		},
		{
			label: 'On Hydrological units',
			sections: [units('res-curtailment', 'Curtailment targets'), units('res-assurance', 'Assurance of supply')]
		}
	];
}

/** Every section in page order: the scroll spy's list. */
export const resultSections = (summary: SectionInput): ResultSection[] => resultGroups(summary).flatMap((g) => g.sections);

/**
 * Where a `#res-…` fragment on Runs & results now lives, when it moved: a panel
 * of River & reserve or Hydrological units (the same panel there, keeping the run
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
