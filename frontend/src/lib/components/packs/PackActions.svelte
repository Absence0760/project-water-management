<script lang="ts">
	// The evidence pack view's status board (WP-3.14, issue #71; docs/ui.md §
	// Evidence pack): where the pack stands (a draft's checklist from the API,
	// a superseded pack's newer version, a withdrawn pack's public reason) and,
	// for an editor, the moves the server would allow: Issue a signed draft,
	// New version of an issued pack, Withdraw (with a reason, shown publicly on
	// the verify page), Delete an unsigned draft. Signing is in Appendix B.2,
	// where the statement is. The server holds every rule; this offers only
	// what it would accept, and shows its refusal when something moved.
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { api, ApiError, type Pack, type PackIssueChecks } from '$lib/api';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import { fmtDate } from '$lib/format/number';
	import { issueChecklist, packHref } from './pack';

	let {
		projectId,
		pack,
		issue,
		manifestMatches,
		canEdit,
		onchange
	}: {
		projectId: string;
		pack: Pack;
		/** The API's checklist for an editor's draft; null otherwise. */
		issue: PackIssueChecks | null;
		manifestMatches: boolean;
		canEdit: boolean;
		/** The pack changed (issued, withdrawn): reload it. */
		onchange: () => void;
	} = $props();

	let busy = $state(false);
	let error = $state<string | null>(null);
	let note = $state('');
	const checklist = $derived(issue ? issueChecklist(issue) : []);
	const canIssue = $derived(pack.status === 'draft' && manifestMatches && !!issue && checklist.every((c) => c.ok));
	const sourceRun = $derived(pack.scenarioRunId ?? pack.baselineRunId);
	const reportHref = $derived(`${base}/projects/${encodeURIComponent(projectId)}/report?run=${encodeURIComponent(sourceRun)}&evidence`);

	/** The server's words, with the failing checks it names (409 details.checks). */
	function why(e: unknown): string {
		const text = e instanceof Error ? e.message : String(e);
		const checks = e instanceof ApiError ? (e.details as { checks?: { label: string; fix?: string | null }[] } | undefined)?.checks : undefined;
		return checks?.length ? `${text}${checks.some((c) => c.fix) ? ` Way out: ${checks.map((c) => c.fix).filter(Boolean).join(' ')}` : ''}` : text;
	}

	async function run(what: string, call: () => Promise<unknown>) {
		busy = true;
		error = null;
		try {
			await call();
			note = what;
			onchange();
		} catch (e) {
			error = why(e);
		} finally {
			busy = false;
		}
	}

	async function issueIt() {
		const ok = await confirmDialog({
			title: `Issue version ${pack.version} of this evidence pack?`,
			message: `Its verify page then answers for code ${pack.shortCode}, publicly, with the signers’ names and registrations.${pack.supersedesId ? ' The version it replaces is marked superseded.' : ''} An issued pack is never edited or deleted: a change is a new version, or a withdrawal.`,
			confirmLabel: 'Issue pack'
		});
		if (ok) await run('Issued.', () => api.packs.issue(projectId, pack.id));
	}

	async function newVersion() {
		const ok = await confirmDialog({
			title: `Draft version ${pack.version + 1}?`,
			message: `A new draft from this run’s evidence report as it stands now, replacing version ${pack.version} once it is signed and issued. For new evidence (another run), open that run’s evidence report and create the pack there.`,
			confirmLabel: 'Draft new version'
		});
		if (!ok) return;
		busy = true;
		error = null;
		try {
			const next = await api.packs.create(projectId, sourceRun, pack.id);
			await goto(packHref(base, projectId, next.id));
		} catch (e) {
			error = why(e);
		} finally {
			busy = false;
		}
	}

	async function deleteDraft() {
		const ok = await confirmDialog({ title: 'Delete this draft pack?', message: 'It was never issued or signed; nothing else refers to it.', confirmLabel: 'Delete draft', danger: true });
		if (!ok) return;
		busy = true;
		error = null;
		try {
			await api.packs.remove(projectId, pack.id);
			await goto(reportHref);
		} catch (e) {
			error = why(e);
		} finally {
			busy = false;
		}
	}

	// --- withdraw, with a reason ---
	let withdrawing = $state(false);
	let reason = $state('');
	const reasonOk = $derived(reason.trim().length >= 1 && reason.trim().length <= 1000);
	async function withdraw(e: SubmitEvent) {
		e.preventDefault();
		if (!reasonOk || busy) return;
		await run('Withdrawn.', () => api.packs.withdraw(projectId, pack.id, reason.trim()));
		if (!error) withdrawing = false;
	}
</script>

