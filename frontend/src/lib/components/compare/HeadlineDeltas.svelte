<script lang="ts">
	// Headline numbers for both runs with the change B − A.
	import { SUPPLY_TARGET, type MetricDelta, type RunComparison } from '@water-management/engine';
	import { fmtPct } from '$lib/format/number';
	import Delta from './Delta.svelte';
	import { fmtMetric, type MetricSpec } from './delta';

	let { comparison }: { comparison: RunComparison } = $props();

	interface Row {
		label: string;
		unit: string;
		m: MetricDelta;
		spec: MetricSpec;
	}

	const water = $derived<Row[]>([
		{ label: 'Irrigation supplied (all farms)', unit: 'm³/day', m: comparison.totals.suppliedM3Day, spec: { format: 'volume', better: 'higher' } },
		{ label: 'Irrigation deficit (all farms)', unit: 'm³/day', m: comparison.totals.deficitM3Day, spec: { format: 'volume', better: 'lower' } },
		{ label: 'Share of demand supplied', unit: '', m: comparison.totals.fractionSupplied, spec: { format: 'fraction', better: 'higher' } },
		{ label: `Farms below ${fmtPct(SUPPLY_TARGET, 0)} supplied`, unit: 'farms', m: comparison.totals.farmsBelowTarget, spec: { format: 'count', better: 'lower' } },
		{ label: 'Days EWR not met', unit: 'days', m: comparison.catchment.ewrDaysNotMet, spec: { format: 'days', better: 'lower' } },
		{ label: 'Share of days EWR not met', unit: '', m: comparison.catchment.ewrFractionDaysNotMet, spec: { format: 'fraction', better: 'lower' } },
		{ label: 'Mean simulated outflow', unit: 'm³/day', m: comparison.catchment.meanSimulatedOutflowM3Day, spec: { format: 'volume', better: 'neutral' } },
		{ label: 'Mean natural flow', unit: 'm³/day', m: comparison.catchment.meanNaturalFlowM3Day, spec: { format: 'volume', better: 'neutral' } }
	]);

	const calibration = $derived<Row[]>(
		comparison.calibration
			? [
					{ label: 'Nash–Sutcliffe (NSE)', unit: '', m: comparison.calibration.nse, spec: { format: 'ratio', better: 'higher' } },
					{ label: 'Percent bias', unit: '', m: comparison.calibration.pbias, spec: { format: 'percent', better: 'zero' } },
					{ label: 'RMSE', unit: 'm³/s', m: comparison.calibration.rmseM3s, spec: { format: 'ratio', better: 'lower' } },
					{ label: 'Overlapping days', unit: 'days', m: comparison.calibration.days, spec: { format: 'days', better: 'neutral' } }
				]
			: []
	);
</script>

{#snippet table(rows: Row[], caption: string)}
	<div class="table-wrap">
		<table class="data">
			<caption class="visually-hidden">{caption}</caption>
			<thead>
				<tr>
					<th scope="col">Measure</th>
					<th scope="col" class="num">Run A</th>
					<th scope="col" class="num">Run B</th>
					<th scope="col" class="num">Change (B − A)</th>
				</tr>
			</thead>
			<tbody>
				{#each rows as r (r.label)}
					<tr>
						<th scope="row">{r.label}{#if r.unit}<span class="u"> · {r.unit}</span>{/if}</th>
						<td class="num">{fmtMetric(r.m.a, r.spec)}</td>
						<td class="num">{fmtMetric(r.m.b, r.spec)}</td>
						<td class="num"><Delta m={r.m} spec={r.spec} /></td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/snippet}

<div class="cols">
	<div>
		<h3>Water balance</h3>
		{@render table(water, 'Headline water balance for both runs')}
	</div>
	<div>
		<h3>Calibration against observed flow</h3>
		{#if calibration.length}
			{@render table(calibration, 'Calibration statistics for both runs')}
		{:else}
			<p class="muted">Neither run has observed flow overlapping its simulation period.</p>
		{/if}
	</div>
</div>

<style>
	.cols {
		display: grid;
		grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
		gap: 1rem;
		align-items: start;
	}
	@media (max-width: 900px) {
		.cols {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	.u {
		color: var(--text-muted);
		font-weight: 400;
	}
</style>
