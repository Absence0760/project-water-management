// The dam release rule's wording in the one-node form (DamStorageFields.svelte,
// docs/model.md §2.7a). Pass inflow with no monthly amounts releases water for
// the EWR required at the node, and that flow also holds against the unit's
// river pump, river abstractions and river off-takes (engine dam.ts
// passInflowTarget), so the hint says so: a baseline of the river as used
// today normally leaves the rule off (issue #507).
import type { DamReleaseRule } from '@water-management/engine';

export const RULE_LABEL: Record<DamReleaseRule, string> = {
	none: 'None: the dam releases nothing',
	passInflow: 'Pass inflow: release for the river below (the EWR unless amounts are set)',
	fixed: 'Fixed: a set release each month'
};

const TAKERS = "This unit's river pump, river abstractions and river off-takes leave that flow in the river too.";

/** The hint under the rule's select; `useEwr` when pass inflow has no monthly amounts. */
export function releaseHint(rule: DamReleaseRule, useEwr: boolean): string {
	if (rule === 'passInflow')
		return useEwr
			? `This releases water for the EWR: before irrigation the dam passes its inflow below the wall, up to the EWR required here, capped by the outlet. ${TAKERS} Release rules are off by default and no import sets one, so a baseline of the river as used today normally leaves this at None.`
			: `Before irrigation the dam passes its inflow below the wall, up to the month's flow to keep below the dam, capped by the outlet. ${TAKERS}`;
	if (rule === 'fixed') return 'Before irrigation the dam releases the amounts below from the water above its minimum operating level, capped by the outlet.';
	return 'A compensation or low-flow release is a common licence condition; pick a rule to model one.';
}
