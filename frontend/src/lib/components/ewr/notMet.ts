// The one way the app words the pragmatic EWR test at the outflow gauge
// (issue #162, item 18): "EWR not met", the share of days and "X of N days".
// The Summary's KPI card (overview/latestRun.ts), River & reserve's tile
// (river/river.ts) and the Summary's reserve strip all build their words
// here, so the same figure is never framed as "met" on one page and "not
// met" on another. "Not met" is the framing the flow chart's shading, the
// EWR by month grid and the projects list already use.
import type { RunSummary } from '@water-management/engine';
import { fmtNum, fmtPct } from '$lib/format/number';
import { headlineSite } from '$lib/components/runs/ewrAssurance';
import type { EwrHeadline } from '$lib/api/types';

/** The term, on every card, tile and label that counts days below the pragmatic EWR. */
export const EWR_NOT_MET = 'EWR not met';

/** HelpTip key for the term. */
export const EWR_NOT_MET_HELP = 'catchment.ewrFractionDaysNotMet';

export interface EwrNotMetFigure {
	term: typeof EWR_NOT_MET;
	help: typeof EWR_NOT_MET_HELP;
	/** "78.8%". */
	value: string;
	unit: 'of days';
	/** "4 316 of 5 479 days at the outflow gauge". */
	count: string;
	/** Worth a look: not met on more than 5% of days (the Runs tab's threshold). */
	flagged: boolean;
}

/** More than this share of days not met flags the figure. */
export const EWR_FLAG_FRACTION = 0.05;

/**
 * The figure from a run's catchment summary. `days` is the record the summary
 * covers (latestRun.ts historyDays: a forecast run's history only).
 */
export function ewrNotMet(c: Pick<RunSummary['catchment'], 'ewrDaysNotMet' | 'ewrFractionDaysNotMet'>, days: number): EwrNotMetFigure {
	return {
		term: EWR_NOT_MET,
		help: EWR_NOT_MET_HELP,
		value: fmtPct(c.ewrFractionDaysNotMet),
		unit: 'of days',
		count: `${fmtNum(c.ewrDaysNotMet)} of ${fmtNum(days)} days at the outflow gauge`,
		flagged: c.ewrFractionDaysNotMet > EWR_FLAG_FRACTION
	};
}

/**
 * What a count of days below the pragmatic EWR is called on a heading: "the
 * reserve", or, when the project has a Reserve rule table (ewrAssurance.ts
 * headlineSite is not null), "the pragmatic EWR". With a table the Reserve is
 * judged by the table, whole months at a site, so calling the daily pragmatic
 * count "the reserve" would name a different test (issue #177). The Summary's
 * strip (overview/reserveStrip.ts) and River & reserve's water-year panel
 * (river/river.ts) name their counts here.
 */
export function daysBelowTest(ruleTable: boolean): 'the reserve' | 'the pragmatic EWR' {
	return ruleTable ? 'the pragmatic EWR' : 'the reserve';
}

/**
 * The same for a chart of several runs (Compare runs' water-year bars): the
 * bars always count the pragmatic EWR, so "the pragmatic EWR" is true for any
 * mix and is used as soon as one run is judged by a rule table, each by its
 * own project's choice (settings.ewrHeadline, issue #444; none = automatic).
 */
export function daysBelowTestOf(runs: readonly { summary: Pick<RunSummary, 'ewrAssurance'>; choice?: EwrHeadline | null }[]): 'the reserve' | 'the pragmatic EWR' {
	return daysBelowTest(runs.some((r) => headlineSite(r.summary, r.choice) !== null));
}
