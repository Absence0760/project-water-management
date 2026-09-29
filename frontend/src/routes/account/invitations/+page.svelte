<!-- i18n-section: invitations -->
<script lang="ts">
	// Your pending invitations (issue #136, docs/ui.md § Invitations). Adding
	// someone by email is always an invite: an account that already exists
	// joins a project or team only when its holder accepts here, so being added
	// never happens unasked, and the adder never learns whether the address has
	// an account. Linked from the invite email and the banner every page shows
	// while an invitation waits (InvitesBanner). Farmers meet it, so its words
	// come from $lib/i18n; it sits in the account pages' frame.
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import { api, type MyInvite } from '$lib/api';
	import SectionHeader from '$lib/components/workspace/SectionHeader.svelte';
	import { invitesChanged } from '$lib/components/auth-extras/pendingInvites.svelte';
	import { fmtDay } from '$lib/format/number';
	import { msg, type Msg } from '$lib/i18n/msg';
	import { t } from '$lib/i18n/locale.svelte';
	import { errorText } from '$lib/i18n/apiError';

	/** What an invitation makes you, in words (project and team roles alike, as roleLabels.ts reads them). */
	const ROLE: Record<string, Msg> = {
		farmer: msg('a farmer'),
		contributor: msg('an applicant'),
		viewer: msg('a viewer'),
		editor: msg('an editor'),
		owner: msg('an owner'),
		member: msg('an editor'),
		admin: msg('an owner')
	};
	const roleWords = (role: string) => (ROLE[role] ? t(ROLE[role]) : role);

	let invites = $state<MyInvite[] | null>(null);
	let loadError = $state<string | null>(null);
	let busy = $state<string | null>(null);
	/** The last thing that happened, for the status line; a failure goes in `error`. */
	let done = $state<{ text: string; href?: string; link?: string } | null>(null);
	let error = $state<string | null>(null);

	async function load() {
		loadError = null;
		try {
			invites = await api.invites.mine();
		} catch (e) {
			loadError = errorText(e);
		}
	}
	onMount(load);

	async function accept(inv: MyInvite) {
		busy = inv.id;
		error = null;
		done = null;
		try {
			const joined = await api.invites.accept(inv.id);
			invites = (invites ?? []).filter((x) => x.id !== inv.id);
			invitesChanged();
			const farmer = inv.role === 'farmer';
			const id = encodeURIComponent(joined.id);
			done = {
				text: t('You joined {name}.', { name: inv.name }),
				href: joined.kind === 'team' ? `${base}/teams/${id}` : farmer ? `${base}/farm/${id}` : `${base}/projects/${id}`,
				link: farmer ? t('Open your hydrological unit') : t('Open it')
			};
		} catch (e) {
			error = errorText(e);
			// Gone meanwhile (revoked, expired, accepted in another tab): show the list as it is now.
			await load();
		} finally {
			busy = null;
		}
	}

	async function decline(inv: MyInvite) {
		busy = inv.id;
		error = null;
		done = null;
		try {
			await api.invites.decline(inv.id);
			invites = (invites ?? []).filter((x) => x.id !== inv.id);
			invitesChanged();
			done = { text: t('You declined the invitation to {name}.', { name: inv.name }) };
		} catch (e) {
			error = errorText(e);
			await load();
		} finally {
			busy = null;
		}
	}
</script>

<svelte:head>
	<title>{t('{page} · Water Management', { page: t('Invitations', {}, 'page title') })}</title>
</svelte:head>

<main class="page invitations-page" data-ready={invites !== null || loadError !== null ? 'true' : undefined}>
	<SectionHeader title={t('Invitations')}>
		{#snippet context()}
			<span>{t('Nobody joins a catchment or team for you: you join when you accept, and whoever invited you sees only that the invitation was declined.')}</span>
		{/snippet}
		{#snippet actions()}
			<a class="btn" href="{base}/account">{t('Back to your account')}</a>
		{/snippet}
	</SectionHeader>

	<p class="status" role="status" aria-live="polite">
		{#if done}{done.text}{#if done.href}{' '}<a href={done.href}>{done.link}</a>{/if}{/if}
	</p>
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}

	{#if loadError}
		<div class="alert alert-error" role="alert">{loadError} <button type="button" class="btn btn-sm" onclick={load}>{t('Try again')}</button></div>
	{:else if invites === null}
		<p class="muted" role="status">…</p>
	{:else if !invites.length}
		<p class="panel empty">{t('You have no invitations waiting.')}</p>
	{:else}
		<ul class="cards">
			{#each invites as inv (inv.id)}
				<li class="panel card" aria-labelledby="inv-{inv.id}" data-invite={inv.id}>
					<h2 id="inv-{inv.id}">{inv.name}</h2>
					<p>
						{inv.kind === 'team'
							? t('{inviter} invited you to the team as {role}.', { inviter: inv.invitedBy, role: roleWords(inv.role) })
							: t('{inviter} invited you to this catchment as {role}.', { inviter: inv.invitedBy, role: roleWords(inv.role) })}
					</p>
					{#if inv.farms.length}
						<p class="farms">{t('Your hydrological units: {farms}', { farms: inv.farms.join(', ') })}</p>
					{/if}
					<p class="muted small">{t('Open until {date}.', { date: fmtDay(inv.expiresAt.slice(0, 10)) })}</p>
					<div class="actions">
						<button type="button" class="btn btn-primary" onclick={() => accept(inv)} disabled={busy !== null} aria-describedby="inv-{inv.id}">
							{busy === inv.id ? t('Joining…') : t('Accept')}
						</button>
						<button type="button" class="btn" onclick={() => decline(inv)} disabled={busy !== null} aria-describedby="inv-{inv.id}">{t('Decline')}</button>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</main>

<style>
	/* The account pages' reading frame (routes/account/alerts). */
	.invitations-page {
		max-width: 92rem;
		padding-bottom: 1.5rem;
	}
	.status {
		margin: 0.5rem 0;
		min-height: 1.4em;
	}
	.cards {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.75rem;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 22rem), 1fr));
	}
	.card h2 {
		margin: 0 0 0.35rem;
		font-size: 1.05rem;
		overflow-wrap: anywhere;
	}
	.card p {
		margin: 0 0 0.35rem;
		overflow-wrap: anywhere;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}
	.empty {
		margin: 0;
	}
</style>
