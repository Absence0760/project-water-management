<script lang="ts">
	// The help shell: every /help page shares one sidebar (search, guides,
	// glossary) so the landing page, the guides and the glossary read as one
	// piece. On wide screens the sidebar stays beside the text; on phones it
	// folds behind a "Help contents" button above the page.
	import type { Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
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

	let contentsOpen = $state(false);
	$effect(() => {
		void page.url.pathname;
		contentsOpen = false;
	});
</script>

<div class="page help-shell">
	<aside class="side">
		<form role="search" class="search" onsubmit={(e) => (e.preventDefault(), search())}>
			<label for="help-q" class="visually-hidden">Search help</label>
			<input id="help-q" type="search" placeholder="Search guides and terms" bind:value={q} oninput={search} autocomplete="off" />
		</form>
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
	</aside>
	<main class="help-main">
		{@render children()}
	</main>
</div>

<style>
	.help-shell {
		max-width: 80rem;
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
	.help-main {
		min-width: 0;
		margin-top: 1.25rem;
	}
	@media (min-width: 64rem) {
		.help-shell {
			display: grid;
			grid-template-columns: 16.5rem minmax(0, 1fr);
			gap: 2.5rem;
			align-items: start;
		}
		.side {
			position: sticky;
			top: calc(var(--header-h) + 1rem);
			display: flex;
			flex-direction: column;
			max-height: calc(100vh - var(--header-h) - 2rem);
		}
		.toggle {
			display: none;
		}
		.contents {
			display: block;
			flex: 1;
			min-height: 0;
			overflow-y: auto;
			overscroll-behavior: contain;
			margin-top: 0.75rem;
			padding: 0 0.25rem 0 0;
			border: 0;
		}
		.help-main {
			margin-top: 0;
		}
	}
</style>
