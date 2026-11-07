<script lang="ts">
	// The app's error page, in the root layout's frame: a page that crashed
	// (an exception while it loaded or rendered) or an address that matches no
	// page. A crash shows its error id, which hooks.client.ts sent to the API
	// with what threw (POST /client-errors), so a user who quotes it leads the
	// operator to the log line (docs/ui.md § Error page). It can appear on any
	// route, the translated farm and account pages included, but Kit loads it
	// with the app's first download, so it stays off the message catalogue
	// (lib/i18n/boundary.test.ts): its words are msg()s, worded through the
	// i18n module only where the root layout already loaded it.
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { isTranslatedPath } from '#lib/auth/session.svelte.js';
	import { basePath } from '#lib/nav/base.js';
	import { msg, type Msg } from '#lib/i18n/msg.js';

	// i18n-section: crash
	const CRASHED = msg('Something went wrong on this page');
	const NOT_FOUND = msg('Page not found');
	const NOT_SHOWN = msg('This page could not be shown');
	const NOT_FOUND_HINT = msg('Check the address, or go back and follow a link.');
	const ERROR_ID = msg('Error id');
	const QUOTE = msg('If you report this, quote the error id: it tells us exactly what went wrong.');
	const RELOAD = msg('Reload the page');
	const TO_PROJECTS = msg('Back to your projects');
	const TO_FARMS = msg('Back to your hydrological units');

	type Translate = (m: Msg) => string;
	let translate = $state.raw<Translate | null>(null);
	const translated = $derived(isTranslatedPath(page.url.pathname, basePath()));
	$effect(() => {
		if (!translated || translate) return;
		// Already loaded by the root layout on these routes, so this resolves from the module cache.
		import('#lib/i18n/locale.svelte.js')
			.then((m) => (translate = (x: Msg) => m.t(x)))
			.catch(() => {});
	});
	const words = (m: Msg): string => (translate ? translate(m) : m);

	const status = $derived(page.status);
	const heading = $derived(status === 404 ? NOT_FOUND : status >= 500 ? CRASHED : NOT_SHOWN);
	const farm = $derived(/^\/farm(\/|$)/.test(page.url.pathname.slice(basePath().length)));
</script>

<svelte:head><title>{words(heading)} · IC-WBT</title></svelte:head>

<main class="page error-page">
	<h1>{words(heading)}</h1>
	{#if status === 404}
		<p>{words(NOT_FOUND_HINT)}</p>
	{:else if page.error?.message}
		<p class="message" data-error-message>{page.error.message}</p>
	{/if}
	{#if page.error?.id}
		<p class="error-id">{words(ERROR_ID)}: <code data-error-id>{page.error.id}</code></p>
		<p class="muted">{words(QUOTE)}</p>
	{/if}
	<div class="actions">
		{#if status !== 404}
			<button type="button" class="btn btn-primary" onclick={() => location.reload()}>{words(RELOAD)}</button>
		{/if}
		{#if farm}
			<a class="btn" href={resolve('farm')}>{words(TO_FARMS)}</a>
		{:else}
			<a class="btn" href={resolve('')}>{words(TO_PROJECTS)}</a>
		{/if}
	</div>
</main>

<style>
	.error-page {
		max-width: 40rem;
	}
	.message {
		overflow-wrap: anywhere;
	}
	.error-id code {
		user-select: all;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 1rem;
	}
</style>
