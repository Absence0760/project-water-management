<!--
	A quiet line under a model input (WP-2.4 UI, docs/ui.md § Field history):
	"Changed 3× · last by Ann, 12 Aug 2026: 40% → 60%", a link to History
	filtered to this field. Shows nothing for a field never changed, or for
	someone who can't see History (the page sets no store for them).
-->
<script lang="ts">
	import { fieldHistoryGetter } from './fieldHistory.svelte';
	import { fieldHistoryHref, fieldHistoryText } from './fieldLine';

	let {
		field,
		unit = null
	}: {
		/** `settings:<path>`, `node:<nodeId>:<field>` or `crop:<nodeId>:<cropId>`. */
		field: string;
		/** The unit (farm) the field belongs to, for History's unit filter. */
		unit?: string | null;
	} = $props();

	const getStore = fieldHistoryGetter();
	const store = $derived(getStore());
	$effect(() => store?.want());
	const f = $derived(store?.fields?.[field] ?? null);
</script>

{#if f}
	<a class="field-history" href={fieldHistoryHref(f, unit)} data-testid="field-history">{fieldHistoryText(f)}</a>
{/if}

<style>
	.field-history {
		display: block;
		margin-top: 0.15rem;
		font-size: 0.8rem;
		font-weight: normal;
		color: var(--text-muted);
		text-decoration: none;
		overflow-wrap: anywhere;
	}
	.field-history:hover,
	.field-history:focus-visible {
		color: var(--accent);
		text-decoration: underline;
	}
</style>
