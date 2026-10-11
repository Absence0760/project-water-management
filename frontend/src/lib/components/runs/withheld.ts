// A cap or full-allocation run read by a viewer the project keeps from each
// registered volume (decision D3, issue #523 finding I, docs/security.md §
// Allocations): the API leaves out of the run's summary, and of its series
// list, every unit the run bound to its volume, and names them in
// `summary.allocations.withheldUnits` (and `withheldSeries`). The pages say so
// instead of showing fewer units without a word.
import type { RunSummary } from '@water-management/engine';

/** The units left out of this run's results for this reader (none for most readers and runs). */
export const withheldUnits = (summary: Pick<RunSummary, 'allocations'> | null | undefined): readonly string[] => summary?.allocations?.withheldUnits ?? [];

/** The note the run pages show when units are left out, or null. */
export function withheldUnitsText(summary: Pick<RunSummary, 'allocations'> | null | undefined): string | null {
	const n = withheldUnits(summary).length;
	if (!n) return null;
	const how = summary?.allocations?.mode === 'fullAllocation' ? 'scales each one’s demand to its registered water volume' : 'caps each one’s use at its registered water volume';
	return `${n === 1 ? '1 hydrological unit is' : `${n} hydrological units are`} left out of these results and their daily series: this run ${how}, and this project shows those volumes to its editors and owners only.`;
}
