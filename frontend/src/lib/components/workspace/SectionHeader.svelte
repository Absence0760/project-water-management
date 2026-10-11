<script lang="ts">
	// One header per workspace section (issue #17, option A · the boards'
	// header): the section's title, a one-line context under it, and on the
	// right, in this order, the page's rain-freshness pill (`status`, after the
	// Summary's "Setup complete" pill), the
	// tab's own actions (`actions`, headerSlot.svelte.ts) and the page's main
	// box: Add data, then Run model (the page's RunButton, or the tab's main
	// action in its place: `main`, Runs & results' run form).
	// Under them, one slim line of notices (view only, new data) instead of
	// full-width banners.
	//
	// Wide, the three groups are one row of controls beside the title, or under
	// it when they would squeeze the context line onto a second line. In a
	// narrow header (a phone, 640 px at most; issue #521 round 5): the pills
	// on a line of their own (the last one's words wrapping inside it) with
	// one ⋯ button at its end, More actions, whose list names every one of the
	// tab's own controls (its pickers, links, buttons and menus, the same
	// elements as on a wide screen); then the page's main box, its controls
	// sharing one row. The main box never splits, so it always ends the header.
	// "How this page works" becomes a 44 px "?" beside the title.
	import type { Snippet } from 'svelte';

	let {
		title,
		badge,
		context,
		status,
		actions,
		main,
		notices,
		guide
	}: {
		title: string;
		/** The page's help guide (/help/guides/<id>, TAB_GUIDE), linked as "How this page works" beside the title. */
		guide?: string | null;
		/** Beside the title (the "Unsaved changes" badge). */
		badge?: Snippet;
		context?: Snippet | null;
		/** The page's status before the actions (the rain-freshness pill). */
		status?: Snippet | null;
		/** The section's own actions (pickers, links, its buttons). */
		actions?: Snippet | null;
		/** The page's main box, last: Add data, then the section's main action. */
		main?: Snippet | null;
		notices?: Snippet;
	} = $props();

	const uid = $props.id();
	/** The header's own width (its container query's), so a phone's tab actions fold into More actions. */
	let width = $state(0);
	const narrow = $derived(width > 0 && width <= 640);
	// How many controls the tab's actions drew: none (a tab with nothing to offer yet) draws no ⋯ button.
	let items: HTMLDivElement | undefined = $state();
	let count = $state(0);
	$effect(() => {
		const el = items;
		if (!el) return;
		const update = () => (count = el.childElementCount);
		update();
		const watch = new MutationObserver(update);
		watch.observe(el, { childList: true });
		return () => watch.disconnect();
	});
	const menu = $derived(narrow && count > 0);
	let open = $state(false);
	let own: HTMLDivElement | undefined = $state();
	let more: HTMLButtonElement | undefined = $state();
	$effect(() => {
		if (!menu) open = false;
	});

	/**
	 * A control picked in the list closes it and leaves the focus on More actions, so a dialog it opens hands the
	 * focus back there (Dialog keeps what had it). A control inside one of the list's own menus (Tables ▾,
	 * Download ▾) leaves it open: that menu, or the dialog its link opens, is still in use.
	 */
	function picked(e: MouseEvent) {
		if (!menu || !items) return;
		const t = (e.target as Element | null)?.closest('a[href], button');
		if (!t || !items.contains(t) || t.hasAttribute('aria-expanded')) return;
		const top = [...items.children].find((c) => c.contains(t));
		if (top && top !== t && (top.matches('details') || top.querySelector('details, [aria-expanded]'))) return;
		open = false;
		more?.focus();
	}
	function keydown(e: KeyboardEvent) {
		// A menu inside the list closes first (its own handler prevents the default).
		if (e.key !== 'Escape' || !open || e.defaultPrevented) return;
		e.preventDefault();
		open = false;
		more?.focus();
	}
	// Leaving the list (a click or the focus elsewhere) closes it; a dialog one of its controls opened doesn't.
	const outside = (n: EventTarget | null) => !!n && n instanceof Node && !own?.contains(n) && !(n instanceof Element && n.closest('dialog'));
	function focusout(e: FocusEvent) {
		if (open && outside(e.relatedTarget)) open = false;
	}
	$effect(() => {
		if (!open) return;
		const onDoc = (e: PointerEvent) => {
			if (outside(e.target)) open = false;
		};
		document.addEventListener('pointerdown', onDoc);
		return () => document.removeEventListener('pointerdown', onDoc);
	});
