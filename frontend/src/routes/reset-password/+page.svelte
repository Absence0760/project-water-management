<script lang="ts">
	import { onMount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api, ApiError } from '$lib/api';
	import { emailAuthApi, linkToken, passwordProblem } from '$lib/api/emailAuth';
	import { session } from '$lib/auth/session.svelte';
	import PasswordInput from '$lib/components/common/PasswordInput.svelte';
	import AuthCard from '$lib/components/layout/AuthCard.svelte';
	import { t, tRich } from '$lib/i18n/locale.svelte';
	import Rich from '$lib/i18n/Rich.svelte';

	const emailAuth = emailAuthApi(api);

	// Read once, then drop it from the address bar so it doesn't linger in
	// history or get copied along with the URL.
	const token = linkToken(page.url);
	onMount(() => {
		if (page.url.searchParams.has('token')) replaceState(`${base}/reset-password`, {});
	});

	let password = $state('');
	let confirm = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let linkDead = $state(!token);
	let done = $state(false);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		const problem = passwordProblem(password, confirm);
		error = problem ? t(problem) : null;
		if (error || !token) return;
		busy = true;
		try {
			await emailAuth.resetPassword(token, password);
			// The server revoked every session, this browser's included.
			session.user = null;
			done = true;
		} catch (err) {
			if (err instanceof ApiError && err.status === 400 && /link/i.test(err.message)) linkDead = true;
			else error = err instanceof Error ? err.message : String(err);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>{t('common.pageTitle', { page: t('reset.title') })}</title>
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<AuthCard title={t('reset.title')} subtitle={t('reset.subtitle')}>
	{#if done}
		<div class="alert alert-info" role="status">{t('reset.done')}</div>
		<a class="btn btn-primary" href="{base}/login">{t('common.signIn')}</a>
	{:else if linkDead}
		<div class="alert alert-error" role="alert">{t('reset.dead')}</div>
		<a class="btn btn-primary" href="{base}/forgot-password">{t('reset.newLink')}</a>
	{:else}
		{#if session.user}
			<p class="signed-in"><Rich text={tRich('reset.signedIn', { email: session.user.email })} /></p>
		{/if}
		{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
		<form onsubmit={submit}>
			<div class="field">
				<label for="password">{t('common.newPassword')}</label>
				<PasswordInput
					id="password"
					autocomplete="new-password"
					required
					minlength={8}
					maxlength={200}
					aria-describedby="password-hint"
					bind:value={password}
				/>
				<span class="hint" id="password-hint">{t('reset.hint')}</span>
			</div>
			<div class="field">
				<label for="confirm">{t('common.repeatNewPassword')}</label>
				<PasswordInput id="confirm" autocomplete="new-password" required maxlength={200} bind:value={confirm} />
			</div>
			<button class="btn btn-primary" type="submit" disabled={busy}>{busy ? t('common.saving') : t('reset.submit')}</button>
		</form>
	{/if}
	{#snippet footer()}
		{#if session.user}
			<a href="{base}/">{t('common.backToProjects')}</a>
		{:else}
			<a href="{base}/login">{t('common.backToSignIn')}</a>
		{/if}
	{/snippet}
</AuthCard>

<style>
	.signed-in {
		padding: 0.55rem 0.7rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface-2);
		font-size: 0.85rem;
		color: var(--text-2);
		overflow-wrap: anywhere;
	}
</style>
