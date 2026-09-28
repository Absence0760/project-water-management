// The printable catchment report (WP-2.15 Phase A, docs/ui.md § Report):
// which sections a run's report has, in order, and when the page is ready to
// print. Data-driven so the licensing evidence pack (#15) can extend the same
// route with sections of its own. A section appears only when the run has its
// data: the report never prints a placeholder for something that doesn't
// exist yet (the published-by line and restriction notice wait for WP-2.3,
// changes since the last publication for WP-2.4). Three sections close every
// report (WP-3.13): the validation statement, the professional sign-off
// (saying plainly when there is none) and the disclaimer (D10). A forecast
// run's report says on its cover that its days from the first forecast day
// use forecast rain (forecastNote).
// Opened from Compare runs' Export impact report (`against`, issue #17 A4),
// it is an impact report: an "Impact against the baseline" section right
// after the cover.
import { FORECAST_RAIN_NOTE, REPORT_NOT_EVIDENCE, REPORT_NOT_SIGNED, REPORT_READ_FIRST, REPORT_SIGNED_BY } from '@water-management/engine';
import type { Run, Signoff } from '$lib/api/types';

export type ReportSectionId = 'cover' | 'impact' | 'network' | 'inputs' | 'calibration' | 'curtailment' | 'ewr' | 'farms' | 'notes' | 'validation' | 'signoff' | 'disclaimer';

export interface ReportSection {
	id: ReportSectionId;
	/** The section's heading (the cover's is the project name, set by the page). */
	title: string;
}

/** The uPlot charts the report draws, each of which must draw before the report is ready. */
export type ReportChartId = 'hydrograph' | 'ewr';

type ReportRun = Pick<Run, 'summary' | 'model' | 'notes'>;

export function reportSections(run: ReportRun, opts: { impact?: boolean } = {}): ReportSection[] {
	const out: ReportSection[] = [{ id: 'cover', title: opts.impact ? 'Impact report' : 'Catchment report' }];
	if (opts.impact) out.push({ id: 'impact', title: 'Impact against the baseline' });
	if (run.model?.nodes?.length) out.push({ id: 'network', title: 'Network' });
	out.push({ id: 'inputs', title: 'Inputs' });
	out.push({ id: 'calibration', title: 'Calibration' });
	if (run.summary.curtailment) out.push({ id: 'curtailment', title: 'Shortfalls and curtailment' });
	out.push({ id: 'ewr', title: 'EWR compliance' });
	out.push({ id: 'farms', title: 'Hydrological units, warnings and checks' });
	if (run.notes?.trim()) out.push({ id: 'notes', title: 'Notes' });
	out.push({ id: 'validation', title: 'Validation statement' });
	out.push({ id: 'signoff', title: 'Professional sign-off' });
	out.push({ id: 'disclaimer', title: 'Disclaimer' });
	return out;
}

/**
 * The cover's forecast-rain line: only for a forecast run (summary.forecast,
 * WP-2.12), from its first forecast day, crediting CHIRPS-GEFS only when the
 * run recorded it as the source (an uploaded forecast gets the plain line); else null.
 */
export const forecastNote = (run: Pick<Run, 'summary' | 'forecastRainSource'>): string | null =>
	run.summary.forecast ? FORECAST_RAIN_NOTE(run.summary.forecast.from, run.forecastRainSource) : null;

/** The Disclaimer's section number (the cover counts as 0, as the headings do). */
export const disclaimerSection = (sections: readonly ReportSection[]): number => sections.findIndex((s) => s.id === 'disclaimer');

/**
 * The cover's "Read this first" box (docs/legal/disclaimer-review.md § 1):
 * the disclaimer's key points, the sign-off status, and, for an unsigned run
 * used as evidence (nominated, or an impact report), that it is not for use
 * as evidence in a licence application; else `notEvidence` is null.
 */
export function readFirst(
	sections: readonly ReportSection[],
	signoffs: readonly Pick<Signoff, 'fullName' | 'registrationBody' | 'registrationNo'>[],
	evidenceUse: boolean
): { text: string; status: string; notEvidence: string | null } {
	return {
		text: REPORT_READ_FIRST(disclaimerSection(sections)),
		status: signoffs.length ? REPORT_SIGNED_BY(signoffs) : REPORT_NOT_SIGNED,
		notEvidence: !signoffs.length && evidenceUse ? REPORT_NOT_EVIDENCE : null
	};
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
