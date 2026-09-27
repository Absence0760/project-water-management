<!-- i18n-section: farm -->
<script lang="ts">
	// The farmer view's page frame (docs/design/farmer-view.md §6.1, §7): its own
	// header ("My farm" and Menu, or a back link), the preview banner for WUA
	// staff, the status strip over a saved copy, and one centred 560 px column
	// at a 16 px base. The workspace's AppShell isn't shown on /farm
	// (routes/+layout.svelte). The card styles every farm page shares live here.
	// The language switch (EN | AF, WP-2.5) sits in the header, as the design's
	// board 1 has it.
	import { tick, type Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { api } from '$lib/api';
	import { session } from '$lib/auth/session.svelte';
	import BrandMark from '$lib/components/layout/BrandMark.svelte';
	import { clearNoteCounts } from '$lib/components/notes/counts.svelte';
	import LanguageSwitch from '$lib/i18n/LanguageSwitch.svelte';
	import { t } from '$lib/i18n/locale.svelte';
	import { clearFarmMemo } from './farmState.svelte';
	import { clearAllSaved, keepsCopy, setKeepsCopy } from './savedCopy';

	let {
		title = null,
		back = null,
		accountPage = false,
		languageSwitch = true,
		preview = null,
		strip = null,
		onretry,
		busy = false,
		children
	}: {
		/** The header's title; "My farm" when not given. */
		title?: string | null;
		/** A back link instead of the title (the "Why?" and dam pages). */
		back?: { href: string; label: string } | null;
		/**
		 * A farmer-only user's account pages (/account/**, the root layout): the
		 * way back to their farms in place of the title, and the page brings its
		 * own <main> and styles, so the farm pages' card styles stay off it.
		 */
		accountPage?: boolean;
		/** The header's EN | AF switch; off where the page has its own (the account page's Language card). */
		languageSwitch?: boolean;
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
		note = keep ? t('Your figures will be kept on this phone.') : t('Nothing is kept on this phone now.');
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
		clearNoteCounts();
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

<div class="farm" class:account-page={accountPage}>
	<header class="farm-header">
		{#if accountPage && !back}
			<a class="back" href="{base}/farm">
				<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M15 5 L8 12 L15 19" /></svg>
				{t('Your farms')}
			</a>
		{:else if back}
			<a class="back" href={back.href}>
				<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M15 5 L8 12 L15 19" /></svg>
				{back.label}
			</a>
		{:else}
			<span class="brand"><BrandMark size={26} /><span class="title">{title ?? t('My farm')}</span></span>
		{/if}
		<span class="spacer"></span>
		{#if languageSwitch}<LanguageSwitch compact />{/if}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="menu-root" bind:this={menuRoot} onkeydown={onKeydown} onfocusout={onFocusOut}>
			<button type="button" class="menu-btn" bind:this={trigger} aria-expanded={menuOpen} aria-controls="farm-menu" onclick={() => (menuOpen = !menuOpen)}>
				{t('Menu')}
			</button>
			<ul id="farm-menu" class="menu" hidden={!menuOpen}>
				<li><a href="{base}/farm">{t('Your farms')}</a></li>
				<li><a href="{base}/farm/words">{t('What do these words mean?')}</a></li>
				<li><a href="{base}/account" aria-current={accountPage ? 'page' : undefined}>{t('Account')}</a></li>
				<!-- The privacy notice from the farm view too (issue #48): what the farm page shows and keeps is described there. -->
				<li><a href="{base}/privacy">{t('Privacy notice')}</a></li>
				<li>
					<button type="button" aria-pressed={!keep} onclick={toggleKeep}>{t('Don’t keep a copy on this phone')}</button>
				</li>
				<li><button type="button" onclick={signOut}>{t('Sign out')}</button></li>
			</ul>
			<p class="visually-hidden" role="status">{note}</p>
		</div>
	</header>

	{#if preview}
		<div class="preview" role="note">
			<span>{preview.text}.</span>
			<a href={preview.href}>{t('Back to the workspace')}</a>
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
			{#if onretry}<button type="button" onclick={onretry}>{t('Try again')}</button>{/if}
		</div>
	{/if}

	{#if accountPage}
		{@render children()}
	{:else}
		<main class="farm-main" aria-busy={busy ? 'true' : undefined}>
			{@render children()}
		</main>
	{/if}
</div>

<style>
	/* The farm header is sticky at every width, so in-page links and focus
	   scrolling (html's scroll-padding-top, app.css) must clear it. The app
	   shell sets --header-h to its own phone bar and to 0 from 900 px, where
	   its sidebar replaces the bar; the farm pages don't use that shell. */
	:global(:root:has(.farm-header)) {
		--header-h: 56px;
	}
	/* No min-height: the body is already --bg, and a 100vh frame under the
	   confirm-your-email banner made a page that fits scroll by the banner. */
	.farm {
		font-size: 16px;
		line-height: 1.45;
		background: var(--bg);
	}
	/* An account page keeps the app's own 14 px base; the header sets its own sizes. */
	.farm.account-page {
		font-size: inherit;
		line-height: inherit;
	}
	.farm-header {
		font-size: 16px;
		line-height: 1.45;
		position: sticky;
		top: 0;
		z-index: 10;
		min-height: var(--header-h);
		padding: 0 8px 0 16px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		background: var(--surface);
		border-bottom: 1px solid var(--border);
	}
	.spacer {
		flex: 1;
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
	.farm-main :global(h1) {
		margin: 0;
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 26px;
		line-height: 1.2;
		overflow-wrap: anywhere;
	}
	.farm-main :global(h2) {
		margin: 0;
		font-size: 17px;
		line-height: 1.3;
	}
	.farm-main :global(p) {
		margin: 0;
	}
	.farm-main :global(.card) {
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
	.farm-main :global(.card.model) {
		border: 1px dashed var(--border-strong);
	}
	.farm-main :global(.big) {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 8px;
	}
	.farm-main :global(.big > :first-child) {
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 40px;
		line-height: 1;
	}
	.farm-main :global(.sub) {
		color: var(--text-2);
	}
	.farm-main :global(.fine) {
		font-size: 14px;
		color: var(--text-muted);
	}
	.farm-main :global(.link) {
		min-height: var(--tap);
		display: inline-flex;
		align-items: center;
		gap: 6px;
		align-self: flex-start;
		font-weight: 600;
		color: var(--accent);
	}
	.farm-main :global(.meter) {
		height: 12px;
		border-radius: 6px;
		background: var(--surface-sunken);
		overflow: hidden;
	}
	.farm-main :global(.meter > span) {
		display: block;
		height: 100%;
		background: var(--series-1);
	}
	.farm-main :global(.dates) {
		margin-top: 8px;
		font-size: 14px;
		color: var(--text-muted);
	}
	.farm-main :global(.dates.stale) {
		display: flex;
		gap: 6px;
		align-items: flex-start;
		color: var(--warning);
	}
	.farm-main :global(.dates.stale svg) {
		flex-shrink: 0;
		margin-top: 2px;
	}
	.farm-main :global(details > summary) {
		min-height: var(--tap);
		display: flex;
		align-items: center;
		color: var(--accent);
		font-weight: 600;
		cursor: pointer;
	}
	.farm-main :global(table.numbers) {
		width: 100%;
		border-collapse: collapse;
		font-size: 14px;
		font-variant-numeric: tabular-nums;
	}
	.farm-main :global(table.numbers th),
	.farm-main :global(table.numbers td) {
		padding: 4px 0;
		text-align: right;
		border-bottom: 1px solid var(--border);
	}
	.farm-main :global(table.numbers th:first-child) {
		text-align: left;
		font-weight: 400;
	}
	.farm-main :global(table.numbers thead th) {
		font-weight: 600;
	}
</style>
