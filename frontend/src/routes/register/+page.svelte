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
	import { i18n, readStoredLocale, t, tRich } from '$lib/i18n/locale.svelte';
	import Rich from '$lib/i18n/Rich.svelte';

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
			resendMsg = t('register.resent');
		} catch (err) {
			if (err instanceof ApiError && err.status === 409 && session.user) {
				session.user = { ...session.user, emailVerified: true };
				resendMsg = t('register.alreadyConfirmed');
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
			? t('register.targetProject', { name: invite.projectName })
			: invite?.teamName
				? t('register.targetTeam', { name: invite.teamName })
				: 'Water Management'
	);

	// Keep ?next= across to sign-in, but not the invite token.
	const next = page.url.searchParams.get('next');
	const loginHref = `${base}/login${next ? `?next=${encodeURIComponent(next)}` : ''}`;

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		if (password.length < 8 || password.length > 200) {
			error = t('register.passwordLength');
			return;
		}
		busy = true;
		try {
			const user = await api.auth.register(
				email.trim(),
				password,
				displayName.trim(),
				inviteState === 'ok' ? inviteToken : null,
				// The language this page was in, when chosen: the account and its emails start in it (WP-2.5).
				readStoredLocale() ?? (i18n.locale !== 'en' ? i18n.locale : null)
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
	<title>{t('common.pageTitle', { page: t('register.pageTitle') })}</title>
	{#if hasInviteParam}<meta name="referrer" content="no-referrer" />{/if}
</svelte:head>

{#if signedInAs}
	<AuthCard title={t('register.signedInTitle')}>
		<p><Rich text={tRich('register.signedInAs', { email: signedInAs.email })} /></p>
		{#if inviteState === 'loading'}
			<p class="muted" role="status">{t('register.checkingThis')}</p>
		{:else if inviteState === 'ok' && invite && forMe}
			<div class="invite" role="status">
				<p><Rich text={tRich('register.invitedThis', { inviter: invite.invitedBy, target })} /></p>
				{#if signedInAs.emailVerified}
					<p class="muted">{t('register.confirmedAlready', { target, inviter: invite.invitedBy })}</p>
				{:else}
					<p class="muted">{t('register.joinOnConfirm', { email: signedInAs.email })}</p>
				{/if}
			</div>
			{#if !signedInAs.emailVerified}
				<button type="button" class="btn act" onclick={resendConfirmation} disabled={resending}>
					{resending ? t('common.sending') : t('register.resend')}
				</button>
				<p class="status" role="status" aria-live="polite">{resendMsg ?? ''}</p>
			{/if}
			<a class="btn btn-primary act" href="{base}/">{t('common.goToProjects')}</a>
		{:else if inviteState === 'ok' && invite}
			<div class="alert alert-warning" role="alert">
				<Rich text={tRich('register.otherAddress', { target, email: invite.email })} />
			</div>
			<p class="muted">{t('register.otherAddressHelp', { email: invite.email, inviter: invite.invitedBy, me: signedInAs.email })}</p>
			<button type="button" class="btn btn-primary act" onclick={signOutToAccept} disabled={signingOut}>
				{signingOut ? t('register.signingOut') : t('register.signOutAccept', { email: invite.email })}
			</button>
			<a class="btn act" href="{base}/">{t('register.stay')}</a>
		{:else if inviteState === 'error'}
			<div class="alert alert-warning" role="alert">{t('register.checkFailedSignedIn')}</div>
			<a class="btn btn-primary act" href="{base}/">{t('common.goToProjects')}</a>
		{:else}
			<div class="alert alert-warning" role="alert">{t('register.deadLinkSignedIn')}</div>
			<a class="btn btn-primary act" href="{base}/">{t('common.goToProjects')}</a>
		{/if}
		{#snippet footer()}
			{t('register.notYou')} <button type="button" class="linkish" onclick={signOutToAccept} disabled={signingOut}>{t('common.signOut')}</button>
		{/snippet}
	</AuthCard>
{:else}
<AuthCard
	title={inviteState === 'ok' ? t('register.titleInvite') : t('register.title')}
	subtitle={inviteState === 'ok' ? undefined : t('register.subtitle')}
>
	{#if inviteState === 'loading'}
		<p class="muted" role="status">{t('register.checking')}</p>
	{:else if inviteState === 'ok' && invite}
		<div class="invite" role="status">
			<p><Rich text={tRich('register.invitedYou', { inviter: invite.invitedBy, target })} /></p>
			<p class="muted">{t('register.joinNow')}</p>
		</div>
	{:else if inviteState === 'dead'}
		<div class="alert alert-warning" role="alert">{t('register.deadLink')}</div>
	{:else if inviteState === 'error'}
		<div class="alert alert-warning" role="alert">{t('register.checkFailed')}</div>
	{/if}
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
	<form onsubmit={submit} aria-busy={inviteState === 'loading'}>
		<div class="field">
			<label for="name">{t('common.displayName')}</label>
			<input id="name" autocomplete="name" required maxlength="100" bind:value={displayName} />
		</div>
		<div class="field">
			<label for="email">{t('common.email')}</label>
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
					{t('register.emailHintInvite', { inviter: invite?.invitedBy ?? '' })}
				{:else}
					{t('register.emailHint')}
				{/if}
			</span>
		</div>
		<div class="field">
			<label for="password">{t('common.password')}</label>
			<PasswordInput
				id="password"
				autocomplete="new-password"
				required
				minlength={8}
				maxlength={200}
				aria-describedby="pw-hint"
				bind:value={password}
			/>
			<span class="hint" id="pw-hint">{t('register.passwordHint')}</span>
		</div>
		<button class="btn btn-primary" type="submit" disabled={busy || inviteState === 'loading'}>
			{busy ? t('register.busy') : inviteState === 'ok' ? t('register.submitInvite') : t('register.submit')}
		</button>
	</form>
	{#snippet footer()}
		{t('register.already')} <a href={loginHref}>{t('common.signIn')}</a>
	{/snippet}
</AuthCard>
{/if}

<style>
	/* Long addresses (bold, from Rich) wrap rather than overflow on a phone. */
	p :global(strong),
	.alert :global(strong) {
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
