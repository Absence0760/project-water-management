<!-- i18n-section: login -->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api, ApiError } from '$lib/api';
	import { safeNext } from '$lib/auth/redirect';
	import { session } from '$lib/auth/session.svelte';
	import PasswordInput from '$lib/components/common/PasswordInput.svelte';
	import AuthCard from '$lib/components/layout/AuthCard.svelte';
	import { t } from '$lib/i18n/locale.svelte';
	import { errorText } from '$lib/i18n/apiError';

	// Dev-only shortcut to the seeded demo account; never in a production build.
	const DEMO = import.meta.env.DEV ? { email: 'demo@example.com', password: 'demo-password' } : null;

	let email = $state('');
	let password = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	// Carries what was typed, so the reset form starts filled in.
	const forgotHref = $derived(
		`${base}/forgot-password${email.trim() ? `?email=${encodeURIComponent(email.trim())}` : ''}`
	);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		try {
			session.user = await api.auth.login(email.trim(), password);
			await goto(safeNext(page.url.searchParams.get('next'), `${base}/`), { replaceState: true });
		} catch (err) {
			// A wrong password, a lockout (429) or anything else, worded from the error's code (docs/api.md § Errors).
			error = err instanceof ApiError && err.status === 401 ? t('Wrong email or password.') : errorText(err);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>{t('{page} · Water Management', { page: t('Sign in') })}</title></svelte:head>

<AuthCard title={t('Sign in')} subtitle={t('Welcome back. Sign in to your catchment projects.')}>
	{#if DEMO}
		<div class="demo">
			<span>Demo: <span class="mono">{DEMO.email}</span> / <span class="mono">{DEMO.password}</span></span>
			<button
				type="button"
				class="btn btn-sm"
				onclick={() => {
					email = DEMO.email;
					password = DEMO.password;
				}}>Use demo account</button
			>
		</div>
	{/if}
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
	<form onsubmit={submit}>
		<div class="field">
			<label for="email">{t('Email')}</label>
			<input id="email" type="email" autocomplete="email" inputmode="email" required bind:value={email} />
		</div>
		<div class="field">
			<label for="password">{t('Password')}</label>
			<PasswordInput id="password" autocomplete="current-password" required bind:value={password} />
			<a class="forgot" href={forgotHref}>{t('Forgot password?')}</a>
		</div>
		<button class="btn btn-primary" type="submit" disabled={busy}>{busy ? t('Signing in…') : t('Sign in')}</button>
	</form>
	{#snippet footer()}
		{t('No account?')} <a href="{base}/register{page.url.search}">{t('Create one')}</a>
	{/snippet}
</AuthCard>

<style>
	.forgot {
		align-self: flex-end;
		font-size: 0.85rem;
		text-decoration: underline;
		/* Comfortable tap target without growing the visible text. */
		padding: 0.35rem 0;
	}
	.demo {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		flex-wrap: wrap;
		padding: 0.55rem 0.7rem;
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius);
		background: var(--surface-2);
		font-size: 0.8rem;
		color: var(--text-2);
	}
</style>
