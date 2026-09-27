<script lang="ts">
	// One header per workspace section (issue #17, option A · the boards'
	// header): the section's title, a one-line context under it, and the
	// actions on the right (the page's rain-freshness pill, Add data and Run
	// model around the tab's own, headerSlot.svelte.ts). Under them, one
	// slim line of notices (view only, new data) instead of full-width banners.
	import type { Snippet } from 'svelte';

	let {
		title,
		badge,
		context,
		actions,
		notices
	}: {
		title: string;
		/** Beside the title (the "Unsaved changes" badge). */
		badge?: Snippet;
		context?: Snippet | null;
		actions?: Snippet;
		notices?: Snippet;
	} = $props();
</script>

<header class="section-header" data-testid="section-header">
	<div class="row">
		<div class="title">
			<div class="title-line">
				<h1>{title}</h1>
				{@render badge?.()}
			</div>
			{#if context}<div class="context muted" data-testid="section-context">{@render context()}</div>{/if}
		</div>
		{#if actions}<div class="actions">{@render actions()}</div>{/if}
	</div>
	{@render notices?.()}
</header>

<style>
	.section-header {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		margin: 0 0 1rem;
	}
	.row {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 0.75rem 1.5rem;
	}
	.title {
		flex: 1 1 16rem;
		min-width: 0;
	}
	.title-line {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.3rem 0.6rem;
	}
	h1 {
		margin: 0;
		font-size: 1.75rem;
		line-height: 1.2;
		overflow-wrap: anywhere;
	}
	.context {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.2rem 0.4rem;
		margin-top: 0.25rem;
		font-size: 0.9rem;
	}
	.actions {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.actions :global(.btn) {
		min-height: 38px;
	}
	@media (max-width: 640px) {
		h1 {
			font-size: 1.45rem;
		}
		.actions {
			width: 100%;
		}
		.actions :global(.btn) {
			min-height: 44px;
		}
	}
</style>
