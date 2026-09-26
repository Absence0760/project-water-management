<script lang="ts">
	// The page an alert email's "Stop these emails" link opens (WP-2.13,
	// docs/ui.md § Alerts). Works signed in or out: the token in the URL's
	// fragment (never sent to a server log) is the credential, and it only
	// ever turns its own alert off. It asks first rather than acting on
	// arrival, so a mail scanner that opens links can't switch a farmer's dam
	// alerts off; a mail client's own one-click unsubscribe (RFC 8058) posts
	// to the API directly. Its words come from $lib/i18n.
	import { onMount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api, type Unsubscribed } from '$lib/api';
	import { fragmentToken, unsubscribedText } from '$lib/components/alerts/words';
	import AuthCard from '$lib/components/layout/AuthCard.svelte';
	import { t } from '$lib/i18n/locale.svelte';

	let token = $state<string | null>(null);
	let status = $state<'loading' | 'ask' | 'working' | 'done' | 'dead' | 'incomplete'>('loading');
	let done = $state<Unsubscribed | null>(null);

	onMount(() => {
		token = fragmentToken(page.url.hash);
		// Out of the address bar and the history once read.
		if (page.url.hash) replaceState(`${base}/alerts/unsubscribe`, {});
		status = token ? 'ask' : 'incomplete';
	});

	async function confirm() {
		if (!token) return;
		status = 'working';
		try {
			done = await api.alerts.unsubscribe(token);
			status = 'done';
		} catch {
			status = 'dead';
		}
	}
</script>

<svelte:head>
	<title>{t('common.pageTitle', { page: t('unsubscribe.title') })}</title>
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<AuthCard title={t('unsubscribe.title')}>
	<div data-ready={status === 'loading' ? undefined : 'true'} data-state={status}>
		{#if status === 'ask' || status === 'working'}
			<p>{t('unsubscribe.ask')}</p>
			<button type="button" class="btn btn-primary" onclick={confirm} disabled={status === 'working'}>
				{status === 'working' ? t('unsubscribe.working') : t('unsubscribe.confirm')}
			</button>
		{:else if status === 'done' && done}
			<div class="alert alert-info" role="status">{unsubscribedText(done)}</div>
			<a class="btn btn-primary" href="{base}/account/alerts">{t('unsubscribe.manage')}</a>
		{:else if status === 'dead'}
			<div class="alert alert-error" role="alert">{t('unsubscribe.dead')}</div>
			<a class="btn btn-primary" href="{base}/account/alerts">{t('unsubscribe.manage')}</a>
		{:else if status === 'incomplete'}
			<div class="alert alert-error" role="alert">{t('unsubscribe.noToken')}</div>
		{/if}
	</div>
	{#snippet footer()}
		<a href="{base}/account/alerts">{t('unsubscribe.manage')}</a>
	{/snippet}
</AuthCard>
