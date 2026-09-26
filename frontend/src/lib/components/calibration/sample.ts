// Whether a run's calibration scores are in-sample (issue #45): only when its
// parameters were fitted automatically on the days scored
// (CalibrationStats.fitStatus, engine ≥ 0.39.0). Every surface that labels
// the scores (the calibration panel, the summary cards, the run sentence, the
// checks line, the overview and compare) takes its words from here.
import type { CalibrationFitStatus, CalibrationStats } from '@water-management/engine';

export interface CalibrationSample {
	/** The run's fit status; 'unknown' on a run made before engine 0.39.0 recorded it. */
	status: CalibrationFitStatus | 'unknown';
	/** Sentence case, for a heading: "Calibration period (in-sample)". */
	label: string;
	/** Lower case, for a card's sub-line: "calibration period (in-sample)". */
	short: string;
	/** What the scores do and don't show. */
	note: string;
	/** The words in brackets ("in-sample", "parameters not fitted"); null when not recorded. */
	qualifier: string | null;
}

const LABELS: Record<CalibrationSample['status'], { qualifier: string | null; note: string }> = {
	fitted: {
		qualifier: 'in-sample',
		note: 'These scores are for the same days the parameters were fitted on, so they show how well the model fits, not how well it predicts. The fit’s validation scores (split-sample, wet/dry years, independent record) are under Where the parameters came from.'
	},
	notFitted: {
		qualifier: 'parameters not fitted',
		note: 'The parameters were set by hand, imported or left at their defaults: no automatic fit chose them. If they were tuned by hand against this record the scores flatter the model as much as a fit’s own scores do. Fit automatically with validation to see how they score on days they never saw.'
	},
	edited: {
		qualifier: 'parameters edited since the fit',
		note: 'Parameters were changed by hand after the automatic fit, so neither the fit’s scores nor its validation describe them. These scores are for the parameters as edited.'
	},
	otherPeriod: {
		qualifier: 'not the period fitted',
		note: 'The parameters were fitted on another calibration window, other exclusions or the other flow record, so some or all of these days were not part of the fit. The fit’s own scores are under Where the parameters came from.'
	},
	unknown: {
		qualifier: null,
		note: 'This run was made before the app recorded whether its parameters were fitted on these days (engine 0.39.0). Run the model again to see it; Where the parameters came from shows the fit, if any.'
	}
};

/** How to label a run's calibration scores. */
export function calibrationSample(cal: Pick<CalibrationStats, 'fitStatus'> | null | undefined): CalibrationSample {
	const status = cal?.fitStatus ?? 'unknown';
	const { qualifier, note } = LABELS[status] ?? LABELS.unknown;
	const short = qualifier ? `calibration period (${qualifier})` : 'calibration period';
	return { status, label: short[0]!.toUpperCase() + short.slice(1), short, note, qualifier };
}
