<script lang="ts">
	// The account menu (Account, Sign out, Sign out everywhere): a disclosure
	// list of a link and buttons, same pattern as DownloadMenu (no
	// role="menu"/menuitem, so no arrow-key contract to keep). In the app
	// sidebar's foot it opens upward (`up`); in the phone bar, downward, and
	// `compact` shows the initials only.

	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import { tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import { session } from '$lib/auth/session.svelte';
	import { clearAllSaved } from '$lib/components/farm/savedCopy';
	import { clearNoteCounts } from '$lib/components/notes/counts.svelte';

	let { up = false, compact = false }: { up?: boolean; compact?: boolean } = $props();

	let signingOut = $state(false);
	let menuOpen = $state(false);
	let accountRoot: HTMLDivElement | undefined = $state();
	let trigger: HTMLButtonElement | undefined = $state();
	const menuId = 'account-menu';

	const onAccountPage = $derived((page.url.pathname.slice(base.length) || '/') === '/account');

	const initials = $derived(
		(session.user?.displayName ?? '')
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((w) => w[0]!.toUpperCase())
			.join('') || '?'
	);

	function closeMenu(refocus = false) {
		menuOpen = false;
		if (refocus) trigger?.focus();
	}

	function onMenuKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && menuOpen) {
			e.stopPropagation();
			closeMenu(true);
		}
	}

	// Close when focus or a click leaves the widget.
	function onMenuFocusOut(e: FocusEvent) {
		if (menuOpen && accountRoot && !accountRoot.contains(e.relatedTarget as Node | null)) menuOpen = false;
	}
	$effect(() => {
		if (!menuOpen) return;
		const onDoc = (e: PointerEvent) => {
			if (accountRoot && !accountRoot.contains(e.target as Node)) menuOpen = false;
		};
		document.addEventListener('pointerdown', onDoc);
		return () => document.removeEventListener('pointerdown', onDoc);
	});

	// Let the layout's route guard react first (it would send us to
	// /login?next=<this page>); the explicit navigation below then wins, so
	// the next person to sign in isn't dropped onto this user's page.
	async function finishSignOut() {
		// The farmer view's saved copies stay on the phone only while signed in (design §9).
		clearAllSaved();
		clearNoteCounts();
		session.user = null;
		signingOut = false;
		await tick();
		await goto(`${base}/login`);
	}

	async function signOut() {
		closeMenu();
		signingOut = true;
		try {
			await api.auth.logout();
		} catch {
			// Even if the call fails, drop the local session and go to login.
		}
		await finishSignOut();
	}

	async function signOutEverywhere() {
		closeMenu();
		const ok = await confirmDialog({
			title: 'Sign out of every device?',
			message: 'Any other browser or device signed in to this account — including this one — will need to sign in again.',
			confirmLabel: 'Sign out everywhere',
			danger: true
		});
		if (!ok) return;
		signingOut = true;
		try {
			await api.auth.logoutEverywhere();
		} catch {
			// Even if the call fails, drop the local session and go to login.
		}
		await finishSignOut();
	}
</script>

{#if session.user}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="account" class:up class:compact bind:this={accountRoot} onkeydown={onMenuKeydown} onfocusout={onMenuFocusOut}>
		<button
			type="button"
			class="account-trigger"
			bind:this={trigger}
			aria-label="Account menu for {session.user.displayName}"
			aria-expanded={menuOpen}
			aria-controls={menuId}
			disabled={signingOut}
			onclick={() => (menuOpen = !menuOpen)}
		>
			<span class="avatar" aria-hidden="true">{initials}</span>
			<span class="who">
				<span class="name">{session.user.displayName}</span>
				<span class="email">{session.user.email}</span>
			</span>
			<span aria-hidden="true" class="caret">▾</span>
		</button>
		<ul id={menuId} class="menu" hidden={!menuOpen}>
			<li>
				<a
					class="item"
					href="{base}/account"
					aria-current={onAccountPage ? 'page' : undefined}
					onclick={() => closeMenu()}
				>
					<span class="label">Account</span>
					<span class="hint" aria-hidden="true">Name and password</span>
				</a>
			</li>
			<li>
				<button type="button" class="item" onclick={signOut} disabled={signingOut}>
					<span class="label">Sign out</span>
					<span class="hint" aria-hidden="true">Just this device</span>
				</button>
			</li>
			<li>
				<button type="button" class="item item-danger" onclick={signOutEverywhere} disabled={signingOut}>
					<span class="label">Sign out everywhere</span>
					<span class="hint" aria-hidden="true">Every device, including this one</span>
				</button>
			</li>
		</ul>
		<!-- Only while the menu is open (so it exists before a sign-out starts and can announce
		     it): an always-present empty status region would sit on every page. -->
		{#if menuOpen || signingOut}
			<p class="visually-hidden" role="status" aria-live="polite">{signingOut ? 'Signing out…' : ''}</p>
		{/if}
	</div>
{/if}

<style>
	.account {
		position: relative;
		min-width: 0;
	}
	.account-trigger {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		min-width: 0;
		padding: 0.3rem 0.4rem;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: transparent;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}
	.account-trigger:hover:not(:disabled),
	.account-trigger[aria-expanded='true'] {
		background: var(--surface-2);
	}
	.account-trigger:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
	.caret {
		flex: none;
		font-size: 0.75em;
		color: var(--text-muted);
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
	/* The dropdown: anchored under the trigger. Unlike DownloadMenu it never
	   sits inside a scrolling ancestor, so plain absolute positioning (no
	   viewport math, no position: fixed) is enough. */
	.menu {
		position: absolute;
		z-index: 30;
		top: calc(100% + 4px);
		right: 0;
		min-width: 14rem;
		max-width: min(20rem, calc(100vw - 2 * var(--gutter)));
		margin: 0;
		padding: 0.25rem;
		list-style: none;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: 0 6px 20px rgb(0 0 0 / 0.14);
	}
	.menu[hidden] {
		display: none;
	}
	.item {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		width: 100%;
		padding: 0.4rem 0.6rem;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.item:hover:not(:disabled),
	.item:focus-visible {
		background: var(--row-hover);
		text-decoration: none;
	}
	a.item[aria-current='page'] .label {
		color: var(--accent);
		font-weight: 600;
	}
	.item:disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}
	.item-danger .label {
		color: var(--danger);
	}
	.item .hint {
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	/* In the sidebar's foot the trigger fills the width and the menu opens above it. */
	.up .account-trigger {
		width: 100%;
		text-align: left;
	}
	.up .menu {
		top: auto;
		bottom: calc(100% + 4px);
		left: 0;
		right: auto;
	}
	.compact .who,
	.compact .caret {
		display: none;
	}
</style>