</script>

<header class="section-header" class:narrow class:has-status={!!status} data-testid="section-header" bind:clientWidth={width}>
	<div class="row">
		<div class="title">
			<div class="title-line">
				<h1>{title}</h1>
				{@render badge?.()}
				{#if guide}<a class="guide" href={guide} data-testid="section-guide" title={narrow ? 'How this page works' : undefined}
						><span class="guide-q" aria-hidden="true">?</span><span class="guide-text">How this page works</span></a
					>{/if}
			</div>
			{#if context}<div class="context muted" data-testid="section-context">{@render context()}</div>{/if}
		</div>
		{#if status || actions || main}
			<div class="actions">
				{#if status}<div class="group status" data-testid="header-status">{@render status()}</div>{/if}
				{#if actions}
					<!-- On a phone the tab's controls sit in a list under More actions (one row with the pills, not a row each). -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div class="group own" class:menu data-testid="header-own" bind:this={own} onkeydown={keydown} onfocusout={focusout}>
						{#if menu}
							<button
								type="button"
								class="btn more"
								aria-expanded={open}
								aria-controls="{uid}-more"
								aria-label="More actions"
								title="More actions"
								bind:this={more}
								onclick={() => (open = !open)}
								data-testid="header-more"><span aria-hidden="true">⋯</span></button
							>
						{/if}
						<!-- svelte-ignore a11y_click_events_have_key_events (a keyboard's Enter on a link or button is a click) -->
						<div
							class="items"
							class:pop={menu}
							id="{uid}-more"
							role={menu ? 'group' : undefined}
							aria-label={menu ? `${title}: more actions` : undefined}
							hidden={menu && !open}
							bind:this={items}
							onclick={picked}
						>
							{@render actions()}
						</div>
					</div>
				{/if}
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
	.guide {
		/* At least 24 px tall (WCAG 2.5.8): the line of text alone was 18 px. */
		display: inline-flex;
		align-items: center;
		min-height: 24px;
		font-size: 0.875rem;
		white-space: nowrap;
	}
	.guide-q {
		display: none;
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
	.group,
	.items {
		display: contents;
	}
	.items[hidden] {
		display: none;
	}
	.main {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.actions :global(.btn) {
		min-height: 38px;
	}
	/* Narrow (a phone, 640 px at most): the pills and More actions on one row, then the main box's row. */
	@container section-header (max-width: 640px) {
		h1 {
			font-size: 1.45rem;
		}
		.actions {
			flex: 1 1 100%;
		}
		/* The pills share one row: the Summary's Setup complete (~130 px) and the
		   rain pill (~250 px) need ~385 px on a 358 px phone row, so wrapping put
		   each alone on a half-empty row. They keep their own width, and the last
		   one gives: its words wrap inside it. A pill's list opens from this row's
		   left edge (position: relative; the rain pill is positioned from here). */
		.status {
			display: flex;
			flex: 1 1 100%;
			align-items: stretch;
			gap: 0.5rem;
			position: relative;
		}
		.status > :global(*) {
			flex: 0 0 auto;
		}
		.status > :global(*:last-child:not(:first-child)) {
			flex: 0 1 auto;
			min-width: 0;
		}
		/* The tab's controls: one ⋯ button (More actions) at the end of the pills' row, or before the main box when
		   there are no pills; its list opens under it from the right edge, every control a full-width 44 px row. */
		.own {
			display: flex;
			position: relative;
		}
		.own.menu {
			flex: 0 0 auto;
		}
		.more {
			width: var(--tap);
			padding: 0;
			justify-content: center;
			font-size: 1.25rem;
			line-height: 1;
		}
		.pop {
			position: absolute;
			top: calc(100% + 4px);
			right: 0;
			z-index: 30;
			display: flex;
			flex-direction: column;
			gap: 0.35rem;
			width: max-content;
			min-width: 14rem;
			max-width: min(22rem, calc(100vw - 2 * var(--gutter)));
			padding: 0.5rem;
			background: var(--surface);
			border: 1px solid var(--border-strong);
			border-radius: var(--radius);
			box-shadow: var(--shadow), 0 6px 18px rgb(0 0 0 / 0.14);
		}
		.pop[hidden] {
			display: none;
		}
		.pop > :global(*) {
			width: 100%;
		}
		.pop > :global(.btn),
		.pop > :global(:is(details, div)) > :global(:is(summary, .btn):first-child) {
			width: 100%;
			justify-content: flex-start;
			text-align: left;
		}
		/* A menu in the list (Tables ▾) opens in place, under its button, rather than over the list's next rows. */
		.pop > :global(details) > :global(:not(summary)) {
			position: static;
			min-width: 0;
			margin-top: 0.25rem;
			box-shadow: none;
		}
		/* A picker in the list shows its name over the select (a wide screen keeps it for screen readers only). */
		.pop > :global(label) {
			display: grid;
			gap: 0.2rem;
			font-size: 0.85rem;
			color: var(--text-2);
		}
		.pop > :global(label) > :global(.visually-hidden) {
			position: static !important;
			width: auto;
			height: auto;
			margin: 0;
			overflow: visible;
			clip: auto;
			white-space: normal;
		}
		.section-header .pop :global(select) {
			width: 100%;
			max-width: none;
			min-height: var(--tap);
		}
		/* With the pills: the ⋯ ends their row, the pills taking the rest (their words wrap inside the last). */
		.has-status .status {
			flex: 1 1 0;
			min-width: 0;
		}
		/* ...so the last pill gives way even when it is the only one: its words wrap inside it rather than run
		   under the ⋯ (320 px). */
		.has-status .own.menu {
			margin-left: auto;
		}
		.section-header.has-status:has(.own.menu) .status > :global(*:last-child) {
			flex: 0 1 auto;
			min-width: 0;
		}
		.has-status .main {
			flex-basis: 100%;
		}
		/* No pills (a project with no data yet): the ⋯ starts the main box's row. */
		.section-header:not(.has-status) .own.menu + .main {
			flex: 1 1 0;
		}
		/* The guide link: a "?" after the title, named "How this page works" (its words hidden, still its name): a
		   36 px circle, about the title's line, whose target reaches 44 px (::after). */
		.guide {
			position: relative;
			justify-content: center;
			width: 2.6rem;
			height: 2.6rem;
			border: 1px solid var(--border);
			border-radius: 50%;
			font-weight: 600;
			font-size: 1rem;
		}
		.guide::after {
			content: '';
			position: absolute;
			inset: -0.25rem;
		}
		.guide:hover {
			text-decoration: none;
			background: var(--surface-2);
		}
		.guide-q {
			display: inline;
		}
		.guide-text {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip-path: inset(50%);
			white-space: nowrap;
		}
		/* The main box never splits: one box, last, sharing a row with the tab's
		   buttons when it fits and taking the next row when it doesn't. */
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
		/* Runs' run form (label, name, Run forecast, Run model): its label and name take the first row, then Add
		   data shares the next with its buttons, so the main box is two rows, not three (issue #521 round 5). The
		   form draws no box of its own here (its fields and buttons are the box's items; it still submits). */
		.main:has(> :global(form)) {
			flex-basis: 100%;
		}
		.main > :global(form) {
			display: contents;
		}
		.main > :global(form) > :global(:is(label, input)) {
			order: -1;
		}
		.actions :global(.btn) {
			min-height: 44px;
		}
	}
</style>
