<!--
	The nominated evidence run (010_run_nomination, docs/ui.md § Evidence
	nomination): whether the shown run is the project's evidence, the action to
	nominate it (editors, with a required reason) and the whole history. The
	history is append-only in the database, so replacing a nomination keeps the
	earlier one on the list.
-->
<script lang="ts">
	import { api, NOMINATION_REASON_MAX, type Nomination, type RunMeta } from '$lib/api';
	import { fmtDate } from '$lib/format/number';
	import { currentNomination, evidenceLine, historyEntries, nominateBlocker } from './evidence';

	let {
		projectId,
		run,
		history,
		canEdit,
		onNominated
	}: {
		projectId: string;
		run: RunMeta;
		/** The project's nominations, oldest first. */
		history: Nomination[];
		canEdit: boolean;
		onNominated?: (history: Nomination[]) => void;
	} = $props();

	const uid = $props.id();
	const fmt = (iso: string) => fmtDate(iso, true);
	let reason = $state('');
	let saving = $state(false);
	let error = $state<string | null>(null);

	const current = $derived(currentNomination(history));
	const line = $derived(evidenceLine(run.id, history, fmt));
	const blocker = $derived(nominateBlocker(run, history));
	const entries = $derived(historyEntries(history, fmt).reverse());
	const trimmed = $derived(reason.trim());
	const tooLong = $derived(trimmed.length > NOMINATION_REASON_MAX);

	async function nominate(e: SubmitEvent) {
		e.preventDefault();
		if (!trimmed || tooLong) return;
		saving = true;
		error = null;
		try {
			const updated = await api.runs.nominate(projectId, run.id, trimmed);
			reason = '';
			onNominated?.(updated);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}
</script>

<section aria-labelledby="{uid}-h">
	<h3 id="{uid}-h">Evidence</h3>
	<p>
		{#if line}{line}{:else}This run is not nominated as evidence.{/if}
		{#if current && current.runId !== run.id}
			The project's evidence run is “{current.runLabel || 'Untitled run'}”.
		{:else if !current}
			No run of this project has been nominated yet.
		{/if}
	</p>

	{#if canEdit}
		{#if blocker}
			<p class="muted small">{blocker}</p>
		{:else}
			<form onsubmit={nominate}>
				<label for="{uid}-r">Why this run is the evidence <span class="muted">(required)</span></label>
				<textarea
					id="{uid}-r"
					rows="3"
					bind:value={reason}
					aria-describedby="{uid}-help"
					aria-invalid={tooLong}
					placeholder="e.g. Calibrated GR4J against the logger record, KGE 0.71; the run the licence application relies on."
				></textarea>
				<p id="{uid}-help" class="muted small">
					A nomination can't be edited or removed. Nominating another run later replaces it, and both stay in the history below.
					<span class:over={tooLong}>{trimmed.length} / {NOMINATION_REASON_MAX} characters</span>
				</p>
				<button class="btn btn-primary btn-sm" type="submit" disabled={saving || !trimmed || tooLong}>
					{saving ? 'Nominating…' : current ? 'Nominate this run instead' : 'Nominate as evidence'}
				</button>
				{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
			</form>
		{/if}
	{/if}

	<h4>Nomination history</h4>
	{#if entries.length}
		<ol class="history" aria-label="Nomination history, newest first">
			{#each entries as entry (entry.id)}
				<li class:current={entry.current}>
					<span class="what">{entry.text}{#if entry.current}<span class="badge badge-owner">Current</span>{/if}</span>
					<span class="muted small">{entry.model}</span>
					<span class="reason">{entry.reason}</span>
				</li>
			{/each}
		</ol>
	{:else}
		<p class="muted">No nominations yet.</p>
	{/if}
</section>

<style>
	textarea {
		width: 100%;
		max-width: 90ch;
		font: inherit;
		display: block;
		margin-top: 0.25rem;
	}
	.small {
		font-size: 0.85rem;
	}
	.over {
		color: var(--danger);
		font-weight: 500;
	}
	h4 {
		margin: 1rem 0 0.4rem;
		font-size: 0.95rem;
	}
	.history {
		list-style: none;
		margin: 0;
		padding: 0;
		max-width: 90ch;
	}
	.history li {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		padding: 0.35rem 0;
		border-bottom: 1px solid var(--border);
	}
	.history li:last-child {
		border-bottom: 0;
	}
	.what {
		font-weight: 600;
	}
	.what .badge {
		margin-left: 0.4rem;
		vertical-align: 1px;
	}
	.reason {
		white-space: pre-wrap;
	}
</style>
