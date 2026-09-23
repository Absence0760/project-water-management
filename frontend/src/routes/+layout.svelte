<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api, ApiError } from '$lib/api';
	import { safeNext } from '$lib/auth/redirect';
	import { isPublicPath, session } from '$lib/auth/session.svelte';
	import AppHeader from '$lib/components/layout/AppHeader.svelte';

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

	// Route guard: signed-out users go to /login (remembering where they were);
	// signed-in users skip the auth pages — to the remembered ?next= page, so
	// this guard and the login form's own redirect agree on where to land.
	$effect(() => {
		if (!session.checked || bootError) return;
		const path = page.url.pathname;
		const isPublic = isPublicPath(path, base);
		if (!session.user && !isPublic) {
			const next = path + page.url.search;
			goto(`${base}/login?next=${encodeURIComponent(next)}`, { replaceState: true });
		} else if (session.user && isPublic) {
			goto(safeNext(page.url.searchParams.get('next'), `${base}/`), { replaceState: true });
		}
	});

	const ready = $derived(
		session.checked && !bootError && (!!session.user === !isPublicPath(page.url.pathname, base))
	);
</script>

<AppHeader />

{#if bootError}
	<main class="page">
		<div class="alert alert-error" role="alert">
			Could not reach the API: {bootError}
			<button type="button" class="btn btn-sm" onclick={checkSession}>Try again</button>
		</div>
	</main>
{:else if ready}
	{@render children()}
{:else}
	<main class="page"><p class="muted" role="status">Loading…</p></main>
{/if}
