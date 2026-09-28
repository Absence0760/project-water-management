// The farmer view's small charts: the sizes and the axis rule, with no words,
// so the /share page's flow chart shares them without loading the message
// catalogue (./chart.ts, which adds the words, re-exports these).

export const CHART_HEIGHT = 152;
/** The top of the plot area. */
export const CHART_TOP = 10;
/** The x axis (y of zero). */
export const CHART_BASE = 130;
/** Baseline of the month letters. */
export const LABEL_Y = 147;
/** The design's minimum text size, chart labels included (§7). */
export const CHART_FONT_PX = 13;

/** A round top for the axis whose half is round too: 116.5 → 120, 45 → 50, 7 → 8. */
export function niceMax(v: number): number {
	if (!(v > 0)) return 1;
	const p = 10 ** Math.floor(Math.log10(v));
	for (const m of [1, 1.2, 1.6, 2, 3, 4, 5, 6, 8, 10]) if (m * p >= v - 1e-9) return m * p;
	return 10 * p;
}
