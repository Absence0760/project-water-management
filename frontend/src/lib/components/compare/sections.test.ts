import { describe, expect, it } from 'vitest';
import { navText } from '$lib/components/common/sectionNav';
import { compareNavGroups, COMPARE_HEADINGS } from './sections';

const all = { overrides: true, reserve: true, plausibility: true, assurance: true };
const none = { overrides: false, reserve: false, plausibility: false, assurance: false };
const ids = (g: ReturnType<typeof compareNavGroups>) => g.flatMap((x) => x.sections.map((s) => s.id));

describe('compareNavGroups', () => {
	it('lists the summary, then the full comparison under its heading, in page order (issue #462)', () => {
		const groups = compareNavGroups({ summary: { yearsHeading: 'Days below the pragmatic EWR, each year' }, full: all });
		expect(groups.map((g) => g.label)).toEqual([null, 'Full comparison']);
		expect(ids(groups)).toEqual([
			'cmp-outcomes',
			'cmp-years',
			'cmp-overrides',
			'cmp-changes',
			'cmp-headline',
			'cmp-uncertainty',
			'cmp-reserve',
			'cmp-ewr-agreement',
			'cmp-plausibility',
			'cmp-units',
			'cmp-assurance',
			'cmp-series'
		]);
	});

	it('names each link by its panel heading, with a shorter bar name only where the heading is long', () => {
		const groups = compareNavGroups({ summary: { yearsHeading: 'Days below the pragmatic EWR, each year' }, full: all });
		const flat = groups.flatMap((g) => g.sections);
		expect(flat.map((s) => s.label)).toEqual([
			COMPARE_HEADINGS.outcomes,
			'Days below the pragmatic EWR, each year',
			COMPARE_HEADINGS.overrides,
			COMPARE_HEADINGS.changes,
			COMPARE_HEADINGS.headline,
			COMPARE_HEADINGS.uncertainty,
			'Reserve compliance by month',
			'EWR test against observed flow',
			'Plausibility checks',
			COMPARE_HEADINGS.units,
			COMPARE_HEADINGS.assurance,
			COMPARE_HEADINGS.series
		]);
		expect(flat.map((s) => navText(s, 'bar'))).toEqual([
			'What the change does',
			'Days below, by year',
			'Scenario overrides',
			'Inputs that differ',
			'Headline results',
			'Uncertainty',
			'Reserve by month',
			'EWR vs observed',
			'Plausibility',
			'Hydrological units',
			'Assurance of supply',
			'Daily series'
		]);
	});

	it('lists only the panels drawn: the optional ones by the pair, nothing before a comparison loads', () => {
		expect(ids(compareNavGroups({ summary: { yearsHeading: 'x' }, full: none }))).toEqual([
			'cmp-outcomes',
			'cmp-years',
			'cmp-changes',
			'cmp-headline',
			'cmp-uncertainty',
			'cmp-ewr-agreement',
			'cmp-units',
			'cmp-series'
		]);
		// The full comparison of the what-if picked can arrive before or after the summary.
		expect(ids(compareNavGroups({ summary: null, full: none }))[0]).toBe('cmp-changes');
		expect(ids(compareNavGroups({ summary: { yearsHeading: 'x' }, full: null }))).toEqual(['cmp-outcomes', 'cmp-years']);
		expect(ids(compareNavGroups({ summary: null, full: null }))).toEqual([]);
	});
});
