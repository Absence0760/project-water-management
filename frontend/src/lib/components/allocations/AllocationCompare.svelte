<script lang="ts">
	// A run's modelled use against the registered volumes, per farm or water
	// user, water source and water year (WP-3.10, docs/ui.md § Allocations).
	// Every modelled number is labelled "modelled, not metered", and the words
	// describe the arithmetic, never a finding of lawfulness.
	import { untrack } from 'svelte';
	import type { AllocationComparison } from '@water-management/engine';
	import { api, type RunMeta } from '$lib/api';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { fmtDate, fmtNum } from '$lib/format/number';
	import { comparisonRows, overSummary, SOURCE_LABEL, STATUS_LABEL, statusSentence, waterYearLabel } from './allocations';

	/** `version` changes whenever the allocations do (an import, an edit), to reload. */
	let { projectId, runs, version }: { projectId: string; runs: RunMeta[]; version: number } = $props();

	/** The published run when there is one (what members and farmers see), else the latest. */
	const defaultRun = $derived(runs.find((r) => r.published && !r.scenarioId)?.id ?? runs[0]?.id ?? '');
	let chosen = $state('');
	const runId = $derived(chosen || defaultRun);

	let comparison = $state<AllocationComparison | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let wanted = '';
	async function load(id: string) {
		wanted = id;
		loading = true;
		error = null;
		try {
			const r = await api.allocations.compare(projectId, id);
			if (wanted === id) comparison = r.comparison;
		} catch (e) {
			if (wanted === id) {
				comparison = null;
				error = e instanceof Error ? e.message : String(e);
			}
		} finally {
			if (wanted === id) loading = false;
		}
	}
	$effect(() => {
		// Reload when the run changes or the allocations do.
		void version;
		const id = runId;
		if (id) untrack(() => load(id));
	});

	const rows = $derived(comparison ? comparisonRows(comparison) : []);
	const over = $derived(comparison ? overSummary(comparison) : []);
	const runLabel = (r: RunMeta) => `${r.label || 'Untitled run'} · ${fmtDate(r.createdAt, true)}${r.published ? ' · published' : ''}${r.scenarioId ? ' · scenario' : ''}`;
</script>

