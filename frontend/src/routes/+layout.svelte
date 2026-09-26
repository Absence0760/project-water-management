<script lang="ts">
	import { onMount, untrack, type Snippet } from 'svelte';
	import { goto, onNavigate } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api, ApiError } from '$lib/api';
	import { safeNext } from '$lib/auth/redirect';
	import { watchScrollRegions } from '$lib/a11y/scrollRegions';
	import { stylesheetsReady } from '$lib/nav/stylesheets';
	import { isPublicPath, routeAccess, session } from '$lib/auth/session.svelte';
	import ChunkFailed from '$lib/components/common/ChunkFailed.svelte';
	import AppHeader from '$lib/components/layout/AppHeader.svelte';
	import { msg, type Msg } from '$lib/i18n/msg';

	import '../app.css';

	let { children }: { children: Snippet } = $props();
	let bootError = $state<string | null>(null);

	async function checkSession() {
		bootError = null;
		try {
			session.user = await api.auth.me();
		} catch (e) {
			if (e instanceof ApiError && e.status === 401) session.user = null;
			else bootError = e instanceof Error ? e.message : String(e);
		}
		session.checked = true;
	}

	onMount(checkSession);
	// A client navigation commits only once the new page's stylesheets have
	// loaded; otherwise SvelteKit + Vite can render it unstyled for a moment
	// and a scroll or measurement made then is wrong ($lib/nav/stylesheets).
	onNavigate(() => stylesheetsReady());
	// Wide tables and drawings that scroll sideways take keyboard focus when they overflow.
	onMount(() => watchScrollRegions(document.body));

	// Route guard (routeAccess): signed-out users go to /login (remembering
	// where they were); signed-in users skip the sign-in pages — to the
	// remembered ?next= page, so this guard and the login form's own redirect
	// agree on where to land. Emailed-link pages (reset/verify, and an invitation
	// on /register) work either way.
	const access = $derived(routeAccess(page.url.pathname, base, !!session.user, page.url.searchParams));
	$effect(() => {
		if (!session.checked || bootError) return;
		if (access === 'login') {
			const next = page.url.pathname + page.url.search;
			goto(`${base}/login?next=${encodeURIComponent(next)}`, { replaceState: true });
		} else if (access === 'leave') {
			goto(safeNext(page.url.searchParams.get('next'), `${base}/`), { replaceState: true });
		}
	});

	// Sign-in and emailed-link pages have their own full-screen layout (AuthCard),
	// even when a signed-in user opens a reset or confirmation link.
	const authScreen = $derived(isPublicPath(page.url.pathname, base));
	// The farmer view (/farm/…) has its own header and Menu (FarmShell): a farmer
	// has no projects, teams or workspace to navigate to.
	const farmScreen = $derived(/^\/farm(\/|$)/.test(page.url.pathname.slice(base.length)));

	// Language (WP-2.5, docs/ui.md § Language), on the translated surfaces
	// only (sign-in pages, the farm view, the account and alert pages, the
	// public /share page): the modeller workspace is English and never loads
	// the message catalogue.
	// The i18n module is imported on the first translated route; the language
	// is the account's when signed in and chosen, else this device's, else the
	// browser's, re-resolved when the user signs in or out or changes it (the
	// switch updates session.user). The route renders once that language is
	// set (i18nReady), so it never shows one language and then another.
	const translated = $derived(/^\/(login|register|forgot-password|reset-password|verify-email|farm|account|alerts|share)(\/|$)/.test(page.url.pathname.slice(base.length)));
	type I18n = typeof import('$lib/i18n/locale.svelte');
	let i18nModule = $state.raw<I18n | null>(null);
	let i18nReady = $state(false);
	let i18nFailed = $state(false);

	// The "confirm your email" banner is its own chunk (it carries the i18n
	// module). If it fails to download, say so in its place rather than drop
	// the reminder: an unconfirmed address holds back pending invitations.
	// Worded here with msg(), since the banner's own t() calls are in the chunk
	// that failed: through the i18n module where the page loaded it (the
	// translated pages), else the English (the workspace is English).
	// i18n-section: banner
	const BANNER_FAILED = msg('The reminder to confirm your email address could not be loaded. Check your connection, then reload the page.');
	const RELOAD_PAGE = msg('Reload page');
	const words = (m: Msg): string => (i18nModule ? i18nModule.t(m) : m);
	const accountLocale = $derived(session.user?.locale ?? null);
	async function applyLocale(chosen: string | null) {
		i18nFailed = false;
		try {
			const m = i18nModule ?? (await import('$lib/i18n/locale.svelte'));
			i18nModule = m;
			await m.setLocale(m.resolveLocale(chosen, m.readStoredLocale()));
			i18nReady = true;
		} catch {
			// The i18n module or the catalogue chunk didn't arrive. Only a reload
			// can fetch it again (common/lazy.ts), so ChunkFailed, in English:
			// the catalogue is what failed.
			i18nFailed = true;
		}
	}
	$effect(() => {
		const chosen = accountLocale;
		if (!session.checked || !translated) return;
		untrack(() => applyLocale(chosen));
	});
	// <html lang> names the language the page's words are in (wordsLang: it
	// stays English until the chosen language's catalogue is complete).
	$effect(() => {
		document.documentElement.lang = translated && i18nModule ? i18nModule.wordsLang() : 'en';
	});
	const ready = $derived(session.checked && !bootError && access === 'show' && (!translated || i18nReady));
</script>

{#if !authScreen}
	{#if !farmScreen}<AppHeader />{/if}
	<!-- Loaded only for an unconfirmed address: it is worded from the catalogue, which the workspace doesn't load otherwise. -->
	{#if session.user?.emailVerified === false}
		{#await import('$lib/components/auth-extras/VerifyEmailBanner.svelte') then banner}
			<banner.default />
		{:catch}
			<div class="verify-failed"><ChunkFailed text={words(BANNER_FAILED)} reload={words(RELOAD_PAGE)} /></div>
		{/await}
	{/if}
{/if}

{#if bootError}
	<main class="page">
		<div class="alert alert-error" role="alert">
			Could not reach the API: {bootError}
			<button type="button" class="btn btn-sm" onclick={checkSession}>Try again</button>
		</div>
	</main>
{:else if i18nFailed && translated}
	<main class="page">
		<ChunkFailed what="This page" />
	</main>
{:else if ready}
	<div id="main" tabindex="-1">{@render children()}</div>
{:else}
	<main class="page"><p class="muted" role="status">Loading…</p></main>
{/if}

<style>
	/* In the verify-email banner's place, under the header. */
	.verify-failed {
		padding: 0.5rem var(--gutter) 0;
	}
</style>
