<script lang="ts">
	// One header per workspace section (issue #17, option A · the boards'
	// header): the section's title, a one-line context under it, and on the
	// right, in this order, the page's rain-freshness pill (`status`, after the
	// Summary's "Setup complete" pill), the
	// tab's own actions (`actions`, headerSlot.svelte.ts) and the page's pair,
	// Add data and Run model or the tab's main action in its place (`main`).
	// Under them, one slim line of notices (view only, new data) instead of
	// full-width banners.
	//
	// Wide, the three groups are one row of controls beside the title, or under
	// it when they would squeeze the context line onto a second line. In a
	// narrow header (a phone), in the same order: the pill on a line of its
	// own; the tab's pickers, each a full row; then its buttons and the page's
	// pair in full rows, every control growing to fill its row. Add data and
	// Run model are one box that never splits, so they always end the header
	// side by side (a page action used to push them onto rows of their own,
	// or split them over two).
	import type { Snippet } from 'svelte';

	let {
		title,
		badge,
		context,
		status,
		actions,
		main,
		notices
	}: {
		title: string;
		/** Beside the title (the "Unsaved changes" badge). */
		badge?: Snippet;
		context?: Snippet | null;
		/** The page's status before the actions (the rain-freshness pill). */
		status?: Snippet | null;
		/** The section's own actions (pickers, links, its buttons). */
		actions?: Snippet | null;
		/** The page's pair, last: Add data and Run model, or the section's main action. */
		main?: Snippet | null;
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
		{#if status || actions || main}
			<div class="actions">
				{#if status}<div class="group status" data-testid="header-status">{@render status()}</div>{/if}
				{#if actions}<div class="group own" data-testid="header-own">{@render actions()}</div>{/if}
				{#if main}<div class="group main" data-testid="header-main">{@render main()}</div>{/if}
			</div>
		{/if}
	</div>
	{@render notices?.()}
</header>

<style>
	.section-header {
		/* Its width decides the layout: the sidebar takes 240 px, so the viewport would lie. */
		container: section-header / inline-size;
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
	/* The title asks for its context's full one-line width (flex-basis auto is its
	   max-content), and no more: when the controls fit beside a context on one
	   line they share the row, and when they don't the controls wrap under the
	   title instead of squeezing the context into a narrow column of 3–4 short
	   lines (River & reserve for a viewer at 1440, Compare runs at 1024). No
	   floor over its content: a 16rem one made a short title claim room it didn't
	   use, so in a wide font (DejaVu Sans) Data's controls wrapped under
	   "2 input series · 1 behind" at 1024 with space to spare beside it. */
	.title {
		flex: 1 1 auto;
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
	/* Wide: the pill and the tab's controls add no boxes, so they are one row
	   with the pair; the pair itself is one box, so a wrap never splits it. */
	.group {
		display: contents;
	}
	.main {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.actions :global(.btn) {
		min-height: 38px;
	}
	/* Narrow (a phone, 640 px at most): the pill on a line of its own, then the controls in full rows. */
	@container section-header (max-width: 640px) {
		h1 {
			font-size: 1.45rem;
		}
		.actions {
			flex: 1 1 100%;
		}
		.status {
			display: flex;
			flex: 1 1 100%;
			flex-wrap: wrap;
			gap: 0.5rem;
		}
		/* Every control grows to fill its row, so no row ends in a ragged gap. */
		.own > :global(*) {
			flex: 1 1 auto;
		}
		.own > :global(.btn) {
			justify-content: center;
		}
		/* A menu's button (Tables ▾, Download ▾) fills its share like the rest. */
		.own > :global(:is(details, div)) > :global(:is(summary, .btn):first-child) {
			width: 100%;
			justify-content: center;
		}
		/* A picker takes a row of its own, its select the full width (over the tab's desktop cap). */
		.own > :global(label),
		.own > :global(.field),
		.own > :global(select) {
			flex-basis: 100%;
		}
		.section-header .own :global(select) {
			width: 100%;
			max-width: none;
		}
		/* Add data and Run model never split: one box, last, sharing a row with the tab's
		   buttons when they fit and taking the next row when they don't. */
		.main {
			display: flex;
			flex: 1 1 auto;
			flex-wrap: wrap;
			gap: 0.5rem;
		}
		.main > :global(*) {
			flex: 1 1 0;
			justify-content: center;
		}
		/* Runs' run form (label, name, Run model) takes a row of its own under Add data. */
		.main:has(> :global(form)) {
			flex-basis: 100%;
		}
		.main > :global(form) {
			flex-basis: 100%;
		}
		.actions :global(.btn) {
			min-height: 44px;
		}
	}
</style>
