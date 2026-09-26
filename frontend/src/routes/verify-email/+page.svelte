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
			resendMsg = t('verify.sentNew', { email: session.user?.email ?? t('verify.yourAddress') });
		} catch (err) {
			resendMsg = err instanceof Error ? err.message : String(err);
		} finally {
			resending = false;
		}
	}
</script>

<svelte:head>
	<title>{t('common.pageTitle', { page: t('verify.title') })}</title>
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<AuthCard title={t('verify.title')}>
	{#if status === 'working'}
		<p role="status">{t('verify.working')}</p>
	{:else if status === 'done'}
		<div class="alert alert-info" role="status">
			{#if session.user}
				<Rich text={tRich('verify.doneSignedIn', { email: session.user.email })} />
			{:else}
				{t('verify.doneSignedOut')}
			{/if}
		</div>
		{#if session.user}
			<a class="btn btn-primary" href="{base}/">{t('common.goToProjects')}</a>
		{:else}
			<a class="btn btn-primary" href="{base}/login">{t('common.signIn')}</a>
		{/if}
	{:else}
		<div class="alert alert-error" role="alert">{t('verify.dead')}</div>
		{#if session.user}
			<button type="button" class="btn btn-primary" onclick={resend} disabled={resending}>
				{resending ? t('common.sending') : t('verify.newLink')}
			</button>
			<p class="muted resend" role="status" aria-live="polite">{resendMsg ?? ''}</p>
		{:else}
			<p><Rich text={tRich('verify.signInToResend')} /></p>
			<a class="btn btn-primary" href="{base}/login">{t('common.signIn')}</a>
		{/if}
	{/if}
	{#snippet footer()}
		{#if session.user}
			<a href="{base}/">{t('common.backToProjects')}</a>
		{:else}
			{t('verify.noAccount')} <a href="{base}/register">{t('verify.createOne')}</a>
		{/if}
	{/snippet}
</AuthCard>

<style>
	.resend {
		margin-top: 0.75rem;
	}
</style>
