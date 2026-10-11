// Settings → the daily EWR at the outlet (engine ≥ 1.77.0, issue #455): the form's helpers.
import { blankEwrDailySource, type EwrDailySource } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { dailySourceError, exampleDailyCsv, knownScale, lastRunScale, parseMonthlyRow, rulLoad, scaledEwrTables, scaleFactor } from './ewrDailySource';
import { parseGrid } from './ewrRules';

// The MAR ratio by default here; a new source scales by area (issue #90 B2), which the area tests set.
const tab = (over: Partial<EwrDailySource> = {}): EwrDailySource => ({ ...blankEwrDailySource(), scaling: 'mar', method: 'tab', tabM3s: new Array(12).fill(0.5), tableMarMm3: 100, ...over });

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

describe('knownScale', () => {
	it('the area ratio from the two areas, at once; null without both', () => {
		expect(knownScale(tab({ scaling: 'area', tableAreaKm2: 16 }), 4, null)).toBe(0.25);
		expect(knownScale(tab({ scaling: 'area' }), 4, null)).toBeNull();
		expect(knownScale(tab({ scaling: 'area', tableAreaKm2: 16 }), 0, null)).toBeNull();
	});
	it('the MAR ratio only once a run gives the model’s MAR (exact or estimated)', () => {
		expect(knownScale(tab(), 4, null)).toBeNull();
		expect(knownScale(tab(), 4, { modelMarMm3: 25, exact: true })).toBe(0.25);
		expect(knownScale(tab(), 4, { modelMarMm3: 50, exact: false })).toBe(0.5);
		expect(knownScale(tab({ tableMarMm3: null }), 4, { modelMarMm3: 25, exact: true })).toBeNull();
	});
});

describe('scaledEwrTables (issue #90 B1 gap a)', () => {
	const row = [10, 8, 6, 5, 4, 3, 2, 1.5, 1, 0.5];
	it('the TAB flows × s; only the tables the method reads', () => {
		const t = scaledEwrTables(tab({ tabM3s: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24], naturalPctM3s: [row] }), 0.5);
		expect(t).toEqual({ method: 'tab', scale: 0.5, tabM3s: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], naturalPctM3s: null, reservePctM3s: null });
	});
	it('both percentile tables × s, a blank cell staying blank', () => {
		const nat = new Array(12).fill(row);
		const res = new Array(12).fill(row.map((v) => v / 2));
		res[0] = [Number.NaN, ...row.slice(1).map((v) => v / 2)];
		const t = scaledEwrTables({ ...blankEwrDailySource(), method: 'percentile', naturalPctM3s: nat, reservePctM3s: res, tableAreaKm2: 40 }, 2)!;
		expect(t.method).toBe('percentile');
		expect(t.tabM3s).toBeNull();
		expect(t.naturalPctM3s![11]).toEqual(row.map((v) => v * 2));
		expect(t.reservePctM3s![0]![0]).toBeNull();
		expect(t.reservePctM3s![5]).toEqual(row);
	});
	it('null for the pragmatic EWR, an unknown s, or tables not yet entered', () => {
		expect(scaledEwrTables(null, 1)).toBeNull();
		expect(scaledEwrTables(blankEwrDailySource(), 1)).toBeNull();
		expect(scaledEwrTables(tab(), null)).toBeNull();
		expect(scaledEwrTables(tab(), Number.NaN)).toBeNull();
		expect(scaledEwrTables(tab({ tabM3s: null }), 1)).toBeNull();
		expect(scaledEwrTables({ ...blankEwrDailySource(), method: 'percentile' }, 1)).toBeNull();
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

describe('rulLoad: a .rul fills the percentile tables and never changes the method', () => {
	const tables = { naturalPctM3s: [[1]], reservePctM3s: [[0.5]] };
	it('under the TAB file: the tables only, the TAB file still in use, the switch offered', () => {
		const out = rulLoad('tab', tables, 'x.rul', 'm3s');
		expect(out.patch).toEqual(tables);
		expect('method' in out.patch).toBe(false);
		expect(out.offerPercentile).toBe(true);
		expect(out.text).toBe(
			'Read x.rul (DRM rule curves, m³/s): filled the two percentile tables (the total Reserve and the natural duration curve). The daily EWR still comes from the DRM TAB file; the tables are used only once you pick them.'
		);
	});
	it('under the percentile tables: the tables, no switch to offer; an Mm³ file says it was converted', () => {
		const out = rulLoad('percentile', tables, 'x.rul', 'mcm');
		expect(out.patch).toEqual(tables);
		expect(out.offerPercentile).toBe(false);
		expect(out.text).toBe('Read x.rul (DRM rule curves, converted from Mm³ a month to m³/s, February 28 days): the total Reserve and the natural duration curve fill the two tables.');
	});
	it('names the pragmatic EWR when that is the method', () => {
		expect(rulLoad('pragmatic', tables, 'x.rul', 'm3s').text).toContain('still comes from the pragmatic EWR');
	});
});
