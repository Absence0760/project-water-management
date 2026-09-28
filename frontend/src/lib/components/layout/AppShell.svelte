<script lang="ts">
	// The app frame for a signed-in person (issue #17, option A's shell): a
	// full-height sidebar on wide screens (the app mark, the main sections,
	// the page's own navigation in the slot, and the account at the foot)
	// instead of a bar across the top; on a phone, a slim bar whose Menu
	// opens the same main sections. Pages fill the slot through
	// sidebar.svelte.ts (the workspace: its catchment and sections). The farmer
	// view and the sign-in pages have their own frames and don't use this.
	import type { Snippet } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import AccountMenu from './AccountMenu.svelte';
	import BrandMark from './BrandMark.svelte';
	import { sidebarSlot } from './sidebar.svelte';

	let { children }: { children: Snippet } = $props();

	/** From this width the sidebar shows; below it, the phone bar (app.css sets --header-h to match). */
	const wide = new MediaQuery('min-width: 900px');

	// Section the current URL belongs to, for aria-current on the main sections.
	const section = $derived.by(() => {
		const p = page.url.pathname.slice(base.length) || '/';
		// /compare shows runs of your projects (the workspace's Compare runs, standalone).
		if (p === '/' || p.startsWith('/projects') || p.startsWith('/compare')) return 'projects';
		if (p.startsWith('/teams')) return 'teams';
		if (p.startsWith('/help')) return 'help';
		return null;
	});

	// The phone Menu closes on navigation and on Escape.
	let menuOpen = $state(false);
	let menuButton: HTMLButtonElement | undefined = $state();
	$effect(() => {
		void page.url.pathname;
		menuOpen = false;
	});
	let barEl: HTMLElement | undefined = $state();
	$effect(() => {
		if (!menuOpen) return;
		// A click outside the bar and its menu closes it too, as the account menu does.
		const onDoc = (e: PointerEvent) => {
			if (barEl && !barEl.contains(e.target as Node)) menuOpen = false;
		};
		document.addEventListener('pointerdown', onDoc);
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return;
			e.preventDefault();
			menuOpen = false;
			menuButton?.focus();
		};
		window.addEventListener('keydown', onKey);
		return () => {
			window.removeEventListener('keydown', onKey);
			document.removeEventListener('pointerdown', onDoc);
		};
	});
</script>

