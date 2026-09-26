<script lang="ts">
	// Summary → the latest run's outflow against the pragmatic EWR, the Runs
	// tab's "EWR vs simulated outflow" chart (flowSeries.ts) over the last
	// year. Its own chunk (it pulls in uPlot), loaded by OverviewTab only once
	// the run's record is in. Series come through the Runs tab's cache, so
	// opening the run there next draws at once.
	import type { DailySeries } from '@water-management/engine';
	import { api, type RunSeriesRef } from '$lib/api';
	import LineChart from '$lib/components/charts/LineChart.svelte';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { forecastBand } from '$lib/components/forecast/forecast';
	import { cachedSeries } from '$lib/components/runs/cache';
	import { ewrChartSeries, type CatchmentFlows } from '$lib/components/runs/flowSeries';
	import { toDisplayUnit } from '$lib/components/runs/results';

	let {
		projectId,
		runId,
		refs,
		forecastFrom = null
	}: {
		projectId: string;
		runId: string;
		/** The run's stored series (its detail record), so only series it has are fetched. */
		refs: RunSeriesRef[];
		/** A forecast run's first forecast day: the chart shades from it. */
		forecastFrom?: string | null;
	} = $props();

	const SLOTS = [
		['simulated', 'simulated_outflow'],
		['ewr', 'ewr']
	] as const;

	// $state.raw: long daily arrays must not become deep proxies (RunCharts.svelte).
	let flows = $state.raw<CatchmentFlows>({});
	let loading = $state(true);
	let error = $state<string | null>(null);
	let log = $state(true);
	let attempt = $state(0);

	$effect(() => {
		const id = runId;
		void attempt;
		const present = SLOTS.filter(([, key]) => refs.some((r) => r.key === key && r.nodeId === null));
		loading = true;
		error = null;
		Promise.all(
			present.map(async ([slot, key]) => {
				const d = await cachedSeries(id, key, null, () => api.runs.series(projectId, id, key, null));
				return [slot, d] as const;
			})
		)
			.then((pairs) => {
				if (id === runId) flows = Object.fromEntries(pairs) as CatchmentFlows;
			})
			.catch((e) => {
				if (id === runId) error = e instanceof Error ? e.message : String(e);
			})
			.finally(() => {
				if (id === runId) loading = false;
			});
	});

	const conv = (d: DailySeries) => toDisplayUnit(d.values, 'm³/day', 'm³/s').values;
	const series = $derived(ewrChartSeries(flows, conv));
	const band = $derived(forecastBand(forecastFrom));
</script>

<section class="panel flow" aria-labelledby="flow-h" aria-busy={loading}>
	<h2 id="flow-h">Flow vs reserve</h2>
	<LoadState {loading} {error} retry={() => attempt++}>
		{#if series.length === 0}
			<p class="muted">This run stored no outflow or EWR series.</p>
		{:else}
			<LineChart
				title="EWR vs simulated outflow"
				unit="m³/s"
				height={220}
				{series}
				logToggle
				bind:log
				recentDays={365}
				recentLabel="Last year"
				{band}
				caption="Days the outflow dips below the dashed EWR line count as EWR not met."
			/>
		{/if}
	</LoadState>
</section>

<style>
	.flow h2 {
		margin: 0 0 0.5rem;
		font-size: 1.05rem;
	}
</style>
