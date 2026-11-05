<script lang="ts">
	// The run's other calibration locations (each ticked gauge but the headline): a calibration hydrograph each, its
	// record against the simulated flow there, under the outlet's and the headline's in Model quality. Built from the
	// run's `observed_flow_check` and `outflow` at the gauge (engine ≥ 1.90.0); their scores are in the Calibration
	// locations table. Pure parts: checkGauges.ts (calibrationLocationGauges, checkHydrograph).
	import type { Snippet } from 'svelte';
	import { CHECK_GAUGE_FLOW_KEY, type DailySeries } from '@water-management/engine';
	import { api } from '#lib/api/index.js';
	import LineChart from '#lib/components/charts/LineChart.svelte';
	import { followRetry } from '#lib/components/common/loadState.js';
	import { cachedSeries } from './cache';
	import { checkHydrograph, type LocationGauge } from './checkGauges';
	import { calibrationHydrographTitle } from './flowSeries';
	import { toDisplayUnit } from './results';

	let {
		projectId,
		runId,
		gauges,
		flowUnit,
		toolbar,
		band
	}: {
		projectId: string;
		runId: string;
		/** calibrationLocationGauges: the locations whose record the run stored. */
		gauges: LocationGauge[];
		flowUnit: 'm³/s' | 'm³/day';
		toolbar: Snippet;
		band?: { from: string; to?: string; label: string; note: string };
	} = $props();

	const get = (key: string, nodeId: string): Promise<DailySeries> => cachedSeries(runId, key, nodeId, () => api.runs.series(projectId, runId, key, nodeId));

	// $state.raw: long daily arrays must not become deep proxies (ModelQuality.svelte). Replace, never mutate.
	type Flows = { observed: DailySeries; simulated: DailySeries } | { error: string };
	let flows = $state.raw<Record<string, Flows>>({});
	let loadedRun = '';
	let asked = new Set<string>();
	function load(nodeId: string) {
		const id = runId;
		Promise.all([get(CHECK_GAUGE_FLOW_KEY, nodeId), get('outflow', nodeId)])
			.then(([observed, simulated]) => {
				if (id === runId) flows = { ...flows, [nodeId]: { observed, simulated } };
			})
			.catch((e) => {
				if (id === runId) flows = { ...flows, [nodeId]: { error: e instanceof Error ? e.message : String(e) } };
			});
	}
	$effect(() => {
		if (runId !== loadedRun) {
			loadedRun = runId;
			asked = new Set();
			flows = {};
		}
		for (const g of gauges) {
			if (asked.has(g.nodeId)) continue;
			asked.add(g.nodeId);
			load(g.nodeId);
		}
	});
	function retry(nodeId: string) {
		const { [nodeId]: _, ...rest } = flows;
		flows = rest;
		load(nodeId);
	}

	const conv = (d: DailySeries) => toDisplayUnit(d.values, 'm³/day', flowUnit).values;
	const RECENT = 3 * 365;
	const recordOf = (g: LocationGauge) => (g.flowKind === 'flow_logger_m3s' ? 'logger' : 'gauge');
</script>

{#each gauges as g (g.nodeId)}
	{@const f = flows[g.nodeId]}
	{@const title = calibrationHydrographTitle(g.name, recordOf(g))}
	<div class="location" data-testid="calibration-location-flows" data-node={g.nodeId}>
		{#if !f}
			<div class="chart-ph" style:height="390px" role="status">Loading flows at {g.name}…</div>
		{:else if 'error' in f}
			<div class="alert alert-error" role="alert">
				Couldn’t load the flows at {g.name}: {f.error}
				<button
					type="button"
					class="btn btn-sm"
					onclick={(e) => {
						followRetry(e.currentTarget);
						retry(g.nodeId);
					}}>Try again</button
				>
			</div>
		{:else}
			<LineChart
				{title}
				toolsLabel="{title} controls"
				unit={flowUnit}
				series={checkHydrograph(f.observed, f.simulated, g.flowKind, conv)}
				logToggle
				recentDays={RECENT}
				recentLabel="Last 3 years"
				{toolbar}
				{band}
				caption="A calibration location: its {recordOf(g)} record against the simulated flow there, a line broken wherever the record has no reading (a lone reading is a dot). Its scores are in the Calibration locations table."
			/>
		{/if}
	</div>
{/each}

<style>
	.location {
		margin-top: 1.25rem;
	}
	.chart-ph {
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-muted);
		background: var(--surface-2);
		border-radius: var(--radius-sm);
	}
</style>
