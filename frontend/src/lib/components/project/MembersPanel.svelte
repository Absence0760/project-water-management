<script lang="ts">
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { onMount, untrack } from 'svelte';
	import { focusAfterRemove } from '$lib/a11y/focusAfterRemove';
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
		onLeftProject,
		authorityVersion = 0
	}: {
		projectId: string;
		/** The owning team, if any: its members have access too (not listed here). */
		team?: ProjectTeam | null;
		isOwner: boolean;
		currentUserId: string;
		onLeftProject: () => void;
		/** Bumped after a change in Acts for the authority (233): the list reloads, quietly, so its authority lines follow. */
		authorityVersion?: number;
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
	$effect(() => {
		if (authorityVersion > 0) untrack(() => load(true));
	});

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
			const at = shown.findIndex((x) => x.userId === m.userId);
			members = members.filter((x) => x.userId !== m.userId);
			// Its row, and the Remove that had the focus, have gone: the member now in its place takes it, on their role.
			await focusAfterRemove(at, 'select[aria-label^="Role for "]', 'mem-email');
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
		<!-- On a phone each member is one row of two lines (as the team page's, issue #520): the name with the email
		     under it beside the role, then Leave or Remove on a line of its own, so nothing is cut at the right edge. The
		     rows are grids there, so the table keeps its roles explicitly (Safari drops them otherwise). -->
		<div class="table-wrap members-wrap">
			<!-- svelte-ignore a11y_no_redundant_roles -->
			<table class="data member-rows" role="table" aria-labelledby="members-h-t">
				<thead role="rowgroup">
					<tr role="row">
						<th scope="col" role="columnheader">Name</th>
						<th scope="col" role="columnheader" class="email">Email</th>
						<th scope="col" role="columnheader">Role</th>
						<th scope="col" role="columnheader" class="act-h"><span class="visually-hidden">Actions</span></th>
					</tr>
				</thead>
				<tbody role="rowgroup">
					{#each shown as m (m.userId)}
						{@const canAct = isOwner || m.userId === currentUserId}
						<tr role="row" class:extras={m.role === 'contributor' || !!m.party || m.role === 'editor' || m.role === 'owner'}>
							<th scope="row" role="rowheader">
								{m.displayName}{#if m.userId === currentUserId}&nbsp;<span class="muted">(you)</span>{/if}
								<span class="sub-email"><EmailText email={m.email} breakAfter="." /></span>
							</th>
							<td role="cell" class="email"><EmailText email={m.email} /></td>
							<td role="cell" class="role">
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
									<label class="check small">
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
								<!-- Who acts for the responsible authority is the authority's own call (233_authority_delegates): shown
								     here, managed in Acts for the authority below. A proposal grants nothing until it is confirmed. -->
								{#if m.authority === 'confirmed' && m.actsForAuthority}
									<span class="badge small authority" data-testid="member-authority">Acts for the responsible authority</span>
								{:else if m.authority === 'proposed'}
									<span class="muted small authority" data-testid="member-authority">Proposed to act for the responsible authority (not confirmed)</span>
								{/if}
							</td>
							<td role="cell" class="act" class:none={!canAct}>
								{#if canAct}
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
	.check,
	.authority {
		margin-top: 0.25rem;
	}
	.authority {
		display: block;
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
	.team-note {
		margin: -0.25rem 0 0.75rem;
	}
	.team-note a {
		text-decoration: underline;
	}
	.sub-email {
		display: none;
		font-weight: 400;
		font-size: var(--font-sm);
		color: var(--text-muted);
	}
	@media (max-width: 560px) {
		.email {
			display: none;
		}
		.sub-email {
			display: block;
		}
		/* Each member a grid of two lines: the name (the email under it) beside the role, then the row's action
		   under both (issue #521 round 5: Leave read "Lea" and Remove "Remo" at 390 px, the role select 25 px tall). */
		.members-wrap {
			max-height: none;
		}
		.member-rows,
		.member-rows tbody,
		.member-rows thead {
			display: block;
		}
		.member-rows tr {
			display: grid;
			grid-template-columns: minmax(0, 1fr) 9rem;
			align-items: center;
			border-bottom: 1px solid var(--border);
		}
		.member-rows tbody tr:last-child {
			border-bottom: 0;
		}
		.member-rows :is(th, td) {
			border-bottom: 0;
			min-width: 0;
		}
		.member-rows thead .email,
		.member-rows .act-h {
			position: absolute;
			width: 1px;
			height: 1px;
			padding: 0;
			overflow: hidden;
			clip-path: inset(50%);
			white-space: nowrap;
		}
		/* A role with more under it (the applying party, the authority line) takes the full width under the name. */
		.member-rows tr.extras :is(th, td.role) {
			grid-column: 1 / -1;
		}
		.member-rows tr.extras td.role {
			padding-top: 0;
		}
		.member-rows td.role select {
			width: 100%;
			min-height: var(--tap);
		}
		.party,
		.party-row {
			max-width: none;
		}
		.party-row .party {
			flex: 1;
			min-height: var(--tap);
		}
		.act {
			grid-column: 1 / -1;
			padding-top: 0;
			text-align: right;
		}
		.act .btn {
			min-height: var(--tap);
		}
		.act.none {
			display: none;
		}
	}
</style>
