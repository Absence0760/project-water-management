// The Calibration record's folded line of quality-flag values and whether they are all at their defaults
// (issue #521). Its own module, apart from qualityFlags.ts: the Settings tab imports these two, and importing
// that file would pull the quality-flag fields' helpers and messages into the tab's chunk, which sits at its
// size ceiling (they stay in QualityFlagsFields' lazy chunk).
import { CALIBRATION_FLOW_KINDS, GAP_FILL_KINDS, gapFillRecordLabel, zeroFlowMonthsText, type CalibrationFlowKind, type FlowGapFillSettings, type QualityFlagSettings } from '@water-management/engine';

/** The records as the line names them (qualityFlags.ts RECORD_NAME, lower case). */
const RECORD = { flow_observed_m3s: 'gauge record', flow_logger_m3s: 'logger record' } as const;

const DAY_NAME = { aboveRating: 'above-range', belowRating: 'below-range', suspect: 'suspect', infilled: 'infilled' } as const;
const TREATMENT = { censor: 'censored', exclude: 'left out', include: 'scored as recorded' } as const;
const andList = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * The Calibration record's folded line (ui-playbook.md § 2, "Rarely changed settings fold into their values"):
 * "gauged range not known · above-range days censored · below-range, suspect and infilled days left out ·
 * no river-stop months · flow gaps not filled". `seriesKinds` are the project's series kinds (null = not known): a
 * range is named only for a record offered (qualityFlags.ts ratedKinds).
 */
export function qualityFlagsSummary(q: QualityFlagSettings, gapFill: FlowGapFillSettings | null | undefined, seriesKinds: readonly string[] | null): string {
	const kinds: CalibrationFlowKind[] = CALIBRATION_FLOW_KINDS.filter((k) => seriesKinds === null || seriesKinds.includes(k));
	const known = kinds.filter((k) => q.ratings[k] && (q.ratings[k]!.gaugedMaxM3s !== null || q.ratings[k]!.gaugedMinM3s !== null));
	const parts = [known.length ? `gauged range set for the ${andList(known.map((k) => RECORD[k]))}` : 'gauged range not known'];
	for (const t of ['censor', 'exclude', 'include'] as const) {
		const days = (Object.keys(DAY_NAME) as (keyof typeof DAY_NAME)[]).filter((k) => q[k] === t).map((k) => DAY_NAME[k]);
		if (days.length) parts.push(`${andList(days)} days ${TREATMENT[t]}`);
	}
	const months = q.zeroFlowMonths ?? [];
	parts.push(months.length ? `river stops ${zeroFlowMonthsText(months)}` : 'no river-stop months');
	const filled = GAP_FILL_KINDS.filter((k) => gapFill?.[k]);
	parts.push(filled.length ? `gaps filled in the ${andList(filled.map((k) => gapFillRecordLabel(k)))}` : 'flow gaps not filled');
	return parts.join(' · ');
}

/** Every quality-flag rule and gap-fill switch is at its default: the Calibration record's fold starts closed. */
export function qualityFlagsAtDefaults(q: QualityFlagSettings, gapFill: FlowGapFillSettings | null | undefined): boolean {
	return (
		Object.keys(q.ratings).length === 0 &&
		q.aboveRating === 'censor' &&
		q.belowRating === 'exclude' &&
		q.suspect === 'exclude' &&
		q.infilled === 'exclude' &&
		!(q.zeroFlowMonths ?? []).length &&
		!GAP_FILL_KINDS.some((k) => gapFill?.[k])
	);
}
