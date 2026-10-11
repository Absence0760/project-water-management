<script lang="ts">
	// The units a cap or full-allocation run bound to their registered volume,
	// left out for a viewer the project keeps from the volumes (issue #523
	// finding I, ./withheld.ts): one line saying how many and why, so the
	// results don't just show fewer units.
	import type { RunSummary } from '@water-management/engine';
	import { withheldUnitsText } from './withheld';

	let { summary }: { summary: Pick<RunSummary, 'allocations'> } = $props();
	const text = $derived(withheldUnitsText(summary));
</script>

{#if text}
	<p class="alert alert-info" role="note" data-testid="withheld-units">{text}</p>
{/if}
