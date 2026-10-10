<!--
	A run's daily EWR tables scaled to the modelled catchment (issue #90 B1
	gap a, docs/model.md §2.9f, docs/ui.md § Runs): the tables in the run's own
	settings snapshot × the scale factor the run used (summary.catchment.
	outletEwr.scale), so they are the values the run read, whatever the
	project's Settings say now. Under the run summary, only for a run judged by
	a DRM table; its own chunk, loaded only then.
-->
<script lang="ts">
	import type { EwrDailySource, OutletEwrInfo } from '@water-management/engine';
	import ScaledEwrTablesView from '$lib/components/settings/ScaledEwrTablesView.svelte';
	import { scaledEwrTables } from '$lib/components/settings/ewrDailySource';

	let { source, info }: { source: EwrDailySource; info: OutletEwrInfo } = $props();

	const tables = $derived(scaledEwrTables(source, info.scale));
</script>

{#if tables}
	<details class="run-scaled" data-testid="run-ewr-scaled">
		<summary>The daily EWR’s tables as this run read them (× s = {String(Number(info.scale.toPrecision(4)))})</summary>
		<ScaledEwrTablesView {tables} />
	</details>
{/if}

<style>
	.run-scaled {
		margin-top: 0.75rem;
	}
	.run-scaled summary {
		font-weight: 500;
		font-size: 0.85rem;
		cursor: pointer;
	}
</style>
