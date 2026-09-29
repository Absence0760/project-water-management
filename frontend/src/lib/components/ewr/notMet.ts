// The one way the app words the pragmatic EWR test at the outflow gauge
// (issue #162, item 18): "EWR not met", the share of days and "X of N days".
// The Summary's KPI card (overview/latestRun.ts), River & reserve's tile
// (river/river.ts) and the Summary's reserve strip all build their words
// here, so the same figure is never framed as "met" on one page and "not
// met" on another. "Not met" is the framing the flow chart's shading, the
// EWR by month grid and the projects list already use.
import type { RunSummary } from '@water-management/engine';
import { fmtNum, fmtPct } from '$lib/format/number';

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
