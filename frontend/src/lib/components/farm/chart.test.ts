import { describe, expect, it } from 'vitest';
import { CHART_TOP, CHART_TOP_INSIDE, MIN_MONTH_PX } from './chartGeometry';
import { barChart, CHART_BASE, damChart, damRows, damSummary, monthLabels, niceMax, rangeCaption, supplyLevel, supplyLevelKey, supplyRows, supplySummary } from './chart';
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

	it('draws the axis in m³ when the reader chose m³, the bars where they were', () => {
		const ml = barChart(farm.monthly, farm.dataUntil, 496);
		const m3 = barChart(farm.monthly, farm.dataUntil, 496, 'm3');
		expect(m3.ticks.map((t) => sp(t.label))).toEqual(['120 000', '60 000', '0']);
		expect(m3.groups[9]!.need.h).toBeCloseTo(ml.groups[9]!.need.h);
	});

	it('moves the axis labels into a narrow plot, so every month keeps its room', () => {
		// A 320 px phone's card (256 px) with m³'s wide labels: a label column would leave each month under MIN_MONTH_PX.
		const narrow = barChart(farm.monthly, farm.dataUntil, 256, 'm3');
		expect(narrow.inside).toBe(true);
		expect(narrow.axisLeft).toBe(0);
		const step = narrow.groups[1]!.labelX - narrow.groups[0]!.labelX;
		expect(step).toBeGreaterThanOrEqual(MIN_MONTH_PX);
		// The plot's top drops to leave room for the top label above its line; the bars stay under it.
		expect(narrow.ticks[0]!.y).toBe(CHART_TOP_INSIDE);
		for (const g of narrow.groups) expect(g.need.y).toBeGreaterThanOrEqual(CHART_TOP_INSIDE - 1e-9);
		// Room enough: the labels keep their own column.
		const wide = barChart(farm.monthly, farm.dataUntil, 496, 'm3');
		expect(wide.inside).toBe(false);
		expect(wide.axisLeft).toBeGreaterThan(0);
		expect(wide.ticks[0]!.y).toBe(CHART_TOP);
	});

	it('sums the chart up and lists all 12 months with years', () => {
		expect(supplySummary(farm.monthly, farm.dataUntil)).toBe(
			'Water you needed and received each month, February 2023 to 10 January 2024. You were short in February, March, November and December. The numbers are in the table below.'
		);
		const rows = supplyRows(farm.monthly, farm.dataUntil, 'ML');
		expect(rows).toHaveLength(12);
		expect(rows.map((r) => [r.label, sp(r.need), sp(r.got)])[0]).toEqual(['Feb 2023', '104.4 ML', '83.1 ML']);
		expect(rows.map((r) => [r.label, sp(r.need), sp(r.got)])[10]).toEqual(['Dec 2023', '110 ML', '96.3 ML']);
		expect(rows[11]!.label).toBe('1–10 Jan 2024');
	});

	// Issue #70: the engine's stress class of each month, in a farmer's words.
	it('gives each month the share of its need received and how short it was', () => {
		const rows = supplyRows(farm.monthly, farm.dataUntil, 'ML');
		// February: 83.1 of 104.4 ML, 80 %: "short" (70–85 %).
		expect([sp(rows[0]!.share), rows[0]!.level]).toEqual(['80 %', 'short']);
		// December: 96.3 of 110 ML, 88 %.
		expect([sp(rows[10]!.share), rows[10]!.level]).toEqual(['88 %', 'a little short']);
		const month = (demandM3: number, suppliedM3: number) => ({ month: '2023-05', demandM3, suppliedM3, damPctEnd: null });
		expect(supplyLevel(month(100, 100)).level).toBe('all or nearly all');
		expect(supplyLevel(month(100, 95)).level).toBe('all or nearly all');
		expect(supplyLevel(month(100, 94)).level).toBe('a little short');
		expect(supplyLevel(month(100, 60)).level).toBe('very short');
		expect(supplyLevel(month(100, 49)).level).toBe('far too little');
		// No need that month: nothing to be short of.
		expect(supplyLevel(month(0, 0))).toEqual({ share: '–', level: '' });
		expect(sp(supplyLevelKey())).toBe(
			'All or nearly all is 95 % or more of what you needed; a little short, 85 % or more; short, 70 % or more; very short, 50 % or more; far too little, less than 50 %.'
		);
	});

	// Issue #51: the table ignored the unit chosen on the supply card.
	it('writes the rows in the unit the reader chose', () => {
		const rows = supplyRows(farm.monthly, farm.dataUntil, 'm3');
		// 104.4 ML and 83.1 ML in the ML table, to the cubic metre here.
		expect(sp(rows[0]!.need)).toMatch(/^104 \d{3} m³$/);
		expect(sp(rows[0]!.got)).toMatch(/^83 \d{3} m³$/);
		expect(rows.every((r) => r.need.endsWith('m³') && r.got.endsWith('m³'))).toBe(true);
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

	it('moves the axis labels into the plot on a 320 px phone, so the month letters don’t crowd', () => {
		const narrow = damChart(farm.monthly, farm.dataUntil, 256, farm.damMinPct);
		expect(narrow.inside).toBe(true);
		expect(narrow.axisLeft).toBe(0);
		expect(narrow.labels[1]!.x - narrow.labels[0]!.x).toBeGreaterThanOrEqual(MIN_MONTH_PX);
		const roomy = damChart(farm.monthly, farm.dataUntil, 296, farm.damMinPct);
		expect(roomy.inside).toBe(false);
		expect(roomy.labels[1]!.x - roomy.labels[0]!.x).toBeGreaterThanOrEqual(MIN_MONTH_PX);
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
