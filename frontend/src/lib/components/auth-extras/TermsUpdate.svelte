<!-- i18n-section: terms-update -->
<script lang="ts">
	// The re-acceptance step (docs/legal-status.md): a signed-in account that
	// accepted an older version of the terms and privacy notice (or none, made
	// by a script) sees this in place of any app page until it accepts the
	// version in force (termsCurrent on /auth/me, LEGAL_VERSION). The root
	// layout shows it; the legal pages and the emailed-link pages stay open.
	// Accept records the version (POST /auth/me/accept-terms) and the page
	// the person asked for renders in its place.
	import { tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { focusPageStart } from '$lib/a11y/focusPage';
	import { api } from '$lib/api';
	import { session } from '$lib/auth/session.svelte';
	import { clearAllSaved } from '$lib/components/farm/savedCopy';
	import AuthCard from '$lib/components/layout/AuthCard.svelte';
	import TermsSummary from '$lib/components/legal/TermsSummary.svelte';
	import { errorText } from '$lib/i18n/apiError';
	import { msg, t } from '$lib/i18n/locale.svelte';

	// What changed in this version. Rewrite it whenever LEGAL_VERSION changes.
	// Since 2026-09-28: Privacy §7 (2026-09-30, issue #112) and the alert feedback (2026-10-01, issue #74).
	const CHANGES = [
		msg('When an account is deleted, what it made for a project stays as the project’s record with the name removed. A sign-off’s typed name and the names in an evidence pack are kept only as long as that record.'),
		msg('Alert emails now ask “Was this useful?”. If you answer, your answer and any comment are kept for a year, and your WUA sees them without your name.'),
		msg('Our emails don’t track whether you open them or follow their links.')
	];

	let busy = $state(false);
	let signingOut = $state(false);
	let error = $state<string | null>(null);

	async function accept() {
		busy = true;
		error = null;
		try {
			session.user = await api.auth.acceptTerms();
		} catch (err) {
			error = errorText(err);
			return;
		} finally {
			busy = false;
		}
		// The requested page replaces this one (the root layout): focus its title or #main, not <body> (WCAG 2.4.3).
		await focusPageStart();
	}

	async function signOut() {
		signingOut = true;
		try {
			await api.auth.logout();
		} catch {
			// Drop the local session either way.
		}
		clearAllSaved();
		session.user = null;
		signingOut = false;
		await tick();
		await goto(`${base}/login`);
	}
</script>

<svelte:head>
	<title>{t('{page} · Water Management', { page: t('Our terms have changed') })}</title>
</svelte:head>

<AuthCard legal={false} title={t('Our terms have changed')}>
	<p>{t('Read what changed, then accept the new Terms of use and Privacy notice to carry on.')}</p>
	<h2 class="changed">{t('What changed')}</h2>
	<ul class="changes">
		{#each CHANGES as change (change)}<li>{t(change)}</li>{/each}
	</ul>
	<p class="links">
		<a href="{base}/terms">{t('Terms of use')}</a>
		<a href="{base}/privacy">{t('Privacy notice')}</a>
	</p>
	<TermsSummary id="terms-update-summary" />
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
	<button type="button" class="btn btn-primary act" onclick={accept} disabled={busy || signingOut}>
		{busy ? t('Saving…') : t('Accept the new terms')}
	</button>
	<button type="button" class="btn act" onclick={signOut} disabled={busy || signingOut}>
		{signingOut ? t('Signing out…') : t('Sign out')}
	</button>
</AuthCard>

<style>
	.changed {
		margin: 1rem 0 0.35rem;
		font-size: 1rem;
		font-weight: 600;
	}
	.changes {
		margin: 0;
		padding-left: 1.1rem;
	}
	.changes li + li {
		margin-top: 0.3rem;
	}
	.links {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1.25rem;
		margin: 0.75rem 0;
	}
	.links a {
		display: inline-block;
		min-height: 24px;
	}
	.act {
		display: flex;
		width: 100%;
		justify-content: center;
		min-height: 44px;
		margin-top: 0.75rem;
	}
</style>
