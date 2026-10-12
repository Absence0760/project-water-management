<script lang="ts">
	// A licence's granted terms, read only (231_licence_terms, issue #523 G3;
	// docs/ui.md § Applications): "As applied for", or the changes as licensed
	// in words, and the conditions as the licence gives them. Also a
	// variation's terms (232_decision_events).
	import type { ModelInput } from '@water-management/engine';
	import type { LicenceTerms } from '$lib/api';
	import OpList from './OpList.svelte';
	import { opItems } from './ops';

	let {
		terms,
		base = null,
		names = new Map(),
		label,
		testid
	}: {
		terms: LicenceTerms;
		/** The base run's input, for each change's "from" value; null for an applicant (other farms are blanks to them). */
		base?: ModelInput | null;
		/** Names the scenario already knows (its ops' and the base's); the terms' own names win. */
		names?: ReadonlyMap<string, string>;
		/** Accessible name of the list ("Granted terms of Upper dam"). */
		label: string;
		testid?: string;
	} = $props();

	const allNames = $derived(new Map([...names, ...terms.opNames.map((x) => [x.id, x.name] as const)]));
	const list = $derived(opItems(terms.ops, null, null, base, allNames));
</script>

<div class="terms" data-testid={testid}>
	{#if terms.asApplied}
		<p>As applied for: the changes in the application, unchanged.</p>
	{:else if terms.ops.length}
		<OpList items={list.items} other={list.other} {label} />
	{:else}
		<p>No changes to the model.</p>
	{/if}
	{#if terms.withheldOps}
		<p class="muted small">
			{terms.withheldOps === 1 ? '1 change sets' : `${terms.withheldOps} changes set`} a farm’s registered volume, which this project shows to its editors and owners only.
		</p>
	{/if}
	{#if terms.conditions}<p class="conditions"><strong>Conditions:</strong> {terms.conditions}</p>{/if}
</div>

<style>
	.terms p {
		margin: 0.25rem 0;
	}
	.conditions {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
