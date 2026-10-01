<script lang="ts">
	// The validation statement on screen (WP-3.13 UI, docs/ui.md § Runs &
	// results › Record and § Scenarios): the report's own ValidationStatement,
	// folded shut. It is closed by default, so the statement (and the engine's
	// known-limitations list) loads as its own chunk only when opened. `open`
	// is bindable, so the run header's known-bug badge (issue #103) can open it
	// on the errata it names.
	import type { RunSummary } from '@water-management/engine';
	import Lazy from '$lib/components/common/Lazy.svelte';

	const loadStatement = () => import('./ValidationStatement.svelte');

	let {
		summary,
		engineVersion,
		legacy,
		fitEngineVersion = null,
		open = $bindable(false)
	}: { summary: RunSummary; engineVersion: string; legacy: boolean; fitEngineVersion?: string | null; open?: boolean } = $props();

	const uid = $props.id();
</script>

<section aria-labelledby="{uid}-h" class="vpanel" data-testid="validation-panel">
	<details bind:open>
		<summary>
			<h3 id="{uid}-h">Validation statement</h3>
			<span class="muted small">Engine {engineVersion}: its checks, this run’s self-checks and calibration ratings, data quality, the known limitations and errata. Also in the report.</span>
		</summary>
		{#if open}
			<div class="body">
				<Lazy load={loadStatement}>
					{#snippet children(ValidationStatement)}
						<ValidationStatement {summary} {engineVersion} {legacy} {fitEngineVersion} headingLevel={4} />
					{/snippet}
				</Lazy>
			</div>
		{/if}
	</details>
</section>

<style>
	summary {
		cursor: pointer;
	}
	summary h3 {
		display: inline;
		margin: 0 0.5rem 0 0;
		font-size: 1rem;
	}
	.body {
		margin-top: 0.75rem;
	}
	.body :global(h4) {
		font-size: 0.95rem;
	}
</style>
