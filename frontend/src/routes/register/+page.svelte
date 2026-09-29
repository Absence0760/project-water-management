<!-- i18n-section: register -->
<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api, ApiError, type InviteInfo } from '$lib/api';
	import { emailAuthApi, linkToken } from '$lib/api/emailAuth';
	import { CONFIRM_EMAIL_KEY, safeNext } from '$lib/auth/redirect';
	import { session } from '$lib/auth/session.svelte';
	import PasswordInput from '$lib/components/common/PasswordInput.svelte';
	import AuthCard, { focusAuthTitle } from '$lib/components/layout/AuthCard.svelte';
	import { i18n, readStoredLocale, t, tRich } from '$lib/i18n/locale.svelte';
	import { errorText } from '$lib/i18n/apiError';
	import Rich from '$lib/i18n/Rich.svelte';
	import TermsSummary from '$lib/components/legal/TermsSummary.svelte';

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
		// The sign-up form replaces this view, and the button that was focused with it.
		void focusAuthTitle();
	}

	async function resendConfirmation() {
		resending = true;
		resendMsg = null;
		try {
			await emailAuth.resendVerification();
			resendMsg = t('Sent. Check your inbox (and spam folder) for the confirmation link.');
		} catch (err) {
			if (err instanceof ApiError && err.status === 409 && session.user) {
				session.user = { ...session.user, emailVerified: true };
				resendMsg = t('Your address is already confirmed.');
			} else resendMsg = errorText(err);
		} finally {
			resending = false;
		}
	}

	let displayName = $state('');
	let email = $state('');
	let password = $state('');
	// Asked twice (issue #57, as threkir learned): a typo in the one field
	// would be baked into the account, and its owner locked out of it.
	let password2 = $state('');
	let password2El: HTMLInputElement | undefined = $state();
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
			? t('the project {name}', { name: invite.projectName })
			: invite?.teamName
				? t('the team {name}', { name: invite.teamName })
				: 'Water Management'
	);

	// The assent checkbox's words, "I have read the main points above and accept
	// the {terms} and {privacy}.", split around its two links (t leaves a
	// placeholder it isn't given as written).
	const agreeParts = $derived(t('I have read the main points above and accept the {terms} and {privacy}.').split(/(\{terms\}|\{privacy\})/));
	// Required and unticked: the browser won't submit the form without it.
	let agreed = $state(false);

	// Keep ?next= across to sign-in, but not the invite token.
	const next = page.url.searchParams.get('next');
	const loginHref = `${base}/login${next ? `?next=${encodeURIComponent(next)}` : ''}`;

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		if (password.length < 8 || password.length > 200) {
			error = t('Password must be 8–200 characters.');
			return;
		}
		// Compared exactly: a trailing space is a real difference, never trimmed away.
		if (password !== password2) {
			error = t('The two passwords don’t match. Type the same password in both.');
			password2El?.focus();
			return;
		}
		busy = true;
		try {
			const result = await api.auth.register(
				email.trim(),
				password,
				displayName.trim(),
				inviteState === 'ok' ? inviteToken : null,
				// The language this page was in, when chosen: the account and its emails start in it (WP-2.5).
				readStoredLocale() ?? (i18n.locale !== 'en' ? i18n.locale : null)
			);
			if ('user' in result) {
				// Through a matching invite: confirmed and signed in, straight to it.
				registered = true;
				session.user = result.user;
				await goto(safeNext(page.url.searchParams.get('next'), `${base}/`), { replaceState: true });
				return;
			}
			// An ordinary sign-up: nobody is signed in until the address is
			// confirmed. On to sign-in, which says where the link went and keeps
			// the address (not in the URL: this tab's storage).
			try {
				sessionStorage.setItem(CONFIRM_EMAIL_KEY, result.email);
			} catch {
				// Storage refused (a private window): the notice still shows, without the address.
			}
			const login = new URLSearchParams({ confirm: 'sent' });
			if (next) login.set('next', next);
			await goto(`${base}/login?${login}`, { replaceState: true });
		} catch (err) {
			error = errorText(err);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>{t('{page} · Water Management', { page: t('Create account', {}, 'page title') })}</title>
	{#if hasInviteParam}<meta name="referrer" content="no-referrer" />{/if}
</svelte:head>

{#if signedInAs}
	<AuthCard title={t('You’re already signed in')}>
		<p><Rich text={tRich('Signed in as **{email}**.', { email: signedInAs.email })} /></p>
		{#if inviteState === 'loading'}
			<p class="muted" role="status">{t('Checking the invitation…')}</p>
		{:else if inviteState === 'ok' && invite && forMe}
			<div class="invite" role="status">
				<p><Rich text={tRich('**{inviter}** invited this address to **{target}**.', { inviter: invite.invitedBy, target })} /></p>
				{#if signedInAs.emailVerified}
					<!-- An account that exists joins only when it accepts (issue #136). -->
					<p class="muted">{t('Accept or decline it on your invitations page.')}</p>
				{:else}
					<p class="muted">{t('You’ll join as soon as you confirm your email address: use the link we sent to {email}.', { email: signedInAs.email })}</p>
				{/if}
			</div>
			{#if !signedInAs.emailVerified}
				<button type="button" class="btn act" onclick={resendConfirmation} disabled={resending}>
					{resending ? t('Sending…') : t('Resend confirmation email')}
				</button>
				<p class="status" role="status" aria-live="polite">{resendMsg ?? ''}</p>
			{/if}
			{#if signedInAs.emailVerified}
				<a class="btn btn-primary act" href="{base}/account/invitations">{t('See your invitations')}</a>
			{:else}
				<a class="btn btn-primary act" href="{base}/">{t('Go to your projects')}</a>
			{/if}
		{:else if inviteState === 'ok' && invite}
			<div class="alert alert-warning" role="alert">
				<Rich text={tRich('This invitation to **{target}** is for **{email}**, not the account you’re signed in with.', { target, email: invite.email })} />
			</div>
			<p class="muted">{t('To accept it, sign out and create an account for {email}. To use this account instead, ask {inviter} to invite {me}.', { email: invite.email, inviter: invite.invitedBy, me: signedInAs.email })}</p>
			<button type="button" class="btn btn-primary act" onclick={signOutToAccept} disabled={signingOut}>
				{signingOut ? t('Signing out…') : t('Sign out and accept as {email}', { email: invite.email })}
			</button>
			<a class="btn act" href="{base}/">{t('Stay signed in and go to your projects')}</a>
		{:else if inviteState === 'error'}
			<div class="alert alert-warning" role="alert">{t('We couldn’t check this invitation right now. Try the link again later.')}</div>
			<a class="btn btn-primary act" href="{base}/">{t('Go to your projects')}</a>
		{:else}
			<div class="alert alert-warning" role="alert">{t('This invitation link is invalid, was revoked, or has expired (they last 7 days). Ask whoever invited you to send a new one.')}</div>
			<a class="btn btn-primary act" href="{base}/">{t('Go to your projects')}</a>
		{/if}
		{#snippet footer()}
			{t('Not you?')} <button type="button" class="linkish" onclick={signOutToAccept} disabled={signingOut}>{t('Sign out')}</button>
		{/snippet}
	</AuthCard>
{:else}
<AuthCard
	legal={false}
	fit
	title={inviteState === 'ok' ? t('Accept your invitation') : t('Create an account')}
	subtitle={inviteState === 'none' ? t('Model your own catchments, or join a team’s.') : undefined}
>
	{#if inviteState === 'loading'}
		<p class="muted" role="status">{t('Checking your invitation…')}</p>
	{:else if inviteState === 'ok' && invite}
		<div class="invite" role="status">
			<p><Rich text={tRich('**{inviter}** invited you to **{target}**.', { inviter: invite.invitedBy, target })} /></p>
			<p class="muted">{t('Create your account to join. You’ll have access straight away.')}</p>
		</div>
	{:else if inviteState === 'dead'}
		<div class="alert alert-warning" role="alert">{t('This invitation link has expired or was withdrawn. You can still create an account, then ask to be invited again.')}</div>
	{:else if inviteState === 'error'}
		<div class="alert alert-warning" role="alert">{t('We couldn’t check your invitation right now. You can still create an account; you’ll join once your email address is confirmed.')}</div>
	{/if}
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
	<form onsubmit={submit} aria-busy={inviteState === 'loading'}>
		<div class="field">
			<label for="name">{t('Display name')}</label>
			<input id="name" autocomplete="name" required maxlength="100" bind:value={displayName} />
		</div>
		<div class="field">
			<label for="email">{t('Email')}</label>
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
					{t('The invitation was sent to this address. To use another, ask {inviter} to invite that one instead.', { inviter: invite?.invitedBy ?? '' })}
				{:else}
					{t('We’ll email you a link to confirm your address. You can sign in once it’s confirmed.')}
				{/if}
			</span>
		</div>
		<div class="field">
			<label for="password">{t('Password')}</label>
			<PasswordInput
				id="password"
				autocomplete="new-password"
				required
				minlength={8}
				maxlength={200}
				aria-describedby="pw-hint"
				bind:value={password}
			/>
			<span class="hint" id="pw-hint">{t('At least 8 characters. A short passphrase works well.')}</span>
		</div>
		<div class="field">
			<label for="password2">{t('Confirm password')}</label>
			<PasswordInput
				id="password2"
				autocomplete="new-password"
				required
				minlength={8}
				maxlength={200}
				aria-invalid={password2 !== '' && password2.length >= password.length && password2 !== password ? 'true' : undefined}
				bind:value={password2}
				bind:el={password2El}
			/>
		</div>

		<!-- Directly above the button that makes the account, so the terms are seen before they are accepted
		     (a notice below the button is weak evidence of assent; #47): the main points in the reader's language,
		     then a required, unticked box. The points are in their own scroll box (issue #162), so the form fits
		     a laptop's window and the box, the tick and the button are on screen together: the heading and the
		     first points always show, the whole list shows whenever the window has room, a fade says there is
		     more, and the box scrolls with the keyboard. "Read the full terms" sits beside its heading. -->
		<TermsSummary contained termsHref="{base}/terms" />
		<div class="agree">
			<input id="agree" type="checkbox" required bind:checked={agreed} />
			<label for="agree">
				{#each agreeParts as part, i (i)}{#if part === '{terms}'}<a href="{base}/terms">{t('Terms of use')}</a>{:else if part === '{privacy}'}<a href="{base}/privacy">{t('Privacy notice')}</a>{:else}{part}{/if}{/each}
			</label>
		</div>
		<button class="btn btn-primary" type="submit" disabled={busy || inviteState === 'loading'}>
			{busy ? t('Creating…') : inviteState === 'ok' ? t('Create account and join') : t('Create account')}
		</button>

	</form>
	{#snippet footer()}
		{t('Already registered?')} <a href={loginHref}>{t('Sign in')}</a>
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
	.agree {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		/* No bottom margin: the button's 0.5rem is the gap (the form is a flex column on a wide screen, where margins don't collapse). */
		margin: 0;
		font-size: 1rem;
		color: var(--text-2);
	}
	/* A 24 px target (WCAG 2.5.8), level with the first line. */
	.agree input {
		flex: none;
		width: 1.15rem;
		height: 1.15rem;
		min-width: 24px;
		min-height: 24px;
		margin: 0;
	}
	/* The Terms and Privacy links look like links (accent and underlined, as in running text), not like the label around them (WCAG 1.4.1). */
	.agree a {
		text-decoration: underline;
		font-weight: 400;
	}
	.status {
		margin: 0.5rem 0 0;
		font-size: 1rem;
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
		font-size: 1rem;
	}
</style>
