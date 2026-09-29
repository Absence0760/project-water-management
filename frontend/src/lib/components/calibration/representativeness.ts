// "How representative is the record" (calibration research CR-34, engine ≥
// 1.19.0): the fit report's record-representativeness block, as table rows
// and words. Pure, so it is unit-tested; FitPanel.svelte renders it.
import { waterYearLabel, type RecordRepresentativeness, type YearClass } from '@water-management/engine';
import { fmtNum } from '$lib/format/number';

export const YEAR_CLASS_TEXT: Record<YearClass, string> = { dry: 'Dry', normal: 'Near normal', wet: 'Wet' };

export interface RepresentativenessRow {
	/** "WY 2015/16". */
	year: string;
	scoredDays: string;
	/** "612 mm", or "incomplete" when the year's rain isn't complete. */
	rain: string;
	/** "21st", or "–". */
	percentile: string;
	/** "Dry", "Near normal", "Wet", or "–" (no percentile, or too short a long-term record to class it). */
	klass: string;
	/** The class id, for styling; null when unclassed. */
	cls: YearClass | null;
}

/** 21 → "21st". */
export function ordinal(n: number): string {
	const t = n % 100;
	return `${n}${t >= 11 && t <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`;
}

/** One row per scored water year. */
export function representativenessRows(r: RecordRepresentativeness): RepresentativenessRow[] {
	return r.years.map((y) => ({
		year: `WY ${waterYearLabel(y.waterYear)}`,
		scoredDays: fmtNum(y.scoredDays),
		rain: y.rainMm === null ? 'incomplete' : `${fmtNum(y.rainMm)} mm`,
		percentile: y.percentile === null ? '–' : ordinal(Math.round(y.percentile)),
		klass: y.class ? YEAR_CLASS_TEXT[y.class] : '–',
		cls: y.class
	}));
}

/** What the columns mean: the reference, the thresholds and the percentile rule. */
export function representativenessKey(r: RecordRepresentativeness): string {
	const ref = r.longTerm
		? `the ${fmtNum(r.longTerm.years)} complete water years of the run's rain (WY ${waterYearLabel(r.longTerm.firstYear)}–${waterYearLabel(r.longTerm.lastYear)}, CHIRPS-filled days included)`
		: "the run's rain, which has no complete water year";
	return (
		`Percentile: where the year's rain sits among ${ref}; 50th is the median. ` +
		`Dry is below the ${ordinal(r.thresholds.dry)}, wet above the ${ordinal(r.thresholds.wet)}.`
	);
}

/** "3 water years · mean rain 82 % of the long-term mean": the block's one-line gist. */
export function representativenessGist(r: RecordRepresentativeness): string {
	const years = `${fmtNum(r.waterYears)} water year${r.waterYears === 1 ? '' : 's'}`;
	return r.meanRatio === null ? years : `${years} · mean rain ${fmtNum(r.meanRatio * 100)} % of the long-term mean`;
}
