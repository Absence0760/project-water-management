<script lang="ts">
	// Thin wrapper over the native <dialog> (focus trap, Esc to close, backdrop).
	import type { Snippet } from 'svelte';

	let {
		open = $bindable(false),
		title,
		// A wider dialog (720px), for content like a data table that doesn't fit the default 440px.
		wide = false,
		// Near full-viewport, for a big data table: the body becomes a flex column so a child
		// with `flex: 1; min-height: 0` takes the remaining height and scrolls on its own.
		full = false,
		// A sheet down the right edge, full height, for editing one thing beside the page
		// (the per-farm planted areas, crops/FarmCropsDrawer.svelte). Full width on a phone.
		side = false,
		children,
		actions
	}: { open?: boolean; title: string; wide?: boolean; full?: boolean; side?: boolean; children: Snippet; actions: Snippet } =
		$props();

	let el: HTMLDialogElement | undefined = $state();
	const titleId = `dlg-${Math.random().toString(36).slice(2, 9)}`;

	$effect(() => {
		if (!el) return;
		if (open && !el.open) el.showModal();
		else if (!open && el.open) el.close();
	});
</script>

<dialog bind:this={el} class:wide class:full class:side aria-labelledby={titleId} onclose={() => (open = false)}>
	<h2 id={titleId}>{title}</h2>
	<div class="body">{@render children()}</div>
	<div class="actions">{@render actions()}</div>
	<!-- A visible way out for people who don't know Esc closes it. Last in the DOM so
	     showModal() still focuses the dialog's first real control; drawn top right. -->
	<button type="button" class="x" aria-label="Close dialog" title="Close (Esc)" onclick={() => (open = false)}>
		<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
	</button>
</dialog>

<style>
	dialog {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		padding: 1.25rem;
		/* 100 % of the viewport the modal sits in, not 100vw: vw includes a
		   classic scrollbar (the page always shows one), so the dialog came
		   out off-centre with uneven gutters. max-width: none drops the
		   browser's own cap (calc(100% − 6px − 2em)), which made it narrower
		   than the page gutter on a phone. */
		max-width: none;
		width: min(440px, calc(100% - 2 * var(--gutter)));
		max-height: calc(100vh - 2rem);
		overflow-y: auto;
		box-shadow: 0 10px 30px rgb(0 0 0 / 0.2);
	}
	dialog.wide {
		width: min(720px, calc(100% - 2 * var(--gutter)));
	}
	dialog.full {
		width: min(1600px, calc(100% - 2 * var(--gutter)));
		height: calc(100vh - 2rem);
		overflow: hidden;
	}
	dialog.full[open] {
		display: flex;
		flex-direction: column;
	}
	dialog.full .body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	dialog.side {
		margin: 0 0 0 auto;
		width: min(480px, 100%);
		height: 100%;
		max-height: 100%;
		border-width: 0 0 0 1px;
		border-radius: 0;
	}
	dialog.side[open] {
		display: flex;
		flex-direction: column;
	}
	dialog.side .body {
		flex: 1;
	}
	/* Room for the close button so a long title never runs under it. */
	h2 {
		padding-right: 2.25rem;
	}
	.x {
		position: absolute;
		top: 0.75rem;
		right: 0.75rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		padding: 0;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-2);
		cursor: pointer;
	}
	.x:hover {
		background: var(--surface-2);
		border-color: var(--border);
		color: var(--text);
	}
	.x:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
	@media (max-width: 640px) {
		.x {
			width: 44px;
			height: 44px;
			top: 0.5rem;
			right: 0.5rem;
		}
	}
	dialog::backdrop {
		background: rgb(0 0 0 / 0.35);
	}
	/* Text fields fill the dialog; checkboxes and radios keep their own size, or a
	   stretched box pushes its label across the row (the series preview's column picker). */
	.body :global(input:not([type='checkbox']):not([type='radio'])),
	.body :global(textarea) {
		width: 100%;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 1rem;
	}
</style>
