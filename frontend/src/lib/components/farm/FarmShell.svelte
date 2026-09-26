<script lang="ts">
	// The farmer view's page frame (docs/design/farmer-view.md §6.1, §7): its own
	// header ("My farm" and Menu, or a back link), the preview banner for WUA
	// staff, the status strip over a saved copy, and one centred 560 px column
	// at a 16 px base. The workspace's AppHeader isn't shown on /farm
	// (routes/+layout.svelte). The card styles every farm page shares live here.
	import { tick, type Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { api } from '$lib/api';
	import { session } from '$lib/auth/session.svelte';
	import BrandMark from '$lib/components/layout/BrandMark.svelte';
	import { clearFarmMemo } from './farmState.svelte';
	import { clearAllSaved, keepsCopy, setKeepsCopy } from './savedCopy';

	let {
		title = 'My farm',
		back = null,
		preview = null,
		strip = null,
		onretry,
		busy = false,
		children
	}: {
		title?: string;
		/** A back link instead of the title (the "Why?" and dam pages). */
		back?: { href: string; label: string } | null;
		/** Viewer+ previewing a farm: the banner text and the way back to the workspace. */
		preview?: { text: string; href: string } | null;
		/** The status strip over a saved copy. */
		strip?: { text: string; offline: boolean } | null;
		onretry?: () => void;
		busy?: boolean;
		children: Snippet;
	} = $props();

	let menuOpen = $state(false);
	let keep = $state(keepsCopy());
	let menuRoot: HTMLDivElement | undefined = $state();
	let trigger: HTMLButtonElement | undefined = $state();
	let note = $state('');

	function toggleKeep() {
		keep = !keep;
		setKeepsCopy(keep);
		note = keep ? 'Your figures will be kept on this phone.' : 'Nothing is kept on this phone now.';
	}

	async function signOut() {
		menuOpen = false;
		try {
			await api.auth.logout();
		} catch {
			// Signed out locally whatever the server said.
		}
		clearAllSaved();
		clearFarmMemo();
		session.user = null;
		await tick();
		await goto(`${base}/login`);
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && menuOpen) {
			e.stopPropagation();
			menuOpen = false;
			trigger?.focus();
		}
	}
	function onFocusOut(e: FocusEvent) {
		if (menuOpen && menuRoot && !menuRoot.contains(e.relatedTarget as Node | null)) menuOpen = false;
	}
	$effect(() => {
		if (!menuOpen) return;
		const onDoc = (e: PointerEvent) => {
			if (menuRoot && !menuRoot.contains(e.target as Node)) menuOpen = false;
		};
		document.addEventListener('pointerdown', onDoc);
		return () => document.removeEventListener('pointerdown', onDoc);
	});
</script>

