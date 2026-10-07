import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@water-management/engine';
import { headlines } from '$lib/components/overview/latestRun';
import { riverKpis } from '$lib/components/river/river';
import { EWR_NOT_MET, daysBelowTest, daysBelowTestOf, ewrNotMet } from './notMet';

describe('ewrNotMet', () => {
	it('words the pragmatic EWR test one way: the share not met and the days not met of the record', () => {
		expect(ewrNotMet({ ewrDaysNotMet: 4316, ewrFractionDaysNotMet: 4316 / 5479 }, 5479)).toEqual({
			term: 'EWR not met',
			help: 'catchment.ewrFractionDaysNotMet',
			value: '78.8%',
			unit: 'of days',
			count: '4 316 of 5 479 days at the outflow gauge',
			flagged: true
		});
	});

	it('flags it above 5% of days, not at it', () => {
		expect(ewrNotMet({ ewrDaysNotMet: 5, ewrFractionDaysNotMet: 0.05 }, 100).flagged).toBe(false);
		expect(ewrNotMet({ ewrDaysNotMet: 6, ewrFractionDaysNotMet: 0.06 }, 100).flagged).toBe(true);
		expect(ewrNotMet({ ewrDaysNotMet: 0, ewrFractionDaysNotMet: 0 }, 100)).toMatchObject({ value: '0.0%', flagged: false });
	});
});

// Issue #162, item 18: the Summary said "EWR not met 78.8%" while River & reserve said "Reserve met 21.2%"
// for the same run. Both now take their words from ewrNotMet, so they can't drift apart again.
describe('the Summary and River & reserve frame the figure the same way', () => {
	const s = {
		catchment: { meanNaturalFlowM3Day: 86_400, meanSimulatedOutflowM3Day: 43_200, ewrDaysNotMet: 4316, ewrFractionDaysNotMet: 4316 / 5479 },
		farms: []
	} as unknown as RunSummary;

	it('has the same term, value, unit and count on the Summary card and the River tile', () => {
		const card = headlines(s, 5479, null).find((h) => h.id === 'ewr')!;
		const tile = riverKpis(s, 5479, null).find((k) => k.id === 'ewr')!;
		expect(card.term).toBe(EWR_NOT_MET);
		expect(tile.term).toBe(EWR_NOT_MET);
		expect([tile.value, tile.unit, tile.sub[0]]).toEqual([card.value, card.unit, card.sub[0]]);
		expect(tile.spec).toEqual(card.spec);
	});
});

describe('daysBelowTest', () => {
	it('calls the pragmatic count "the reserve" without a rule table, and "the pragmatic EWR" beside one (issue #177)', () => {
		expect(daysBelowTest(false)).toBe('the reserve');
		expect(daysBelowTest(true)).toBe('the pragmatic EWR');
	});
});

describe('daysBelowTestOf', () => {
	const site = { isOutlet: true } as NonNullable<RunSummary['ewrAssurance']>[number];
	it('names the pragmatic EWR once any compared run has a rule table, and the reserve when none has', () => {
		expect(daysBelowTestOf([{ summary: { ewrAssurance: [] } }, { summary: {} }])).toBe('the reserve');
		expect(daysBelowTestOf([{ summary: { ewrAssurance: [] } }, { summary: { ewrAssurance: [site] } }])).toBe('the pragmatic EWR');
		expect(daysBelowTestOf([])).toBe('the reserve');
	});
	it("follows each run's project choice: a table judged by the pragmatic EWR leaves the count as the reserve (issue #444)", () => {
		expect(daysBelowTestOf([{ summary: { ewrAssurance: [site] }, choice: { source: 'pragmatic' } }])).toBe('the reserve');
		expect(daysBelowTestOf([{ summary: { ewrAssurance: [site] }, choice: { source: 'auto' } }])).toBe('the pragmatic EWR');
		expect(daysBelowTestOf([{ summary: { ewrAssurance: [site] }, choice: { source: 'pragmatic' } }, { summary: { ewrAssurance: [site] } }])).toBe('the pragmatic EWR');
	});
});
