// Display helpers for the EWR agreement table (engine ewrAgreement, issue #4):
// does the model fail the EWR on the days the observed river did?
import { waterYearLabel, type EwrAgreement, type EwrAgreementScores, type RunSummary } from '@water-management/engine';
import { WATER_YEAR_MONTHS } from '$lib/format/months';
import { fmtNum, fmtPct } from '$lib/format/number';

/** Frequency bias within this of 1 reads as "about as often". */
export const BIAS_TOLERANCE = 0.1;

export const AGREEMENT_HELP = {
	hitRate: 'Of the days the observed flow was below the EWR, the share the model was below too. 1 is ideal.',
	falseAlarmRatio: 'Of the days the model is below the EWR, the share the observed flow was not. 0 is ideal.',
	frequencyBias:
		"The model's share of days below the EWR divided by the observed share. 1 means the model fails the EWR as often as the river did; above 1, too often; below 1, not often enough."
} as const;

/** A ratio to two decimals, or "–" when it has no denominator. */
export const fmtRatio = (v: number | null | undefined): string => fmtNum(v, 2);

/** One plain-language sentence on the frequency bias. */
export function biasVerdict(s: Pick<EwrAgreementScores, 'frequencyBias' | 'days' | 'bothBelow' | 'miss' | 'falseAlarm'>): string {
	if (s.days === 0) return 'No observed days to compare.';
	const obs = s.bothBelow + s.miss;
	const model = s.bothBelow + s.falseAlarm;
	if (obs === 0) {
		return model === 0
			? 'Neither the model nor the observed flow is below the EWR on any observed day.'
			: `The observed flow never fell below the EWR, but the model is below it on ${fmtNum(model)} of those days.`;
	}
	const b = s.frequencyBias!;
	if (Math.abs(b - 1) <= BIAS_TOLERANCE) return 'The model fails the EWR about as often as the observed river did.';
	return b > 1
		? `The model fails the EWR ${fmtNum(b, 1)}× as often as the observed river did.`
		: `The model fails the EWR on ${fmtPct(b, 0)} as many days as the observed river did.`;
}

/** Why a run has no agreement table, or null when it has one with days. */
export function agreementGap(summary: Pick<RunSummary, 'catchment' | 'calibration'>): string | null {
	const a = summary.catchment?.ewrAgreement;
	if (a === undefined) return 'This run was made before the EWR agreement existed. Run the model again to see it.';
	if (a === null) {
		return 'The run has no observed gauge or logger flow, so there is nothing to compare the EWR test with. Upload an observed flow series.';
	}
	if (a.days === 0) return 'The observed record has no day inside the run.';
	return null;
}

export interface AgreementRow extends EwrAgreementScores {
	key: string;
	label: string;
}

/** The 12 months in water-year order (Oct … Sep). Months without observed days keep their row. */
export function monthRows(a: EwrAgreement): AgreementRow[] {
	return a.byMonth.map((m, i) => ({ ...m, key: String(i), label: WATER_YEAR_MONTHS[i]! }));
}

export function waterYearRows(a: EwrAgreement): AgreementRow[] {
	return a.byWaterYear.map((y) => ({ ...y, key: String(y.waterYear), label: waterYearLabel(y.waterYear) }));
}
