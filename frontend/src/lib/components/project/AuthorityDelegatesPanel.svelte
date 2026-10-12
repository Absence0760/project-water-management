<script lang="ts">
	// Who acts for the responsible authority (233_authority_delegates, issue
	// #523 G5; docs/ui.md § Project → Acts for the authority). The authority,
	// not the project's host, decides it: an owner proposes an editor or owner
	// (directly or through the team), and a proposal grants nothing until a
	// member already acting for the authority confirms it (or the operator, on
	// the authority's letter: the only way to confirm the first). The owner
	// withdraws a proposal but can't remove a confirmed delegate; anyone
	// acting for the authority can, and anyone can step down. Every change is
	// in the History.
	import { onMount, tick } from 'svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import { api, roleLabel, type AuthorityDelegates, type AuthorityDelegate, type Project } from '$lib/api';
	import { fmtDay, localIsoDate } from '$lib/format/number';

	let {
		projectId,
		project,
		currentUserId,
		onProjectChange,
		onChange = () => {}
	}: {
		projectId: string;
		project: Project;
		currentUserId: string;
		onProjectChange: (p: Project) => void;
		/** After each change, for the panels that show it too (the members list). */
		onChange?: () => void;
	} = $props();

	let data = $state.raw<AuthorityDelegates | null>(null);
	let error = $state<string | null>(null);
	let busy = $state<string | null>(null);
	let pick = $state('');
	let status = $state('');
	let heading: HTMLHeadingElement | undefined = $state();
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
	const day = (iso: string) => fmtDay(localIsoDate(new Date(iso)));
	const isOwner = $derived(project.role === 'owner');
	const confirmed = $derived((data?.delegates ?? []).filter((d) => d.status === 'confirmed'));
	const proposed = $derived((data?.delegates ?? []).filter((d) => d.status === 'proposed'));

	async function load() {
		error = null;
		try {
			data = await api.authorityDelegates.list(projectId);
		} catch (e) {
			error = msg(e);
		}
	}
	onMount(load);

	/** After a change: the list again, and the project when it touched the caller (what they may do here and elsewhere). */
	async function after(d: Pick<AuthorityDelegate, 'userId'>, said: string) {
		await load();
		onChange();
		if (d.userId === currentUserId) onProjectChange(await api.projects.get(projectId));
		status = said;
	}

	async function act(d: Pick<AuthorityDelegate, 'userId'>, fn: () => Promise<unknown>, said: string) {
		busy = d.userId;
		error = null;
		status = '';
		try {
			await fn();
			await after(d, said);
		} catch (e) {
			error = msg(e);
		} finally {
			busy = null;
		}
	}

	async function propose(e: SubmitEvent) {
		e.preventDefault();
		const who = data?.candidates.find((c) => c.userId === pick);
		if (!who) return;
		await act(who, () => api.authorityDelegates.propose(projectId, who.userId), data?.canConfirm ? `${who.displayName} now acts for the authority.` : `Proposed ${who.displayName}. Someone acting for the authority confirms it.`);
		pick = '';
	}

	async function confirmOne(d: AuthorityDelegate) {
		await act(d, () => api.authorityDelegates.confirm(projectId, d.userId), `Confirmed ${d.displayName}.`);
	}

	async function removeOne(d: AuthorityDelegate) {
		const self = d.userId === currentUserId;
		const proposal = d.status === 'proposed';
		const ok = await confirmDialog(
			self
				? { title: proposal ? 'Turn down this proposal?' : 'Stop acting for the authority?', message: proposal ? 'The proposal that you act for the responsible authority goes.' : 'You will no longer record its decisions or endorse a baseline. Someone acting for it can confirm you again.', confirmLabel: proposal ? 'Turn it down' : 'Stop acting for it', danger: true }
				: proposal
					? { title: data?.canConfirm ? 'Decline this proposal?' : 'Withdraw this proposal?', message: `${d.displayName} won’t act for the responsible authority.`, confirmLabel: data?.canConfirm ? 'Decline' : 'Withdraw', danger: true }
					: { title: 'Remove from the authority?', message: `${d.displayName} will no longer record the authority’s decisions or endorse a baseline.`, confirmLabel: 'Remove', danger: true }
		);
		if (!ok) return;
		await act(d, () => api.authorityDelegates.remove(projectId, d.userId), self ? 'Done.' : proposal ? `The proposal for ${d.displayName} is gone.` : `${d.displayName} no longer acts for the authority.`);
		// Its row and the button that had the focus have gone: the panel's heading takes it.
		await tick();
		heading?.focus();
	}

	/** Who may remove this row: the authority (anyone), the person, or the owner while it is only a proposal. */
	const canRemove = (d: AuthorityDelegate) => !!data && (data.canConfirm || d.userId === currentUserId || (isOwner && d.status === 'proposed'));
	const removeLabel = (d: AuthorityDelegate) =>
		d.userId === currentUserId ? (d.status === 'proposed' ? 'Turn down' : 'Step down') : d.status === 'proposed' ? (data?.canConfirm ? 'Decline' : 'Withdraw') : 'Remove';
	const viaLine = (d: AuthorityDelegate) =>
		d.confirmedVia === 'operator'
			? `confirmed on the authority’s request${d.reference ? ` (${d.reference})` : ''}`
			: d.confirmedVia === 'grandfathered'
				? 'marked by an owner before the authority confirmed its own delegates'
				: `confirmed by ${d.confirmedBy?.displayName ?? 'a former member'}`;
