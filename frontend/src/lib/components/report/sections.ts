// The printable catchment report (WP-2.15 Phase A, docs/ui.md § Report):
// which sections a run's report has, in order, and when the page is ready to
// print. Data-driven so the licensing evidence pack (#15) can extend the same
// route with sections of its own. A section appears only when the run has its
// data: the report never prints a placeholder for something that doesn't
// exist yet (the published-by line and restriction notice wait for WP-2.3,
// changes since the last publication for WP-2.4, the disclaimer for D10).
import type { Run } from '$lib/api/types';

export type ReportSectionId = 'cover' | 'network' | 'inputs' | 'calibration' | 'curtailment' | 'ewr' | 'farms' | 'notes';

export interface ReportSection {
	id: ReportSectionId;
	/** The section's heading (the cover's is the project name, set by the page). */
	title: string;
}

/** The uPlot charts the report draws, each of which must draw before the report is ready. */
export type ReportChartId = 'hydrograph' | 'ewr';

type ReportRun = Pick<Run, 'summary' | 'model' | 'notes'>;

export function reportSections(run: ReportRun): ReportSection[] {
	const out: ReportSection[] = [{ id: 'cover', title: 'Catchment report' }];
	if (run.model?.nodes?.length) out.push({ id: 'network', title: 'Network' });
	out.push({ id: 'inputs', title: 'Inputs' });
	out.push({ id: 'calibration', title: 'Calibration' });
	if (run.summary.curtailment) out.push({ id: 'curtailment', title: 'Shortfalls and curtailment' });
	out.push({ id: 'ewr', title: 'EWR compliance' });
	out.push({ id: 'farms', title: 'Farms, warnings and checks' });
	if (run.notes?.trim()) out.push({ id: 'notes', title: 'Notes' });
	return out;
}

/** The charts drawn by these sections. */
export function reportCharts(sections: readonly ReportSection[]): ReportChartId[] {
	const out: ReportChartId[] = [];
	if (sections.some((s) => s.id === 'calibration')) out.push('hydrograph');
	if (sections.some((s) => s.id === 'ewr')) out.push('ewr');
	return out;
}

/**
 * The report is ready (data-report-ready, the signal e2e and a future
 * server-side renderer wait on) once everything it fetches has arrived and
 * every chart it draws has drawn.
 */
export function isReportReady(loaded: boolean, charts: readonly ReportChartId[], drawn: Partial<Record<ReportChartId, boolean>>): boolean {
	return loaded && charts.every((c) => drawn[c] === true);
}