{#snippet brand()}
	<a class="brand" href="{base}/" aria-label="Water Management — projects">
		<BrandMark size={28} />
		<span class="wordmark" aria-hidden="true">Water Management</span>
	</a>
{/snippet}

{#snippet mainNav()}
	<nav class="main-nav" aria-label="Main">
		<a href="{base}/" aria-current={section === 'projects' ? 'page' : undefined}>Projects</a>
		<a href="{base}/teams" aria-current={section === 'teams' ? 'page' : undefined}>Teams</a>
		<a href="{base}/help" aria-current={section === 'help' ? 'page' : undefined}>Help</a>
	</nav>
{/snippet}

<a class="skip" href="#main">Skip to content</a>
<div class="shell" class:wide={wide.current}>
	{#if wide.current}
		<aside class="app-sidebar">
			{@render brand()}
			{@render mainNav()}
			{#if sidebarSlot.content}<div class="slot">{@render sidebarSlot.content()}</div>{/if}
			<div class="foot"><AccountMenu up /></div>
		</aside>
	{:else}
		<header class="phone-bar" bind:this={barEl}>
			<button type="button" class="menu-btn" aria-expanded={menuOpen} aria-controls="app-menu" bind:this={menuButton} onclick={() => (menuOpen = !menuOpen)}>
				<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" /></svg>
				<span class="visually-hidden">Menu</span>
			</button>
			{@render brand()}
			<span class="spacer"></span>
			<AccountMenu compact />
			<div id="app-menu" class="app-menu" hidden={!menuOpen}>{@render mainNav()}</div>
		</header>
	{/if}
	<div class="shell-main">{@render children()}</div>
</div>

<style>
	.skip {
		position: absolute;
		left: var(--gutter);
		top: -100px;
		z-index: 50;
		padding: 0.5rem 0.8rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
	}
	.skip:focus {
		top: 8px;
	}
	.shell.wide {
		display: grid;
		grid-template-columns: 15rem minmax(0, 1fr);
		min-height: 100vh;
	}
	.shell-main {
		min-width: 0;
	}
	/* Beside the sidebar a page starts at its edge instead of centring in the
	   width left: centred, a capped page left a dead gap between the sidebar
	   and the content (and another on the right). */
	.shell.wide .shell-main :global(.page) {
		margin-left: 0;
		padding-left: 1.5rem;
	}
	/* The sidebar: full height from the top edge, in view while the page scrolls.
	   Spaced to fit a 960 px-high window with a project open (every section an
	   owner sees, plus room for one more); on a shorter window the page's slot
	   scrolls on its own, so the account at the foot never leaves the screen. */
	.app-sidebar {
		position: sticky;
		top: 0;
		height: 100vh;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.75rem 0.75rem;
		overflow-y: auto;
		background: var(--surface);
		border-right: 1px solid var(--border);
	}
	.brand {
		display: inline-flex;
		align-items: center;
		gap: 0.55rem;
		padding: 0 0.5rem;
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 1.1rem;
		color: var(--brand-navy);
		letter-spacing: -0.01em;
		white-space: nowrap;
		min-height: var(--tap);
	}
	.brand:hover {
		text-decoration: none;
	}
	.main-nav {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}
	.main-nav a {
		display: flex;
		align-items: center;
		min-height: 34px;
		padding: 0 0.75rem;
		border-radius: var(--radius);
		color: var(--text-2);
		font-weight: 500;
	}
	.main-nav a:focus-visible {
		outline-offset: -2px;
	}
	.main-nav a:hover {
		color: var(--text);
		text-decoration: none;
		background: var(--surface-2);
	}
	.main-nav a[aria-current='page'] {
		color: var(--accent);
		background: var(--accent-soft);
		box-shadow: inset 3px 0 0 var(--accent);
	}
	/* Shrinks and scrolls before the foot would be pushed off (min-height keeps
	   a few rows on a very short window, where the whole sidebar scrolls). */
	.slot {
		flex: 0 1 auto;
		min-height: 8rem;
		overflow-y: auto;
		/* The open section scrolled into view (or focused) clears the edges. */
		scroll-padding-block: 1.5rem;
		padding-top: 0.5rem;
		border-top: 1px solid var(--border);
	}
	.foot {
		flex: none;
		margin-top: auto;
		padding-top: 0.5rem;
		border-top: 1px solid var(--border);
	}
	/* Phones: a slim bar; the Menu opens the main sections under it. */
	.phone-bar {
		position: sticky;
		top: 0;
		z-index: 20;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		height: var(--header-h);
		padding: 0 var(--gutter) 0 0.25rem;
		background: var(--surface);
		border-bottom: 1px solid var(--border);
	}
	.phone-bar .wordmark {
		font-size: 1rem;
	}
	.menu-btn {
		display: inline-grid;
		place-items: center;
		width: var(--tap);
		height: var(--tap);
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text);
		cursor: pointer;
	}
	.menu-btn[aria-expanded='true'] {
		background: var(--surface-2);
	}
	.spacer {
		flex: 1;
	}
	.app-menu {
		position: absolute;
		left: 0;
		right: 0;
		top: 100%;
		padding: 0.5rem var(--gutter);
		background: var(--surface);
		border-bottom: 1px solid var(--border);
		box-shadow: 0 6px 20px rgb(0 0 0 / 0.12);
	}
	.app-menu[hidden] {
		display: none;
	}
	.app-menu .main-nav a {
		min-height: var(--tap);
	}
	/* Paper gets the page, not the frame: printed at A4 the window is under
	   900 px, so without this the phone bar (Menu, the mark, the account)
	   printed at the top of the report and of its server-side PDF. */
	@media print {
		.skip,
		.app-sidebar,
		.phone-bar {
			display: none !important;
		}
		.shell.wide {
			display: block;
		}
	}
	@media (prefers-color-scheme: dark) {
		.brand {
			color: var(--text);
		}
	}
</style>
