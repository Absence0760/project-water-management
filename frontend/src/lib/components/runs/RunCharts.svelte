<script lang="ts">
	// The results below the run's summary on Runs & results, in the groups of
	// sections.ts (model quality, record, dig deeper), with a heading per group.
	// Model quality is its own component (ModelQuality.svelte, issue #586), which
	// takes the run; the parent slots the water balance by water year into it
	// (Runs & results keeps that table when Model quality moves to Calibration)
	// and its own panels into Record and Dig deeper. Dig deeper ends with an
	// explorer for any stored series. The page's flow charts share one unit
	// switch. The river and unit groups have their own pages; the run header
	// links there (RunsTab.svelte).
	import type { Snippet } from 'svelte';
	import type { Run, RunMeta, RunSeriesRef } from '#lib/api/index.js';
	import { forecastBand } from '#lib/components/forecast/forecast.js';
	import FlowUnitSwitch from './FlowUnitSwitch.svelte';
	import ModelQuality from './ModelQuality.svelte';
	import RunChart from './RunChart.svelte';

	let {
		projectId,
		run,
		refs,
		nodeNames,
		nodeOrder,
		runs,
		series = null,
		projectSettings = null,
		waterBalance,
		record,
		deeperLead
	}: {
		projectId: string;
		/** The run shown (GET …/runs/:runId). */
		run: Run;
		refs: RunSeriesRef[];
		nodeNames: Map<string, string>;
		nodeOrder: ReadonlyMap<string, number>;
		/** The project's runs, newest first (the plausibility checks overlay other runoff models' latest). */
		runs: RunMeta[];
		/** The project's input series: a checks-only gauge links to its record on Data. */
		series?: readonly { id: string; kind: string; siteNodeId?: string | null }[] | null;
		/** The project's settings, for a run that kept no snapshot of its own. */
		projectSettings?: { calibrationStart?: string | null; calibrationEnd?: string | null } | null;
		/** The water balance by water year, drawn in Model quality after calibration (it stays on Runs & results, issue #586). */
		waterBalance?: Snippet;
		/** The Record group: notes, evidence and publication (sign-off, after the results). */
		record?: Snippet;
		/** Opening Dig deeper, before the explorer (self-checks). */
		deeperLead?: Snippet;
	} = $props();
	const band = $derived(forecastBand(run.summary.forecast?.from ?? null));

	let flowUnit = $state<'m³/s' | 'm³/day'>('m³/s');
	// Record and Dig deeper follow Model quality's panels after the hydrograph is painted (ModelQuality.svelte).
	let settled = $state(false);
</script>

<!-- The explorer's copy of the page's one flow-unit switch (FlowUnitSwitch.svelte). -->
{#snippet unitToggle()}
	<FlowUnitSwitch bind:unit={flowUnit} />
{/snippet}

<div class="charts">
	<h2 class="group-h wide">Model quality</h2>
	<div class="wide slot">
		<ModelQuality {projectId} {run} {refs} {nodeNames} {nodeOrder} {runs} {series} {projectSettings} bind:flowUnit bind:settled afterCalibration={waterBalance} />
	</div>

	{#if settled}
		{#if record}
			<h2 class="group-h wide">Record</h2>
			<div class="wide slot">{@render record()}</div>
		{/if}

		<h2 class="group-h wide">Dig deeper</h2>
		{#if deeperLead}<div class="wide slot">{@render deeperLead()}</div>{/if}

		<section class="panel wide" id="res-explore" aria-labelledby="exp-h">
			<div class="panel-head"><h3 id="exp-h">Explore any output</h3></div>
			<RunChart {projectId} runId={run.id} {refs} {nodeNames} {nodeOrder} {flowUnit} flowToolbar={unitToggle} {band} />
		</section>
	{/if}
</div>

<style>
	.charts {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0 1rem;
	}
	.charts > .panel {
		min-width: 0;
	}
	.wide {
		grid-column: 1 / -1;
	}
	.slot {
		min-width: 0;
	}
	/* A group of panels (sections.ts): a quiet label above them, not a panel title. */
	.group-h {
		margin: 1.25rem 0 0.6rem;
		font-size: var(--font-sm);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
	}
	@media (max-width: 1100px) {
		.charts {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
