<script lang="ts">
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import { onMount, untrack } from 'svelte';
	import { base } from '$app/paths';
	import { api, ROLE_LABEL, ROLES, type Invite, type Member, type ProjectTeam, type Role } from '$lib/api';
	import { emailAuthApi } from '$lib/api/emailAuth';
	import PendingInvites from '$lib/components/auth-extras/PendingInvites.svelte';
	import { upsertInvite } from '$lib/components/auth-extras/invites';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { cached } from './cache';
	import EmailText from '$lib/components/common/EmailText.svelte';

	let {
		projectId,
		team = null,
		isOwner,
		currentUserId,
		onLeftProject
	}: {
		projectId: string;
		/** The owning team, if any: its members have access too (not listed here). */
		team?: ProjectTeam | null;
		isOwner: boolean;
		currentUserId: string;
		onLeftProject: () => void;
	} = $props();

	// Last-seen list first (no loading flash when returning to the tab).
	const memo = untrack(() => cached(projectId));
	const hadCache = !!memo.members;
	let members = $state<Member[]>(memo.members ?? []);
	// Farmers are listed, with their farms, in FarmersPanel.
	const shown = $derived(members.filter((m) => m.role !== 'farmer'));
	let loading = $state(!hadCache);
	$effect(() => {
		if (!loading && !loadError) memo.members = $state.snapshot(members);
	});
	let loadError = $state<string | null>(null);
	let error = $state<string | null>(null);
	let busy = $state<string | null>(null);

	let email = $state('');
	let role = $state<Role>('viewer');
	let adding = $state(false);
	let added = $state<string | null>(null);

	const invitesApi = emailAuthApi(api).projectInvites;
	let invites = $state<Invite[]>([]);

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	async function load(quiet = false) {
		loading = !quiet;
		loadError = null;
		try {
			members = await api.members.list(projectId);
		} catch (e) {
			loadError = msg(e);
		} finally {
			loading = false;
		}
	}
	onMount(() => load(hadCache));

	async function add(e: SubmitEvent) {
		e.preventDefault();
		adding = true;
		error = null;
		added = null;
		try {
			const r = await api.members.add(projectId, email.trim(), role);
			if (r.invited) {
				invites = upsertInvite(invites, r.invite);
				added = `Invitation sent to ${r.invite.email}. They’ll join as ${ROLE_LABEL[r.invite.role as Role] ?? r.invite.role} once they confirm this email address (signing up first if they’re new).`;
			} else {
				const m = r.member;
				members = [...members.filter((x) => x.userId !== m.userId), m];
				invites = invites.filter((x) => x.email.toLowerCase() !== m.email.toLowerCase());
				added = `${m.displayName} added as ${ROLE_LABEL[m.role] ?? m.role}.`;
			}
			email = '';
		} catch (err) {
			error = msg(err);
		} finally {
			adding = false;
		}
	}

	async function setRole(m: Member, next: Role) {
		busy = m.userId;
		error = null;
		try {
			const updated = await api.members.setRole(projectId, m.userId, next);
			members = members.map((x) => (x.userId === m.userId ? updated : x));
		} catch (err) {
			error = msg(err);
			await load(); // restore the select to the server's value
		} finally {
			busy = null;
		}
	}

	// An applicant's party (049): the people they may share an application with.
	async function setParty(m: Member, next: string) {
		const party = next.trim() || null;
		if (party === m.party) return;
		busy = m.userId;
		error = null;
		try {
			const updated = await api.members.setParty(projectId, m.userId, party);
			members = members.map((x) => (x.userId === m.userId ? updated : x));
		} catch (err) {
			error = msg(err);
			await load();
		} finally {
			busy = null;
		}
	}

	async function remove(m: Member) {
		const self = m.userId === currentUserId;
		const ok = await confirmDialog(
			self
				? { title: 'Leave this project?', message: 'You will lose access unless someone adds you again.', confirmLabel: 'Leave project', danger: true }
				: { title: 'Remove this member?', message: `Remove ${m.displayName} (${m.email}) from this project?`, confirmLabel: 'Remove member', danger: true }
		);
		if (!ok) return;
		busy = m.userId;
		error = null;
		try {
			await api.members.remove(projectId, m.userId);
			if (self) return onLeftProject();
			members = members.filter((x) => x.userId !== m.userId);
		} catch (err) {
			error = msg(err);
		} finally {
			busy = null;
		}
	}
</script>

