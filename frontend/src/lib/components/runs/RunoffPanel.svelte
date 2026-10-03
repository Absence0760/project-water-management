<!--
	The runoff model's water balance for a run (RunSummary.runoff; GR4J runs):
	parameters, where the rain went over the run, and the stores through time
	(on a forecast run, the forecast days in their band, like every daily chart).
-->
<script lang="ts">
	import type { DailySeries, RunoffBalance } from '@water-management/engine';
	import { api, type RunSeriesRef } from '$lib/api';
	import LineChart from '$lib/components/charts/LineChart.svelte';
	import type { ChartSeries } from '$lib/components/charts/series';
	import { forecastBand } from '$lib/components/forecast/forecast';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fmtNum, fmtPct } from '$lib/format/number';
	import { cachedSeries } from './cache';
	import { balanceRows, describeParams, runoffModelName } from './runoff';

	let {
		balance,
		projectId,
		runId,
		refs,
		forecastFrom = null
	}: {
		balance: RunoffBalance;
		projectId: string;
		runId: string;
		refs: RunSeriesRef[];
		/** A forecast run's first forecast day (WP-2.12): the stores chart shades the days from it. */
		forecastFrom?: string | null;
	} = $props();
	const band = $derived(forecastBand(forecastFrom));

	const uid = $props.id();
	const rows = $derived(balanceRows(balance));
	const STORES: [string, string, string][] = [
		['production_store', 'Production store', '--series-1'],
		['routing_store', 'Routing store', '--series-2']
	];
	let stores = $state.raw<ChartSeries[]>([]);
	let error = $state<string | null>(null);
	$effect(() => {
		const id = runId;
		error = null;
		const want = STORES.filter(([k]) => refs.some((r) => r.key === k && r.nodeId === null));
		Promise.all(want.map(([k]) => cachedSeries(id, k, null, () => api.runs.series(projectId, id, k, null))))
			.then((data: DailySeries[]) => {
				if (id !== runId) return;
				stores = data.map((d, i) => ({ label: want[i]![1], startDate: d.startDate, values: d.values, color: want[i]![2], width: 1.25 }));
			})
			.catch((e) => {
				if (id === runId) error = e instanceof Error ? e.message : String(e);
			});
	});
</script>

<section class="runoff" aria-labelledby="{uid}-h">
	<h3 id="{uid}-h">Runoff model: {runoffModelName(balance)} <HelpTip key="settings.gr4j" /></h3>
	<p class="muted small">
		{describeParams(balance)} · warm-up {fmtNum(balance.warmupDays)} days · over {fmtNum(balance.areaKm2, 2)} km²
	</p>
	<div class="grid">
		<div class="table-wrap">
			<table class="data compact" aria-labelledby="{uid}-t">
				<caption id="{uid}-t">Where the rain went over the run</caption>
				<thead>
					<tr>
						<th scope="col"><span class="visually-hidden">Term</span></th>
						<th scope="col" class="num">mm</th>
						<th scope="col" class="num">Share of rain</th>
					</tr>
				</thead>
				<tbody>
					{#each rows as r (r.key)}
						<tr>
							<th scope="row">{r.label}</th>
							<td class="num">{fmtNum(r.mm, 0)}</td>
							<td class="num">{r.ofRain === null ? '–' : fmtPct(r.ofRain, 1)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
			<p class="muted small note">
				Rain{balance.exchangeMm !== 0 ? ' plus exchange' : ''} = evaporation + flow + change in storage, every day. The stores held
				{fmtNum(balance.storageStartMm, 0)} mm after the warm-up and {fmtNum(balance.storageEndMm, 0)} mm at the end. Potential
				evaporation was {fmtNum(balance.petMm, 0)} mm.
			</p>
		</div>
		<div>
			{#if error}
				<div class="alert alert-error" role="alert">{error}</div>
			{:else if stores.length}
				<LineChart title="Model stores" unit="mm" height={220} series={stores} recentDays={3 * 365} recentLabel="Last 3 years" {band} />
			{:else}
				<div class="chart-ph" role="status">Loading stores…</div>
			{/if}
		</div>
	</div>
</section>

<style>
	/* The table beside the stores chart only where the panel is wide enough for both: sized to the
	   panel, not the window, since the runs rail and the app sidebar take their share first. A viewport
	   query left the chart 91 px wide at 1024 px, its Earlier/Later buttons 20 px off the page's edge. */
	.runoff {
		container: runoff / inline-size;
	}
	.grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1rem;
		align-items: start;
	}
	@container runoff (min-width: 44rem) {
		.grid {
			grid-template-columns: minmax(0, 360px) minmax(0, 1fr);
		}
	}
	caption {
		text-align: left;
		font-weight: 500;
		padding-bottom: 0.25rem;
	}
	.note {
		margin-top: 0.4rem;
	}
	.chart-ph {
		height: 290px;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-muted);
	}
</style>
