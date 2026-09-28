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
	import type { EwrChargeSource, EwrRuleTable, LowFlowMeasure, NetworkNode } from '@water-management/engine';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import Lazy from '$lib/components/common/Lazy.svelte';
	import { newTable, rulesError, siteOptions } from './ewrRules';

	let {
		value = $bindable(),
		error = $bindable(null),
		chargeSource = $bindable(),
		lowFlowMeasure = $bindable(),
		readonly = false,
		nodes
	}: {
		value: EwrRuleTable[];
		error?: string | null;
		/** settings.ewrChargeSource (engine ≥ 1.3.0); undefined = 'pragmatic'. */
		chargeSource?: EwrChargeSource;
		/** settings.lowFlowMeasure (engine ≥ 1.3.0); undefined = 'total'. */
		lowFlowMeasure?: LowFlowMeasure;
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
		monthly compliance rate on Runs & results; the pragmatic EWR above sets the daily charge and curtailment unless you choose the rule
		tables below. A total-flow table can
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

	{#if value.length}
		<!-- Method choices pending the hydrologist (engine ≥ 1.3.0, issue #64); the defaults are what every earlier run did. -->
		<div class="methods">
			<div class="field">
				<span class="lbl"><label for="{uid}-charge">EWR charge follows</label><HelpTip key="settings.ewrChargeSource" /></span>
				<select id="{uid}-charge" disabled={readonly} value={chargeSource ?? 'pragmatic'} onchange={(e) => (chargeSource = e.currentTarget.value as EwrChargeSource)} aria-describedby="{uid}-charge-h">
					<option value="pragmatic">The pragmatic EWR</option>
					<option value="ruleTable">The rule tables</option>
				</select>
				<span class="hint" id="{uid}-charge-h">Which daily requirement sets the EWR charge, curtailment and the water account at a site with a table. Pending the hydrologist.</span>
			</div>
			<div class="field">
				<span class="lbl"><label for="{uid}-low">Low flows judged on</label><HelpTip key="settings.lowFlowMeasure" /></span>
				<select id="{uid}-low" disabled={readonly} value={lowFlowMeasure ?? 'total'} onchange={(e) => (lowFlowMeasure = e.currentTarget.value as LowFlowMeasure)} aria-describedby="{uid}-low-h">
					<option value="total">The month’s total flow</option>
					<option value="baseflow">The month’s base flow</option>
				</select>
				<span class="hint" id="{uid}-low-h">Base flow keeps a flood month from passing its low flows. Pending the hydrologist.</span>
			</div>
		</div>
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
	/* As Settings' .fields: the two method choices side by side, stacked on a phone. */
	.methods {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 0 1.25rem;
		margin-top: 0.75rem;
	}
	.methods select {
		width: 100%;
	}
	.lbl {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}
	.lbl label {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
	}
</style>