<div class="farm">
	<header class="farm-header">
		{#if back}
			<a class="back" href={back.href}>
				<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M15 5 L8 12 L15 19" /></svg>
				{back.label}
			</a>
		{:else}
			<span class="brand"><BrandMark size={26} /><span class="title">{title}</span></span>
		{/if}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="menu-root" bind:this={menuRoot} onkeydown={onKeydown} onfocusout={onFocusOut}>
			<button type="button" class="menu-btn" bind:this={trigger} aria-expanded={menuOpen} aria-controls="farm-menu" onclick={() => (menuOpen = !menuOpen)}>
				Menu
			</button>
			<ul id="farm-menu" class="menu" hidden={!menuOpen}>
				<li><a href="{base}/farm">Your farms</a></li>
				<li><a href="{base}/farm/words">What do these words mean?</a></li>
				<li>
					<button type="button" aria-pressed={!keep} onclick={toggleKeep}>Don’t keep a copy on this phone</button>
				</li>
				<li><button type="button" onclick={signOut}>Sign out</button></li>
			</ul>
			<p class="visually-hidden" role="status">{note}</p>
		</div>
	</header>

	{#if preview}
		<div class="preview" role="note">
			<span>{preview.text}.</span>
			<a href={preview.href}>Back to the workspace</a>
		</div>
	{/if}

	{#if strip}
		<div class="strip" role="status">
			<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2">
				{#if strip.offline}
					<path d="M2 8.5 a15 15 0 0 1 20 0" /><path d="M5.5 12 a10 10 0 0 1 13 0" /><path d="M9 15.5 a5 5 0 0 1 6 0" /><path d="M3 3 L21 21" />
				{:else}
					<circle cx="12" cy="12" r="9" /><path d="M12 7 V13" /><path d="M12 16.5 V16.6" />
				{/if}
			</svg>
			<span>{strip.text}</span>
			{#if onretry}<button type="button" onclick={onretry}>Try again</button>{/if}
		</div>
	{/if}

	<main class="farm-main" aria-busy={busy ? 'true' : undefined}>
		{@render children()}
	</main>
</div>

<style>
	.farm {
		font-size: 16px;
		line-height: 1.45;
		min-height: 100vh;
		background: var(--bg);
	}
	.farm-header {
		position: sticky;
		top: 0;
		z-index: 10;
		min-height: 56px;
		padding: 0 8px 0 16px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		background: var(--surface);
		border-bottom: 1px solid var(--border);
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.title {
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 17px;
	}
	.back,
	.menu-btn,
	.menu a,
	.menu button {
		min-height: var(--tap);
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 0 10px;
		font: inherit;
		font-size: 15px;
		color: var(--accent);
		background: none;
		border: 0;
		cursor: pointer;
		text-decoration: none;
	}
	.back {
		padding-left: 0;
		font-weight: 600;
	}
	.menu-btn {
		font-weight: 600;
		border-radius: var(--radius-sm);
	}
	.menu-root {
		position: relative;
	}
	.menu {
		position: absolute;
		right: 0;
		top: calc(100% + 4px);
		min-width: 250px;
		max-width: calc(100vw - 16px);
		margin: 0;
		padding: 4px 0;
		list-style: none;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		box-shadow: var(--shadow);
	}
	.menu a,
	.menu button {
		width: 100%;
		padding: 0 16px;
		text-align: left;
		color: var(--text);
	}
	.menu a:hover,
	.menu button:hover {
		background: var(--surface-2);
	}
	.menu button[aria-pressed='true']::after {
		content: '✓';
		margin-left: auto;
		color: var(--success);
		font-weight: 700;
	}
	.preview,
	.strip {
		padding: 10px 16px;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 10px;
		font-size: 15px;
	}
	.preview {
		background: var(--accent-soft);
		color: var(--text);
		border-bottom: 1px solid var(--accent);
	}
	.preview a {
		min-height: var(--tap);
		display: inline-flex;
		align-items: center;
		font-weight: 600;
		text-decoration: underline;
	}
	/* The dark status strip over a saved copy (§6.5): the page's own text and
	   background swapped, so it reads as a strip in either theme. */
	.strip {
		background: var(--text);
		color: var(--bg);
	}
	.strip svg {
		flex-shrink: 0;
	}
	.strip span {
		flex: 1 1 200px;
	}
	.strip button {
		min-height: var(--tap);
		padding: 0 14px;
		font: inherit;
		font-weight: 600;
		color: var(--bg);
		background: transparent;
		border: 1px solid var(--bg);
		border-radius: var(--radius-sm);
		cursor: pointer;
	}
	.farm-main {
		max-width: 560px;
		margin: 0 auto;
		padding: 16px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	/* ---- Shared by every farm page ---- */
	.farm :global(h1) {
		margin: 0;
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 26px;
		line-height: 1.2;
		overflow-wrap: anywhere;
	}
	.farm :global(h2) {
		margin: 0;
		font-size: 17px;
		line-height: 1.3;
	}
	.farm :global(p) {
		margin: 0;
	}
	.farm :global(.card) {
		padding: 16px;
		border-radius: 8px;
		background: var(--surface);
		border: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		gap: 10px;
		min-width: 0;
	}
	/* The model's cards: neutral, dashed (official and modelled never look alike, §1). */
	.farm :global(.card.model) {
		border: 1px dashed var(--border-strong);
	}
	.farm :global(.big) {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 8px;
	}
	.farm :global(.big > :first-child) {
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 40px;
		line-height: 1;
	}
	.farm :global(.sub) {
		color: var(--text-2);
	}
	.farm :global(.fine) {
		font-size: 14px;
		color: var(--text-muted);
	}
	.farm :global(.link) {
		min-height: var(--tap);
		display: inline-flex;
		align-items: center;
		gap: 6px;
		align-self: flex-start;
		font-weight: 600;
		color: var(--accent);
	}
	.farm :global(.meter) {
		height: 12px;
		border-radius: 6px;
		background: var(--surface-sunken);
		overflow: hidden;
	}
	.farm :global(.meter > span) {
		display: block;
		height: 100%;
		background: var(--series-1);
	}
	.farm :global(.dates) {
		margin-top: 8px;
		font-size: 14px;
		color: var(--text-muted);
	}
	.farm :global(.dates.stale) {
		display: flex;
		gap: 6px;
		align-items: flex-start;
		color: var(--warning);
	}
	.farm :global(.dates.stale svg) {
		flex-shrink: 0;
		margin-top: 2px;
	}
	.farm :global(details > summary) {
		min-height: var(--tap);
		display: flex;
		align-items: center;
		color: var(--accent);
		font-weight: 600;
		cursor: pointer;
	}
	.farm :global(table.numbers) {
		width: 100%;
		border-collapse: collapse;
		font-size: 14px;
		font-variant-numeric: tabular-nums;
	}
	.farm :global(table.numbers th),
	.farm :global(table.numbers td) {
		padding: 4px 0;
		text-align: right;
		border-bottom: 1px solid var(--border);
	}
	.farm :global(table.numbers th:first-child) {
		text-align: left;
		font-weight: 400;
	}
	.farm :global(table.numbers thead th) {
		font-weight: 600;
	}
</style>
