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
		// A side sheet wide enough for a long form in sections, three fields to a row
		// (a node's form, network/NetworkTab.svelte). Full width on a phone, like any side sheet.
		extraWide = false,
		// Leave the body's inputs at their own widths: a grid shown as it is (model/GridModal.svelte).
		keepInputs = false,
		// Fixed under the title, above the scrolling body (a side sheet's picker), so nothing scrolls under it.
		subhead,
		// Open beside this element (the button that opened it) instead of centred, so the
		// pointer barely moves (workspace/SectionsMenu.svelte). Centred on a phone.
		anchor,
		// Asked before Escape or the close button closes it; false keeps it open (Add data's "discard the file?").
		// May answer later (a promise), when it asks in the app's own confirm dialog.
		beforeclose,
		// The ✕ in the corner. A question (ConfirmDialog) leaves it out: its Cancel button is the way out.
		closeButton = true,
		// A question that needs an answer (ConfirmDialog): role alertdialog, described by its body.
		alert = false,
		children,
		actions
	}: {
		open?: boolean;
		title: string;
		wide?: boolean;
		full?: boolean;
		side?: boolean;
		extraWide?: boolean;
		keepInputs?: boolean;
		subhead?: Snippet;
		anchor?: HTMLElement;
		beforeclose?: () => boolean | Promise<boolean>;
		closeButton?: boolean;
		alert?: boolean;
		children: Snippet;
		actions: Snippet;
	} = $props();

	let el: HTMLDialogElement | undefined = $state();
	let anchored = $state(false);
	const titleId = `dlg-${Math.random().toString(36).slice(2, 9)}`;
	const bodyId = `${titleId}-body`;

	// What had the focus when it opened: the native dialog hands it back on close().
	let opener: HTMLElement | null = null;

	$effect(() => {
		if (!el) return;
		if (open && !el.open) {
			opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			el.showModal();
			place(el);
		} else if (!open && el.open) el.close();
	});

	// A caller that removes the dialog as it closes (`{#if open}` round a lazy
	// dialog: the sign-off, SignoffSection.svelte) takes it out of the page
	// while it is still open, and a removed dialog hands the focus to nobody:
	// it fell to <body>, and the next Tab started from the top of the page.
	// Put it back on the opener, as close() would have.
	$effect(() => {
		const d = el;
		if (!d) return;
		return () => {
			// Svelte removes the DOM before teardowns run, so an open `d` here is already detached.
			if (!d.open) return;
			const active = document.activeElement;
			if (opener?.isConnected && (!active || active === document.body || d.contains(active))) opener.focus();
		};
	});

	/** Beside `anchor` (to its right, top-aligned), kept 8 px inside the viewport. */
	function place(d: HTMLDialogElement) {
		anchored = !!anchor && window.innerWidth > 640;
		if (!anchor || !anchored) return;
		const a = anchor.getBoundingClientRect();
		const r = d.getBoundingClientRect();
		const left = Math.max(8, Math.min(a.right + 8, window.innerWidth - r.width - 8));
		const top = Math.max(8, Math.min(a.top, window.innerHeight - r.height - 8));
		d.style.left = `${left}px`;
		d.style.top = `${top}px`;
	}

	// Escape closes the dialog at once, but the browser fires `close` from a
	// queued task, so `open` would stay true until it runs, and a trigger
	// pressed in that gap (Escape, then Enter on the button that opened it)
	// sets `open` to the true it already is: nothing reopens. `cancel` comes
	// synchronously with the Escape, so follow it too. Only the dialog's own:
	// a file input's `cancel` (its picker dismissed) bubbles up to here.
	// With a `beforeclose`, a `cancel` that still comes (the window's keydown
	// below prevents Escape's) asks it too, rather than closing unasked.
	function oncancel(e: Event) {
		if (e.target !== el || e.defaultPrevented) return;
		if (beforeclose) {
			e.preventDefault();
			requestClose();
			return;
		}
		open = false;
	}

	// The browser fires `close` from a queued task. If the dialog was closed and shown again before
	// that task ran (a question answered, the next one asked at once: the leave guard's Stay, then
	// Back again), the stale event would set `open = false` and shut the new one. Only a dialog
	// that really is closed follows it.
	function onclose() {
		if (!el?.open) open = false;
	}

	/** Close unless `beforeclose` says no. */
	let asking = false;
	async function requestClose() {
		if (!beforeclose) {
			open = false;
			return;
		}
		// One question at a time: a second Escape while it is up does nothing.
		if (asking) return;
		asking = true;
		try {
			if (await beforeclose()) open = false;
		} finally {
			asking = false;
		}
	}

	// With a `beforeclose`, Escape is handled here rather than through `cancel`:
	// once a page has refused one `cancel` with no click since, Chrome closes on
	// the next Escape without firing it, so the question would be skipped.
	// Listened for on the window, not the dialog: when the focus has fallen out
	// of the dialog to <body> (a control that had it was disabled) the key never
	// reaches the dialog. A key from inside another dialog (the question
	// `beforeclose` asks, stacked on this one) is that dialog's.
	function onkeydown(e: KeyboardEvent) {
		if (!beforeclose || !open || !el?.open || e.key !== 'Escape' || e.defaultPrevented) return;
		const t = e.target;
		if (t instanceof Node && t !== document.body && t !== document.documentElement && !el.contains(t)) return;
		e.preventDefault();
		requestClose();
	}
