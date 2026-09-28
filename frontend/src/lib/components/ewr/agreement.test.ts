import { describe, expect, it } from 'vitest';
import { ewrAgreement, type RunSummary } from '@water-management/engine';
import { agreementGap, biasVerdict, fmtRatio, monthRows, waterYearRows } from './agreement';

// Synthetic: 2021-09-28 … 2021-10-03, EWR 100 m³/day. The model is below on
// days 0, 1, 4, 5; the observed flow on days 0, 2, 4.
const sim = [50, 50, 150, 150, 50, 50];
const obs = [50, 150, 50, 150, 50, 150].map((v) => v / 86_400);
const table = ewrAgreement(sim, obs, new Array(6).fill(100), { startDate: '2021-09-28' });

const summary = (over: Partial<RunSummary['catchment']>, calibration: RunSummary['calibration'] = null) =>
	({
		catchment: { meanNaturalFlowM3Day: 0, meanSimulatedOutflowM3Day: 0, ewrDaysNotMet: 0, ewrFractionDaysNotMet: 0, ...over },
		calibration
	}) as Pick<RunSummary, 'catchment' | 'calibration'>;

describe('EWR agreement display', () => {
	it('lists all 12 months in water-year order and the water years present', () => {
		const rows = monthRows(table);
		expect(rows.map((r) => r.label)).toEqual(['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep']);
		expect(rows[0]).toMatchObject({ days: 3, bothBelow: 1, falseAlarm: 1, bothAbove: 1 });
		expect(rows[11]).toMatchObject({ days: 3, bothBelow: 1, falseAlarm: 1, miss: 1 });
		expect(rows[4]!.days).toBe(0);
		expect(waterYearRows(table).map((r) => r.label)).toEqual(['2020/21', '2021/22']);
	});

	it('says in words how often the model fails the EWR against the river', () => {
		expect(biasVerdict(table.overall)).toBe('The model fails the EWR 1.3× as often as the observed river did.');
		expect(biasVerdict({ days: 10, bothBelow: 9, falseAlarm: 1, miss: 1, frequencyBias: 1 })).toMatch(/about as often/);
		expect(biasVerdict({ days: 10, bothBelow: 1, falseAlarm: 0, miss: 3, frequencyBias: 0.25 })).toBe(
			'The model fails the EWR on 25% as many days as the observed river did.'
		);
		expect(biasVerdict({ days: 10, bothBelow: 0, falseAlarm: 2, miss: 0, frequencyBias: null })).toMatch(/never fell below the EWR, but the model is below it on 2/);
		expect(biasVerdict({ days: 10, bothBelow: 0, falseAlarm: 0, miss: 0, frequencyBias: null })).toMatch(/Neither/);
		expect(biasVerdict({ days: 0, bothBelow: 0, falseAlarm: 0, miss: 0, frequencyBias: null })).toBe('No observed days to compare.');
	});

	it('formats ratios, with a dash when there is no denominator', () => {
		expect(fmtRatio(4 / 3)).toBe('1.33');
		expect(fmtRatio(null)).toBe('–');
	});

	it('explains why a run has no table', () => {
		expect(agreementGap(summary({ ewrAgreement: table }))).toBeNull();
		expect(agreementGap(summary({}))).toMatch(/before the EWR agreement existed/);
		expect(agreementGap(summary({ ewrAgreement: null }))).toMatch(/no observed gauge or logger flow/);
		const empty = ewrAgreement([1], [null], [1], { startDate: '2021-01-01' });
		expect(agreementGap(summary({ ewrAgreement: empty }))).toMatch(/no day inside the run/);
	});
});
