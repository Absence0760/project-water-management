<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import {
		api,
		ApiError,
		TEAM_ROLES,
		type Invite,
		type ProjectSummary,
		type Team,
		type TeamMember,
		type TeamRole
	} from '$lib/api';
	import { emailAuthApi } from '$lib/api/emailAuth';
	import { session } from '$lib/auth/session.svelte';
	import PendingInvites from '$lib/components/auth-extras/PendingInvites.svelte';
	import { upsertInvite } from '$lib/components/auth-extras/invites';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { fmtDate } from '$lib/format/number';
	import EmailText from '$lib/components/common/EmailText.svelte';

	const teamId = $derived(page.params.id ?? '');
	const me = $derived(session.user?.id ?? '');

	let team = $state<Team | null>(null);
	let members = $state<TeamMember[]>([]);
	let projects = $state<ProjectSummary[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let notFound = $state(false);
	let error = $state<string | null>(null);
	let busy = $state<string | null>(null);

	let newName = $state('');
	let renaming = $state(false);
	let renamed = $state(false);

	let email = $state('');
	let role = $state<TeamRole>('member');
	let adding = $state(false);
	let addError = $state<string | null>(null);
	let added = $state<string | null>(null);

	const invitesApi = emailAuthApi(api).teamInvites;
	let invites = $state<Invite[]>([]);

	function addToMembers(m: TeamMember) {
		const known = members.some((x) => x.userId === m.userId);
		members = [...members.filter((x) => x.userId !== m.userId), m];
		if (team && !known) team.memberCount += 1;
	}

	let deleteOpen = $state(false);
	let deleting = $state(false);

	const isAdmin = $derived(team?.role === 'admin');
	const adminCount = $derived(members.filter((m) => m.role === 'admin').length);
	const soleAdmin = (m: TeamMember) => m.role === 'admin' && adminCount <= 1;

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	async function load() {
		loading = true;
		loadError = null;
		notFound = false;
		try {
			const [detail, list] = await Promise.all([api.teams.get(teamId), api.projects.list()]);
			team = detail.team;
			members = detail.members;
			newName = detail.team.name;
			projects = list.filter((p) => p.team?.id === teamId);
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) notFound = true;
			else loadError = msg(e);
		} finally {
			loading = false;
		}
	}
	$effect(() => {
		void teamId;
		untrack(load);
	});

	async function rename(e: SubmitEvent) {
		e.preventDefault();
		if (!team) return;
		renaming = true;
		error = null;
		try {
			team = await api.teams.rename(team.id, newName.trim());
			newName = team.name;
			renamed = true;
		} catch (err) {
			error = msg(err);
		} finally {
			renaming = false;
		}
	}

	async function add(e: SubmitEvent) {
		e.preventDefault();
		adding = true;
		addError = null;
		added = null;
		try {
			const r = await api.teams.addMember(teamId, email.trim(), role);
			if (r.invited) {
				invites = upsertInvite(invites, r.invite);
				added = `Invitation sent to ${r.invite.email}. They’ll join as ${r.invite.role} once they sign up and confirm their email.`;
			} else {
				addToMembers(r.member);
				invites = invites.filter((x) => x.email.toLowerCase() !== r.member.email.toLowerCase());
				added = `${r.member.displayName} added as ${r.member.role}.`;
			}
			email = '';
			role = 'member';
		} catch (err) {
			addError = msg(err);
		} finally {
			adding = false;
		}
	}

	async function setRole(m: TeamMember, next: TeamRole) {
		busy = m.userId;
		error = null;
		try {
			const updated = await api.teams.setRole(teamId, m.userId, next);
			members = members.map((x) => (x.userId === m.userId ? updated : x));
			// Demoting yourself takes away admin rights on this page.
			if (m.userId === me && team) team.role = updated.role;
		} catch (err) {
			error = msg(err);
			await load(); // put the select back to the server's value
		} finally {
			busy = null;
		}
	}

	async function remove(m: TeamMember) {
		const self = m.userId === me;
		if (soleAdmin(m)) {
			error = self
				? 'You are the only admin. Make another member an admin before you leave, or delete the team.'
				: 'A team must keep at least one admin.';
			return;
		}
		const q = self
			? `Leave ${team?.name}? You lose access to its projects unless they're also shared with you directly.`
			: `Remove ${m.displayName} (${m.email}) from the team? They lose access to its projects unless shared directly.`;
		if (!confirm(q)) return;
		busy = m.userId;
		error = null;
		try {
			await api.teams.removeMember(teamId, m.userId);
			if (self) return void (await goto(`${base}/teams`));
			members = members.filter((x) => x.userId !== m.userId);
			if (team) team.memberCount -= 1;
		} catch (err) {
			error = msg(err);
		} finally {
			busy = null;
		}
	}

	async function deleteTeam() {
		if (!team) return;
		deleting = true;
		error = null;
		try {
			await api.teams.remove(team.id);
			deleteOpen = false;
			await goto(`${base}/teams`);
		} catch (err) {
			deleteOpen = false;
			error = msg(err);
		} finally {
			deleting = false;
		}
	}

	const self = $derived(members.find((m) => m.userId === me));
