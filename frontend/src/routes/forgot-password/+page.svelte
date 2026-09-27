<!-- i18n-section: forgot -->
<script lang="ts">
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import { emailAuthApi } from '$lib/api/emailAuth';
	import AuthCard, { focusAuthTitle } from '$lib/components/layout/AuthCard.svelte';
	import { t, tRich } from '$lib/i18n/locale.svelte';
	import { errorText } from '$lib/i18n/apiError';
	import Rich from '$lib/i18n/Rich.svelte';

	const emailAuth = emailAuthApi(api);

	// Prefill from ?email= (e.g. a "Forgot password?" link that carries what was typed).
	let email = $state(page.url.searchParams.get('email') ?? '');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let sentTo = $state<string | null>(null);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		try {
			await emailAuth.forgotPassword(email.trim());
			sentTo = email.trim();
			void focusAuthTitle();
		} catch (err) {
			error = errorText(err);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>{t('{page} · Water Management', { page: t('Reset your password') })}</title></svelte:head>

<AuthCard title={sentTo ? t('Check your email') : t('Reset your password')} subtitle={sentTo ? undefined : t('Enter the email address you signed up with and we’ll send you a link to choose a new password.')}>
	{#if sentTo}
		<!-- Same message whether or not the address has an account (no enumeration). -->
		<div class="alert alert-info" role="status">
			<p><Rich text={tRich('If there is an account for **{email}**, we’ve emailed it a link to choose a new password.', { email: sentTo })} /></p>
			<p>{t('The link works once and expires in 1 hour. Check your spam folder if it doesn’t arrive in a few minutes.')}</p>
		</div>
		<button type="button" class="btn" onclick={() => {
			sentTo = null;
			void focusAuthTitle();
		}}>{t('Use a different address')}</button>
	{:else}
		{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
		<form onsubmit={submit}>
			<div class="field">
				<label for="email">{t('Email')}</label>
				<input id="email" type="email" autocomplete="email" inputmode="email" required bind:value={email} />
			</div>
			<button class="btn btn-primary" type="submit" disabled={busy}>{busy ? t('Sending…') : t('Send reset link')}</button>
		</form>
	{/if}
	{#snippet footer()}
		{t('Remembered it?')} <a href="{base}/login">{t('Sign in')}</a>
	{/snippet}
</AuthCard>

<style>
	.alert p:last-child {
		margin-bottom: 0;
	}
</style>
