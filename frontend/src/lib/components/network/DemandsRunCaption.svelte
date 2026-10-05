<script lang="ts">
	// The Demands grid's line naming the run its Supplied and Short columns come from (docs/ui.md § Demands grid).
	import { fmtDate } from '$lib/format/number';
	import { ranAgo } from './supplyColour';
	import type { DemandsRun } from './demandsRunLoad.svelte';

	let { run, dirty }: { run: DemandsRun; dirty: boolean } = $props();
</script>

{#if run.meta}
	<p class="small run-caption" data-testid="demands-run" aria-live="polite">
		{#if run.failed}
			Couldn't load run “{run.meta.label || fmtDate(run.meta.createdAt, true)}”'s results.
			<button type="button" class="btn btn-sm" onclick={() => run.retry()}>Retry</button>
		{:else if run.figures}
			Supplied and Short: the mean a day over run “{run.meta.label || fmtDate(run.meta.createdAt, true)}”, ran
			{fmtDate(run.meta.createdAt, true)} ({ranAgo(run.meta.createdAt)}); – where the run doesn't have the demand.
			{#if dirty}<strong>Unsaved changes aren't in it:</strong> save and run the model to see them.{/if}
		{:else}
			<span class="muted">Loading run “{run.meta.label || fmtDate(run.meta.createdAt, true)}”'s results…</span>
		{/if}
	</p>
{/if}

<style>
	.run-caption {
		margin: 0 0 0.5rem;
		max-width: 80ch;
	}
</style>
