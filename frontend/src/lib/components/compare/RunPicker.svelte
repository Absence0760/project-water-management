<script lang="ts">
	// One run of the comparison: project → run. As a run card (issue #17 A4)
	// it also shows `summary` (the run's name and what changed) under the
	// legend, `actions` beside it, and a coloured top edge (`colour`).
	import type { Snippet } from 'svelte';
	import type { ProjectSummary, RunMeta } from '$lib/api';
	import { fmtDate } from '$lib/format/number';
	import { runOptionLabel } from './picker';

	let {
		id,
		legend,
		projects,
		projectId,
		runId,
		runs,
		runsLoading = false,
		runsError = null,
		onProject,
		onRun,
		summary,
		actions,
		colour = null
	}: {
		/** Unique prefix for input ids ("a" / "b"). */
		id: string;
		legend: string;
		projects: ProjectSummary[];
		projectId: string | null;
		runId: string | null;
		/** Runs of the selected project, newest first; null until loaded. */
		runs: RunMeta[] | null;
		runsLoading?: boolean;
		runsError?: string | null;
		onProject: (projectId: string) => void;
		onRun: (runId: string) => void;
		summary?: Snippet;
		actions?: Snippet;
		/** The run's colour in the charts: a card's top edge. null: a plain box. */
		colour?: string | null;
	} = $props();

	const runSelected = $derived(!!runs?.some((r) => r.id === runId));
</script>

<fieldset class="picker" class:card={colour !== null} style:--run-colour={colour}>
	<legend>{legend}</legend>
	{#if actions}<div class="actions">{@render actions()}</div>{/if}
	{#if summary}<div class="summary">{@render summary()}</div>{/if}
	<div class="field">
		<label for="{id}-project">Project</label>
		<select id="{id}-project" value={projectId ?? ''} onchange={(e) => onProject(e.currentTarget.value)}>
			{#if !projectId}<option value="" disabled>Choose a project…</option>{/if}
			{#each projects as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
		</select>
	</div>
	<div class="field">
		<label for="{id}-run">Run</label>
		<select
			id="{id}-run"
			value={runSelected ? runId : ''}
			disabled={!projectId || runsLoading || !runs?.length}
			aria-describedby={runsError ? `${id}-run-err` : undefined}
			onchange={(e) => onRun(e.currentTarget.value)}
		>
			{#if runsLoading}
				<option value="">Loading runs…</option>
			{:else if runs && runs.length === 0}
				<option value="">This project has no runs</option>
			{:else}
				{#if !runSelected}<option value="" disabled>Choose a run…</option>{/if}
				{#each runs ?? [] as r, i (r.id)}
					<option value={r.id}>{runOptionLabel(r, (iso) => fmtDate(iso, true), i === 0)}</option>
				{/each}
			{/if}
		</select>
		{#if runsError}<p class="err" id="{id}-run-err" role="alert">{runsError}</p>{/if}
	</div>
</fieldset>

<style>
	.picker {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.6rem 0.8rem 0.1rem;
		margin: 0;
		min-width: 0;
		flex: 1 1 280px;
	}
	legend {
		font-weight: 600;
		padding: 0 0.3rem;
	}
	.card {
		position: relative;
		background: var(--surface);
		border: 1px solid var(--border);
		border-top: 4px solid var(--run-colour);
		box-shadow: var(--shadow);
		padding: 0.75rem 0.9rem 0.4rem;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}
	/* The legend as the card's kicker: a fieldset legend can't sit inside the padding, so float it. */
	.card legend {
		float: left;
		width: 100%;
		padding: 0;
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-2);
		padding-right: 5rem;
	}
	.actions {
		position: absolute;
		top: 0.45rem;
		right: 0.5rem;
	}
	.summary {
		clear: both;
		min-height: 2.6rem;
		margin-bottom: 0.3rem;
	}
	/* On a card, each label sits beside its select, so the card stays short. */
	.card .field {
		display: grid;
		grid-template-columns: 3.4rem minmax(0, 1fr);
		align-items: center;
		column-gap: 0.4rem;
		margin-bottom: 0.35rem;
	}
	.card label {
		font-size: 0.8rem;
		margin: 0;
	}
	.card .err {
		grid-column: 2;
	}
	select {
		width: 100%;
	}
	.err {
		color: var(--danger);
		font-size: 0.8rem;
		margin: 0;
	}
</style>
