<script lang="ts">
	// The results below the run's summary on Runs & results, in the groups of
	// sections.ts: the water balance by water year (with the summary, no heading
	// of its own), then Record and The model’s working, with a heading per group. The
	// parent slots its own panels in. The model’s working ends with a chart of any
	// stored daily series (#586 E14: was Dig deeper and Explore any output). Model quality (the hydrograph to the plausibility checks)
	// moved to the Calibration page (issue #586 Round 3, ModelQuality.svelte), and
	// the river and unit groups have their own pages; the run header and the
	// Summary's model checks link there (RunsTab.svelte, RunSummaryView.svelte).
	import type { Snippet } from 'svelte';
	import type { Run, RunSeriesRef } from '#lib/api/index.js';
	import { forecastBand } from '#lib/components/forecast/forecast.js';
	import FlowUnitSwitch from './FlowUnitSwitch.svelte';
	import RunChart from './RunChart.svelte';

	let {
		projectId,
		run,
		refs,
		nodeNames,
		nodeOrder,
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
		/** The water balance by water year (issue #137): first, under the summary. */
		waterBalance?: Snippet;
		/** The Record group: notes, evidence and publication (sign-off, after the results). */
		record?: Snippet;
		/** Opening The model’s working, before the chart (the arithmetic checks). */
		deeperLead?: Snippet;
	} = $props();
	const band = $derived(forecastBand(run.summary.forecast?.from ?? null));

	let flowUnit = $state<'m³/s' | 'm³/day'>('m³/s');
</script>

<!-- The explorer's flow-unit switch (FlowUnitSwitch.svelte). -->
{#snippet unitToggle()}
	<FlowUnitSwitch bind:unit={flowUnit} />
{/snippet}

<div class="charts">
	{#if waterBalance}<div class="wide slot">{@render waterBalance()}</div>{/if}

	{#if record}
		<h2 class="group-h wide">Record</h2>
		<div class="wide slot">{@render record()}</div>
	{/if}

	<h2 class="group-h wide">The model’s working</h2>
	{#if deeperLead}<div class="wide slot">{@render deeperLead()}</div>{/if}

	<section class="panel wide" id="res-explore" aria-labelledby="exp-h">
		<div class="panel-head"><h3 id="exp-h">Chart any daily series</h3></div>
		<RunChart {projectId} runId={run.id} {refs} {nodeNames} {nodeOrder} {flowUnit} flowToolbar={unitToggle} {band} />
	</section>
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
