<!--
	The Data tab's double-mass check of catchment rain against CHIRPS (engine
	doubleMass, docs/model.md §2.10a): the cumulative curve with the
	whole-record line and the fitted segments, the departure from that line by
	water year, and the numbers as a table. It only reports; the CHIRPS factor
	fit and the rain a run uses don't change.
-->
<script lang="ts">
	import { waterYearLabel, type DoubleMass } from '@water-management/engine';
	import LineChart from '$lib/components/charts/LineChart.svelte';
	import { fmtCompact } from '$lib/components/charts/series';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fmtNum } from '$lib/format/number';
	import { doubleMassChart } from './doubleMass';

	let { dm }: { dm: DoubleMass } = $props();

	const chart = $derived(doubleMassChart(dm));
	const pct = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x * 100))} %`;
	const wyTick = (v: number) => (Number.isInteger(v) ? waterYearLabel(v) : '');
</script>

<section class="panel" aria-labelledby="dm-h" data-testid="double-mass">
	<div class="panel-head">
		<h2 id="dm-h">Double mass: catchment rain vs CHIRPS <HelpTip key="double-mass" /></h2>
	</div>
	<p class="summary">
		{#if dm.breaks.length}
			The ratio of catchment rain to CHIRPS changes
			{#each dm.breaks as b, i (b.afterWaterYear)}{i ? ' and ' : ''}after {waterYearLabel(b.afterWaterYear)} ({b.slopeBefore.toFixed(2)} → {b.slopeAfter.toFixed(2)}, {pct(
					b.change
				)}){/each}. A station change, a moved gauge or a change in how the catchment average is built can do this; so can a change in CHIRPS.
			The CHIRPS factors are still fitted over the whole record: this check doesn't change them.
		{:else}
			No break: catchment rain keeps a steady ratio to CHIRPS, {dm.wholeSlope.toFixed(2)} over the whole record.
		{/if}
	</p>
	<LineChart
		title="Cumulative catchment rain against cumulative CHIRPS"
		unit="mm"
		height={300}
		series={chart.curve.series}
		xy={chart.curve.xy}
		xLabel="Cumulative CHIRPS (mm)"
		xFormat={fmtCompact}
		caption={chart.caption}
	/>
	<LineChart
		title="Departure from the whole-record line"
		unit="%"
		height={180}
		series={chart.residual.series}
		xy={chart.residual.xy}
		xLabel="Water year"
		xFormat={wyTick}
		caption="(Cumulative catchment − whole-record slope × cumulative CHIRPS) ÷ cumulative catchment. A drift that runs one way for years is what a break looks like."
	/>
	<details class="years">
		<summary>Water-year totals ({dm.years.length} years)</summary>
		<div class="table-wrap">
			<table class="data compact">
				<caption class="visually-hidden">Double mass of catchment rain against CHIRPS, by water year</caption>
				<thead>
					<tr>
						<th scope="col">Water year</th>
						<th scope="col" class="num">Shared days</th>
						<th scope="col" class="num">Catchment<br /><span class="u">mm</span></th>
						<th scope="col" class="num">CHIRPS<br /><span class="u">mm</span></th>
						<th scope="col" class="num">Ratio<br /><span class="u">×</span></th>
						<th scope="col" class="num">Departure<br /><span class="u">%</span></th>
					</tr>
				</thead>
				<tbody>
					{#each dm.years as y (y.waterYear)}
						<tr>
							<th scope="row">{waterYearLabel(y.waterYear)}</th>
							<td class="num">{y.days}</td>
							<td class="num">{fmtNum(y.catchmentMm, 0)}</td>
							<td class="num">{fmtNum(y.chirpsMm, 0)}</td>
							<td class="num">{fmtNum(y.ratio, 2)}</td>
							<td class="num">{y.residualPct === null ? '–' : fmtNum(y.residualPct, 1)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if dm.skippedYears.length}
			<p class="muted small">Too few shared days or too little CHIRPS to judge: {dm.skippedYears.map(waterYearLabel).join(', ')}.</p>
		{/if}
	</details>
</section>

<style>
	.summary {
		margin: 0 0 0.75rem;
		font-size: 0.875rem;
		max-width: 80ch;
	}
	.years {
		margin-top: 0.75rem;
	}
	.years summary {
		cursor: pointer;
		font-size: 0.875rem;
		/* A 44px touch target without leaving display: list-item (which keeps the disclosure marker). */
		padding: 0.75rem 0;
	}
	h2 {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}
</style>
