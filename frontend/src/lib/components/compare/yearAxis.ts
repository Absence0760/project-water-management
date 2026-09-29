// The water-year axis of "Days below the reserve, each water year"
// (ReserveYearsChart.svelte): which years get a label, and where, so the
// last one is never cut off at the plot's right edge (issue #162: it read
// "2024/2…" on River & reserve's narrow column).

/** Rough width of one character of the 11 px axis text, in px ("2024/25" ≈ 46 px). */
export const LABEL_CHAR_PX = 6.5;

/**
 * The indices of the year groups to label: about `most` of them evenly
 * spaced, always the last, and never a regular one so close before the last
 * that the two would overlap.
 */
export function yearLabelIndices(n: number, most = 6): number[] {
	if (n <= 0) return [];
	const every = Math.max(1, Math.ceil(n / most));
	const out: number[] = [];
	for (let i = 0; i < n - 1; i += every) if (n - 1 - i >= every) out.push(i);
	out.push(n - 1);
	return out;
}

/**
 * Where to centre a label of `text` whose group is centred at `cx`: there,
 * unless that would run the label past `left` or `right` (the svg's edges),
 * in which case it moves inward just enough to fit.
 */
export function labelX(cx: number, text: string, left: number, right: number): number {
	const half = (text.length * LABEL_CHAR_PX) / 2;
	return Math.max(left + half, Math.min(right - half, cx));
}
