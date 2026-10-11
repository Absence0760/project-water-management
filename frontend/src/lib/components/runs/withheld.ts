// A cap or full-allocation run read by a viewer the project keeps from each
// registered volume (decision D3, issue #523 finding I, docs/security.md §
// Allocations): the API serves only its river outcomes (the EWR results, the
// outflow and the results at the EWR and gauge sites, the natural flow),
// marks the summary `allocations.riverOutcomesOnly`, names the fields it left
// out in `withheld`, and lists the series in `withheldSeries`. The pages say
// so instead of showing a run without its units without a word.
import type { RunSummary } from '@water-management/engine';

/** Whether this reader gets only the run's river outcomes. */
export const riverOutcomesOnly = (summary: Pick<RunSummary, 'allocations'> | null | undefined): boolean => summary?.allocations?.riverOutcomesOnly === true;

/** The note the run pages show for such a run, or null. */
export function riverOutcomesText(summary: Pick<RunSummary, 'allocations'> | null | undefined): string | null {
	if (!riverOutcomesOnly(summary)) return null;
	const how = summary?.allocations?.mode === 'fullAllocation' ? 'scales every unit’s demand to its registered water volume' : 'caps every unit’s use at its registered water volume';
	return `Only this run’s river outcomes are shown (the EWR results, the outflow and the natural flow): it ${how}, and this project shows those volumes to its editors and owners only, so no unit’s figures or use totals are given.`;
}
