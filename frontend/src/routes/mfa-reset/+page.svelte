<!-- i18n-section: mfa-reset -->
<script lang="ts">
	// The emailed link that starts the 3-day wait before two-step sign-in is
	// removed from an account whose phone and recovery codes were lost
	// (205_mfa_recovery; docs/ui.md § Sign-in, docs/security.md § Two-step
	// sign-in → Recovery). A button, not on load: a mail scanner that opens
	// the link must not start the wait.
	import { onMount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api, ApiError } from '$lib/api';
	import { linkToken } from '$lib/api/emailAuth';
	import AuthCard, { focusAuthTitle } from '$lib/components/layout/AuthCard.svelte';
	import { fmtStampTime } from '$lib/components/farm/format';
	import { t } from '$lib/i18n/locale.svelte';
	import { errorText } from '$lib/i18n/apiError';

	// Read once, then dropped from the address bar so it doesn't linger in history.
	const token = linkToken(page.url);
	onMount(() => {
		if (page.url.searchParams.has('token')) replaceState(`${base}/mfa-reset`, {});
	});

	let busy = $state(false);
	let error = $state<string | null>(null);
	let linkDead = $state(!token);
	let effectiveAt = $state<string | null>(null);

	async function startWait() {
		if (!token) return;
		busy = true;
		error = null;
		try {
			effectiveAt = (await api.auth.mfa.reset.confirm(token)).effectiveAt;
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
	<title>{t('{page} · Water Management', { page: t('Remove two-step sign-in') })}</title>
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<AuthCard title={t('Remove two-step sign-in')} subtitle={t('For when your phone and your recovery codes are both lost.')}>
	{#if effectiveAt}
		<div class="alert alert-info" role="status" data-reset-started>
			<p>{t('The 3-day wait has started. Two-step sign-in will be removed at {when}, and every device will be signed out.', { when: fmtStampTime(effectiveAt) })}</p>
			<p>{t('We’ll email you every day until then. Then sign in with your password alone, and set up two-step sign-in again on your Account page.')}</p>
		</div>
		<a class="btn btn-primary" href="{base}/login">{t('Back to sign in')}</a>
	{:else if linkDead}
		<div class="alert alert-error" role="alert">{t('This link is invalid, already used, or older than 1 hour. Sign in again and ask for a new one.')}</div>
		<a class="btn btn-primary" href="{base}/login">{t('Sign in')}</a>
	{:else}
		{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
		<p>{t('Confirm to start a 3-day wait. When it ends, two-step sign-in is removed from your account and every device is signed out.')}</p>
		<p>{t('Until then your authenticator app keeps working, and we email you every day with a link to cancel. Signing in with a code also cancels it.')}</p>
		<button type="button" class="btn btn-primary" onclick={startWait} disabled={busy}>{busy ? t('Checking…') : t('Start the 3-day wait')}</button>
		<p class="muted">{t('If you didn’t ask for this, close this page: someone knows your password, so choose a new one.')}</p>
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
