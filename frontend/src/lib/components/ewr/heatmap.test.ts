import { describe, expect, it } from 'vitest';
import type { EwrCompliance } from '@water-management/engine';
import { EWR_TRAFFIC_LIGHT } from '@water-management/engine';
import { bandLabels } from './bands';
import { bandPct, binVolume, cellPct, fmtCompact, fmtVolume, legend, maxShortfall, monthProfile, totals, worstYears } from './heatmap';

const row = (vals: Record<number, number>) => Array.from({ length: 12 }, (_, i) => vals[i] ?? 0);

// Two water years; the first starts in Sep (a one-month part year).
const c: EwrCompliance = {
	waterYears: [2019, 2020],
	days: [row({ 11: 30 }), row({ 0: 31, 1: 30, 2: 31 })],
	outlet: {
		nodeId: null,
		name: 'Gauge',
		daysNotMet: [row({ 11: 3 }), row({ 0: 31, 2: 10 })],
		shortfallM3: [row({ 11: 1500 }), row({ 0: 2_000_000, 2: 40_000 })]
	},
	farms: []
};

describe('binning', () => {
	it('bands % of days by the EWR traffic light: green under 5 %, amber under 20 %, red from 20 %', () => {
		expect(bandPct(0, 0)).toBeNull();
		expect(bandPct(0, 31)).toBe('green');
		expect(bandPct(1, 31)).toBe('green'); // 3.2 %
		expect(bandPct(2, 31)).toBe('amber'); // 6.5 %
		expect(bandPct(5, 100)).toBe('amber');
		expect(bandPct(6, 31)).toBe('amber'); // 19.4 %
		expect(bandPct(20, 100)).toBe('red');
		expect(bandPct(31, 31)).toBe('red');
	});

	it('bins volume relative to the grid maximum', () => {
		expect(binVolume(0, 100)).toBe(0);
		expect(binVolume(5, 0)).toBe(0);
		expect(binVolume(10, 100)).toBe(1);
		expect(binVolume(20, 100)).toBe(2);
		expect(binVolume(40, 100)).toBe(3);
		expect(binVolume(100, 100)).toBe(4);
	});

	it('computes cell percentages, null when nothing was simulated', () => {
		expect(cellPct(3, 30)).toBe(10);
		expect(cellPct(0, 0)).toBeNull();
	});
});

describe('legend and formatting', () => {
	it('states the three bands for % of days, and five volume steps', () => {
		expect(legend('pct')).toEqual([
			{ cls: 'green', label: 'Green: under 5% of days not met' },
			{ cls: 'amber', label: 'Amber: 5% to under 20%' },
			{ cls: 'red', label: 'Red: 20% or more' }
		]);
		const v = legend('volume', 2_000_000);
		expect(v.map((l) => l.cls)).toEqual(['v0', 'v1', 'v2', 'v3', 'v4']);
		expect(v[1]!.label).toBe('≤ 200\u202f000 m³');
		expect(v[4]!.label).toBe('> 1.00 Mm³');
	});

	it('reads the engine’s traffic light, the portfolio’s defaults (backend portfolio/status.ts uses the same constant)', () => {
		expect(bandLabels()).toEqual(bandLabels(EWR_TRAFFIC_LIGHT));
		expect(bandLabels({ green: 10, amber: 30 }).amber).toBe('Amber: 10% to under 30%');
	});

	it('abbreviates cell values', () => {
		expect(fmtCompact(45)).toBe('45');
		expect(fmtCompact(1234)).toBe('1.2k');
		expect(fmtCompact(45_600)).toBe('46k');
		expect(fmtCompact(2_300_000)).toBe('2.3M');
		expect(fmtCompact(23_000_000)).toBe('23M');
	});

	it('formats volumes in m³ or Mm³', () => {
		expect(fmtVolume(1500)).toBe('1\u202f500 m³');
		expect(fmtVolume(2_345_678)).toBe('2.35 Mm³');
		expect(fmtVolume(NaN)).toBe('–');
	});
});

describe('summaries', () => {
	it('totals only simulated months', () => {
		expect(totals(c, c.outlet)).toEqual({ daysNotMet: 44, days: 122, shortfallM3: 2_041_500, monthsFailed: 3, months: 4 });
		expect(maxShortfall(c.outlet)).toBe(2_000_000);
	});

	it('builds a typical-year profile per month', () => {
		const p = monthProfile(c, c.outlet);
		expect(p[0]).toBe(100);
		expect(p[1]).toBe(0);
		expect(p[2]).toBeCloseTo(1000 / 31, 10);
		expect(p[5]).toBeNull();
		expect(p[11]).toBe(10);
	});

	it('ranks the worst water years', () => {
		expect(worstYears(c, c.outlet).map((y) => y.waterYear)).toEqual([2020, 2019]);
		expect(worstYears(c, c.outlet, 1)[0]!.daysNotMet).toBe(41);
	});
});