<section class="panel" aria-labelledby="alloc-compare-h" data-testid="allocation-compare">
	<div class="panel-head">
		<h2 id="alloc-compare-h">Modelled use vs registered volume</h2>
		{#if runs.length}
			<label class="run-pick">
				<span>Run</span>
				<select value={runId} onchange={(e) => (chosen = e.currentTarget.value)}>
					{#each runs as r (r.id)}<option value={r.id}>{runLabel(r)}</option>{/each}
				</select>
			</label>
		{/if}
	</div>
	<p class="muted intro">
		The model's abstraction per water year (October–September) next to the volume registered for it. Modelled use is <strong>modelled, not metered</strong>, and a
		registered volume can be incomplete, so a difference is something to look into, not a finding about anyone's use.
	</p>
	{#if !runs.length}
		<p class="muted">Run the model to compare its use with the registered volumes.</p>
	{:else}
		<LoadState loading={loading && !comparison} {error} retry={() => load(runId)}>
			{#if comparison}
				{#if over.length}
					<div class="alert alert-warning" role="status">
						Modelled use is above the registered volume (by more than {fmtNum(comparison.tolerance * 100, 0)} %) in:
						<ul>
							{#each over as o (o.name + o.source)}
								<li>{o.name}, {SOURCE_LABEL[o.source].toLowerCase()}: {o.yearsOver} of {o.wholeYears} whole water year{o.wholeYears === 1 ? '' : 's'}</li>
							{/each}
						</ul>
					</div>
				{/if}
				{#if comparison.unmatchedAllocationIds.length}
					<p class="alert alert-info">
						{comparison.unmatchedAllocationIds.length} registered volume{comparison.unmatchedAllocationIds.length === 1 ? ' is' : 's are'} not matched to a unit yet, so
						{comparison.unmatchedAllocationIds.length === 1 ? 'it is' : 'they are'} not counted below.
					</p>
				{/if}
				{#if comparison.notInRunAllocationIds.length}
					<p class="alert alert-info">
						{comparison.notInRunAllocationIds.length} registered volume{comparison.notInRunAllocationIds.length === 1 ? ' belongs' : 's belong'} to a unit this run doesn't
						have (added or removed since it ran).
					</p>
				{/if}
				{#if rows.length}
					<div class="table-wrap">
						<table class="data cards" data-testid="allocation-compare-table">
							<caption class="visually-hidden">Modelled use against the registered volume per unit, water source and water year</caption>
							<thead>
								<tr>
									<th scope="col">Unit or user</th>
									<th scope="col">Source</th>
									<th scope="col">Water year</th>
									<th scope="col" class="num">Registered (m³)</th>
									<th scope="col" class="num">Modelled use (m³)<span class="sub">modelled, not metered</span></th>
									<th scope="col" class="num">Modelled ÷ registered</th>
									<th scope="col">Comparison</th>
								</tr>
							</thead>
							<tbody>
								{#each rows as r (r.key)}
									<tr class:flag={r.year.status === 'over'}>
										<th scope="row">{r.name}</th>
										<td data-label="Source">{SOURCE_LABEL[r.source]}</td>
										<td data-label="Water year">
											{waterYearLabel(r.year.waterYear)}
											{#if r.year.partial}<span class="part" title="The run covers {r.year.days} of the year's {r.year.yearDays} days; the registered volume is prorated to them.">part ({r.year.days} d)</span>{/if}
										</td>
										<td class="num" data-label="Registered (m³)">{fmtNum(r.year.registeredM3)}</td>
										<td class="num" data-label="Modelled use (m³, not metered)">{fmtNum(r.year.modelledM3)}</td>
										<td class="num" data-label="Modelled ÷ registered">{r.year.ratio === null ? '–' : `${fmtNum(r.year.ratio * 100, 0)} %`}</td>
										<td data-label="Comparison"><span class="status status-{r.year.status}" title={statusSentence(r.year, comparison.tolerance)}>{STATUS_LABEL[r.year.status]}</span></td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					<p class="hint muted">
						“Within band” is within ±{fmtNum(comparison.tolerance * 100, 0)} % of the registered volume. A part year compares the days the run covers with the registered
						volume prorated to them, and isn't counted in the summary above.
					</p>
				{:else}
					<p class="muted" data-testid="allocation-compare-empty">This run has no modelled abstraction and no registered volume to compare.</p>
				{/if}
			{/if}
		</LoadState>
	{/if}
</section>

<style>
	.intro {
		margin: 0 0 0.75rem;
		max-width: 70ch;
	}
	.run-pick {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.85rem;
		color: var(--text-2);
		min-width: 0;
	}
	.run-pick select {
		max-width: 22rem;
	}
	.sub {
		display: block;
		font-weight: 400;
		font-size: 0.7rem;
	}
	.part {
		margin-left: 0.3rem;
		font-size: 0.75rem;
		color: var(--text-2);
	}
	.status {
		display: inline-block;
		padding: 0.05rem 0.45rem;
		border-radius: 999px;
		font-size: 0.75rem;
		font-weight: 600;
		white-space: nowrap;
		border: 1px solid var(--border);
		background: var(--surface-2);
		color: var(--text-2);
	}
	.status-over {
		background: var(--warning-soft);
		color: var(--warning);
		border-color: color-mix(in srgb, var(--warning) 40%, transparent);
	}
	.status-within {
		background: var(--success-soft);
		color: var(--success);
		border-color: color-mix(in srgb, var(--success) 40%, transparent);
	}
	.hint {
		font-size: 0.8rem;
		margin: 0.5rem 0 0;
	}
	/* Phones: each row is a card of label–value lines instead of a wide table. */
	@media (max-width: 640px) {
		.cards thead {
			display: none;
		}
		.cards tr {
			display: block;
			padding: 0.4rem 0;
			border-bottom: 1px solid var(--border);
		}
		.cards th,
		.cards td {
			display: flex;
			justify-content: space-between;
			gap: 1rem;
			border-bottom: none;
			text-align: right;
		}
		.cards th {
			font-weight: 600;
			text-align: left;
		}
		.cards td::before {
			content: attr(data-label);
			color: var(--text-2);
			text-align: left;
		}
	}
</style>
