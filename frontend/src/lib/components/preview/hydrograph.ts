// The Preview dialog's mini hydrograph (roadmap WP-1.17, UnsavedPreviewDialog.svelte): the outlet's flow in
// the last run against the same run with the unsaved edits, and the observed record when the run has one,
// as LineChart series. The worker sends the lines (lib/preview/compute.ts previewHydrograph).
import type { ChartSeries } from '#lib/components/charts/series.js';
import type { PreviewHydrograph, PreviewLine } from '#lib/preview/messages.js';

export const LAST_LABEL = 'Last run';
export const EDITED_LABEL = 'With your edits';
export const OBSERVED_LABEL = 'Observed';

/**
 * The chart's series, back to front: the observed record, the last run, then the edits dashed over it, so
 * where the edits change nothing the two simulated lines lie on each other and both still show (a dash over
 * a solid line), and the two read apart by their look as well as their colour (ui-playbook.md § 3).
 */
export function hydrographSeries(h: PreviewHydrograph): ChartSeries[] {
	const out: ChartSeries[] = [];
	if (h.observed) out.push({ label: OBSERVED_LABEL, ...h.observed, color: '--chart-obs', width: 1.25 });
	out.push({ label: LAST_LABEL, ...h.last, color: '--series-1', width: 1.5 });
	out.push({ label: EDITED_LABEL, ...h.edited, color: '--series-2', width: 1.75, style: 'dashed' });
	return out;
}

/** Below this the difference is rounding, not the edits' (m³/day, as compute.ts's M3_EPS). */
const M3_EPS = 1e-6;

/**
 * How many days the edits move the outlet's flow, of the days both runs have (matched by date): the number
 * the chart's caption gives, so the change reads in words as well as on the plot.
 */
export function daysChanged(a: PreviewLine, b: PreviewLine): { changed: number; compared: number } {
	const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
	const shift = day(b.startDate) - day(a.startDate);
	let changed = 0;
	let compared = 0;
	for (let i = 0; i < a.values.length; i++) {
		const x = a.values[i];
		const y = b.values[i - shift];
		if (x == null || y == null) continue;
		compared++;
		if (Math.abs(x - y) > M3_EPS) changed++;
	}
	return { changed, compared };
}
