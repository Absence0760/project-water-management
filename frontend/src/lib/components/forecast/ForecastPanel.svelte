<script lang="ts">
	// A forecast run's forecast days (WP-2.12, docs/ui.md § Forecast runs): per
	// farm, the lowest dam level, the days short and the share of demand
	// supplied, and the outlet's EWR at risk. Everything else on the page
	// covers the days before them; this panel says so, and words every figure
	// as what the model expects, not what will happen.
	import type { ForecastSummary } from '@water-management/engine';
	import { forecastHeading, forecastRows, outletLine } from './forecast';

	let { forecast, nodeNames = new Map() }: { forecast: ForecastSummary; nodeNames?: ReadonlyMap<string, string> } = $props();

	const rows = $derived(forecastRows(forecast, nodeNames));
</script>

<section class="panel forecast" id="res-forecast" aria-labelledby="forecast-h" data-testid="forecast-panel">
	<div class="panel-head">
		<h3 id="forecast-h">Forecast</h3>
		<span class="tag tag-warn">Modelled on forecast rain, not measured</span>
	</div>
	<p>{forecastHeading(forecast)}</p>
	<p class="muted small">
		Forecast rain is uncertain, and so is everything modelled on it. Read these figures as a guide to the coming days. Every
		other figure of this run (unit totals, curtailment, EWR days, calibration) covers the days before {forecast.from} only; on the
		charts these days are the hatched band marked “Forecast”.
	</p>
	{#if rows.length}
		<table class="data compact">
			<caption class="visually-hidden">Expected over the forecast days, by unit</caption>
			<thead>
				<tr>
					<th scope="col">Unit</th>
					<th scope="col">Lowest dam level expected</th>
					<th scope="col">Days short expected</th>
					<th scope="col">Share of demand supplied</th>
				</tr>
			</thead>
			<tbody>
				{#each rows as r (r.nodeId)}
					<tr class:watch={r.watch}>
						<th scope="row">{r.name}</th>
						<td>{r.lowestDam}</td>
						<td>{r.shortDays}</td>
						<td>{r.supplied}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
	<p data-testid="forecast-outlet">{outletLine(forecast)}</p>
</section>

<style>
	.forecast {
		border-left: 3px dashed var(--series-4, #7a4fc4);
	}
	.panel-head {
		display: flex;
		gap: 0.5rem;
		align-items: baseline;
		flex-wrap: wrap;
	}
	tr.watch th {
		font-weight: 600;
	}
	table {
		margin: 0.5rem 0;
	}
</style>
