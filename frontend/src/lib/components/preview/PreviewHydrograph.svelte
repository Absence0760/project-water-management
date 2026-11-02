<script lang="ts">
	// The Preview dialog's mini hydrograph (roadmap WP-1.17): the flow at the
	// outlet in the last run against the same run with the unsaved edits, and
	// the observed record when the run has one, beside the dialog's figures.
	// It opens on the record's last year (30 days / 1 year / All, Earlier and
	// Later), on a log scale switch since flows span orders of magnitude. The
	// lines come with the preview's answer (lib/preview/compute.ts
	// previewHydrograph); nothing is fetched. Part of the dialog's own chunk,
	// so uPlot loads only when a preview opens.
	import LineChart from '#lib/components/charts/LineChart.svelte';
	import { FLOW_OPEN_DAYS, FLOW_WINDOWS } from '#lib/components/overview/summaryChart.js';
	import { fmtNum } from '#lib/format/number.js';
	import type { PreviewHydrograph } from '#lib/preview/messages.js';
	import { daysChanged, hydrographSeries } from './hydrograph';

	let { hydrograph }: { hydrograph: PreviewHydrograph } = $props();

	const series = $derived(hydrographSeries(hydrograph));
	const moved = $derived(daysChanged(hydrograph.last, hydrograph.edited));
	let log = $state(false);
</script>

<section class="hydrograph" aria-labelledby="preview-hydrograph-h" data-testid="unsaved-preview-hydrograph">
	<h3 id="preview-hydrograph-h">Flow at the outlet</h3>
	<p class="muted moved" data-testid="unsaved-preview-hydrograph-moved">
		{#if moved.changed === 0}
			Your edits don't change the flow at the outlet on any day: the two lines lie on each other.
		{:else}
			Your edits change the flow at the outlet on {fmtNum(moved.changed)} of {fmtNum(moved.compared)} days.
		{/if}
	</p>
	<LineChart
		title="Flow at the outlet · last run vs with your edits"
		unit="m³/day"
		{series}
		height={220}
		logToggle
		bind:log
		recentDays={FLOW_OPEN_DAYS}
		windows={FLOW_WINDOWS}
		toolsLabel="Preview hydrograph controls"
		caption="The last run solid, with your edits dashed over it{hydrograph.observed ? ', and the observed record' : ''}."
	/>
</section>

<style>
	.hydrograph {
		margin-top: 1rem;
	}
	h3 {
		font-size: 0.95rem;
		margin: 0 0 0.25rem;
	}
	.moved {
		font-size: 0.85rem;
		margin: 0 0 0.4rem;
	}
</style>
