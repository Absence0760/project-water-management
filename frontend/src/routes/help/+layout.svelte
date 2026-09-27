<script lang="ts">
	// The help shell: every /help page shares one contents list (guides and
	// glossary) so the landing page, the guides and the glossary read as one
	// piece, and one search box, at the top of the page (not in a side panel).
	// On wide screens the contents are a column beside the text that stays in
	// view while reading; the app sidebar stays short (the contents don't go in
	// it: a long list made it scroll). On phones they fold behind a "Help
	// contents" button.
	import type { Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { MediaQuery } from 'svelte/reactivity';
	import HelpNav from '$lib/components/help/HelpNav.svelte';

	let { children }: { children: Snippet } = $props();

	const onSearch = $derived(page.url.pathname.replace(/\/$/, '') === `${base}/help/search`);
	let q = $state(page.url.searchParams.get('q') ?? '');
	// Follow the URL (back/forward, a link to a search).
	$effect(() => {
		if (onSearch) q = page.url.searchParams.get('q') ?? '';
	});

	// Results update as you type, on /help/search; the box stays focused.
	function search() {
		const v = q.trim();
		if (!v && !onSearch) return;
		goto(v ? `${base}/help/search?q=${encodeURIComponent(v)}` : `${base}/help`, {
			replaceState: onSearch,
			keepFocus: true,
			noScroll: true
		});
	}

	const wide = new MediaQuery('min-width: 900px');

	let contentsOpen = $state(false);
	$effect(() => {
		void page.url.pathname;
		contentsOpen = false;
	});
</script>

{#snippet searchForm()}
	<form role="search" class="search" onsubmit={(e) => (e.preventDefault(), search())}>
		<label for="help-q" class="visually-hidden">Search help</label>
		<input id="help-q" type="search" placeholder="Search guides and terms" bind:value={q} oninput={search} autocomplete="off" />
	</form>
{/snippet}

<div class="page help-shell">
	{#if wide.current}
		<aside class="side" aria-label="Help contents">
			<HelpNav />
		</aside>
	{/if}
	<div class="help-col">
		{@render searchForm()}
		{#if !wide.current}
			<button
				type="button"
				class="btn toggle"
				aria-expanded={contentsOpen}
				aria-controls="help-contents"
				onclick={() => (contentsOpen = !contentsOpen)}>Help contents</button
			>
			<div id="help-contents" class="contents" class:open={contentsOpen}>
				<HelpNav />
			</div>
		{/if}
		<main class="help-main">
			{@render children()}
		</main>
	</div>
</div>

<style>
	/* The app's usual page width (not a narrower cap), starting at the sidebar:
	   the contents column sits beside it, and the tour and guides get the width
	   (the text keeps its own reading width). */
	/* No bottom padding of its own: the page's 1rem gutter is the space under
	   it (no-pointless-scroll.spec.ts), and the sticky contents column ends
	   1.25rem above the window's foot, inside that. */
	.help-shell {
		max-width: 1480px;
	}
	.search input {
		width: 100%;
		padding: 0.5rem 0.65rem;
	}
	.toggle {
		width: 100%;
		margin-top: 0.5rem;
	}
	.contents {
		display: none;
		margin-top: 0.5rem;
		padding: 0.25rem 0 0.75rem;
		border-bottom: 1px solid var(--border);
	}
	.contents.open {
		display: block;
	}
	/* The reading space at the end of a long page is the text column's, not
	   the page's: the contents column beside it fits the window exactly, so a
	   page that fits doesn't scroll by the page's usual bottom padding. */
	.help-main {
		min-width: 0;
		margin-top: 1.25rem;
		padding-bottom: 3.75rem;
	}
	/* The search heads the page, across the text column. */
	.search {
		max-width: 36rem;
	}
	.help-col {
		min-width: 0;
	}
	/* Pages size their own layout to the text column (a guide's "On this page" rail). */
	.help-main {
		container: help-main / inline-size;
	}
	@media (min-width: 900px) {
		.help-shell {
			display: grid;
			grid-template-columns: 13rem minmax(0, 1fr);
			gap: 2.5rem;
			align-items: start;
		}
		/* In view while reading; it scrolls on its own only when it is taller
		   than the window (a short window, or the glossary's term list). It
		   starts and sticks at the page's top gutter and ends as far from the
		   bottom, so at the top of a short page it doesn't make the page scroll. */
		.side {
			position: sticky;
			top: 1.25rem;
			max-height: calc(100vh - 2.5rem);
			overflow-y: auto;
			overscroll-behavior: contain;
			scrollbar-width: thin;
		}
	}
</style>
