<!-- i18n-section: banner -->
<script lang="ts">
	// "You have an invitation" nudge (issue #136): adding someone by email is
	// always an invite, and an account joins only when its holder accepts on
	// /account/invitations. Shown on every signed-in page while one waits,
	// except that page itself. Mount once, just under the app header, in
	// routes/+layout.svelte, for a confirmed address only (an unconfirmed one
	// gets VerifyEmailBanner: confirming it accepts its invites).
	import { page } from '$app/state';
	import { base } from '$app/paths';
	import { session } from '$lib/auth/session.svelte';
	import { t, tn } from '$lib/i18n/locale.svelte';
	import { plural } from '$lib/i18n/msg';
	import { invitesChanged, loadPendingInvites, pendingInvites } from './pendingInvites.svelte';

	const INVITATIONS = plural({ one: '{n} invitation', other: '{n} invitations' });

	$effect(() => {
		const user = session.user;
		if (user?.emailVerified) void loadPendingInvites(user.id);
	});
	// An invitation that arrives during a long session: read the count again when the tab comes back into view.
	$effect(() => {
		const onVisible = () => {
			if (document.visibilityState === 'visible' && session.user?.emailVerified) invitesChanged();
		};
		document.addEventListener('visibilitychange', onVisible);
		return () => document.removeEventListener('visibilitychange', onVisible);
	});

	const here = $derived(page.url.pathname.slice(base.length) === '/account/invitations');
	const show = $derived(!!session.user?.emailVerified && pendingInvites.user === session.user.id && pendingInvites.count > 0 && !here);
</script>

{#if show}
	<section class="invites-banner" aria-label={t('Invitations')}>
		<p>{t('You have {invitations} waiting.', { invitations: tn(INVITATIONS, pendingInvites.count) })}</p>
		<a class="btn btn-sm" href="{base}/account/invitations">{t('See invitations')}</a>
	</section>
{/if}

<style>
	.invites-banner {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 1rem;
		padding: 0.5rem var(--gutter);
		background: var(--accent-soft);
		border-bottom: 1px solid var(--border);
		color: var(--text);
	}
	.invites-banner p {
		margin: 0;
	}
</style>
