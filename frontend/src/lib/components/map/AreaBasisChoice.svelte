<!--
	Which of a ticked area a unit takes (195, areaBasis.ts): the gross area
	(the default, as WR2012's quaternary areas are) or the effective one,
	without what drains into pans. Shown under a Start or Divide area tick
	when the piece holds pans; nothing is chosen silently, gross until changed.
-->
<script lang="ts">
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import type { MapAreaBasis } from '$lib/api/types';
	import { basisOptions } from './areaBasis';

	let {
		areaM2,
		ncM2,
		basis = $bindable(),
		testid
	}: {
		areaM2: number;
		/** What of it drains into pans (m², more than 0: offersEffective). */
		ncM2: number;
		basis: MapAreaBasis;
		testid: string;
	} = $props();
	const uid = $props.id();
	const options = $derived(basisOptions(areaM2, ncM2));
</script>

<fieldset class="basis" data-testid={testid}>
	<legend>Which area <HelpTip key="area-basis" /></legend>
	{#each options as o (o.value)}
		<label class="choice">
			<input type="radio" name="{uid}-basis" value={o.value} bind:group={basis} data-basis={o.value} />
			<span>{o.label}</span>
		</label>
	{/each}
	<p class="hint">WR2012’s quaternary areas are gross; take the effective area if you model the pans as not contributing runoff.</p>
</fieldset>

<style>
	.basis {
		border: 0;
		padding: 0 0 0 1.6rem;
		margin: 0.2rem 0 0.4rem;
	}
	legend {
		font-weight: 600;
		padding: 0;
		font-size: 0.9rem;
	}
	.choice {
		display: flex;
		gap: 0.4rem;
		align-items: baseline;
		min-height: 24px;
	}
	.hint {
		margin: 0.2rem 0 0;
	}
</style>
