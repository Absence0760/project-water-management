<!--
	"Where the water went": the run's water balance as yearly averages, told
	on the help illustration's stops from rain to outlet (./waterStory.ts). The
	picture is a generic catchment, not this project's network, and says so.
-->
<script lang="ts">
	import type { RunSummary } from '@water-management/engine';
	import { base } from '$app/paths';
	import PictureTour from '$lib/components/help/PictureTour.svelte';
	import { waterStory } from './waterStory';

	let { summary }: { summary: Pick<RunSummary, 'waterBalance' | 'catchment'> } = $props();

	const items = $derived(waterStory(summary));
	const stops = $derived(
		(items ?? []).map((i) => ({
			spot: i.spot,
			title: i.title,
			text: i.value ? `**${i.value}.** ${i.detail}` : i.detail
		}))
	);
</script>

<div class="panel-head">
	<h2 id="res-water-h">Where the water went</h2>
</div>
{#if items}
	<p class="muted intro">
		Yearly averages over this run, told on an illustration of a catchment rather than a drawing of this project’s
		network. The self-checks below give the same balance per water year. What each part means:
		<a href="{base}/help">How the catchment model works</a>.
	</p>
	<PictureTour shot="catchment" {stops} sizes="(min-width: 64rem) 52rem, 100vw" />
{:else}
	<p class="muted">
		This run was saved before the model kept a water balance (engine 0.11.0). Run the model again to see where its
		water went.
	</p>
{/if}

<style>
	.intro {
		max-width: 48rem;
		margin: 0 0 0.75rem;
	}
</style>
