import { describe, expect, it } from 'vitest';
import { barChart, CHART_BASE, damChart, damRows, damSummary, monthLabels, niceMax, rangeCaption, supplyRows, supplySummary } from './chart';
import { vaalbankFixture } from './fixture';

const sp = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ');
const { farm } = vaalbankFixture();

describe('month labels', () => {
	it('marks the month dataUntil cuts short', () => {
		const l = monthLabels(farm.monthly, farm.dataUntil);
		expect(l.map((x) => x.letter).join('')).toBe('FMAMJJASONDJ*');
		expect(l[0]!.row).toBe('Feb 2023');
		expect(l[11]!.row).toBe('1–10 Jan 2024');
		expect(monthLabels(farm.monthly, '2024-01-31')[11]!.partial).toBe(false);
	});

	it('captions the range as board 1 does', () => {
		expect(rangeCaption(farm.monthly, farm.dataUntil)).toBe('Feb 2023 to Jan 2024. * January to the 10th.');
		expect(rangeCaption(farm.monthly, '2024-01-31')).toBe('Feb 2023 to Jan 2024.');
		expect(rangeCaption(farm.monthly, '2024-01-02')).toBe('Feb 2023 to Jan 2024. * January to the 2nd.');
	});
});

describe('the needed/received bars', () => {
	it('tops the axis at a round number whose half is round', () => {
		expect(niceMax(116.5)).toBe(120);
		expect(niceMax(45)).toBe(50);
		expect(niceMax(7)).toBe(8);
		expect(niceMax(0)).toBe(1);
	});

	it('draws at the rendered width, bars inside the plot and on the axis', () => {
		for (const width of [256, 296, 496]) {
			const c = barChart(farm.monthly, farm.dataUntil, width);
			expect(c.width).toBe(width);
			expect(c.ticks.map((t) => t.label)).toEqual(['120', '60', '0']);
			expect(c.groups).toHaveLength(12);
			for (const g of c.groups) {
				expect(g.need.x).toBeGreaterThanOrEqual(c.axisLeft);
				expect(g.got.x + g.got.w).toBeLessThanOrEqual(width);
				expect(g.need.y + g.need.h).toBeCloseTo(CHART_BASE);
				expect(g.got.h).toBeLessThanOrEqual(g.need.h + 1e-9);
			}
		}
		const c = barChart(farm.monthly, farm.dataUntil, 296);
		// November: needed 106.1, received 67.5 ML.
		expect(c.groups[9]!.need.h).toBeCloseTo((106.1 / 120) * 120);
		expect(c.groups[9]!.got.h).toBeCloseTo((67.5 / 120) * 120);
		expect(c.groups[11]!.label).toBe('J*');
	});

	it('sums the chart up and lists all 12 months with years', () => {
		expect(supplySummary(farm.monthly, farm.dataUntil)).toBe(
			'Water you needed and received each month, February 2023 to 10 January 2024. You were short in February, March, November and December. The numbers are in the table below.'
		);
		const rows = supplyRows(farm.monthly, farm.dataUntil);
		expect(rows).toHaveLength(12);
		expect(rows.map((r) => [r.label, sp(r.need), sp(r.got)])[0]).toEqual(['Feb 2023', '104.4 ML', '83.1 ML']);
		expect(rows.map((r) => [r.label, sp(r.need), sp(r.got)])[10]).toEqual(['Dec 2023', '110 ML', '96.3 ML']);
		expect(rows[11]!.label).toBe('1–10 Jan 2024');
	});
});

describe('the dam line', () => {
	it('draws a point per month and the stop level', () => {
		const c = damChart(farm.monthly, farm.dataUntil, 296, farm.damMinPct);
		expect(c.points.split(' ')).toHaveLength(12);
		expect(c.stopY).toBeCloseTo(CHART_BASE - 0.15 * 120);
		expect(c.ticks.map((t) => sp(t.label))).toEqual(['100 %', '50 %', '0 %']);
		expect(damChart(farm.monthly, farm.dataUntil, 296, 0).stopY).toBeNull();
	});

	it('sums the line up and tabulates it', () => {
		expect(sp(damSummary(farm.monthly, farm.dataUntil))).toBe(
			'Dam level at the end of each month, February 2023 to 10 January 2024. Lowest 16 % at the end of February 2023, highest 100 % at the end of April 2023, and 24 % on 10 January 2024. The numbers are in the table below.'
		);
		expect(damRows(farm.monthly, farm.dataUntil).map((r) => sp(r.pct))).toEqual(['16 %', '82 %', '100 %', '100 %', '100 %', '100 %', '82 %', '45 %', '20 %', '17 %', '25 %', '24 %']);
	});

	// Issue #51: with the last month complete, {to} is a month, and "on December 2023" isn't English.
	it('says "at the end of" a complete last month', () => {
		const upToDec = farm.monthly.slice(0, 11);
		expect(sp(damSummary(upToDec, '2023-12-31'))).toBe(
			'Dam level at the end of each month, February 2023 to December 2023. Lowest 16 % at the end of February 2023, highest 100 % at the end of April 2023, and 25 % at the end of December 2023. The numbers are in the table below.'
		);
	});
});
