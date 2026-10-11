// A cap or full-allocation run read by a viewer the project keeps from each
// registered volume (decision D3, issue #523 finding I, docs/security.md §
// Allocations): the API serves only its EWR verdicts and counts (days and
// months the EWR is not met, assurance rates), no series, volume or unit;
// it marks the summary `allocations.verdictsOnly` and names the fields it
// left out in `withheld`. The pages say so instead of showing an empty run
// without a word.
import type { RunSummary } from '@water-management/engine';

/** Whether this reader gets only the run's EWR verdicts and counts. */
export const verdictsOnly = (summary: Pick<RunSummary, 'allocations'> | null | undefined): boolean => summary?.allocations?.verdictsOnly === true;

/** The note the run pages show for such a run, or null. */
export function verdictsOnlyText(summary: Pick<RunSummary, 'allocations'> | null | undefined): string | null {
	if (!verdictsOnly(summary)) return null;
	const how = summary?.allocations?.mode === 'fullAllocation' ? 'scales every unit’s demand to its registered water volume' : 'caps every unit’s use at its registered water volume';
	return `Only this run’s EWR verdicts and counts are shown (the days and months the EWR is not met): it ${how}, and this project shows those volumes to its editors and owners only, so no flow, volume or unit figure is given.`;
}
