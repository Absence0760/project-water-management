<!--
	Scenarios → Scenario against its base → "EWR months met: base against a run" (docs/ui.md § Scenarios): the EWR
	page's months-met panel for the daily EWR in use (ewr/EwrDailyMonthsPanel.svelte, compact) twice, the scenario's
	base run on the left (fixed) and a run picked on the right (default the scenario's latest run), so a scenario's
	outcome reads against its base at a glance. Both are the same component, so the axis (0–100 %), the bars'
	colours and the month order match; the tiles come first in each, so they line up. Side by side from 44rem of
	the section (a laptop's scenario page), stacked under that. Which daily EWR both are judged by is said once
	above them, or that they differ (ewrMonths.ts judgedBy).
-->
<script lang="ts">
	import type { RunSummary } from '@water-management/engine';
	import { untrack } from 'svelte';
	import { api, type RunMeta } from '#lib/api/index.js';
	import Lazy from '#lib/components/common/Lazy.svelte';
	import { runOptionLabel, runPickName } from '#lib/components/compare/picker.js';
	import { detailCache } from '#lib/components/runs/cache.js';
	import { fmtWhen } from '#lib/format/number.js';
	import { judgedBy, rightChoices, rightRun } from './ewrMonths';

	type Known = Pick<RunMeta, 'id' | 'label' | 'createdAt' | 'fromScenario' | 'scenarioId' | 'scenarioName'> & { summary: RunSummary };

	let {
		projectId,
		runs,
		base,
		latest
	}: {
		projectId: string;
		/** The project's runs (the page's list), for the right side's Run menu. */
		runs: readonly RunMeta[];
		/** The base run the comparison above used, with its record. */
		base: Known;
		/** The scenario's latest run, with its record: the right side's default. */
		latest: Known;
	} = $props();

	const uid = $props.id();
	const loadPanel = () => import('#lib/components/ewr/EwrDailyMonthsPanel.svelte');

	let picked = $state<string | null>(null);
	const choices = $derived(rightChoices(runs, base.id));
	const rightId = $derived(rightRun(choices, picked, latest.id));

	// The right side's record: the latest run's is in hand; another is fetched through the Runs tab's cache.
	let fetched = $state.raw<Known | null>(null);
	let error = $state<string | null>(null);
	async function load(id: string) {
		error = null;
		const hit = detailCache.get(id);
		if (hit) {
			fetched = hit.run;
			return;
		}
		fetched = null;
		try {
			const d = await api.runs.get(projectId, id);
			detailCache.set(id, d);
			if (id === rightId) fetched = d.run;
		} catch (e) {
			if (id === rightId) error = e instanceof Error ? e.message : String(e);
		}
	}
	$effect(() => {
		const id = rightId;
		if (id && id !== latest.id) untrack(() => load(id));
	});
	const right = $derived(rightId === latest.id ? latest : fetched?.id === rightId ? fetched : null);
	const judged = $derived(judgedBy(base.summary, right?.summary ?? null));
	const title = (r: Known) => `${runPickName(r)} · ${fmtWhen(r.createdAt)}`;
</script>

<section class="ewr-months" aria-labelledby="{uid}-h" data-testid="scenario-ewr-months">
	<h3 id="{uid}-h">EWR months met: base against a run</h3>
	<div class="pick">
		<label for="{uid}-run">Run on the right</label>
		<select id="{uid}-run" value={rightId} onchange={(e) => (picked = e.currentTarget.value)} data-testid="scenario-ewr-run">
			{#each choices as r, i (r.id)}<option value={r.id}>{runOptionLabel(r, (iso) => fmtWhen(iso), i === 0)}</option>{/each}
		</select>
	</div>
	{#if judged?.same}
		<p class="muted small" data-testid="scenario-ewr-judged">
			Each whole calendar month at the outlet, judged by <strong>{judged.name}</strong> on both sides: met when the simulated outflow over the month is at
			least the requirement summed over its days.
		</p>
	{:else if judged}
		<p class="alert alert-warning" role="note" data-testid="scenario-ewr-mismatch">{judged.text}</p>
	{/if}
	<div class="cols">
		<div class="col" data-testid="scenario-ewr-base">
			<Lazy load={loadPanel}>
				{#snippet children(Panel)}
					<Panel summary={base.summary} compact level={4} title="Base: {title(base)}">
						{#snippet missing()}<a href="?tab=runs">Run the model</a>{/snippet}
					</Panel>
				{/snippet}
			</Lazy>
		</div>
		<div class="col" data-testid="scenario-ewr-right" aria-busy={!right && !error}>
			{#if right}
				<Lazy load={loadPanel}>
					{#snippet children(Panel)}<Panel summary={right.summary} compact level={4} title={title(right)} />{/snippet}
				</Lazy>
			{:else if error}
				<p class="alert alert-error" role="alert">That run couldn’t be loaded: {error}</p>
			{:else}
				<p class="muted">Loading…</p>
			{/if}
		</div>
	</div>
</section>

<style>
	.ewr-months {
		container: ewr-months / inline-size;
	}
	.pick {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.5rem;
		margin: 0.25rem 0 0.5rem;
	}
	.pick select {
		max-width: 100%;
		min-width: 0;
	}
	.cols {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem 1.5rem;
	}
	.col {
		min-width: 0;
	}
	@container ewr-months (min-width: 44rem) {
		.cols {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		}
	}
</style>
