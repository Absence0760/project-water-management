<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api, ApiError, type InviteInfo } from '$lib/api';
	import { emailAuthApi, linkToken } from '$lib/api/emailAuth';
	import { safeNext } from '$lib/auth/redirect';
	import { session } from '$lib/auth/session.svelte';
	import PasswordInput from '$lib/components/common/PasswordInput.svelte';
	import AuthCard from '$lib/components/layout/AuthCard.svelte';

	const emailAuth = emailAuthApi(api);

	// An emailed invitation (/register?invite=…): look it up so the page can
	// say who invited whom to what, and lock the address it was sent to. A
	// dead or mangled link falls back to a normal sign-up.
	const hasInviteParam = page.url.searchParams.has('invite');
	const inviteToken = linkToken(page.url, 'invite');
	let invite = $state<InviteInfo | null>(null);
	let inviteState = $state<'none' | 'loading' | 'ok' | 'dead' | 'error'>(
		inviteToken ? 'loading' : hasInviteParam ? 'dead' : 'none'
	);

	// Signed in already (the route guard keeps an invitation link open): say
	// whose invitation this is and what to do, rather than sending them home.
	// `registered` hides this view in the moment between signing up here and
	// moving on.
	let registered = $state(false);
	const signedInAs = $derived(registered ? null : session.user);
	const forMe = $derived(!!invite && !!signedInAs && invite.email.toLowerCase() === signedInAs.email.toLowerCase());
	let signingOut = $state(false);
	let resendMsg = $state<string | null>(null);
	let resending = $state(false);

	async function signOutToAccept() {
		signingOut = true;
		try {
			await api.auth.logout();
		} catch {
			// Drop the local session either way; the sign-up form takes over.
		}
		session.user = null;
		signingOut = false;
	}

	async function resendConfirmation() {
		resending = true;
		resendMsg = null;
		try {
			await emailAuth.resendVerification();
			resendMsg = 'Sent. Check your inbox (and spam folder) for the confirmation link.';
		} catch (err) {
			if (err instanceof ApiError && err.status === 409 && session.user) {
				session.user = { ...session.user, emailVerified: true };
				resendMsg = 'Your address is already confirmed.';
			} else resendMsg = err instanceof Error ? err.message : String(err);
		} finally {
			resending = false;
		}
	}

	let displayName = $state('');
	let email = $state('');
	let password = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	onMount(async () => {
		if (!inviteToken) return;
		try {
			invite = await emailAuth.inviteInfo(inviteToken);
			email = invite.email;
			inviteState = 'ok';
		} catch (err) {
			inviteState = err instanceof ApiError && (err.status === 404 || err.status === 400) ? 'dead' : 'error';
		}
	});

	const target = $derived(
		invite?.projectName
			? `the project ${invite.projectName}`
			: invite?.teamName
				? `the team ${invite.teamName}`
				: 'Water Management'
	);

	// Keep ?next= across to sign-in, but not the invite token.
	const next = page.url.searchParams.get('next');
	const loginHref = `${base}/login${next ? `?next=${encodeURIComponent(next)}` : ''}`;

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		if (password.length < 8 || password.length > 200) {
			error = 'Password must be 8–200 characters.';
			return;
		}
		busy = true;
		try {
			const user = await api.auth.register(
				email.trim(),
				password,
				displayName.trim(),
				inviteState === 'ok' ? inviteToken : null
			);
			registered = true;
			session.user = user;
			await goto(safeNext(page.url.searchParams.get('next'), `${base}/`), { replaceState: true });
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>Create account · Water Management</title>
	{#if hasInviteParam}<meta name="referrer" content="no-referrer" />{/if}
</svelte:head>

{#if signedInAs}
	<AuthCard title="You’re already signed in">
		<p>Signed in as <strong class="addr">{signedInAs.email}</strong>.</p>
		{#if inviteState === 'loading'}
			<p class="muted" role="status">Checking the invitation…</p>
		{:else if inviteState === 'ok' && invite && forMe}
			<div class="invite" role="status">
				<p><strong>{invite.invitedBy}</strong> invited this address to <strong>{target}</strong>.</p>
				{#if signedInAs.emailVerified}
					<p class="muted">
						Your address is confirmed, so you should have access already. If {target} isn’t in your projects, ask
						{invite.invitedBy} to add you again.
					</p>
				{:else}
					<p class="muted">
						You’ll join as soon as you confirm your email address: use the link we sent to {signedInAs.email}.
					</p>
				{/if}
			</div>
			{#if !signedInAs.emailVerified}
				<button type="button" class="btn act" onclick={resendConfirmation} disabled={resending}>
					{resending ? 'Sending…' : 'Resend confirmation email'}
				</button>
				<p class="status" role="status" aria-live="polite">{resendMsg ?? ''}</p>
			{/if}
			<a class="btn btn-primary act" href="{base}/">Go to your projects</a>
		{:else if inviteState === 'ok' && invite}
			<div class="alert alert-warning" role="alert">
				This invitation to <strong>{target}</strong> is for <strong class="addr">{invite.email}</strong>, not the
				account you’re signed in with.
			</div>
			<p class="muted">
				To accept it, sign out and create an account for {invite.email}. To use this account instead, ask
				{invite.invitedBy} to invite {signedInAs.email}.
			</p>
			<button type="button" class="btn btn-primary act" onclick={signOutToAccept} disabled={signingOut}>
				{signingOut ? 'Signing out…' : `Sign out and accept as ${invite.email}`}
			</button>
			<a class="btn act" href="{base}/">Stay signed in and go to your projects</a>
		{:else if inviteState === 'error'}
			<div class="alert alert-warning" role="alert">We couldn’t check this invitation right now. Try the link again later.</div>
			<a class="btn btn-primary act" href="{base}/">Go to your projects</a>
		{:else}
			<div class="alert alert-warning" role="alert">
				This invitation link is invalid, was revoked, or has expired (they last 7 days). Ask whoever invited you to send a
				new one.
			</div>
			<a class="btn btn-primary act" href="{base}/">Go to your projects</a>
		{/if}
		{#snippet footer()}
			Not you? <button type="button" class="linkish" onclick={signOutToAccept} disabled={signingOut}>Sign out</button>
		{/snippet}
	</AuthCard>
{:else}
<AuthCard
	title={inviteState === 'ok' ? 'Accept your invitation' : 'Create an account'}
	subtitle={inviteState === 'ok' ? undefined : 'Model your own catchments, or join a team’s.'}
>
	{#if inviteState === 'loading'}
		<p class="muted" role="status">Checking your invitation…</p>
	{:else if inviteState === 'ok' && invite}
		<div class="invite" role="status">
			<p><strong>{invite.invitedBy}</strong> invited you to <strong>{target}</strong>.</p>
			<p class="muted">Create your account to join. You’ll have access straight away.</p>
		</div>
	{:else if inviteState === 'dead'}
		<div class="alert alert-warning" role="alert">
			This invitation link is invalid, was revoked, or has expired (they last 7 days). You can still create an
			account — then ask whoever invited you to add you again.
		</div>
	{:else if inviteState === 'error'}
		<div class="alert alert-warning" role="alert">
			We couldn’t check your invitation right now. You can still create an account; you’ll join once your email
			address is confirmed.
		</div>
	{/if}
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
	<form onsubmit={submit} aria-busy={inviteState === 'loading'}>
		<div class="field">
			<label for="name">Display name</label>
			<input id="name" autocomplete="name" required maxlength="100" bind:value={displayName} />
		</div>
		<div class="field">
			<label for="email">Email</label>
			<input
				id="email"
				type="email"
				autocomplete="email"
				inputmode="email"
				required
				readonly={inviteState === 'ok'}
				aria-describedby="email-hint"
				bind:value={email}
			/>
			<span class="hint" id="email-hint">
				{#if inviteState === 'ok'}
					The invitation was sent to this address. To use another, ask {invite?.invitedBy} to invite that one instead.
				{:else}
					Colleagues add you to teams and projects by this address.
				{/if}
			</span>
		</div>
		<div class="field">
			<label for="password">Password</label>
			<PasswordInput
				id="password"
				autocomplete="new-password"
				required
				minlength={8}
				maxlength={200}
				aria-describedby="pw-hint"
				bind:value={password}
			/>
			<span class="hint" id="pw-hint">At least 8 characters. A short passphrase works well.</span>
		</div>
		<button class="btn btn-primary" type="submit" disabled={busy || inviteState === 'loading'}>
			{busy ? 'Creating…' : inviteState === 'ok' ? 'Create account and join' : 'Create account'}
		</button>
	</form>
	{#snippet footer()}
		Already registered? <a href={loginHref}>Sign in</a>
	{/snippet}
</AuthCard>
{/if}

<style>
	.addr {
		overflow-wrap: anywhere;
	}
	/* Full-width actions, stacked, like the sign-up button. */
	.act {
		display: flex;
		width: 100%;
		justify-content: center;
		min-height: 44px;
		margin-top: 0.75rem;
	}
	.status {
		margin: 0.5rem 0 0;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.status:empty {
		margin: 0;
	}
	.linkish {
		all: unset;
		color: var(--accent);
		text-decoration: underline;
		font-weight: 500;
		cursor: pointer;
	}
	.linkish:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.invite + .act,
	.alert + .muted {
		margin-top: 0.75rem;
	}
	.invite {
		padding: 0.75rem 0.9rem;
		border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
		border-left: 3px solid var(--accent);
		border-radius: var(--radius);
		background: var(--accent-soft);
		overflow-wrap: anywhere;
	}
	.invite p {
		margin: 0;
	}
	.invite p + p {
		margin-top: 0.25rem;
		font-size: 0.85rem;
	}
</style>
