<!-- i18n-section: mfa-reset -->
<script lang="ts">
	// The cancel link in every email of the 3-day wait before two-step sign-in
	// is removed (205_mfa_recovery; docs/ui.md § Sign-in, docs/security.md
	// § Two-step sign-in → Recovery). It needs no sign-in: the person it
	// protects may not be able to sign in. A button, not on load, like the
	// confirmation page.
	import { onMount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api, ApiError } from '$lib/api';
	import { linkToken } from '$lib/api/emailAuth';
	import AuthCard, { focusAuthTitle } from '$lib/components/layout/AuthCard.svelte';
	import { t } from '$lib/i18n/locale.svelte';
	import { errorText } from '$lib/i18n/apiError';

	const token = linkToken(page.url);
	onMount(() => {
		if (page.url.searchParams.has('token')) replaceState(`${base}/mfa-reset/cancel`, {});
	});

	let busy = $state(false);
	let error = $state<string | null>(null);
	let linkDead = $state(!token);
	let done = $state(false);

	async function cancel() {
		if (!token) return;
		busy = true;
		error = null;
		try {
			await api.auth.mfa.reset.cancel(token);
			done = true;
			void focusAuthTitle();
		} catch (err) {
			if (err instanceof ApiError && err.code === 'link_invalid') {
				linkDead = true;
				void focusAuthTitle();
			} else error = errorText(err);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>{t('{page} · Water Management', { page: t('Keep two-step sign-in') })}</title>
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<AuthCard title={t('Keep two-step sign-in')} subtitle={t('Cancel the request to remove it from your account.')}>
	{#if done}
		<div class="alert alert-info" role="status" data-reset-cancelled>
			<p>{t('Cancelled. Two-step sign-in stays on your account.')}</p>
			<p>{t('If you didn’t ask for it to be removed, someone knows your password and can read your email: change both passwords now.')}</p>
		</div>
		<a class="btn btn-primary" href="{base}/forgot-password">{t('Choose a new password')}</a>
	{:else if linkDead}
		<div class="alert alert-error" role="alert">{t('This link no longer works: the request was already cancelled, or two-step sign-in has already been removed.')}</div>
		<a class="btn btn-primary" href="{base}/login">{t('Sign in')}</a>
	{:else}
		{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
		<p>{t('Someone asked to remove two-step sign-in from your account. If it wasn’t you, or you found your phone, cancel it.')}</p>
		<button type="button" class="btn btn-primary" onclick={cancel} disabled={busy}>{busy ? t('Checking…') : t('Cancel the removal')}</button>
	{/if}
	{#snippet footer()}
		<a href="{base}/login">{t('Back to sign in')}</a>
	{/snippet}
</AuthCard>

<style>
	p {
		margin: 0;
	}
	.alert {
		display: grid;
		gap: 0.5rem;
	}
</style>
