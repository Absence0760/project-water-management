<script lang="ts">
	// A cap or full-allocation run read by a viewer the project keeps from each
	// registered volume (issue #523 finding I, ./withheld.ts): the API gives
	// only its river outcomes, so the page says so in one line rather than
	// showing a run without its units without a word.
	import type { RunSummary } from '@water-management/engine';
	import { riverOutcomesText } from './withheld';

	let { summary }: { summary: Pick<RunSummary, 'allocations'> } = $props();
	const text = $derived(riverOutcomesText(summary));
</script>

{#if text}
	<p class="alert alert-info" role="note" data-testid="river-outcomes-only">{text}</p>
{/if}
