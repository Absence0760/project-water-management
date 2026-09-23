<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { api } from '$lib/api';
	import { session } from '$lib/auth/session.svelte';

	let signingOut = $state(false);

	async function signOut() {
		signingOut = true;
		try {
			await api.auth.logout();
		} catch {
			// Even if the call fails, drop the local session and go to login.
		}
		session.user = null;
		signingOut = false;
		await goto(`${base}/login`);
	}
</script>

<header class="app-header">
	<a class="brand" href="{base}/">
		<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
			<path d="M12 2.5c-3.2 4.4-6.5 8.3-6.5 12a6.5 6.5 0 0 0 13 0c0-3.7-3.3-7.6-6.5-12Z" fill="currentColor" />
		</svg>
		<span>Water Balance</span>
	</a>
	{#if session.user}
		<nav aria-label="Main"><a href="{base}/">Projects</a></nav>
		<div class="spacer"></div>
		<span class="user" title={session.user.email}>{session.user.displayName}</span>
		<button type="button" class="btn btn-sm" onclick={signOut} disabled={signingOut}>Sign out</button>
	{/if}
</header>

<style>
	.app-header {
		display: flex;
		align-items: center;
		gap: 1rem;
		height: 48px;
		padding: 0 var(--gutter);
		background: var(--surface);
		border-bottom: 1px solid var(--border);
		position: sticky;
		top: 0;
		z-index: 20;
	}
	.brand {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		font-weight: 650;
		color: var(--text);
		letter-spacing: 0.01em;
	}
	.brand svg {
		color: var(--accent);
	}
	.brand:hover {
		text-decoration: none;
	}
	nav a {
		color: var(--text-2);
		font-weight: 500;
	}
	.spacer {
		flex: 1;
	}
	.user {
		color: var(--text-2);
		font-size: 0.875rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 40vw;
	}
</style>
