// Compare runs' section menu (common/SectionNav, issue #462): the summary on
// top (what the change does, the days below the reserve each year), then the
// full comparison's panels in page order under its heading. Each id is set on
// its panel in CompareView.svelte, each link says the panel's heading, and on
// the bar a shorter name where the heading is long. Panels drawn only for
// some pairs (a scenario's overrides, reserve compliance, plausibility,
// assurance of supply) are listed only when drawn.
import type { NavGroup, NavSection } from '$lib/components/common/sectionNav';

export interface CompareNavInput {
	/** The summary is drawn (a what-if's comparison has loaded); its days-below chart's heading. */
	summary: { yearsHeading: string } | null;
	/** The full comparison is drawn, and which of its optional panels. */
	full: { overrides: boolean; reserve: boolean; plausibility: boolean; assurance: boolean } | null;
}

/** The headings of the full comparison's panels, as CompareView draws them. */
export const COMPARE_HEADINGS = {
	outcomes: 'What the change does',
	overrides: 'Scenario overrides',
	changes: 'Inputs that differ',
	headline: 'Headline results',
	uncertainty: 'Uncertainty',
	reserve: 'Reserve compliance by month',
	ewrAgreement: 'EWR test against observed flow',
	plausibility: 'Plausibility checks',
	units: 'Hydrological units',
	assurance: 'Assurance of supply',
	series: 'Daily series'
} as const;

export function compareNavGroups({ summary, full }: CompareNavInput): NavGroup[] {
	const H = COMPARE_HEADINGS;
	const top: NavSection[] = summary
		? [
				{ id: 'cmp-outcomes', label: H.outcomes },
				{ id: 'cmp-years', label: summary.yearsHeading, bar: 'Days below, by year' }
			]
		: [];
	const rest: NavSection[] = full
		? [
				...(full.overrides ? [{ id: 'cmp-overrides', label: H.overrides }] : []),
				{ id: 'cmp-changes', label: H.changes },
				{ id: 'cmp-headline', label: H.headline },
				{ id: 'cmp-uncertainty', label: H.uncertainty },
				...(full.reserve ? [{ id: 'cmp-reserve', label: H.reserve, bar: 'Reserve by month' }] : []),
				{ id: 'cmp-ewr-agreement', label: H.ewrAgreement, bar: 'EWR vs observed' },
				...(full.plausibility ? [{ id: 'cmp-plausibility', label: H.plausibility, bar: 'Plausibility' }] : []),
				{ id: 'cmp-units', label: H.units },
				...(full.assurance ? [{ id: 'cmp-assurance', label: H.assurance }] : []),
				{ id: 'cmp-series', label: H.series }
			]
		: [];
	return [
		// The summary has no heading of its own on the page: the opening group, unnamed (as Runs & results' Summary).
		{ label: null, sections: top },
		{ label: 'Full comparison', sections: rest }
	];
}