<section class="panel" aria-labelledby="members-h">
	<div class="panel-head">
		<h2 id="members-h">{team ? 'Shared directly with' : 'Members'}</h2>
		{#if !isOwner}<span class="muted small">Only owners can manage members.</span>{/if}
	</div>
	{#if team}
		<p class="muted small team-note">
			Everyone in
			{#if team.name}<a href="{base}/teams/{team.id}">{team.name}</a>{:else}the owning team{/if}
			also has access (admins as owners, members as editors, viewers as viewers). Add people here to share outside the team.
		</p>
	{/if}
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
	{#if loading}
		<!-- Same shape as the loaded table, so nothing below moves when it fills in. -->
		<div class="table-wrap skeleton" role="status" aria-label="Loading members">
			<table class="data">
				<thead><tr><th scope="col">Name</th><th scope="col" class="email">Email</th><th scope="col">Role</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
				<tbody><tr><td colspan="4"><span class="bone"></span></td></tr></tbody>
			</table>
		</div>
	{:else}
	<LoadState loading={false} error={loadError} retry={load} empty={shown.length === 0} emptyText="No members.">
		<div class="table-wrap">
			<table class="data">
				<thead>
					<tr>
						<th scope="col">Name</th>
						<th scope="col" class="email">Email</th>
						<th scope="col">Role</th>
						<th scope="col"><span class="visually-hidden">Actions</span></th>
					</tr>
				</thead>
				<tbody>
					{#each shown as m (m.userId)}
						<tr>
							<th scope="row">
								{m.displayName}{#if m.userId === currentUserId}&nbsp;<span class="muted">(you)</span>{/if}
								<span class="sub-email"><EmailText email={m.email} /></span>
							</th>
							<td class="email"><EmailText email={m.email} /></td>
							<td>
								{#if isOwner}
									<select
										aria-label="Role for {m.displayName}"
										value={m.role}
										disabled={busy === m.userId}
										onchange={(e) => setRole(m, e.currentTarget.value as Role)}
									>
										{#each ROLES as r (r)}<option value={r}>{ROLE_LABEL[r]}</option>{/each}
									</select>
								{:else}
									<span class="badge" class:badge-owner={m.role === 'owner'}>{ROLE_LABEL[m.role] ?? m.role}</span>
								{/if}
								{#if m.role === 'contributor'}
									{#if isOwner}
										<input
											class="party"
											aria-label="Applying party for {m.displayName}"
											placeholder="Applying party"
											maxlength="80"
											value={m.party ?? ''}
											disabled={busy === m.userId}
											onchange={(e) => setParty(m, e.currentTarget.value)}
										/>
									{:else if m.party}
										<span class="muted small party">{m.party}</span>
									{/if}
								{/if}
							</td>
							<td class="act">
								{#if isOwner || m.userId === currentUserId}
									<button
										type="button"
										class="btn btn-sm btn-danger"
										disabled={busy === m.userId}
										onclick={() => remove(m)}
									>
										{m.userId === currentUserId ? 'Leave' : 'Remove'}
									</button>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</LoadState>
	{/if}

	{#if isOwner}
		<form class="add form-row" onsubmit={add}>
			<div class="field grow">
				<label for="mem-email">Add member by email</label>
				<input id="mem-email" type="email" required placeholder="colleague@example.com" bind:value={email} />
			</div>
			<div class="field">
				<label for="mem-role">Role</label>
				<select id="mem-role" bind:value={role}>
					{#each ROLES as r (r)}<option value={r}>{ROLE_LABEL[r]}</option>{/each}
				</select>
			</div>
			<div class="field">
				<button class="btn btn-primary" type="submit" disabled={adding || !email.trim()}>{adding ? 'Adding…' : 'Add'}</button>
			</div>
		</form>
		<p class="added" role="status" aria-live="polite">{added ?? ''}</p>
		<p class="muted small add-hint">
			Anyone without an account gets an email invitation to sign up. Viewers can read; editors can change the model and
			run it; owners also manage members. An applicant sees only the published baseline, their own hydrological units and their own
			applications (a licence applicant or their consultant). Put an applicant and their consultant in the same applying
			party: they can share applications only with each other.
		</p>
		<PendingInvites
			bind:invites
			idPrefix="project"
			load={async () => (await invitesApi.list(projectId)).filter((i) => i.role !== 'farmer') /* farmer invites: FarmersPanel */}
			resend={async (inv) => {
				const r = await invitesApi.add(projectId, inv.email, inv.role as Role);
				if (r.invited) return r.invite;
				// Signed up meanwhile: a member now, not an invite.
				members = [...members.filter((x) => x.userId !== r.member.userId), r.member];
				return null;
			}}
			revoke={(inv) => invitesApi.revoke(projectId, inv.id)}
		/>
	{/if}
</section>

<style>
	.add {
		margin-top: 1rem;
	}
	.grow {
		flex: 1;
		min-width: 200px;
	}
	.add .field {
		margin-bottom: 0;
	}
	.act {
		text-align: right;
	}
	select {
		text-transform: capitalize;
		min-width: 6.5rem;
	}
	.party {
		display: block;
		margin-top: 0.25rem;
		max-width: 12rem;
	}
	.skeleton td {
		height: 37px;
	}
	.bone {
		display: block;
		height: 0.8rem;
		width: 60%;
		border-radius: 3px;
		background: var(--surface-sunken);
	}
	.added {
		margin: 0.5rem 0 0;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.added:empty {
		margin: 0;
	}
	.add-hint {
		margin: 0.5rem 0 0;
	}
	.team-note {
		margin: -0.25rem 0 0.75rem;
	}
	.team-note a {
		text-decoration: underline;
	}
	.sub-email {
		display: none;
		font-weight: 400;
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	@media (max-width: 560px) {
		.email {
			display: none;
		}
		.sub-email {
			display: block;
		}
	}
</style>