</script>

<section class="panel" aria-labelledby="delegates-h-t" data-testid="authority-delegates">
	<div class="panel-head">
		<h2 id="delegates-h" tabindex="-1" bind:this={heading}>
			<span id="delegates-h-t">Acts for the authority</span> <HelpTip key="responsible-authority" label="About acting for the responsible authority" />
		</h2>
	</div>
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
	{#if data === null && !error}
		<p class="muted" role="status">Loading…</p>
	{:else if data}
		{#if confirmed.length === 0}
			<p class="muted" data-testid="delegates-none">
				Nobody acts for the authority yet. {isOwner ? 'You can propose someone below; the authority then asks the operator, in writing, to confirm the first.' : ''}
			</p>
		{:else}
			<ul class="rows" aria-label="Confirmed">
				{#each confirmed as d (d.userId)}
					<li data-testid="delegate-row" data-status="confirmed">
						<div class="who">
							<span class="name">{d.displayName}{#if d.userId === currentUserId}&nbsp;<span class="muted">(you)</span>{/if}</span>
							<span class="badge small">Confirmed</span>
							{#if !d.active}<span class="muted small">no longer an editor: counts for nothing</span>{/if}
							<span class="muted small line">{viaLine(d)}{d.confirmedAt ? `, ${day(d.confirmedAt)}` : ''}</span>
						</div>
						{#if canRemove(d)}
							<button type="button" class="btn btn-sm btn-danger" disabled={busy === d.userId} onclick={() => removeOne(d)}>{removeLabel(d)}<span class="visually-hidden"> {d.displayName}</span></button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
		{#if proposed.length}
			<h3 class="sub">Proposed, not confirmed</h3>
			<p class="muted small">A proposal grants nothing until someone acting for the authority confirms it.</p>
			<ul class="rows" aria-label="Proposed, not confirmed">
				{#each proposed as d (d.userId)}
					<li data-testid="delegate-row" data-status="proposed">
						<div class="who">
							<span class="name">{d.displayName}{#if d.userId === currentUserId}&nbsp;<span class="muted">(you)</span>{/if}</span>
							<span class="badge small badge-warn">Proposed</span>
							<span class="muted small line">by {d.proposedBy?.displayName ?? 'a former member'}, {day(d.proposedAt)}</span>
						</div>
						<div class="acts">
							{#if data.canConfirm && d.userId !== currentUserId}
								<button type="button" class="btn btn-sm btn-primary" disabled={busy === d.userId} onclick={() => confirmOne(d)}>Confirm<span class="visually-hidden"> {d.displayName}</span></button>
							{/if}
							{#if canRemove(d)}
								<button type="button" class="btn btn-sm btn-danger" disabled={busy === d.userId} onclick={() => removeOne(d)}>{removeLabel(d)}<span class="visually-hidden"> {d.displayName}</span></button>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		{/if}
		{#if data.canPropose}
			{#if data.candidates.length}
				<form class="form-row propose" onsubmit={propose}>
					<div class="field grow">
						<label for="delegate-pick">{data.canConfirm ? 'Add someone' : 'Propose someone'}</label>
						<select id="delegate-pick" bind:value={pick} aria-describedby="delegate-pick-h">
							<option value="">Choose an editor or owner…</option>
							{#each data.candidates as c (c.userId)}<option value={c.userId}>{c.displayName} ({roleLabel(c.role)}{c.via === 'team' ? ', through the team' : ''})</option>{/each}
						</select>
						<span class="hint" id="delegate-pick-h">{data.canConfirm ? 'You act for the authority, so they act for it at once.' : 'The authority confirms it; until then it grants nothing.'}</span>
					</div>
					<div class="field">
						<button type="submit" class="btn btn-sm" disabled={!pick || busy !== null}>{data.canConfirm ? 'Add' : 'Propose'}</button>
					</div>
				</form>
			{:else}
				<p class="muted small">Every editor and owner is already proposed or acting for the authority.</p>
			{/if}
		{/if}
	{/if}
	<p class="visually-hidden" role="status">{status}</p>
</section>

<style>
	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.rows li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.5rem 0;
		border-bottom: 1px solid var(--border);
	}
	.rows li:last-child {
		border-bottom: 0;
	}
	.who {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.25rem 0.5rem;
		min-width: 0;
	}
	.name {
		font-weight: 600;
	}
	.line {
		flex-basis: 100%;
	}
	.acts {
		display: flex;
		gap: 0.4rem;
		flex-shrink: 0;
	}
	.sub {
		font-size: 0.95rem;
		margin: 1rem 0 0.25rem;
	}
	.propose {
		margin-top: 1rem;
	}
	.propose .field {
		margin-bottom: 0;
	}
	.grow {
		flex: 1;
		min-width: 200px;
	}
	@media (max-width: 560px) {
		.rows li {
			flex-wrap: wrap;
		}
		.acts,
		.rows li > .btn {
			margin-left: auto;
		}
		.rows .btn {
			min-height: var(--tap);
		}
	}
</style>
