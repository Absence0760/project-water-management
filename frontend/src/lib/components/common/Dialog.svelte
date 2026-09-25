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
		children,
		actions
	}: { open?: boolean; title: string; wide?: boolean; full?: boolean; children: Snippet; actions: Snippet } =
		$props();

	let el: HTMLDialogElement | undefined = $state();
	const titleId = `dlg-${Math.random().toString(36).slice(2, 9)}`;

	$effect(() => {
		if (!el) return;
		if (open && !el.open) el.showModal();
		else if (!open && el.open) el.close();
	});
</script>

<dialog bind:this={el} class:wide class:full aria-labelledby={titleId} onclose={() => (open = false)}>
	<h2 id={titleId}>{title}</h2>
	<div class="body">{@render children()}</div>
	<div class="actions">{@render actions()}</div>
</dialog>

<style>
	dialog {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		padding: 1.25rem;
		width: min(440px, calc(100vw - 2 * var(--gutter)));
		max-height: calc(100vh - 2rem);
		overflow-y: auto;
		box-shadow: 0 10px 30px rgb(0 0 0 / 0.2);
	}
	dialog.wide {
		width: min(720px, calc(100vw - 2 * var(--gutter)));
	}
	dialog.full {
		width: min(1600px, calc(100vw - 2 * var(--gutter)));
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
