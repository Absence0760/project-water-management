<script lang="ts">
	// One side of the comparison: project → run.
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
		onRun
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
	} = $props();

	const runSelected = $derived(!!runs?.some((r) => r.id === runId));
</script>

<fieldset class="picker">
	<legend>{legend}</legend>
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
				{#each runs ?? [] as r (r.id)}
					<option value={r.id}>{runOptionLabel(r, (iso) => fmtDate(iso, true))}{r.pinned ? ' · pinned' : ''}</option>
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
	select {
		width: 100%;
	}
	.err {
		color: var(--danger);
		font-size: 0.8rem;
		margin: 0;
	}
</style>
