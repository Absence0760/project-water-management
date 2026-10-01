<script lang="ts">
	// Farmers on the project (WP-2.1): members who see only the farms linked
	// to them. Owners invite them (WP-2.2, InviteFarmersDialog: one by email or
	// many from a CSV) and choose their farms; an address without an account
	// waits as a pending invite, listed here for owners, until it signs up. A
	// farmer is removed like any member (their links go with the membership).
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import { onMount } from 'svelte';
	import { api, type Farmer, type FarmerEntry, type InvitedFarmer } from '$lib/api';
	import { emailAuthApi } from '$lib/api/emailAuth';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import EmailText from '$lib/components/common/EmailText.svelte';
	import { expiryText } from '$lib/components/auth-extras/invites';
	import { fmtDate } from '$lib/format/number';
	import Lazy from '$lib/components/common/Lazy.svelte';
	import { farmNames, toggleFarm, type FarmOption } from './farmers';

	// The invite dialog (its CSV preview and pending-invite list) is its own chunk, fetched on the
	// first "Invite farmers": it was ~2.4 KB gzip of the workspace page chunk, which every catchment
	// opening downloads, for a dialog only owners open (issue #9).
	const loadInviteDialog = () => import('./InviteFarmersDialog.svelte');

	let {
		projectId,
		isOwner,
		farms
	}: {
		projectId: string;
		isOwner: boolean;
		/** The project's farm nodes (from the model), in network-table order. */
		farms: FarmOption[];
	} = $props();

	let entries = $state<FarmerEntry[]>([]);
	const farmers = $derived(entries.filter((f): f is Farmer => f.status === 'active'));
	const invites = $derived(entries.filter((f): f is InvitedFarmer => f.status !== 'active'));
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let error = $state<string | null>(null);
	let busy = $state<string | null>(null);
	let message = $state<string | null>(null);
	let inviting = $state(false);
	let inviteMounted = $state(false);

	/** The farmer whose farms are being edited, and the draft selection. */
	let editing = $state<string | null>(null);
	let draft = $state<string[]>([]);

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
	const keyOf = (f: FarmerEntry) => (f.status === 'active' ? f.userId : f.inviteId);

	/** `quiet`: refresh behind the list already shown (after a CSV), with no loading state in its place. */
	async function load(quiet = false) {
		loading = !quiet;
		loadError = null;
		try {
			entries = await api.farmers.list(projectId);
		} catch (e) {
			loadError = msg(e);
		} finally {
			loading = false;
		}
	}
	onMount(load);

	/** Put one farmer or invite in the list, replacing any entry for the same address. */
	function upsert(entry: FarmerEntry) {
		const email = entry.email.toLowerCase();
		entries = [...entries.filter((x) => keyOf(x) !== keyOf(entry) && x.email.toLowerCase() !== email), entry];
	}

	function invited(text: string, entry?: FarmerEntry) {
		message = text;
		error = null;
		if (entry) upsert(entry);
		else void load(true); // a CSV: many rows changed; the list stays up while it refreshes
	}

	function edit(f: Farmer) {
		editing = f.userId;
		draft = farms.filter((x) => f.nodeIds.includes(x.id)).map((x) => x.id);
	}

	async function save(f: Farmer) {
		busy = f.userId;
		error = null;
		try {
			upsert(await api.farmers.setFarms(projectId, f.userId, draft));
			editing = null;
		} catch (err) {
			error = msg(err);
		} finally {
			busy = null;
		}
	}

	async function remove(f: Farmer) {
		const ok = await confirmDialog({
			title: 'Remove this farmer?',
			message: `Remove ${f.displayName} (${f.email}) as a farmer? They lose access to ${farmNames(f, farms).join(', ') || 'their hydrological units'}.`,
			confirmLabel: 'Remove farmer',
			danger: true
		});
		if (!ok) return;
		busy = f.userId;
		error = null;
		try {
			await api.members.remove(projectId, f.userId);
			entries = entries.filter((x) => keyOf(x) !== f.userId);
		} catch (err) {
			error = msg(err);
		} finally {
			busy = null;
		}
	}

	async function resend(inv: InvitedFarmer) {
		busy = inv.inviteId;
		error = message = null;
		try {
			const r = await api.farmers.add(projectId, inv.email, inv.nodeIds.filter((id) => farms.some((f) => f.id === id)), inv.locale, inv.role ?? 'farmer');
			upsert(r.invite);
			message =
				r.invite.expiresAt !== inv.expiresAt
					? `Invitation re-sent to ${inv.email}. The earlier link no longer works.`
					: `An invitation went to ${inv.email} less than a minute ago: wait a moment before re-sending.`;
		} catch (err) {
			error = msg(err);
		} finally {
			busy = null;
		}
	}

	async function revoke(inv: InvitedFarmer) {
		if (!(await confirmDialog({ title: 'Revoke this invitation?', message: `Revoke the invitation to ${inv.email}? The link in their email stops working.`, confirmLabel: 'Revoke invitation', danger: true }))) return;
		busy = inv.inviteId;
		error = message = null;
		try {
			await emailAuthApi(api).projectInvites.revoke(projectId, inv.inviteId);
			entries = entries.filter((x) => keyOf(x) !== inv.inviteId);
			message = `Invitation to ${inv.email} revoked.`;
		} catch (err) {
			error = msg(err);
		} finally {
			busy = null;
		}
	}
