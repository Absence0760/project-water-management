<!-- i18n-section: unsubscribe -->
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
	import { api, ApiError, type Unsubscribed } from '$lib/api';
	import { fragmentToken, unsubscribedText } from '$lib/components/alerts/words';
	import AuthCard, { focusAuthTitle } from '$lib/components/layout/AuthCard.svelte';
	import { t } from '$lib/i18n/locale.svelte';
	import { errorText } from '$lib/i18n/apiError';

	let token = $state<string | null>(null);
	let status = $state<'loading' | 'ask' | 'working' | 'done' | 'dead' | 'incomplete'>('loading');
	let done = $state<Unsubscribed | null>(null);
	/** A failure that isn't the link's (no signal, a server problem): the question and its button stay, to try again. */
	let failure = $state<string | null>(null);

	onMount(() => {
		token = fragmentToken(page.url.hash);
		// Out of the address bar and the history once read.
		if (page.url.hash) replaceState(`${base}/alerts/unsubscribe`, {});
		status = token ? 'ask' : 'incomplete';
	});

	async function confirm() {
		if (!token) return;
		status = 'working';
		failure = null;
		try {
			done = await api.alerts.unsubscribe(token);
			status = 'done';
			void focusAuthTitle();
		} catch (e) {
			// Only the server's "this link is no good" (404, or 400 for a malformed token) means the link is dead.
			if (e instanceof ApiError && (e.status === 404 || e.status === 400)) {
				status = 'dead';
				void focusAuthTitle();
			} else {
				failure = errorText(e);
				status = 'ask';
			}
		}
	}
</script>

<svelte:head>
	<title>{t('{page} · Water Management', { page: t('Stop alert emails') })}</title>
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<!-- Once the answer offers Manage alerts as its button, the footer doesn't repeat it. -->
<AuthCard title={t('Stop alert emails')} footer={status === 'done' || status === 'dead' ? undefined : manageLink}>
	<div data-ready={status === 'loading' ? undefined : 'true'} data-state={status}>
		{#if status === 'ask' || status === 'working'}
			<p>{t('Stop getting these alert emails? You can turn them back on from your account at any time.')}</p>
			{#if failure}<div class="alert alert-error" role="alert">{failure}</div>{/if}
			<button type="button" class="btn btn-primary" onclick={confirm} disabled={status === 'working'}>
				{status === 'working' ? t('One moment…') : t('Stop these emails')}
			</button>
		{:else if status === 'done' && done}
			<div class="alert alert-info" role="status">{unsubscribedText(done)}</div>
			<a class="btn btn-primary" href="{base}/account/alerts">{t('Manage alerts')}</a>
		{:else if status === 'dead'}
			<div class="alert alert-error" role="alert">{t('This link doesn’t work any more: a newer email may have replaced it, or you may no longer be a member of the catchment.')}</div>
			<a class="btn btn-primary" href="{base}/account/alerts">{t('Manage alerts')}</a>
		{:else if status === 'incomplete'}
			<div class="alert alert-error" role="alert">{t('This link is incomplete. Open it again from the email, or copy the whole link.')}</div>
		{/if}
	</div>
</AuthCard>

{#snippet manageLink()}
	<a href="{base}/account/alerts">{t('Manage alerts')}</a>
{/snippet}
