// The flow-quality strips' colours, computed (issue #557 follow-up, PR #570).
// Each class has its own strip, in a fixed order the key repeats, so a class
// reads by its place; the strips must still stay apart for colour-blind
// readers, light and dark: within each look (solid, double line) by colour,
// across the two looks by the line along the strip's middle. Colour
// vision deficiency is simulated with Machado, Oliveira & Fernandes (2009) at
// full severity (protanopia, deuteranopia, tritanopia), on linear sRGB; the
// difference is CIEDE2000 (ΔE00), both in #lib/a11y/colourVision.ts. A strip
// is a non-text mark, so it holds 3:1 against the ground (WCAG 1.4.11).
// docs/design/ui-playbook.md § 3.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { FlowDayFlag } from '@water-management/engine';
import { contrast, cssHex, de00, lab, seen, worstDe, type Theme } from '#lib/a11y/colourVision.js';
import { LANE_COLOR, LANE_FLAGS, LANE_DOUBLED } from './flowFlags';

const css = readFileSync(new URL('../../app.css', import.meta.url), 'utf8');
/** A token's hex value in a theme (the dark block lists every colour token it changes; the rest keep light's). */
const hex = (theme: Theme, token: string) => cssHex(css, theme, token);

const colour = (theme: Theme, flag: FlowDayFlag) => hex(theme, LANE_COLOR[flag]);

/** The flow charts' own colours, light then dark, from LineChart's style block (its --series-4 and --chart-obs). */
const chartCss = readFileSync(new URL('../components/charts/LineChart.svelte', import.meta.url), 'utf8');
function chartHex(theme: Theme, token: string): string {
	const all = [...chartCss.matchAll(new RegExp(`${token}:\\s*(#[0-9a-f]{6})\\b`, 'gi'))].map((m) => m[1]!.toLowerCase());
	const v = theme === 'light' ? all[0] : all[1];
	if (!v) throw new Error(`${token} has no ${theme} value in LineChart.svelte`);
	return v;
}
/**
 * Every line the hydrograph and the Data chart draw over the strips: observed (--chart-obs), the other observed record
 * (--series-4, dashed), natural (--series-1), simulated (--series-2), and the Data chart's filled and edited dots
 * (LineChart's fallback --series-1…4, runs/flowSeries.ts, series/SeriesTab.svelte).
 */
const lines = (theme: Theme) => [hex(theme, '--series-1'), hex(theme, '--series-2'), hex(theme, '--series-3'), chartHex(theme, '--series-4'), chartHex(theme, '--chart-obs')];
/** A strip and a line are different shapes, so they need only read as different colours to normal vision. */
const FROM_LINES = 13;
/** Below this ΔE00, under any of the four visions, two strips side by side read as one colour. */
const APART = 10;

describe('the flow-quality strips’ colours (issue #557, PR #570)', () => {
	const themes: readonly Theme[] = ['light', 'dark'];

	it('reads the colours from app.css: the methods give their published values', () => {
		// Sharma et al. 2005, Table 1, pair 1.
		expect(de00([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 3);
		// The palette as app.css has it (a token moved means this file's numbers need measuring again).
		expect(hex('light', '--series-7')).toBe('#008300');
		expect(hex('dark', '--series-9')).toBe('#e66767');
		expect(hex('light', '--surface')).toBe('#fdfdfe');
		expect(chartHex('light', '--series-4')).toBe('#7a4fc4');
		expect(chartHex('dark', '--chart-obs')).toBe('#e6e8e5');
		expect(hex('dark', '--lane-suspect')).toBe('#cc8800');
	});

	for (const theme of themes) {
		it(`${theme}: every two strips with the same look are ΔE00 ≥ ${APART} apart for every reader; the others differ by the double line`, () => {
			const close: string[] = [];
			for (let i = 0; i < LANE_FLAGS.length; i++)
				for (let j = i + 1; j < LANE_FLAGS.length; j++) {
					const [a, b] = [LANE_FLAGS[i]!, LANE_FLAGS[j]!];
					const d = worstDe(colour(theme, a), colour(theme, b));
					if (d < APART && LANE_DOUBLED.has(a) === LANE_DOUBLED.has(b)) close.push(`${a}|${b} ${d.toFixed(1)}`);
				}
			expect(close).toEqual([]);
			// Every strip a colour of its own.
			expect(new Set(LANE_FLAGS.map((f) => colour(theme, f))).size).toBe(LANE_FLAGS.length);
		});

		it(`${theme}: no strip shares a colour with a line the flow charts draw (ΔE00 ≥ ${FROM_LINES}, normal vision)`, () => {
			for (const f of LANE_FLAGS)
				for (const l of lines(theme)) expect(de00(lab(seen(colour(theme, f), 'normal')), lab(seen(l, 'normal'))), `${f} vs ${l}`).toBeGreaterThanOrEqual(FROM_LINES);
		});

		// Both flow charts sit on a card (--surface). On the page's --bg the light below-range aqua and suspect gold fall under
		// 3:1 (2.86, 2.9), so a chart moved off its card needs this checking again.
		it(`${theme}: every strip is at least 3:1 on the card the chart sits on (WCAG 1.4.11)`, () => {
			for (const f of LANE_FLAGS) expect(contrast(colour(theme, f), hex(theme, '--surface')), f).toBeGreaterThanOrEqual(3);
		});
	}

	it('two looks, by what a class says: solid for a reading outside the flow it can be trusted at, a double line for a doubtful one', () => {
		expect(LANE_FLAGS.filter((f) => !LANE_DOUBLED.has(f))).toEqual(['aboveRating', 'periodHigh', 'belowRating']);
		expect(LANE_FLAGS.filter((f) => LANE_DOUBLED.has(f))).toEqual(['suspect', 'infilled', 'humanUse']);
		// Why the look is needed: no six colours stay apart for every reader; here above-range red and human use rose, for a tritanope.
		for (const theme of ['light', 'dark'] as const) expect(worstDe(colour(theme, 'aboveRating'), colour(theme, 'humanUse')), theme).toBeLessThan(APART);
	});
});
