<!-- i18n-section: account.delete -->
<script lang="ts">
	// "Delete my account" on the account page (issue #112; POPIA s24). A
	// short card whose button opens a dialog: what goes, what stays without
	// the name and what keeps it (Privacy §7, docs/security.md § Personal
	// information), then the password again. The card stays small so the
	// account page still fits a laptop's window. The only owner of a project or only admin of a team is refused
	// (409 account_sole_holder) with a list of what to hand over first. Once
	// the account is gone this browser forgets it, as signing out does, and
	// the sign-in page says it was deleted (?deleted=1). docs/ui.md § Account.
	import { tick } from 'svelte';
	import { base } from '$app/paths';
	import { api } from '$lib/api';
	import type { SoleHoldings } from '$lib/api/types';
	import { forgetSession } from '$lib/auth/signOut';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import PasswordInput from '$lib/components/common/PasswordInput.svelte';
	import { errorText } from '$lib/i18n/apiError';
	import { t } from '$lib/i18n/locale.svelte';
	import { soleHoldingsOf } from './deleteAccount';

	let open = $state(false);
	let password = $state('');
	let deleting = $state(false);
	let error = $state<string | null>(null);
	let held = $state<SoleHoldings | null>(null);
	let heldBox: HTMLDivElement | undefined = $state();

	function start() {
		password = '';
		error = null;
		held = null;
		open = true;
	}

	async function deleteAccount(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		held = null;
		if (!password) {
			error = t('Enter your password.');
			return;
		}
		deleting = true;
		try {
			await api.auth.deleteMe(password);
		} catch (err) {
			deleting = false;
			held = soleHoldingsOf(err);
			if (held) {
				// The list replaces the form's question: take the reader to it (WCAG 2.4.3).
				await tick();
				heldBox?.focus();
			} else error = errorText(err);
			return;
		}
		// Gone: forget it here as signing out does (lib/auth/signOut.ts), then say so on the sign-in page.
		password = '';
		open = false;
		await forgetSession('/login?deleted=1', { replaceState: true });
	}
</script>

<section class="panel" aria-labelledby="delete-h">
	<h2 id="delete-h">{t('Delete my account')}</h2>
	<p class="muted intro">{t('Deleting your account removes your name and email address. What you made for a project stays, without your name.')}</p>
	<button class="btn btn-danger" type="button" onclick={start}>{t('Delete my account')}</button>
</section>

<Dialog bind:open title={t('Delete your account?')} wide closeButton={false}>
	<p class="lead">{t('Deleting your account can’t be undone. This is what happens:')}</p>
	<div class="what">
		<div>
			<h3>{t('Deleted')}</h3>
			<ul>
				<li>{t('Your name, email address and password')}</li>
				<li>{t('Your memberships of projects and teams, and your links to hydrological units')}</li>
				<li>{t('Your alert choices, and the alert emails sent to you')}</li>
				<li>{t('Your settings')}</li>
				<li>{t('An uncertainty result you started and never finished, and a licence application still in draft')}</li>
			</ul>
		</div>
		<div>
			<h3>{t('Kept, without your name')}</h3>
			<ul>
				<li>{t('What you made for a project: the project or team itself, model runs, imports, scenarios, a licence application you submitted, notes')}</li>
				<li>{t('The project’s history of what you did')}</li>
			</ul>
			<p class="muted small">{t('They will read “Deleted user” or “a former member”, and are never put in someone else’s name.')}</p>
		</div>
		<div>
			<h3>{t('Kept, with your name')}</h3>
			<ul>
				<li>{t('A sign-off keeps the name and registration you typed, and an evidence pack keeps the names it printed, for as long as the licence record they support.')}</li>
			</ul>
		</div>
	</div>
	<p class="muted small">
		{t('If you are the only owner of a project or the only admin of a team, hand it to someone else first. We email you what was deleted and what was kept. Copies in our backups are deleted as the backups expire, within 35 days.')}
		<a href="{base}/privacy#retention">{t('Privacy notice')}</a>
	</p>

	{#if held}
		<div class="alert alert-error held" role="alert" tabindex="-1" bind:this={heldBox} data-sole-holder>
			<p>{t('Your account wasn’t deleted: someone else needs to take over these first.')}</p>
			{#if held.projects.length}
				<p>{t('You are the only owner of these projects. Make someone else an owner, or delete the project:')}</p>
				<ul>
					{#each held.projects as p (p.id)}
						<li><a href="{base}/projects/{p.id}">{p.name}</a></li>
					{/each}
				</ul>
			{/if}
			{#if held.teams.length}
				<p>{t('You are the only admin of these teams. Make someone else an admin, or delete the team:')}</p>
				<ul>
					{#each held.teams as team (team.id)}
						<li><a href="{base}/teams/{team.id}">{team.name}</a></li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}

	<form id="delete-form" onsubmit={deleteAccount} novalidate>
		{#if error}<div class="alert alert-error" role="alert" id="delete-error">{error}</div>{/if}
		<div class="field">
			<label for="delete-password">{t('Your password')}</label>
			<PasswordInput
				id="delete-password"
				autocomplete="current-password"
				maxlength={200}
				aria-invalid={error ? 'true' : undefined}
				aria-describedby={error ? 'delete-error delete-hint' : 'delete-hint'}
				bind:value={password}
			/>
			<span class="hint" id="delete-hint">{t('Type your password again to confirm.')}</span>
		</div>
	</form>
	{#snippet actions()}
		<button class="btn" type="button" onclick={() => (open = false)} disabled={deleting}>{t('Cancel')}</button>
		<button class="btn btn-danger" type="submit" form="delete-form" disabled={deleting}>
			{deleting ? t('Deleting…') : t('Delete my account')}
		</button>
	{/snippet}
</Dialog>

<style>
	.panel {
		padding: 1rem 1.1rem 0.75rem;
	}
	h2 {
		margin: 0 0 0.75rem;
		font-size: 1.05rem;
	}
	.intro {
		margin: 0 0 0.75rem;
		max-width: 60ch;
	}
	.panel .btn {
		margin-bottom: 0.25rem;
	}
	.lead {
		margin: 0 0 0.75rem;
	}
	h3 {
		margin: 0 0 0.25rem;
		font-size: 0.95rem;
	}
	.what {
		display: grid;
		gap: 0.75rem;
		margin-bottom: 0.75rem;
	}
	.what ul,
	.held ul {
		margin: 0;
		padding-left: 1.25rem;
	}
	.small {
		margin: 0.25rem 0 0.75rem;
		font-size: 0.85rem;
	}
	.held {
		margin-bottom: 0.75rem;
		overflow-wrap: anywhere;
	}
	.held p {
		margin: 0 0 0.35rem;
	}
	.held ul {
		margin-bottom: 0.5rem;
	}
</style>
