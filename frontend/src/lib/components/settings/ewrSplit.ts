// Settings → Split the EWR between units by (settings.ewrSplit, engine ≥ 1.94.0, issue #553,
// EwrSplitFields.svelte): the options and what the hint says, by the method and whether
// flow generation is Per unit. Pure, so the component stays a thin template.
import type { EwrSplitMethod } from '@water-management/engine';

export const EWR_SPLIT_OPTIONS: readonly { value: EwrSplitMethod; label: string }[] = [
	{ value: 'flowShare', label: 'The flow share' },
	{ value: 'naturalMar', label: 'Each unit’s natural MAR' }
];

/**
 * The field's explanation (hidden with the explanations off) and its state
 * line (always shown): under Fragmentation the two methods give the same
 * shares, so the choice matters only under Per unit.
 */
export function ewrSplitHint(method: EwrSplitMethod, perUnit: boolean): { explain: string; state: string } {
	const explain =
		method === 'naturalMar'
			? 'Each unit’s share of the EWR is its natural runoff over the run’s complete water years ÷ the units’ total (the whole run when it has no complete water year). The charge, curtailment, hands-off EWR flows and the drought restriction’s EWR trigger follow it. The period is provisional, pending the hydrologist.'
			: 'Each unit’s share of the EWR is its flow share, from the Method above. The charge, curtailment, hands-off EWR flows and the drought restriction’s EWR trigger follow it.';
	const state = perUnit
		? method === 'naturalMar'
			? 'Per unit: each unit’s EWR share is its own GR4J runoff’s share, not its flow share.'
			: 'Per unit: the flow share splits the EWR, though each unit makes its own runoff.'
		: 'Fragmentation: GR4J runs once on the catchment rain, so both give the flow share. The choice matters only under Per unit.';
	return { explain, state };
}

/** The Flow share panel's summary line's EWR part: only when it isn't the default. */
export function ewrSplitSummary(method: EwrSplitMethod | undefined, perUnit: boolean): string | null {
	if (method !== 'naturalMar') return null;
	return perUnit ? 'the EWR split by each unit’s natural MAR' : 'the EWR split by natural MAR (the flow share under Fragmentation)';
}