</script>

<section class="panel" aria-labelledby="farmers-h">
	<div class="panel-head">
		<h2 id="farmers-h">Farmers{#if !loading && !loadError}&nbsp;({farmers.length}){/if}</h2>
		{#if isOwner && farms.length > 0}
			<button type="button" class="btn btn-sm btn-primary" onclick={() => (inviteMounted = inviting = true)}>Invite farmers</button>
		{/if}
	</div>
	<p class="muted small intro">
		A farmer sees only the hydrological units linked to them, never another hydrological unit’s name or figures, and none of the model.
	</p>
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
	<LoadState
		{loading}
		error={loadError}
		retry={load}
		empty={entries.length === 0}
		emptyText={isOwner ? 'No farmers yet: invite them to see their own hydrological unit.' : 'No farmers yet.'}
	>
		{#if farmers.length}
			<div class="table-wrap">
				<table class="data">
					<thead>
						<tr>
							<th scope="col">Name</th>
							<th scope="col">Farms</th>
							<th scope="col"><span class="visually-hidden">Actions</span></th>
						</tr>
					</thead>
					<tbody>
						{#each farmers as f (f.userId)}
							<tr>
								<th scope="row">
									{f.displayName}
									<!-- An applicant (WP-3.3) keeps their farm links; they are a member through the Members panel. -->
									{#if f.role === 'contributor'}<span class="badge">applicant</span>{/if}
									<span class="sub-email"><EmailText email={f.email} /></span>
								</th>
								<td>
									{#if editing === f.userId}
										<fieldset class="farms">
											<legend class="visually-hidden">Hydrological units for {f.displayName}</legend>
											{#each farms as farm (farm.id)}
												<label class="check">
													<input
														type="checkbox"
														checked={draft.includes(farm.id)}
														onchange={() => (draft = toggleFarm(draft, farm.id, farms))}
													/>
													{farm.name}
												</label>
											{/each}
										</fieldset>
									{:else}
										{farmNames(f, farms).join(', ') || '–'}
									{/if}
								</td>
								<td class="act">
									{#if isOwner}
										{#if editing === f.userId}
											<button type="button" class="btn btn-sm btn-primary" disabled={busy === f.userId || draft.length === 0} onclick={() => save(f)}>Save</button>
											<button type="button" class="btn btn-sm" disabled={busy === f.userId} onclick={() => (editing = null)}>Cancel</button>
										{:else}
											<button type="button" class="btn btn-sm" disabled={busy === f.userId} onclick={() => edit(f)}>Change hydrological units</button>
											{#if f.role !== 'contributor'}
												<button type="button" class="btn btn-sm btn-danger" disabled={busy === f.userId} onclick={() => remove(f)}>Remove</button>
											{/if}
										{/if}
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}

		{#if invites.length}
			<section class="invites" aria-labelledby="farmer-inv-h">
				<h3 id="farmer-inv-h">Pending farmer invitations <span class="count">({invites.length})</span></h3>
				<ul>
					{#each invites as inv (inv.inviteId)}
						<li class:expired={inv.status === 'expired'}>
							<div class="who">
								<span class="email"><EmailText email={inv.email} /></span>
								{#if inv.role === 'contributor'}<span class="badge">applicant</span>{/if}
								<span class="meta">
									{farmNames(inv, farms).join(', ') || 'no hydrological units left'} · invited by {inv.invitedBy} ·
									{#if inv.status === 'expired'}
										<span class="badge badge-warn">Expired</span>
									{:else}
										<span title="Expires {fmtDate(inv.expiresAt, true)}">{expiryText({ expiresAt: inv.expiresAt, expired: false })}</span>
									{/if}
									{#if inv.senderLapsed}
										<span class="badge badge-warn" title="Whoever sent it can no longer add people here, so it can’t be accepted. Resend it to renew it.">Sender can no longer invite</span>
									{/if}
								</span>
							</div>
							{#if isOwner}
								<div class="act">
									<button
										type="button"
										class="btn btn-sm"
										disabled={busy === inv.inviteId || !inv.nodeIds.some((id) => farms.some((f) => f.id === id))}
										aria-label="Resend invitation to {inv.email}"
										onclick={() => resend(inv)}>Resend</button
									>
									<button
										type="button"
										class="btn btn-sm btn-danger"
										disabled={busy === inv.inviteId}
										aria-label="Revoke invitation to {inv.email}"
										onclick={() => revoke(inv)}>Revoke</button
									>
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	</LoadState>

	<p class="status" role="status" aria-live="polite">{message ?? ''}</p>
	{#if isOwner && farms.length === 0}
		<p class="muted small add-hint">Add a hydrological unit on the Network tab before inviting a farmer to it.</p>
	{/if}
</section>

{#if isOwner && inviteMounted}
	<Lazy load={loadInviteDialog}>
		{#snippet children(InviteFarmersDialog)}
			<InviteFarmersDialog bind:open={inviting} {projectId} {farms} ondone={invited} />
		{/snippet}
	</Lazy>
{/if}

<style>
	.intro {
		margin: -0.25rem 0 0.75rem;
	}
	.farms {
		border: 0;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1rem;
	}
	.check {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		min-height: 24px;
	}
	.act {
		text-align: right;
		white-space: nowrap;
	}
	.act .btn + .btn {
		margin-left: 0.35rem;
	}
	.sub-email {
		display: block;
		font-weight: 400;
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.invites {
		margin-top: 1rem;
	}
	.invites h3 {
		margin: 0 0 0.4rem;
		font-size: 0.9rem;
		font-weight: 600;
	}
	.count {
		color: var(--text-muted);
		font-weight: 400;
	}
	.invites ul {
		list-style: none;
		margin: 0;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.invites li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem 1rem;
		flex-wrap: wrap;
		padding: 0.5rem 0.75rem;
	}
	.invites li + li {
		border-top: 1px solid var(--border);
	}
	.invites li.expired .email {
		color: var(--text-2);
	}
	.who {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
	}
	.email {
		font-weight: 500;
	}
	.meta {
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.invites .act {
		display: flex;
		gap: 0.4rem;
		margin-left: auto;
	}
	.status {
		margin: 0.5rem 0 0;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.status:empty {
		margin: 0;
	}
	.add-hint {
		margin: 0.5rem 0 0;
	}
</style>
