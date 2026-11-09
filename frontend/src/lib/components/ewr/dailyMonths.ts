// The EWR page's months-met panel for the daily EWR in use (engine ≥ 1.116.0,
// RunSummary.ewrDailyMonths, docs/model.md §2.9h): pure helpers for
// EwrDailyMonthsPanel.svelte. The Reserve rule tables keep their own panel
// (runs/EwrAssurancePanel.svelte); this one follows Model settings → EWR →
// Daily EWR from, so a change of source shows here after a re-run.
import type { EwrDailyMonths, RunSummary } from '@water-management/engine';
import { fmtNum, fmtPct } from '#lib/format/number.js';
import { verdictsOnly } from '#lib/components/runs/withheld.js';

/** "Met in 18 of 24 months (75.0 %); not met in 6.", or why nothing was assessed. */
export function dailyMonthsVerdict(r: Pick<EwrDailyMonths, 'months' | 'met' | 'rate'>): string {
	if (!r.months) return 'Not assessed: the run has no complete calendar month.';
	if (r.met === r.months) return `Met in every one of the ${fmtNum(r.months)} complete months.`;
	if (r.met === 0) return `Not met in any of the ${fmtNum(r.months)} complete months.`;
	return `Met in ${fmtNum(r.met)} of ${fmtNum(r.months)} months (${fmtPct(r.rate)}); not met in ${fmtNum(r.months - r.met)}.`;
}

/** The line under the tiles when some months met asked for nothing (an EWR of 0 all month), else null. */
export function zeroRequirementText(r: Pick<EwrDailyMonths, 'zeroRequirementMonths'>): string | null {
	const n = r.zeroRequirementMonths;
	if (!n) return null;
	return `${n === 1 ? '1 of the months met' : `${fmtNum(n)} of the months met`} had a daily EWR of 0 all month: nothing was required, so ${n === 1 ? 'it counts' : 'they count'} as met.`;
}

/** Why a run has no ewrDailyMonths: kept from this reader (a run on the registered volumes), or made before engine 1.116.0. */
export function dailyMonthsMissing(summary: Pick<RunSummary, 'allocations'>): string {
	if (verdictsOnly(summary)) return 'This run’s months for the daily EWR are shown to the project’s editors and owners only (it rests on the registered water volumes).';
	return 'Run the model again to see this for the daily EWR.';
}

/** The share-of-months class the bars and the headline take: all met, most (≥ 80 %), or fewer. */
export const rateClass = (r: number | null): 'none' | 'good' | 'ok' | 'bad' => (r === null ? 'none' : r >= 1 ? 'good' : r >= 0.8 ? 'ok' : 'bad');

