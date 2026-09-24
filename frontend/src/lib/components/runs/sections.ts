// The Runs & results page's in-page menu: one link per results panel, in page
// order. Each id is set on its panel (RunsTab.svelte, RunCharts.svelte).
import type { RunSummary } from '@water-management/engine';

export interface ResultSection {
	id: string;
	label: string;
}

export function resultSections(summary: Pick<RunSummary, 'farms' | 'runoff' | 'wr2012'>): ResultSection[] {
	const out: ResultSection[] = [
		{ id: 'res-summary', label: 'Summary' },
		{ id: 'res-water', label: 'Where the water went' },
		{ id: 'res-checks', label: 'Self-checks' },
		{ id: 'res-curtailment', label: 'Curtailment' },
		{ id: 'res-hydrograph', label: 'Hydrograph' },
		{ id: 'res-calibration', label: 'Calibration' },
		// Runoff model balance: conceptual models (GR4J) only.
		...(summary.runoff ? [{ id: 'res-runoff', label: 'Runoff model' }] : []),
		// WR2012 check: only when the project has a reference.
		...(summary.wr2012 ? [{ id: 'res-wr2012', label: 'WR2012 check' }] : []),
		{ id: 'res-fdc', label: 'Flow duration' },
		{ id: 'res-ewr', label: 'EWR vs outflow' },
		{ id: 'res-ewr-grid', label: 'EWR by month' },
		{ id: 'res-ewr-agreement', label: 'EWR vs observed' }
	];
	// Farm detail is only drawn when the run has farms.
	if (summary.farms?.length) out.push({ id: 'res-farm', label: 'Farm detail' });
	out.push({ id: 'res-explore', label: 'Explore outputs' });
	return out;
}

/**
 * The section being read, for the rail's scroll spy: the last one whose top
 * has scrolled up to `line` (px from the viewport top, just under the sticky
 * header), else the first. At the bottom of the page it is the last section,
 * since a short final panel may never reach the line. `tops` are viewport
 * offsets in page order; sections not rendered yet are simply absent.
 */
export function activeSectionId(tops: { id: string; top: number }[], line: number, atBottom = false): string | null {
	if (!tops.length) return null;
	if (atBottom) return tops[tops.length - 1]!.id;
	let current = tops[0]!.id;
	for (const t of tops) {
		if (t.top <= line) current = t.id;
		else break;
	}
	return current;
}
