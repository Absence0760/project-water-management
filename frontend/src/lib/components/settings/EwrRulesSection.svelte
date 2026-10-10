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
	import NotesDrawer from '$lib/components/notes/NotesDrawer.svelte';
	import { settingTarget } from '$lib/components/notes/notes';
	import { newTable, rulesError, siteOptions } from './ewrRules';

	let {
		/** What the panel is set to now, under its heading (settings/summaries.ts). */
		summary = null,
		value = $bindable(),
		error = $bindable(null),
		chargeSource = $bindable(),
		lowFlowMeasure = $bindable(),
		readonly = false,
		nodes,
		projectId = null
	}: {
		summary?: string | null;
		value: EwrRuleTable[];
		error?: string | null;
		/** settings.ewrChargeSource (engine ≥ 1.3.0); undefined = 'pragmatic'. */
		chargeSource?: EwrChargeSource;
		/** settings.lowFlowMeasure (engine ≥ 1.3.0); undefined = 'total'. */
		lowFlowMeasure?: LowFlowMeasure;
		readonly?: boolean;
		/** For the group's notes; none without it. */
		projectId?: string | null;
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
		{#if projectId}<NotesDrawer {projectId} target={settingTarget('reserve')} />{/if}
		<!-- In the head, above the tables: with several sites they run screens long (a "new" action goes above a long list). -->
		{#if !readonly}
			<button type="button" class="btn btn-sm head-add" disabled={!canAdd} onclick={add} aria-describedby={!canAdd && value.length ? `${uid}-full` : undefined}>Add a rule table</button>
		{/if}
	</div>
	{#if summary}<p class="summary" data-testid="summary-reserve">{summary}</p>{/if}
	<p class="hint muted explain">Optional: judge each month against the Ecological Reserve’s assurance rules.</p>
	{#if !readonly && !canAdd && value.length}<p class="hint muted" id="{uid}-full">Every EWR site has a table. Add a gauge on the Network tab for another site.</p>{/if}
	<p class="hint muted explain">
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
				<span class="hint explain" id="{uid}-charge-h">Which daily requirement sets the EWR charge, curtailment and the water account at a site with a table. A provisional default, not yet confirmed by the catchment’s hydrologist.</span>
			</div>
			<div class="field">
				<span class="lbl"><label for="{uid}-low">Low flows judged on</label><HelpTip key="settings.lowFlowMeasure" /></span>
				<select id="{uid}-low" disabled={readonly} value={lowFlowMeasure ?? 'total'} onchange={(e) => (lowFlowMeasure = e.currentTarget.value as LowFlowMeasure)} aria-describedby="{uid}-low-h">
					<option value="total">The month’s total flow</option>
					<option value="baseflow">The month’s base flow</option>
				</select>
				<span class="hint explain" id="{uid}-low-h"
					>Base flow keeps a flood month from passing its low flows. The total flow is the catchment’s hydrologist’s choice.
					<!-- issue #507 item 6, docs/model.md §2.9d: the filter's passes and α are not yet checked against the DRM's method. -->
					<span class="badge badge-warn" data-testid="baseflow-filter-unconfirmed">Filter settings unconfirmed</span>
					The base-flow filter (Lyne–Hollick, three passes, α 0.995) isn’t yet checked against the Desktop Reserve Model’s own method, which may use one pass.</span
				>
			</div>
		</div>
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
	/* The heading takes the spare room, so Notes and Add a rule table sit together at the right, as on the other panels. */
	.panel-head > h2 {
		margin-right: auto;
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
