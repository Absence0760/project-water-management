<script lang="ts">
	// The EWR test against observed flow for both runs (issue #4): the overall
	// scores with the change B − A, then each run's table side by side, so a
	// legacy run and a GR4J run of the same catchment can be judged on whether
	// their EWR failures match the river's.
	import type { MetricDelta } from '@water-management/engine';
	import type { RunCompareResponse } from '$lib/api';
	import EwrAgreementTable from '$lib/components/ewr/EwrAgreementTable.svelte';
	import Delta from './Delta.svelte';
	import { fmtMetric, type MetricSpec } from './delta';

	let { data }: { data: RunCompareResponse } = $props();

	interface Row {
		label: string;
		m: MetricDelta;
		spec: MetricSpec;
	}
	const ag = $derived(data.comparison.ewrAgreement);
	const rows = $derived<Row[]>(
		ag
			? [
					{ label: 'Frequency bias (1 ideal)', m: ag.frequencyBias, spec: { format: 'ratio', better: 'one', digits: 2 } },
					{ label: 'Hit rate', m: ag.hitRate, spec: { format: 'ratio', better: 'higher', digits: 2 } },
					{ label: 'False-alarm ratio', m: ag.falseAlarmRatio, spec: { format: 'ratio', better: 'lower', digits: 2 } },
					{ label: 'Model: share of days below the EWR', m: ag.modelFractionBelow, spec: { format: 'fraction', better: 'neutral' } },
					{ label: 'Observed: share of days below the EWR', m: ag.observedFractionBelow, spec: { format: 'fraction', better: 'neutral' } },
					{ label: 'Observed days compared', m: ag.days, spec: { format: 'days', better: 'neutral' } }
				]
			: []
	);
	const name = (s: RunCompareResponse['a']) => s.run.label || 'Untitled run';
</script>

<p class="muted small intro">
	On each day with an observed flow, is the simulated outflow below the EWR when the observed flow was? The model whose
	frequency bias is nearer 1, with the higher hit rate and the lower false-alarm ratio, reproduces the river's EWR failures
	better. The two runs are only comparable on the same observed days, so check that the day counts match.
</p>

{#if rows.length}
	<div class="table-wrap">
		<table class="data">
			<caption class="visually-hidden">EWR test against observed flow for both runs</caption>
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
						<th scope="row">{r.label}</th>
						<td class="num">{fmtMetric(r.m.a, r.spec)}</td>
						<td class="num">{fmtMetric(r.m.b, r.spec)}</td>
						<td class="num"><Delta m={r.m} spec={r.spec} /></td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}

<div class="sides">
	<EwrAgreementTable summary={data.a.run.summary} title="A: {name(data.a)}" />
	<EwrAgreementTable summary={data.b.run.summary} title="B: {name(data.b)}" />
</div>

<style>
	.intro {
		max-width: 85ch;
		margin-top: 0;
	}
	.sides {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem 1.5rem;
		margin-top: 1rem;
		align-items: start;
	}
	@media (max-width: 1100px) {
		.sides {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
