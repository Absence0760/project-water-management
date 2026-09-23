<script lang="ts">
	import { tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { api } from '$lib/api';
	import { session } from '$lib/auth/session.svelte';
	import BrandMark from './BrandMark.svelte';

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
		// Let the layout's route guard react first (it would send us to
		// /login?next=<this page>); the explicit navigation below then wins, so
		// the next person to sign in isn't dropped onto this user's page.
		await tick();
		await goto(`${base}/login`);
	}
</script>

<header class="app-header">
	<a class="brand" href="{base}/">
		<BrandMark size={26} />
		<span>Water Management</span>
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
		gap: 0.5rem;
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 1.15rem;
		color: var(--text);
		letter-spacing: -0.005em;
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
