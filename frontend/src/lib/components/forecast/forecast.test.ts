import type { ForecastSummary } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { FORECAST_BAND_LABEL, forecastBand, forecastHeading, forecastRows, outletLine } from './forecast';

const summary: ForecastSummary = {
	from: '2026-09-27',
	to: '2026-10-10',
	days: 14,
	lastObserved: '2026-09-26',
	rainMm: 12.34,
	outletEwrDaysAtRisk: 3,
	perFarm: [
		{ nodeId: 'a', name: 'Alpha', minDamPct: 0.4623, minDamDate: '2026-10-02', deficitDays: 0, demandM3: 100, suppliedM3: 100, suppliedFraction: 1 },
		{ nodeId: 'b', name: 'Bravo', minDamPct: null, minDamDate: null, deficitDays: 3, demandM3: 100, suppliedM3: 81.6, suppliedFraction: 0.816 },
		{ nodeId: 'c', name: 'Charlie', minDamPct: 0.001, minDamDate: '2026-10-10', deficitDays: 0, demandM3: 0, suppliedM3: 0, suppliedFraction: null }
	]
};

describe('forecastBand', () => {
	it('is the labelled band from forecastFrom on a forecast run, and nothing on an ordinary run', () => {
		expect(forecastBand('2026-09-27')).toMatchObject({ from: '2026-09-27', label: FORECAST_BAND_LABEL });
		expect(forecastBand('2026-09-27')!.note).toMatch(/forecast rain, not recorded rain/);
		expect(forecastBand(null)).toBeUndefined();
		expect(forecastBand(undefined)).toBeUndefined();
	});
});

describe('forecastRows', () => {
	it('puts farms short on a forecast day first, and words every figure as an expectation in whole percent', () => {
		const rows = forecastRows(summary, new Map([['a', 'Alpha (renamed)']]));
		expect(rows.map((r) => r.nodeId)).toEqual(['b', 'a', 'c']);
		expect(rows[0]).toEqual({ nodeId: 'b', name: 'Bravo', lowestDam: 'no dam', shortDays: '3 of 14', supplied: 'about 82 %', watch: true });
		expect(rows[1]).toMatchObject({ name: 'Alpha (renamed)', lowestDam: 'about 46 %', shortDays: 'none', supplied: 'about 100 %', watch: false });
		expect(rows[2]).toMatchObject({ lowestDam: 'about 0 %', supplied: 'no demand' });
	});
});

describe('the panel wording', () => {
	it('says which days, from how much forecast rain, after which recorded day', () => {
		expect(forecastHeading(summary)).toBe('Next 14 days: 2026-09-27 to 2026-10-10, modelled on 12.3 mm of forecast rain after the last recorded rain on 2026-09-26.');
		expect(forecastHeading({ ...summary, days: 1 })).toMatch(/^Next 1 day:/);
	});

	it('words the outlet as a risk the model expects, with counts only', () => {
		expect(outletLine(summary)).toBe('The model expects the outlet’s ecological flow (EWR) to be at risk on 3 of the 14 forecast days.');
		expect(outletLine({ ...summary, outletEwrDaysAtRisk: 0 })).toBe('The model expects the river’s ecological flow (EWR) at the outlet to be met on all 14 forecast days.');
	});

	it('never states a forecast figure as certain', () => {
		const text = [forecastHeading(summary), outletLine(summary), ...forecastRows(summary).flatMap((r) => [r.lowestDam, r.supplied])].join(' ');
		expect(text).not.toMatch(/\bwill\b|guarantee|certain/i);
	});
});
