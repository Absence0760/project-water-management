<script lang="ts">
	import { onMount, untrack, type Snippet } from 'svelte';
	import { goto, onNavigate } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api, ApiError } from '$lib/api';
	import { safeNext } from '$lib/auth/redirect';
	import { watchScrollRegions } from '$lib/a11y/scrollRegions';
	import { stylesheetsReady } from '$lib/nav/stylesheets';
	import { isAccountPath, isFarmerOnly } from '$lib/auth/frame';
	import { isLandingRoot, isPublicPath, routeAccess, session, STATIC_PATHS } from '$lib/auth/session.svelte';
	import { dropProjectPage, startProjectPage } from '$lib/workspace/firstLoad';
	import ChunkFailed from '$lib/components/common/ChunkFailed.svelte';
	import AppShell from '$lib/components/layout/AppShell.svelte';
	import { msg, type Msg } from '$lib/i18n/msg';

	import '../app.css';

	let { children }: { children: Snippet } = $props();
	let bootError = $state<string | null>(null);

	// The landing page (issue #57): a signed-out visitor to `/` sees it in place
	// of the projects list, loaded as its own chunk, fetched beside /auth/me so
	// it is usually in by the time the answer is. /welcome is the same page
	// prerendered (routes/welcome), shown at once, before the session is known,
	// since nothing on it depends on who is looking.
	const loadLanding = () => import('$lib/components/landing/Landing.svelte');
	// By route, not by path: while prerendering, `base` is relative ('.'), so a
	// path comparison would miss it and the page would prerender as "Loading…".
	const staticPage = $derived(STATIC_PATHS.includes(page.route.id ?? ''));
	const landingRoot = $derived(session.checked && isLandingRoot(page.url.pathname, base, !!session.user));

	async function checkSession() {
		bootError = null;
		if (isLandingRoot(page.url.pathname, base, false)) loadLanding().catch(() => {});
		// The catchment page's own requests go out beside /auth/me, not after it
		// (workspace/firstLoad.ts); the page still mounts only once it answers.
		startProjectPage(page.url.pathname, base);
		try {
			session.user = await api.auth.me();
		} catch (e) {
			dropProjectPage();
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

	// The re-acceptance step (docs/legal-status.md): signed in, but the terms
	// and privacy notice changed since this account accepted them (or it
	// accepted none): a full-page notice in place of any app page until it
	// accepts (TermsUpdate, its own chunk). The public pages stay open, so the
	// legal pages can be read from it.
	const termsGate = $derived(session.user?.termsCurrent === false && !isPublicPath(page.url.pathname, base));

	// Sign-in and emailed-link pages have their own full-screen layout (AuthCard),
	// even when a signed-in user opens a reset or confirmation link; so does the
	// re-acceptance notice.
	const authScreen = $derived(isPublicPath(page.url.pathname, base) || landingRoot || termsGate);
	// The farmer view (/farm/…) has its own header and Menu (FarmShell): a farmer
	// has no projects, teams or workspace to navigate to.
	const farmScreen = $derived(/^\/farm(\/|$)/.test(page.url.pathname.slice(base.length)));

	// A user whose every membership is `farmer` has no workspace, so their
	// account pages (/account/**) sit in the farmer view's frame too
	// (FarmShell: translated, with the way back to their farms), not in the
	// workspace's English sidebar. Only the membership list says so: it is
	// read once per signed-in user when they first open an account page, and
	// the page waits for it rather than flash the wrong frame. FarmShell is
	// its own chunk, loaded only for such a user. If either fails, the
	// workspace frame still works, so that is the fallback.
	const accountScreen = $derived(isAccountPath(page.url.pathname, base));
	type FarmShellModule = typeof import('$lib/components/farm/FarmShell.svelte');
	let farmFrame = $state.raw<{ user: string; shell: FarmShellModule | null } | null>(null);
	async function checkFarmFrame(user: string) {
		let shell: FarmShellModule | null = null;
		try {
			const projects = await api.projects.list();
			if (isFarmerOnly(projects.map((p) => p.role))) shell = await import('$lib/components/farm/FarmShell.svelte');
		} catch {
			shell = null;
		}
		if (session.user?.id === user) farmFrame = { user, shell };
	}
	$effect(() => {
		const user = session.user?.id;
		if (!user || !accountScreen || farmFrame?.user === user) return;
		untrack(() => checkFarmFrame(user));
	});
	const frameKnown = $derived(!accountScreen || !session.user || farmFrame?.user === session.user.id);
	const farmShell = $derived(accountScreen && session.user && farmFrame?.user === session.user.id ? farmFrame.shell : null);

	// Language (WP-2.5, docs/ui.md § Language), on the translated surfaces
	// only (sign-in pages, the farm view, the account and alert pages, the
	// public /share page, the landing page): the modeller workspace is English and never loads
	// the message catalogue.
	// The i18n module is imported on the first translated route; the language
	// is the account's when signed in and chosen, else this device's, else the
	// browser's, re-resolved when the user signs in or out or changes it (the
	// switch updates session.user). The route renders once that language is
	// set (i18nReady), so it never shows one language and then another.
	const translated = $derived(
		landingRoot || termsGate || /^\/(login|register|forgot-password|reset-password|verify-email|farm|account|alerts|share|welcome)(\/|$)/.test(page.url.pathname.slice(base.length))
	);
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
	const ready = $derived(session.checked && !bootError && access === 'show' && (!translated || i18nReady) && frameKnown);
	// The static pages (/welcome, /privacy, /terms, /methods) render at once (and
	// prerender), so crawlers and a slow API still get them (even with the API
	// down: they need none). /welcome is English until the language's words
	// arrive, the one page that may switch; the legal and methods pages are English only.
	const shown = $derived(staticPage || ready);
</script>

<!-- A signed-in person's pages sit in the app frame (a sidebar on wide screens,
     a slim bar on phones, AppShell); sign-in pages and the farmer view have
     their own, and a farmer-only user's account pages the farmer view's. -->
{#snippet content()}
	<!-- Loaded only for an unconfirmed address: it is worded from the catalogue, which the workspace doesn't load otherwise. -->
	{#if !authScreen && session.user?.emailVerified === false}
		{#await import('$lib/components/auth-extras/VerifyEmailBanner.svelte') then banner}
			<banner.default />
		{:catch}
			<div class="verify-failed"><ChunkFailed text={words(BANNER_FAILED)} reload={words(RELOAD_PAGE)} /></div>
		{/await}
	{/if}
	{#if bootError && !staticPage}
		<main class="page">
			<div class="alert alert-error" role="alert">
				Could not reach the API: {bootError}
				<button type="button" class="btn btn-sm" onclick={checkSession}>Try again</button>
			</div>
		</main>
	{:else if i18nFailed && translated && !staticPage}
		<main class="page">
			<ChunkFailed what="This page" />
		</main>
	{:else if shown && termsGate}
		{#await import('$lib/components/auth-extras/TermsUpdate.svelte') then gate}
			<div id="main" tabindex="-1"><gate.default /></div>
		{:catch}
			<main class="page"><ChunkFailed what="This page" /></main>
		{/await}
	{:else if shown && landingRoot}
		{#await loadLanding() then landing}
			<div id="main" tabindex="-1"><landing.default /></div>
		{:catch}
			<main class="page"><ChunkFailed what="This page" /></main>
		{/await}
	{:else if shown}
		<div id="main" tabindex="-1">{@render children()}</div>
	{:else}
		<main class="page"><p class="muted" role="status">Loading…</p></main>
	{/if}
{/snippet}

{#if farmShell && !termsGate}
	<!-- The farm frame's words wait for the language, like the page's. -->
	{#if ready}
		<!-- /account has its own language switch (Language and units); one is enough. -->
		<farmShell.default accountPage languageSwitch={page.url.pathname.slice(base.length) !== '/account'}>{@render content()}</farmShell.default>
	{:else}
		{@render content()}
	{/if}
{:else if !authScreen && !farmScreen && session.user && frameKnown}
	<AppShell>{@render content()}</AppShell>
{:else}
	{@render content()}
{/if}

<style>
	/* In the verify-email banner's place, under the header. */
	.verify-failed {
		padding: 0.5rem var(--gutter) 0;
	}
</style>
