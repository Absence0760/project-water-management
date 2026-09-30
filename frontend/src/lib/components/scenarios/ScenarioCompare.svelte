<script lang="ts">
	// The scenario against its base (docs/ui.md § Scenarios): the latest run
	// of the scenario compared with the base run it was made on, through
	// GET /compare/runs like the compare page, showing the headline changes
	// (the water balance only: the fit is scored against the real gauge, so it
	// is no outcome of the scenario, issue #177),
	// the farms, and the per-node daily overlay (issue #8's CompareOverlay and
	// its overlay.ts helpers, as is). The base is the one the run recorded, so
	// a rebased scenario's older run is still compared with its own base.
	// Under it, the scenario run's validation statement (WP-3.13), folded shut.
	// The head links to the run's evidence report (issue #71).
	import { base } from '$app/paths';
	import { compareTabHref } from '$lib/components/compare/picker';
	import { untrack } from 'svelte';
	import { api, ApiError, type RunCompareResponse, type Scenario } from '$lib/api';
	import Lazy from '$lib/components/common/Lazy.svelte';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import FarmDeltaTable from '$lib/components/compare/FarmDeltaTable.svelte';
	import HeadlineDeltas from '$lib/components/compare/HeadlineDeltas.svelte';
	import ValidationPanel from '$lib/components/liability/ValidationPanel.svelte';
	import { fmtDate } from '$lib/format/number';

	const loadOverlay = () => import('$lib/components/compare/CompareOverlay.svelte');

	// Only assessors see it: ScenarioEditor shows an applicant a note instead.
	let { projectId, scenario }: { projectId: string; scenario: Scenario } = $props();

	let data = $state<RunCompareResponse | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let wanted = '';

	const ref = (runId: string) => `${projectId}:${runId}`;
	async function load(runId: string, baseRunId: string) {
		const key = `${runId}|${baseRunId}`;
		wanted = key;
		loading = true;
		error = null;
		try {
			let d = await api.compare.runs(ref(baseRunId), ref(runId));
			// The run was made on an earlier base (the scenario was rebased since): compare it with that one.
			const recorded = d.b.scenario?.baseRunId;
			if (recorded && recorded !== d.a.run.id) d = await api.compare.runs(ref(recorded), ref(runId));
			if (wanted === key) data = d;
		} catch (e) {
			if (wanted !== key) return;
			data = null;
			error = e instanceof ApiError && e.status === 404 ? "The scenario's run or its base run is no longer stored." : e instanceof Error ? e.message : String(e);
		} finally {
			if (wanted === key) loading = false;
		}
	}
	$effect(() => {
		const runId = scenario.lastRun?.id;
		const baseRunId = scenario.baseRunId;
		untrack(() => {
			if (runId) load(runId, baseRunId);
			else {
				wanted = '';
				data = null;
			}
		});
	});

	/** The scenario's ops changed since this run: its results are of the older list. */
	const stale = $derived(!!data?.b.scenario && data.b.scenario.opsSha256 !== scenario.opsSha256);
	const compareHref = $derived(data ? compareTabHref({ projectId, runId: data.a.run.id }, { projectId, runId: data.b.run.id }) : '');
</script>

<section class="panel" aria-labelledby="sc-compare-h">
	<div class="panel-head">
		<h2 id="sc-compare-h">Scenario against its base</h2>
		{#if data}
			<span class="acts">
				<a class="btn btn-sm" href={compareHref}>Open the full comparison</a>
				<!-- The licensing evidence report of this run on its base (issue #71, docs/ui.md § Evidence report). -->
				<a class="btn btn-sm" href="{base}/projects/{encodeURIComponent(projectId)}/report?run={encodeURIComponent(data.b.run.id)}&evidence" data-testid="scenario-evidence-link">Evidence report</a>
			</span>
		{/if}
	</div>
	{#if !scenario.lastRun}
		<p class="muted" data-testid="scenario-not-run">Not run yet. Run the scenario to compare it with its base run.</p>
	{:else}
		<LoadState loading={loading && !data} {error} retry={() => scenario.lastRun && load(scenario.lastRun.id, scenario.baseRunId)}>
			{#if data}
				<p class="sides" aria-busy={loading}>
					A: <strong>{data.a.run.label || 'Untitled run'}</strong> (base, run {fmtDate(data.a.run.createdAt, true)}) · B:
					<strong>{data.b.run.label || 'Untitled run'}</strong> (this scenario, run {fmtDate(data.b.run.createdAt, true)}). Every change is B − A.
				</p>
				{#if stale}
					<div class="alert alert-info" role="status" data-testid="scenario-stale">
						The scenario's changes have been edited since this run. Run it again to see their effect.
					</div>
				{/if}
				{#if data.a.run.id !== scenario.baseRunId}
					<div class="alert alert-info" role="status">
						This run was made on the scenario's earlier base run, “{data.a.run.label || 'Untitled run'}”, so it is compared with that one.
					</div>
				{/if}
				<section aria-labelledby="sc-headline-h">
					<h3 id="sc-headline-h">Headline results</h3>
					<HeadlineDeltas comparison={data.comparison} fit={false} />
				</section>
				<section aria-labelledby="sc-farms-h">
					<h3 id="sc-farms-h">Hydrological units</h3>
					<FarmDeltaTable comparison={data.comparison} farmsA={data.a.run.summary.farms ?? []} farmsB={data.b.run.summary.farms ?? []} />
				</section>
				<section aria-labelledby="sc-chart-h">
					<h3 id="sc-chart-h">Daily series</h3>
					<Lazy load={loadOverlay}>
						{#snippet children(CompareOverlay)}<CompareOverlay data={data!} />{/snippet}
					</Lazy>
				</section>
				<div class="validation">
					<ValidationPanel summary={data.b.run.summary} engineVersion={data.b.run.engineVersion} legacy={data.b.run.legacy} fitEngineVersion={data.b.run.settings?.fitRecord?.engineVersion ?? null} />
				</div>
			{/if}
		</LoadState>
	{/if}
</section>

<style>
	.acts {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.sides {
		margin: 0 0 0.75rem;
		overflow-wrap: anywhere;
	}
	h3 {
		font-size: 1rem;
		margin: 1rem 0 0.5rem;
	}
	.validation {
		margin-top: 1rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
	}
</style>
