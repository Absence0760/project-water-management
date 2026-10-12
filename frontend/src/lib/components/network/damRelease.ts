// The dam release rule's wording in the one-node form (DamStorageFields.svelte,
// docs/model.md §2.7a). Pass inflow with no monthly amounts releases water for
// the EWR required at the node, and that flow also holds against the unit's
// river pump, river abstractions and river off-takes (engine dam.ts
// passInflowTarget), so the hint says so. Keeping the EWR is a scenario's
// (issue #523 B4): in the baseline the EWR is assessed and reported, never
// applied, so the baseline's pass inflow keeps a set flow (a compensation
// flow), and the EWR target shows only on a release stored before it.
import type { DamReleaseRule } from '@water-management/engine';

export const RULE_LABEL: Record<DamReleaseRule, string> = {
	none: 'None: the dam releases nothing',
	passInflow: 'Pass inflow: keep a set flow in the river below',
	fixed: 'Fixed: a set release each month'
};

const TAKERS = "This unit's river pump, river abstractions and river off-takes leave that flow in the river too.";

/** The hint under the rule's select; `useEwr` when pass inflow has no monthly amounts. */
export function releaseHint(rule: DamReleaseRule, useEwr: boolean): string {
	if (rule === 'passInflow')
		return useEwr
			? `This releases water for the EWR: before irrigation the dam passes its inflow below the wall, up to the EWR required here, capped by the outlet. ${TAKERS} Only a scenario keeps the EWR: untick it to give the monthly flow to keep below the dam.`
			: `Before irrigation the dam passes its inflow below the wall, up to the month's flow to keep below the dam, capped by the outlet. ${TAKERS}`;
	if (rule === 'fixed') return 'Before irrigation the dam releases the amounts below from the water above its minimum operating level, capped by the outlet.';
	return 'A compensation or low-flow release is a common licence condition; pick a rule to model one.';
}
