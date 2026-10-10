<script lang="ts">
	// Headline numbers for both runs with the change B − A, in two optional
	// halves. `water={false}`: Compare runs, whose What the change does table carries
	// the water balance rows (compare/summary.ts outcomeRows, issue #175).
	// `fit={false}`: a scenario against its base, whose run is scored against
	// the *real* gauge, so its NSE is not an outcome of the what-if
	// (ScenarioCompare, issue #177).
	import { SUPPLY_TARGET, type MetricDelta, type RunComparison } from '@water-management/engine';
	import { fmtPct } from '$lib/format/number';
	import Delta from './Delta.svelte';
	import { fmtMetric, type MetricSpec } from './delta';
	import { calibrationSample } from '$lib/components/calibration/sample';

	let { comparison, water: showWater = true, fit = true }: { comparison: RunComparison; water?: boolean; fit?: boolean } = $props();

	interface Row {
		label: string;
		unit: string;
		m: MetricDelta;
		spec: MetricSpec;
	}

	const water = $derived<Row[]>([
		{ label: 'Irrigation supplied (all hydrological units)', unit: 'm³/day', m: comparison.totals.suppliedM3Day, spec: { format: 'volume', better: 'higher' } },
		{ label: 'Irrigation deficit (all hydrological units)', unit: 'm³/day', m: comparison.totals.deficitM3Day, spec: { format: 'volume', better: 'lower' } },
		{ label: 'Share of demand supplied', unit: '', m: comparison.totals.fractionSupplied, spec: { format: 'fraction', better: 'higher' } },
		{ label: `Hydrological units below ${fmtPct(SUPPLY_TARGET, 0)} supplied`, unit: 'hydrological units', m: comparison.totals.farmsBelowTarget, spec: { format: 'count', better: 'lower' } },
		{ label: 'Days EWR not met', unit: 'days', m: comparison.catchment.ewrDaysNotMet, spec: { format: 'days', better: 'lower' } },
		{ label: 'Share of days EWR not met', unit: '', m: comparison.catchment.ewrFractionDaysNotMet, spec: { format: 'fraction', better: 'lower' } },
		{ label: 'Mean simulated outflow', unit: 'm³/day', m: comparison.catchment.meanSimulatedOutflowM3Day, spec: { format: 'volume', better: 'neutral' } },
		{ label: 'Mean natural flow', unit: 'm³/day', m: comparison.catchment.meanNaturalFlowM3Day, spec: { format: 'volume', better: 'neutral' } },
		{ label: 'Runoff coefficient (flow ÷ rain)', unit: '', m: comparison.catchment.runoffCoefficient, spec: { format: 'ratio', better: 'neutral' } }
	]);

	// WR2012 check: simulated natural ÷ scaled WR2012 (closer to 1 is better).
	const wr2012 = $derived<Row[]>(
		comparison.wr2012
			? [
					{ label: 'MAR ratio, overlapping years', unit: '', m: comparison.wr2012.marRatioOverlap, spec: { format: 'ratio', better: 'one', digits: 2 } },
					{ label: 'MAR ratio, whole run', unit: '', m: comparison.wr2012.marRatioWhole, spec: { format: 'ratio', better: 'one', digits: 2 } },
					{ label: 'Dry-season ratio', unit: '', m: comparison.wr2012.lowFlowRatio, spec: { format: 'ratio', better: 'one', digits: 2 } },
					{ label: 'Monthly pattern correlation', unit: '', m: comparison.wr2012.patternCorrelation, spec: { format: 'ratio', better: 'higher', digits: 2 } }
				]
			: []
	);

	// "In-sample" only for a run whose parameters were fitted on the days scored (issue #45).
	const samples = $derived({
		a: calibrationSample({ fitStatus: comparison.calibration?.fitStatus?.a ?? undefined }),
		b: calibrationSample({ fitStatus: comparison.calibration?.fitStatus?.b ?? undefined })
	});
	const sampleCaption = $derived(
		samples.a.short === samples.b.short ? samples.a.short : `calibration period (run A ${samples.a.qualifier ?? 'not recorded'}, run B ${samples.b.qualifier ?? 'not recorded'})`
	);

	const calibration = $derived<Row[]>(
		comparison.calibration
			? [
					{ label: 'Kling–Gupta (KGE)', unit: '', m: comparison.calibration.kge, spec: { format: 'ratio', better: 'higher' } },
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

<div class="cols" class:one={!showWater || !fit}>
	{#if showWater}
		<div>
			<h3>Water balance</h3>
			{@render table(water, 'Headline water balance for both runs')}
		</div>
	{/if}
	{#if fit}
		<div>
			<h3>Calibration against observed flow</h3>
			{#if calibration.length}
				<p class="muted small in-sample">
					{sampleCaption[0]!.toUpperCase() + sampleCaption.slice(1)}: in-sample means scored on the days the parameters were fitted
					on. The validation scores of the fit behind each run's parameters are under Fit and validation; <a href="#ewr-agreement-h">the
					EWR test against observed flow</a> below is a check the fit didn't optimise.
				</p>
				{@render table(calibration, `Calibration statistics for both runs, ${sampleCaption}`)}
			{:else}
				<p class="muted">Neither run has observed flow overlapping its simulation period.</p>
			{/if}
			{#if wr2012.length}
				<h3>WR2012 check <span class="u">· simulated natural ÷ scaled WR2012</span></h3>
				{@render table(wr2012, 'WR2012 check for both runs')}
			{/if}
		</div>
	{/if}
</div>

<style>
	.cols {
		display: grid;
		grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
		gap: 1rem;
		align-items: start;
	}
	.cols.one {
		grid-template-columns: minmax(0, 1fr);
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
	.in-sample {
		margin: 0 0 0.5rem;
	}
</style>
