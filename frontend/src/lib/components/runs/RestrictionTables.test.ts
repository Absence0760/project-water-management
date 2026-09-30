// The drought restriction tables (RestrictionTables.svelte, engine 1.52.0,
// WP-3.8), rendered to HTML with Svelte's server renderer.
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@water-management/engine';
import RestrictionTables from './RestrictionTables.svelte';

const text = (html: string) => html.replace(/<!--[^>]*-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const unit = (i: number, cut: number) => ({ nodeId: `n${i}`, name: `Farm ${String(i).padStart(2, '0')}`, avgDemandM3Day: 100, avgRestrictedDemandM3Day: 100 - cut, avgSuppliedM3Day: 90 - cut, avgCutOnRestrictedDaysM3Day: cut ? cut * 4 : null });
const summary = (units = [unit(1, 20)], years = 1) =>
	({
		farms: [],
		catchment: {},
		warnings: [],
		droughtRestriction: {
			rule: { reviewDates: ['01-01'], levels: [{ label: 'Level 1', belowPct: 0.6, cuts: { crops: 0.3 } }] },
			years: Array.from({ length: years }, (_, k) => ({ waterYear: 2003 + k, days: 365, daysByLevel: [300, 65] })),
			daysByLevel: [300 * years, 65 * years],
			reviews: 1,
			units
		}
	}) as unknown as RunSummary;

describe('the drought restriction tables (engine 1.52.0, WP-3.8)', () => {
	it('shows the rule in words, the days at each level per water year and over the run, and each unit’s cut, on restricted days too', () => {
		const body = text(render(RestrictionTables, { props: { summary: summary() } }).body);
		expect(body).toContain('Drought restrictions');
		expect(body).toContain('reviewed 1 Jan; Level 1 (below 60 %): crops 30 %');
		expect(body).toContain('decided 1 time in the run');
		expect(body).toContain('Water year Days No restriction Level 1 (below 60 %) Days restricted');
		expect(body).toContain('2003/04 365 300 65 65');
		expect(body).toContain('Whole run 365 300 65 65');
		expect(body).toContain('Farm 01 100 80 20 20.0% 80 70');
		expect(body).toContain('not the restriction notice farmers see');
	});

	it('puts the most cut first, and folds long lists behind "Show all"', () => {
		const units = Array.from({ length: 14 }, (_, i) => unit(i + 1, i));
		const body = text(render(RestrictionTables, { props: { summary: summary(units, 12) } }).body);
		// Farm 14 is cut 13, the most: first. Farm 01, never cut, is past the fold.
		expect(body.indexOf('Farm 14')).toBeLessThan(body.indexOf('Farm 13'));
		expect(body).not.toContain('Farm 01');
		expect(body).toContain('Show all 14 hydrological units');
		expect(body).toContain('Show all 12 water years');
		expect(body).not.toContain('2014/15');
	});

	it('draws nothing without the rule', () => {
		const s = { ...summary(), droughtRestriction: undefined } as unknown as RunSummary;
		expect(text(render(RestrictionTables, { props: { summary: s } }).body).trim()).toBe('');
	});
});