</script>

<svelte:window {onkeydown} />

<dialog
	bind:this={el}
	class:wide
	class:full
	class:side
	class:extra-wide={extraWide}
	class:anchored
	class:keep-inputs={keepInputs}
	aria-labelledby={titleId}
	role={alert ? 'alertdialog' : undefined}
	aria-describedby={alert ? bodyId : undefined}
	{oncancel}
	{onclose}
>
	<h2 id={titleId}>{title}</h2>
	{#if subhead}<div class="subhead">{@render subhead()}</div>{/if}
	<div class="body" id={bodyId}>{@render children()}</div>
	<div class="actions">{@render actions()}</div>
	<!-- A visible way out for people who don't know Esc closes it. Last in the DOM so
	     showModal() still focuses the dialog's first real control; drawn top right. -->
	{#if closeButton}
		<button type="button" class="x" aria-label="Close dialog" title="Close (Esc)" onclick={requestClose}>
			<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
		</button>
	{/if}
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
		/* The visible height on a phone, whose 100vh runs under the browser's toolbar and hid the action row. */
		max-height: calc(100dvh - 2rem);
		overflow-y: auto;
		box-shadow: 0 10px 30px rgb(0 0 0 / 0.2);
	}
	/* Beside its anchor (see place()): the inline left/top do the positioning. */
	dialog.anchored {
		margin: 0;
		right: auto;
		bottom: auto;
	}
	dialog.wide {
		width: min(720px, calc(100% - 2 * var(--gutter)));
	}
	dialog.full {
		width: min(1600px, calc(100% - 2 * var(--gutter)));
		height: calc(100vh - 2rem);
		height: calc(100dvh - 2rem);
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
	dialog.side.wide {
		width: min(640px, 100%);
	}
	dialog.side.extra-wide {
		width: min(920px, 100%);
	}
	dialog.side[open] {
		display: flex;
		flex-direction: column;
	}
	.subhead {
		margin: 0 0 0.75rem;
	}
	/* The body scrolls; the title and the actions (a save row) stay in view. */
	dialog.side {
		overflow: hidden;
	}
	dialog.side .body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		margin: 0 -1.25rem;
		padding: 0 1.25rem;
	}
	/* Room for the close button so a long title never runs under it. */
	dialog:has(.x) h2 {
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
	/* A full dialog (a grid, a data table) takes the whole phone screen. */
	@media (max-width: 640px) {
		dialog.full {
			margin: 0;
			width: 100%;
			height: 100%;
			max-height: 100%;
			border-width: 0;
			border-radius: 0;
		}
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
	dialog:not(.keep-inputs) .body :global(input:not([type='checkbox']):not([type='radio'])),
	dialog:not(.keep-inputs) .body :global(textarea) {
		width: 100%;
	}
	/* Wraps rather than running off a phone's width with three long labels. */
	.actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 1rem;
	}
</style>
