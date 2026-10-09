// Settings → the daily EWR at the outlet (engine ≥ 1.77.0, issue #455): the form's helpers.
import { blankEwrDailySource, type EwrDailySource } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { dailySourceError, exampleDailyCsv, lastRunScale, parseMonthlyRow, scaleFactor } from './ewrDailySource';
import { parseGrid } from './ewrRules';

const tab = (over: Partial<EwrDailySource> = {}): EwrDailySource => ({ ...blankEwrDailySource(), method: 'tab', tabM3s: new Array(12).fill(0.5), tableMarMm3: 100, ...over });

describe('dailySourceError', () => {
	it('null for none, the pragmatic EWR and a complete source; the engine’s first issue otherwise', () => {
		expect(dailySourceError(null)).toBeNull();
		expect(dailySourceError(undefined)).toBeNull();
		expect(dailySourceError(blankEwrDailySource())).toBeNull();
		expect(dailySourceError(tab())).toBeNull();
		expect(dailySourceError(tab({ tableMarMm3: null }))).toBe('Daily EWR at the outlet: Scaling by MAR needs the table’s MAR (Mm³ a year, the TAB header’s “MAR =”).');
	});
});

describe('scaleFactor', () => {
	it('the area ratio: its value and inputs, or what it needs', () => {
		expect(scaleFactor(tab({ scaling: 'area', tableAreaKm2: 16 }), 4, null)).toBe('Scale factor s = 4 km² ÷ 16 km² = 0.25.');
		expect(scaleFactor(tab({ scaling: 'area' }), 4, null)).toBe('Scale factor: enter the table’s catchment area.');
		expect(scaleFactor(tab({ scaling: 'area', tableAreaKm2: 16 }), 0, null)).toMatch(/^Scale factor: 0, since no hydrological unit/);
	});
	it('the MAR ratio: from the last run, exact or estimated, or after a run', () => {
		expect(scaleFactor(tab({ tableMarMm3: 92.415 }), 4, null)).toMatch(/÷ 92\.415 Mm³\/a, worked out by each run from its own natural flow\. Run the model to see it\.$/);
		expect(scaleFactor(tab(), 4, { modelMarMm3: 25, exact: true })).toMatch(/: the last run’s 25 ÷ 100 = 0\.25\.$/);
		expect(scaleFactor(tab(), 4, { modelMarMm3: 25, exact: false })).toMatch(/about, from the last run’s mean natural flow, 25 ÷ 100/);
		expect(scaleFactor(tab({ tableMarMm3: null }), 4, null)).toBe('Scale factor: enter the table’s MAR.');
	});
});

describe('lastRunScale', () => {
	it('the run’s own MAR when it used the tables, else an estimate from its mean natural flow', () => {
		expect(lastRunScale({ catchment: { meanNaturalFlowM3Day: 1e6, outletEwr: { method: 'tab', scaling: 'mar', scale: 0.5, modelMarMm3: 50, tableMarMm3: 100 } } })).toEqual({ modelMarMm3: 50, exact: true });
		expect(lastRunScale({ catchment: { meanNaturalFlowM3Day: 1e6 } })).toEqual({ modelMarMm3: 365.25, exact: false });
		expect(lastRunScale(null)).toBeNull();
	});
});

describe('parseMonthlyRow', () => {
	it('reads 12 flows in a row or a column, with month names, and a decimal comma in a tab-separated paste', () => {
		const v = Array.from({ length: 12 }, (_, i) => i + 0.5);
		expect(parseMonthlyRow(v.join(' '))).toEqual({ values: v });
		expect(parseMonthlyRow(v.join('\n'))).toEqual({ values: v });
		expect(parseMonthlyRow(v.join(', '))).toEqual({ values: v });
		expect(parseMonthlyRow(['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'].map((m, i) => `${m}\t${String(v[i]).replace('.', ',')}`).join('\n'))).toEqual({ values: v });
	});
	it('says what is wrong', () => {
		expect(parseMonthlyRow('')).toEqual({ error: 'Paste the 12 flows first.' });
		expect(parseMonthlyRow('1 2 3')).toEqual({ error: 'Expected 12 flows, Oct … Sep; the paste has 3.' });
		expect(parseMonthlyRow('1 2 x')).toEqual({ error: '“x” isn\'t a number.' });
	});
});

it('the example CSV reads as a percentile table of the ten points', () => {
	const g = parseGrid(exampleDailyCsv());
	expect('error' in g).toBe(false);
	if (!('error' in g)) expect(g.points).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 99]);
});
