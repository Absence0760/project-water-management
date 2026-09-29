// The WR2012 five-statistic table (calibration research CR-28): rows and the
// periods it is shown for. The engine computes it (reference/wr2012Fit.ts);
// this only words it.
import {
	WR2012_GOOD_FIT_BANDS,
	waterYearLabel,
	type CalibrationReport,
	type Wr2012FitStat,
	type Wr2012FitStatKey,
	type Wr2012FitStats
} from '@water-management/engine';
import { fmtNum, fmtQty } from '$lib/format/number';

/** `volume`: a small catchment's MAR can be well under 0.001 Mm³, so volumes keep 2 significant figures (fmtQty). */
export const WR2012_FIT_STAT: Record<Wr2012FitStatKey, { label: string; unit: string; digits: number; volume?: boolean }> = {
	mar: { label: 'MAR', unit: 'Mm³/a', digits: 3, volume: true },
	meanLog: { label: 'Mean of log annual flows', unit: 'log₁₀ Mm³', digits: 3 },
	sd: { label: 'SD of annual flows', unit: 'Mm³', digits: 3, volume: true },
	logSd: { label: 'SD of log annual flows', unit: 'log₁₀ Mm³', digits: 3 },
	seasonalIndex: { label: 'Seasonal index', unit: '%', digits: 1 }
};

export type Wr2012Verdict = 'within' | 'outside' | 'none';

export interface Wr2012FitRow {
	key: Wr2012FitStatKey;
	label: string;
	unit: string;
	observed: string;
	simulated: string;
	/** "+3.4 %", "−12.0 %", or "–". */
	diff: string;
	/** "< 4 %". */
	band: string;
	verdict: Wr2012Verdict;
	/** Words, so the verdict never rests on colour: "Within", "Outside", "Not computed". */
	verdictText: string;
}

/** Signed to one decimal; float noise that rounds to 0.0 gets no sign. */
const signed = (v: number) => {
	const r = Math.round(v * 10) / 10;
	return `${r > 0 ? '+' : r < 0 ? '−' : ''}${fmtNum(Math.abs(r), 1)} %`;
};

export function wr2012FitRows(s: Wr2012FitStats): Wr2012FitRow[] {
	return s.stats.map((st: Wr2012FitStat) => {
		const def = WR2012_FIT_STAT[st.key];
		const val = (v: number | null) => (v === null ? '–' : def.volume ? fmtQty(v, def.digits) : fmtNum(v, def.digits));
		const verdict: Wr2012Verdict = st.withinBand === null ? 'none' : st.withinBand ? 'within' : 'outside';
		return {
			key: st.key,
			label: def.label,
			unit: def.unit,
			observed: val(st.observed),
			simulated: val(st.simulated),
			diff: st.diffPct === null ? '–' : signed(st.diffPct),
			band: `< ${fmtNum(st.bandPct)} %`,
			verdict,
			verdictText: verdict === 'within' ? 'Within' : verdict === 'outside' ? 'Outside' : 'Not computed'
		};
	});
}

/** "2001/02 – 2004/05" for consecutive years, else each one listed. */
export function waterYearSpan(years: readonly number[]): string {
	if (!years.length) return '–';
	const consecutive = years.every((y, i) => i === 0 || y === years[i - 1]! + 1);
	return consecutive && years.length > 1 ? `${waterYearLabel(years[0]!)} – ${waterYearLabel(years.at(-1)!)}` : years.map(waterYearLabel).join(', ');
}

/** One line under the table: how many statistics fit, over which years. */
export function wr2012FitSummary(s: Wr2012FitStats): string {
	const judged = s.stats.filter((x) => x.withinBand !== null);
	const within = judged.filter((x) => x.withinBand).length;
	const n = s.waterYears.length;
	const years = `${n} complete water year${n === 1 ? '' : 's'} (${waterYearSpan(s.waterYears)})`;
	const bands = s.bandsConfirmed ? 'the good-fit bands' : 'the indicative bands';
	const parts = [`${within} of ${judged.length} within ${bands}, over ${years}.`];
	if (n < 2) parts.push('The two SDs need at least two complete years.');
	else if (s.logYears < n) parts.push(`The log statistics use ${s.logYears} of them: a year with no flow has no logarithm.`);
	return parts.join(' ');
}

/** Why the bands are labelled as they are: the source, and that it is unconfirmed. */
export function wr2012BandsNote(confirmed: boolean = WR2012_GOOD_FIT_BANDS.confirmed): string {
	return confirmed
		? `Good-fit bands: ${WR2012_GOOD_FIT_BANDS.source}.`
		: 'Indicative bands (to be confirmed): taken from a consultant report that cites WR2012; they have not yet been checked against the WR2012 WRSM/Pitman manuals (WRC TT 689/16, TT 690/16). The seasonal index uses the app’s working definition, 100 × Σ |monthly mean − MAR/12| ÷ MAR.';
}

export interface Wr2012FitPeriod {
	id: string;
	label: string;
	stats: Wr2012FitStats;
}

/** The fit's scored periods that have the table (a report from before engine 1.19.0 has none). */
export function wr2012FitPeriods(r: Pick<CalibrationReport, 'fit' | 'before' | 'splitSample' | 'differential' | 'independentRecord'>): Wr2012FitPeriod[] {
	const out: Wr2012FitPeriod[] = [];
	const add = (id: string, label: string, stats: Wr2012FitStats | null | undefined) => {
		if (stats) out.push({ id, label, stats });
	};
	add('fit', 'Fitted', r.fit.wr2012Fit);
	add('before', 'Current parameters', r.before.wr2012Fit);
	add('split-cal', 'Split: fitted half', r.splitSample?.calibration.wr2012Fit);
	add('split-val', 'Split: other half (validation)', r.splitSample?.validation.wr2012Fit);
	add('dsst-cal', 'Dry years (fitted)', r.differential?.calibration.wr2012Fit);
	add('dsst-val', 'Wet years (validation)', r.differential?.validation.wr2012Fit);
	add('record-val', 'Independent record (validation)', r.independentRecord?.validation.wr2012Fit);
	return out;
}
