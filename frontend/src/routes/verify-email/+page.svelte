<!-- i18n-section: verify -->
<script lang="ts">
	// Reached from the confirmation email. Works signed in or out (the token is
	// the proof); signed in, the banner and session update straight away.
	import { onMount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import { emailAuthApi, linkToken } from '$lib/api/emailAuth';
	import { session } from '$lib/auth/session.svelte';
	import AuthCard from '$lib/components/layout/AuthCard.svelte';
	import { t, tRich } from '$lib/i18n/locale.svelte';
	import { errorText } from '$lib/i18n/apiError';
	import Rich from '$lib/i18n/Rich.svelte';

	const emailAuth = emailAuthApi(api);
	const token = linkToken(page.url);

	let status = $state<'working' | 'done' | 'failed'>(token ? 'working' : 'failed');
	let resendMsg = $state<string | null>(null);
	let resending = $state(false);

	onMount(async () => {
		if (page.url.searchParams.has('token')) replaceState(`${base}/verify-email`, {});
		if (!token) return;
		try {
			await emailAuth.verifyEmail(token);
			if (session.user) session.user = { ...session.user, emailVerified: true };
			status = 'done';
		} catch {
			// A second click on a spent link is fine if the address is verified.
			try {
				session.user = await api.auth.me();
			} catch {
				/* the failure message below still applies */
			}
			status = session.user?.emailVerified ? 'done' : 'failed';
		}
	});

	async function resend() {
		resending = true;
		resendMsg = null;
		try {
			await emailAuth.resendVerification();
			resendMsg = t('We’ve sent a new link to {email}.', { email: session.user?.email ?? t('your address') });
		} catch (err) {
			resendMsg = errorText(err);
		} finally {
			resending = false;
		}
	}
</script>

<svelte:head>
	<title>{t('{page} · Water Management', { page: t('Confirm your email') })}</title>
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<AuthCard title={t('Confirm your email')}>
	{#if status === 'working'}
		<p role="status">{t('Confirming your email address…')}</p>
	{:else if status === 'done'}
		<div class="alert alert-info" role="status">
			{#if session.user}
				<Rich text={tRich('Thanks — **{email}** is confirmed. Any projects or teams you were invited to are now in your list.', { email: session.user.email })} />
			{:else}
				{t('Thanks — your email address is confirmed. Sign in to see any projects or teams you were invited to.')}
			{/if}
		</div>
		{#if session.user}
			<a class="btn btn-primary" href="{base}/">{t('Go to your projects')}</a>
		{:else}
			<a class="btn btn-primary" href="{base}/login">{t('Sign in')}</a>
		{/if}
	{:else}
		<div class="alert alert-error" role="alert">{t('This confirmation link is invalid, already used, or older than 48 hours.')}</div>
		{#if session.user}
			<button type="button" class="btn btn-primary" onclick={resend} disabled={resending}>
				{resending ? t('Sending…') : t('Send a new link')}
			</button>
			<p class="muted resend" role="status" aria-live="polite">{resendMsg ?? ''}</p>
		{:else}
			<p><Rich text={tRich('Sign in and use **Resend email** in the banner at the top of the page to get a new link.')} /></p>
			<a class="btn btn-primary" href="{base}/login">{t('Sign in')}</a>
		{/if}
	{/if}
	{#snippet footer()}
		{#if session.user}
			<a href="{base}/">{t('Back to your projects')}</a>
		{:else}
			{t('No account yet?')} <a href="{base}/register">{t('Create one')}</a>
		{/if}
	{/snippet}
</AuthCard>

<style>
	.resend {
		margin-top: 0.75rem;
	}
</style>
