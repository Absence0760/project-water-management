<script lang="ts">
	// A cap or full-allocation run read by a viewer the project keeps from each
	// registered volume (issue #523 finding I, ./withheld.ts): the API gives
	// only its EWR verdicts and counts, so the page says so in one line rather
	// than showing an empty run without a word.
	import type { RunSummary } from '@water-management/engine';
	import { verdictsOnlyText } from './withheld';

	let { summary }: { summary: Pick<RunSummary, 'allocations'> } = $props();
	const text = $derived(verdictsOnlyText(summary));
</script>

{#if text}
	<p class="alert alert-info" role="note" data-testid="verdicts-only">{text}</p>
{/if}
