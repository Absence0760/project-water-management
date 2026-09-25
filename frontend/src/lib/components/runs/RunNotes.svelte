<!--
	A run's written explanation (RunMeta.notes, 007_run_notes): the modeller's
	reason next to a WR2012 query or not-usable flag, or anything else a reviewer
	should read with the run. The one thing about a run that changes after it
	is made. Editors write it; viewers read it.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import type { Wr2012FlagLevel } from '@water-management/engine';
	import { api, RUN_NOTES_MAX, type RunMeta } from '$lib/api';
	import { fmtDate } from '$lib/format/number';
	import { explanationPrompt, normaliseNotes, notesDirty } from './notes';

	let {
		projectId,
		run,
		canEdit,
		flagLevel = null,
		onSaved
	}: {
		projectId: string;
		run: RunMeta;
		canEdit: boolean;
		/** The run's WR2012 flag, if it has a check: a query or not-usable flag asks for the reason. */
		flagLevel?: Wr2012FlagLevel | null;
		onSaved?: (run: RunMeta) => void;
	} = $props();

	const uid = $props.id();
	// The parent keys this component on the run id, so the draft starts from each run's own note.
	let draft = $state(untrack(() => run.notes ?? ''));
	let saving = $state(false);
	let error = $state<string | null>(null);
	let saved = $state(false);

	const stored = $derived(run.notes ?? '');
	const dirty = $derived(notesDirty(draft, stored));
	const tooLong = $derived(normaliseNotes(draft).length > RUN_NOTES_MAX);
	const prompt = $derived(explanationPrompt(flagLevel, stored));

	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (!dirty || tooLong) return;
		saving = true;
		error = null;
		saved = false;
		try {
			const updated = await api.runs.setNotes(projectId, run.id, normaliseNotes(draft));
			draft = updated.notes ?? '';
			saved = true;
			onSaved?.(updated);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}
</script>

<section aria-labelledby="{uid}-h">
	<h3 id="{uid}-h">Run notes</h3>
	{#if prompt}<p class="prompt" role="note">{prompt}</p>{/if}
	{#if canEdit}
		<form onsubmit={save}>
			<label for="{uid}-t" class="visually-hidden">Run notes</label>
			<textarea
				id="{uid}-t"
				rows="4"
				bind:value={draft}
				oninput={() => (saved = false)}
				aria-describedby="{uid}-help"
				aria-invalid={tooLong}
				placeholder="Why this run's results stand, e.g. the quaternary includes an irrigated tributary outside the model."
			></textarea>
			<p id="{uid}-help" class="muted small">
				Read by everyone who can see the project, in run comparison and the summary CSV.
				<span class:over={tooLong}>{normaliseNotes(draft).length} / {RUN_NOTES_MAX} characters</span>
			</p>
			<div class="form-row">
				<button class="btn btn-primary btn-sm" type="submit" disabled={saving || !dirty || tooLong}>{saving ? 'Saving…' : 'Save notes'}</button>
				{#if saved && !dirty}<span class="muted small" role="status">Saved.</span>{/if}
			</div>
			{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
		</form>
	{:else if stored}
		<p class="text">{stored}</p>
	{:else}
		<p class="muted">No notes on this run.</p>
	{/if}
	{#if stored && run.notesUpdatedAt}
		<p class="muted small">Last changed {fmtDate(run.notesUpdatedAt, true)}{run.notesUpdatedBy ? ` by ${run.notesUpdatedBy}` : ''}.</p>
	{/if}
</section>

<style>
	textarea {
		width: 100%;
		max-width: 90ch;
		font: inherit;
	}
	.text {
		white-space: pre-wrap;
		max-width: 90ch;
	}
	.small {
		font-size: 0.85rem;
	}
	.over {
		color: var(--danger);
		font-weight: 500;
	}
	.prompt {
		border-left: 4px solid var(--warning);
		padding: 0.4rem 0.6rem;
		background: var(--surface-2);
		max-width: 90ch;
	}
	.form-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}
</style>
