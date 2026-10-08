<script lang="ts">
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { onMount, untrack } from 'svelte';
	import { base } from '$app/paths';
	import { api, roleLabel, ROLES, type Invite, type Member, type ProjectTeam, type Role } from '$lib/api';
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
			// Always an invite, account or not (issue #136): they join when they accept it.
			const r = await api.members.add(projectId, email.trim(), role);
			invites = upsertInvite(invites, r.invite);
			added = `Invitation sent to ${r.invite.email}. They’ll join as ${roleLabel(r.invite.role)} once they accept it.`;
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

	// The party's appointed specialist (167_signers): signs its applications' evidence packs.
	async function setSpecialist(m: Member, next: boolean) {
		busy = m.userId;
		error = null;
		try {
			const updated = await api.members.setSpecialist(projectId, m.userId, next);
			members = members.map((x) => (x.userId === m.userId ? updated : x));
		} catch (err) {
			error = msg(err);
			await load();
		} finally {
			busy = null;
		}
	}
	// Who acts for the responsible authority (163_licensing_authority): as an editor or owner they record its decisions and endorse a baseline.
	async function setAuthority(m: Member, on: boolean) {
		if (on === (m.actsForAuthority ?? false)) return;
		busy = m.userId;
		error = null;
		try {
			const updated = await api.members.setActsForAuthority(projectId, m.userId, on);
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

<section class="panel" aria-labelledby="members-h-t">
	<div class="panel-head">
		<h2 id="members-h"><span id="members-h-t">{team ? 'Shared directly with' : 'Members'}</span> <HelpTip key="roles" label="About roles" /></h2>
		{#if !isOwner}<span class="muted small">Only owners can manage members.</span>{/if}
	</div>
	{#if team}
		<p class="muted small team-note">
			Everyone in
			{#if team.name}<a href="{base}/teams/{team.id}">{team.name}</a>{:else}the owning team{/if}
			also has access, with the role they hold in the team. Add people here to share outside the team.
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
										{#each ROLES as r (r)}<option value={r}>{roleLabel(r)}</option>{/each}
									</select>
								{:else}
									<span class="badge" class:badge-owner={m.role === 'owner'}>{roleLabel(m.role)}</span>
								{/if}
								{#if m.role === 'contributor'}
									{#if isOwner}
										<span class="party-row">
											<input
												class="party"
												aria-label="Applying party for {m.displayName}"
												placeholder="Applying party"
												maxlength="80"
												value={m.party ?? ''}
												disabled={busy === m.userId}
												onchange={(e) => setParty(m, e.currentTarget.value)}
											/>
											<HelpTip key="applying-party" label="About applying parties" />
										</span>
									{:else if m.party}
										<span class="muted small party">{m.party}</span>
									{/if}
								{/if}
								{#if m.party && isOwner}
									<label class="specialist small">
										<input
											type="checkbox"
											checked={m.specialist}
											disabled={busy === m.userId}
											onchange={(e) => setSpecialist(m, e.currentTarget.checked)}
											data-testid="member-specialist"
										/>
										Specialist for this party
									</label>
								{:else if m.specialist}
									<span class="badge small">Specialist for {m.party}</span>
								{/if}
								{#if m.role === 'editor' || m.role === 'owner'}
									{#if isOwner}
										<label class="authority small">
											<input
												type="checkbox"
												checked={m.actsForAuthority ?? false}
												disabled={busy === m.userId}
												onchange={(e) => setAuthority(m, e.currentTarget.checked)}
											/>
											Acts for the responsible authority
											<HelpTip key="responsible-authority" label="About acting for the responsible authority" />
										</label>
									{:else if m.actsForAuthority}
										<span class="muted small authority">Acts for the responsible authority</span>
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
				<span class="label"><label for="mem-email">Add member by email</label> <HelpTip key="invitation" label="About invitations" /></span>
				<input id="mem-email" type="email" required placeholder="colleague@example.com" bind:value={email} />
			</div>
			<div class="field">
				<label for="mem-role">Role</label>
				<select id="mem-role" bind:value={role}>
					{#each ROLES as r (r)}<option value={r}>{roleLabel(r)}</option>{/each}
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
			party: they can share applications only with each other. Tick “Specialist for this party” for the registered professional
			the applicant appointed: they sign the evidence packs of the party’s applications (an editor still drafts and issues them).
			Nobody who edits the project may also be in an applying party.
			Tick “Acts for the responsible authority” for the editors who record the authority’s decisions on applications and
			endorse a published baseline for it (DWS or the CMA that decides the project’s licences, named in Settings).
		</p>
		<PendingInvites
			bind:invites
			idPrefix="project"
			load={async () => (await invitesApi.list(projectId)).filter((i) => i.role !== 'farmer') /* farmer invites: FarmersPanel */}
			resend={async (inv) => (await invitesApi.add(projectId, inv.email, inv.role as Role)).invite}
			revoke={(inv) => invitesApi.revoke(projectId, inv.id)}
		/>
	{/if}
</section>

<style>
	.authority {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		margin-top: 0.25rem;
	}
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
	.party-row {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		margin-top: 0.25rem;
	}
	.party-row .party {
		margin-top: 0;
	}
	.party {
		display: block;
		margin-top: 0.25rem;
		max-width: 12rem;
	}
	.specialist {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		margin-top: 0.25rem;
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
