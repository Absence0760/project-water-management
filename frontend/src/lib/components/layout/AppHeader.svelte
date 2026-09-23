<script lang="ts">
	import { tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import { session } from '$lib/auth/session.svelte';
	import BrandMark from './BrandMark.svelte';

	let signingOut = $state(false);

	// Section the current URL belongs to, for aria-current on the nav.
	const section = $derived.by(() => {
		const p = page.url.pathname.slice(base.length) || '/';
		if (p === '/' || p.startsWith('/projects')) return 'projects';
		if (p.startsWith('/teams')) return 'teams';
		if (p.startsWith('/help')) return 'help';
		return null;
	});

	const initials = $derived(
		(session.user?.displayName ?? '')
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((w) => w[0]!.toUpperCase())
			.join('') || '?'
	);

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

{#if session.user}
	<a class="skip" href="#main">Skip to content</a>
	<header class="app-header">
		<a class="brand" href="{base}/" aria-label="Water Management — projects">
			<BrandMark size={28} />
			<span class="wordmark" aria-hidden="true">Water Management</span>
		</a>
		<nav aria-label="Main">
			<a href="{base}/" aria-current={section === 'projects' ? 'page' : undefined}>Projects</a>
			<a href="{base}/teams" aria-current={section === 'teams' ? 'page' : undefined}>Teams</a>
			<a href="{base}/help" aria-current={section === 'help' ? 'page' : undefined}>Help</a>
		</nav>
		<div class="spacer"></div>
		<div class="account">
			<span class="avatar" aria-hidden="true">{initials}</span>
			<span class="who">
				<span class="name">{session.user.displayName}</span>
				<span class="email">{session.user.email}</span>
			</span>
			<button type="button" class="btn btn-sm" onclick={signOut} disabled={signingOut}>
				{signingOut ? 'Signing out…' : 'Sign out'}
			</button>
		</div>
	</header>
{/if}

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
	.app-header {
		display: flex;
		align-items: center;
		gap: 1.5rem;
		height: var(--header-h);
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
		gap: 0.55rem;
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 1.15rem;
		color: var(--brand-navy);
		letter-spacing: -0.01em;
		white-space: nowrap;
		min-height: var(--tap);
	}
	.brand:hover {
		text-decoration: none;
	}
	nav {
		display: flex;
		align-self: stretch;
		gap: 0.25rem;
	}
	nav a {
		display: inline-flex;
		align-items: center;
		padding: 0 0.7rem;
		color: var(--text-2);
		font-weight: 500;
		border-bottom: 2px solid transparent;
		border-top: 2px solid transparent;
	}
	nav a:hover {
		color: var(--text);
		text-decoration: none;
		background: var(--surface-2);
	}
	nav a[aria-current='page'] {
		color: var(--accent);
		border-bottom-color: var(--accent);
	}
	nav a:focus-visible {
		outline-offset: -2px;
	}
	.spacer {
		flex: 1;
	}
	.account {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		min-width: 0;
	}
	.avatar {
		flex: none;
		display: inline-grid;
		place-items: center;
		width: 30px;
		height: 30px;
		border-radius: 50%;
		background: var(--accent-soft);
		color: var(--accent);
		font-size: 0.75rem;
		font-weight: 700;
	}
	.who {
		display: flex;
		flex-direction: column;
		min-width: 0;
		line-height: 1.2;
	}
	.name {
		font-weight: 500;
		font-size: 0.85rem;
	}
	.email {
		color: var(--text-muted);
		font-size: 0.75rem;
	}
	.name,
	.email {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 22ch;
	}
	@media (prefers-color-scheme: dark) {
		.brand {
			color: var(--text);
		}
	}
	@media (max-width: 760px) {
		.who {
			display: none;
		}
	}
	@media (max-width: 560px) {
		.app-header {
			gap: 0.5rem;
		}
		.wordmark,
		.avatar {
			display: none;
		}
		nav a {
			padding: 0 0.6rem;
		}
	}
</style>
