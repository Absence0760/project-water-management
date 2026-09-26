<!--
	Settings → Reserve rule tables (engine ≥ 0.21.0, docs/model.md §2.9c): the
	Ecological Reserve's assurance rules per EWR site (the outlet, or a gauge),
	entered or pasted from a Reserve determination. Bind `value`
	(settings.ewrRules); `error` is set while anything would be rejected, so the
	parent form can block saving. The tables themselves are edited in
	EwrRuleTablesEditor.svelte, a separate chunk loaded once there is one.
	Helpers in ./ewrRules.ts.
-->
<script lang="ts">
	import type { EwrRuleTable, NetworkNode } from '@water-management/engine';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import Lazy from '$lib/components/common/Lazy.svelte';
	import { newTable, rulesError, siteOptions } from './ewrRules';

	let {
		value = $bindable(),
		error = $bindable(null),
		readonly = false,
		nodes
	}: {
		value: EwrRuleTable[];
		error?: string | null;
		readonly?: boolean;
		/** The network, for the site picker (outlet and gauges). */
		nodes: readonly NetworkNode[];
	} = $props();

	const uid = $props.id();
	const loadEditor = () => import('./EwrRuleTablesEditor.svelte');
	const options = $derived(siteOptions(nodes, value.map((t) => t.siteNodeId)));
	const canAdd = $derived(!readonly && newTable(options, value) !== null);

	$effect(() => {
		error = rulesError(value);
	});

	function add() {
		const t = newTable(options, value);
		if (t) value.push(t);
	}
</script>

<section class="panel" aria-labelledby="{uid}-h">
	<div class="panel-head">
		<h2 id="{uid}-h">Reserve rule tables <HelpTip key="settings.ewrRules" /></h2>
		<span class="muted small">Optional: judge each month against the Ecological Reserve’s assurance rules</span>
	</div>
	<p class="hint muted">
		A Reserve determination gives the EWR as a table: for each month, the flow required at each assurance level (“% point”, the share of
		time it should be equalled or exceeded; 10 % is the wet-condition flow, 99 % the drought flow). Each month’s <strong>natural flow</strong>
		picks the point it sits at, and the run checks whether the simulated flow at the site met the EWR at that point. The result is a
		monthly compliance rate on Runs & results; the pragmatic EWR above still sets the daily charge and curtailment. A total-flow table can
		also carry the Desktop Reserve Model’s low-flow table (maintenance and drought low flows), to show whether a month failed its low flows or
		only its high flows, and any site can list freshets and floods to check each water year. Paste from a spreadsheet or load a CSV file.
	</p>

	{#if value.length === 0}
		<p class="muted small">No rule table: runs report the days below the pragmatic EWR only.</p>
	{:else}
		<Lazy load={loadEditor}>
			{#snippet children(Editor)}
				<Editor bind:value {readonly} {options} />
			{/snippet}
		</Lazy>
	{/if}

	{#if !readonly}
		<button type="button" class="btn btn-sm" disabled={!canAdd} onclick={add}>Add a rule table</button>
		{#if !canAdd && value.length}<span class="hint muted"> Every EWR site has a table. Add a gauge on the Network tab for another site.</span>{/if}
	{/if}
</section>

<style>
	.hint {
		font-size: 0.8rem;
		max-width: 75ch;
	}
	.panel > .hint {
		margin: 0.5rem 0 0.75rem;
	}
	h2 :global(.helptip) {
		margin-left: 0.15rem;
	}
</style>