</script>

<svelte:head><title>{team ? `${team.name} · ` : ''}Teams · Water Management</title></svelte:head>

<main class="page">
	<LoadState {loading} error={loadError} retry={load}>
		{#if notFound || !team}
			<div class="alert alert-error" role="alert">
				This team doesn't exist or you're not a member. <a href="{base}/teams">Back to teams</a>
			</div>
		{:else}
			<nav class="crumbs" aria-label="Breadcrumb"><a href="{base}/teams">Teams</a> <span aria-hidden="true">/</span></nav>
			<div class="head">
				<h1>{team.name}</h1>
				<span class="badge" class:badge-owner={isAdmin}>{team.role}</span>
			</div>
			<p class="muted facts">
				{team.projectCount} project{team.projectCount === 1 ? '' : 's'} · {team.memberCount} member{team.memberCount === 1 ? '' : 's'} ·
				created {fmtDate(team.createdAt)}
			</p>

			{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}

			<div class="grid">
				<section class="panel members" aria-labelledby="members-h">
					<div class="panel-head">
						<h2 id="members-h">Members</h2>
						{#if !isAdmin}<span class="muted small">Only admins can manage members.</span>{/if}
					</div>
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
								{#each members as m (m.userId)}
									<tr>
										<th scope="row">
											{m.displayName}{#if m.userId === me}&nbsp;<span class="muted">(you)</span>{/if}
											<span class="sub-email"><EmailText email={m.email} /></span>
										</th>
										<td class="email"><EmailText email={m.email} /></td>
										<td>
											{#if isAdmin}
												<select
													aria-label="Team role for {m.displayName}"
													value={m.role}
													disabled={busy === m.userId}
													onchange={(e) => setRole(m, e.currentTarget.value as TeamRole)}
												>
													{#each TEAM_ROLES as r (r)}
														<option value={r} disabled={r === 'member' && soleAdmin(m)}>{r}</option>
													{/each}
												</select>
											{:else}
												<span class="badge" class:badge-owner={m.role === 'admin'}>{m.role}</span>
											{/if}
										</td>
										<td class="act">
											{#if isAdmin && m.userId !== me}
												<button
													type="button"
													class="btn btn-sm btn-danger"
													disabled={busy === m.userId}
													onclick={() => remove(m)}
													aria-label="Remove {m.displayName}"
												>
													Remove
												</button>
											{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>

					{#if isAdmin}
						<form class="add" onsubmit={add}>
							{#if addError}<div class="alert alert-error" role="alert">{addError}</div>{/if}
							<div class="form-row">
								<div class="field grow">
									<label for="tm-email">Add member by email</label>
									<input id="tm-email" type="email" required placeholder="colleague@example.com" bind:value={email} />
								</div>
								<div class="field">
									<label for="tm-role">Role</label>
									<select id="tm-role" bind:value={role}>
										{#each TEAM_ROLES as r (r)}<option value={r}>{r}</option>{/each}
									</select>
								</div>
								<div class="field">
									<button class="btn btn-primary" type="submit" disabled={adding || !email.trim()}>
										{adding ? 'Adding…' : 'Add'}
									</button>
								</div>
							</div>
						</form>
						<p class="added" role="status" aria-live="polite">{added ?? ''}</p>
						{#key teamId}
							<PendingInvites
								bind:invites
								idPrefix="team"
								load={() => invitesApi.list(teamId)}
								resend={async (inv) => {
									const r = await invitesApi.add(teamId, inv.email, inv.role as TeamRole);
									if (r.invited) return r.invite;
									addToMembers(r.member);
									return null;
								}}
								revoke={(inv) => invitesApi.revoke(teamId, inv.id)}
							/>
						{/key}
					{/if}
					<dl class="roles">
						<div><dt>Member</dt><dd>Edits every team project: model, data and runs.</dd></div>
						<div><dt>Admin</dt><dd>Owner of every team project (delete, share, move) and manages this team.</dd></div>
					</dl>
					<p class="muted small">Anyone without an account gets an email invitation to sign up.</p>
				</section>

				<div class="side">
					<section class="panel" aria-labelledby="tp-h">
						<div class="panel-head">
							<h2 id="tp-h">Projects</h2>
							<a class="small" href="{base}/?owner=team:{team.id}&new=1">New project in this team</a>
						</div>
						{#if projects.length}
							<ul class="plist">
								{#each projects as p (p.id)}
									<li>
										<a href="{base}/projects/{p.id}">{p.name}</a>
										<span class="muted small">updated {fmtDate(p.updatedAt)}</span>
									</li>
								{/each}
							</ul>
						{:else}
							<p class="muted">No projects yet. Create one here, or move an existing project into the team from its Overview tab.</p>
						{/if}
					</section>

					{#if isAdmin}
						<section class="panel" aria-labelledby="ts-h">
							<div class="panel-head"><h2 id="ts-h">Team name</h2></div>
							<form onsubmit={rename}>
								<div class="form-row">
									<div class="field grow">
										<label class="visually-hidden" for="tm-name">Team name</label>
										<input id="tm-name" required maxlength="200" bind:value={newName} oninput={() => (renamed = false)} />
									</div>
									<div class="field">
										<button class="btn" type="submit" disabled={renaming || !newName.trim() || newName.trim() === team.name}>
											{renaming ? 'Saving…' : 'Rename'}
										</button>
									</div>
								</div>
								{#if renamed}<p class="muted small" role="status">Saved.</p>{/if}
							</form>
						</section>
					{/if}

					<section class="panel danger" aria-labelledby="dz-h">
						<div class="panel-head"><h2 id="dz-h">Leave or delete</h2></div>
						{#if self}
							<div class="dz-row">
								<p class="small">
									Leave the team. You keep projects that are also shared with you directly.
								</p>
								<button type="button" class="btn btn-danger" disabled={busy === self.userId} onclick={() => remove(self)}>
									Leave team
								</button>
							</div>
						{/if}
						{#if isAdmin}
							<div class="dz-row">
								<p class="small">
									Delete the team. Its projects are <strong>not</strong> deleted: they stay with the people they're
									shared with directly.
								</p>
								<button type="button" class="btn btn-danger" onclick={() => (deleteOpen = true)}>Delete team</button>
							</div>
						{/if}
					</section>
				</div>
			</div>
		{/if}
	</LoadState>
</main>

<Dialog bind:open={deleteOpen} title="Delete team?">
	<p>
		Delete <strong>{team?.name}</strong>? Its {team?.projectCount ?? 0} project{team?.projectCount === 1 ? '' : 's'}
		stay, but members who only had access through the team lose it. This can't be undone.
	</p>
	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (deleteOpen = false)}>Cancel</button>
		<button type="button" class="btn btn-primary danger-btn" disabled={deleting} onclick={deleteTeam}>
			{deleting ? 'Deleting…' : 'Delete team'}
		</button>
	{/snippet}
</Dialog>

<style>
	.crumbs {
		color: var(--text-muted);
		margin-bottom: 0.25rem;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.head h1 {
		margin: 0;
	}
	.facts {
		margin: 0.25rem 0 1.25rem;
	}
	.grid {
		display: grid;
		grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr);
		gap: 1rem;
		align-items: start;
	}
	.small {
		font-size: 0.85rem;
	}
	.add {
		margin-top: 1rem;
	}
	.added {
		margin: 0.5rem 0 0;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.added:empty {
		margin: 0;
	}
	.add .field {
		margin-bottom: 0;
	}
	.grow {
		flex: 1;
		min-width: 200px;
	}
	.act {
		text-align: right;
		width: 1%;
		white-space: nowrap;
	}
	select {
		text-transform: capitalize;
		min-width: 6.5rem;
	}
	.sub-email {
		display: none;
		font-weight: 400;
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.roles {
		margin: 1rem 0 0.5rem;
		display: grid;
		gap: 0.35rem;
		font-size: 0.85rem;
	}
	.roles div {
		display: flex;
		gap: 0.5rem;
	}
	.roles dt {
		flex: none;
		width: 4.5rem;
		font-weight: 600;
	}
	.roles dd {
		margin: 0;
		color: var(--text-2);
	}
	.plist {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.plist li {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 0.75rem;
		padding: 0.45rem 0;
		border-bottom: 1px solid var(--border);
	}
	.plist li:last-child {
		border-bottom: none;
	}
	.plist .muted {
		flex: none;
	}
	.danger {
		border-color: color-mix(in srgb, var(--danger) 35%, var(--border));
	}
	.dz-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
	.dz-row + .dz-row {
		margin-top: 0.75rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
	}
	.dz-row p {
		margin: 0;
		color: var(--text-2);
	}
	.danger-btn {
		background: var(--danger);
		border-color: var(--danger);
		color: #fff;
	}
	.danger-btn:hover:not(:disabled) {
		background: color-mix(in srgb, var(--danger) 85%, #000);
		border-color: color-mix(in srgb, var(--danger) 85%, #000);
	}
	@media (prefers-color-scheme: dark) {
		.danger-btn {
			color: #1a0a08;
		}
	}
	@media (max-width: 900px) {
		.grid {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	@media (max-width: 560px) {
		.email {
			display: none;
		}
		.sub-email {
			display: block;
		}
		.dz-row {
			flex-direction: column;
			align-items: stretch;
		}
		.dz-row .btn {
			justify-content: center;
		}
	}
</style>