<section class="board no-print" aria-labelledby="pack-state-h" data-testid="pack-actions">
	<p id="pack-state-h" class="visually-hidden">Where this pack stands</p>
	{#if !manifestMatches}
		<p class="alert alert-error" role="alert">The stored manifest no longer matches its SHA-256, so this pack can’t be trusted or issued. Tell the project’s owner.</p>
	{/if}
	{#if pack.status === 'draft'}
		<p><strong>Draft pack, not issued.</strong> No verify page answers for it yet. Drafted {fmtDate(pack.createdAt, true)}{pack.createdBy ? ` by ${pack.createdBy}` : ''}.</p>
		{#if issue}
			<ul class="checks" data-testid="pack-checklist" aria-label="Before it can be issued">
				{#each checklist as c (c.id)}
					<li class:fail={!c.ok}><span class="mark" aria-hidden="true">{c.ok ? '✓' : '✗'}</span><span>{c.ok ? c.done : c.todo}</span></li>
				{/each}
			</ul>
		{/if}
	{:else if pack.status === 'issued'}
		<p><strong>Issued</strong> {fmtDate(pack.issuedAt, true)}{pack.issuedBy ? ` by ${pack.issuedBy}` : ''}. Its verify page answers for code <span class="mono">{pack.shortCode}</span>.</p>
	{:else if pack.status === 'superseded'}
		<p class="banner banner-amber" role="note" data-testid="pack-banner">
			<strong>Superseded.</strong> A newer version replaces this one.
			{#if pack.supersededById}<a href={packHref(base, projectId, pack.supersededById)}>Open the newer version</a>.{/if}
		</p>
	{:else}
		<p class="banner banner-red" role="note" data-testid="pack-banner">
			<strong>Withdrawn.</strong> Reason (shown publicly on the verify page): <span class="reason">{pack.statusReason}</span>
		</p>
	{/if}

	{#if canEdit && pack.status !== 'withdrawn'}
		<div class="actions">
			{#if pack.status === 'draft'}
				<button type="button" class="btn btn-primary" disabled={busy || !canIssue} onclick={issueIt}>Issue pack</button>
				{#if pack.signoffs === 0}<button type="button" class="btn" disabled={busy} onclick={deleteDraft}>Delete draft</button>{/if}
			{:else if pack.status === 'issued'}
				<button type="button" class="btn" disabled={busy} onclick={newVersion}>New version…</button>
			{/if}
			<button type="button" class="btn btn-ghost" disabled={busy} onclick={() => ((reason = ''), (withdrawing = true))}>Withdraw…</button>
		</div>
		{#if pack.status === 'draft' && !canIssue}<p class="muted small">Issue is open once every line above is ticked. Sign the pack in Appendix B.2 below.</p>{/if}
		{#if pack.status === 'draft' && pack.signoffs > 0}<p class="muted small">A signed draft is kept with its sign-off: withdraw it rather than delete it.</p>{/if}
	{/if}
	{#if error}<p class="alert alert-error" role="alert">{error}</p>{/if}
	<p class="visually-hidden" role="status">{note}</p>
</section>

{#if withdrawing}
	<Dialog bind:open={withdrawing} title="Withdraw version {pack.version} of this pack">
		<form id="pack-withdraw-form" onsubmit={withdraw}>
			<p>
				A withdrawn pack stays on record and its verify page says it is withdrawn, and why.
				<strong>The reason is public:</strong> anyone holding the pack’s code reads it, so write it for the licensing authority, not the team.
			</p>
			<div class="field">
				<label for="pack-withdraw-reason">Reason</label>
				<textarea id="pack-withdraw-reason" rows="3" maxlength="1000" bind:value={reason} required></textarea>
			</div>
			{#if error}<p class="alert alert-error" role="alert">{error}</p>{/if}
		</form>
		{#snippet actions()}
			<button type="button" class="btn" onclick={() => (withdrawing = false)}>Cancel</button>
			<button type="submit" form="pack-withdraw-form" class="btn btn-danger" disabled={busy || !reasonOk}>{busy ? 'Withdrawing…' : 'Withdraw pack'}</button>
		{/snippet}
	</Dialog>
{/if}

<style>
	.board {
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		background: var(--surface);
		padding: 0.75rem 1rem;
		margin-bottom: 1.25rem;
	}
	.board p {
		margin: 0.25rem 0;
		max-width: 90ch;
	}
	.checks {
		list-style: none;
		padding: 0;
		margin: 0.5rem 0;
		display: grid;
		gap: 0.3rem;
	}
	.checks li {
		display: flex;
		gap: 0.5rem;
	}
	.checks li.fail {
		font-weight: 500;
	}
	.mark {
		flex: none;
		width: 1.2rem;
		text-align: center;
		font-weight: 700;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin: 0.6rem 0 0.25rem;
	}
	.banner {
		border-radius: var(--radius-sm);
		padding: 0.45rem 0.75rem;
	}
	.banner-amber {
		border: 1px solid var(--warning);
		background: var(--warning-soft);
	}
	.banner-red {
		border: 1px solid var(--danger);
		background: var(--danger-soft);
	}
	.reason {
		white-space: pre-wrap;
	}
	.mono {
		font-family: var(--font-mono);
	}
	textarea {
		width: 100%;
	}
</style>
