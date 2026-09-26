<script lang="ts">
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api } from '$lib/api';
	import { emailAuthApi } from '$lib/api/emailAuth';
	import AuthCard from '$lib/components/layout/AuthCard.svelte';
	import { t, tRich } from '$lib/i18n/locale.svelte';
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
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>{t('common.pageTitle', { page: t('forgot.title') })}</title></svelte:head>

<AuthCard title={sentTo ? t('forgot.titleSent') : t('forgot.title')} subtitle={sentTo ? undefined : t('forgot.subtitle')}>
	{#if sentTo}
		<!-- Same message whether or not the address has an account (no enumeration). -->
		<div class="alert alert-info" role="status">
			<p><Rich text={tRich('forgot.sentTo', { email: sentTo })} /></p>
			<p>{t('forgot.sentHelp')}</p>
		</div>
		<button type="button" class="btn" onclick={() => (sentTo = null)}>{t('forgot.otherAddress')}</button>
	{:else}
		{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
		<form onsubmit={submit}>
			<div class="field">
				<label for="email">{t('common.email')}</label>
				<input id="email" type="email" autocomplete="email" inputmode="email" required bind:value={email} />
			</div>
			<button class="btn btn-primary" type="submit" disabled={busy}>{busy ? t('common.sending') : t('forgot.submit')}</button>
		</form>
	{/if}
	{#snippet footer()}
		{t('forgot.remembered')} <a href="{base}/login">{t('common.signIn')}</a>
	{/snippet}
</AuthCard>

<style>
	.alert p:last-child {
		margin-bottom: 0;
	}
</style>
