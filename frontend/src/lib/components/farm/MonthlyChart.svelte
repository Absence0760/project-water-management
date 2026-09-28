<!-- i18n-section: farm.chart -->
<script lang="ts">
	// "Last 12 months, in ML" (design §3 Q1, §7): needed as an outline and
	// received as a fill, drawn as inline SVG at the card's rendered width so
	// the 13 px labels stay 13 px. The chart is aria-hidden; a visually hidden
	// sentence sums it up and "Show the numbers" is a real table of all 12
	// months with their years.
	import type { FarmProjection } from '@water-management/engine';
	import { t } from '$lib/i18n/locale.svelte';
	import { barChart, CHART_BASE, CHART_FONT_PX, LABEL_Y, rangeCaption, supplyRows, supplySummary } from './chart';

	let { farm }: { farm: FarmProjection } = $props();
	let width = $state(0);
	const chart = $derived(width > 0 ? barChart(farm.monthly, farm.dataUntil, width) : null);
	const rows = $derived(supplyRows(farm.monthly, farm.dataUntil));
</script>

<section class="card" aria-labelledby="chart-h">
	<h2 id="chart-h">{t('Last 12 months, in ML')}</h2>
	<p class="visually-hidden">{supplySummary(farm.monthly, farm.dataUntil)}</p>
	<div class="legend" aria-hidden="true">
		<span><span class="key need"></span>{t('Needed')}</span>
		<span><span class="key got"></span>{t('Received')}</span>
	</div>
	<div class="plot" bind:clientWidth={width}>
		{#if chart}
			<svg width={chart.width} height={chart.height} viewBox="0 0 {chart.width} {chart.height}" aria-hidden="true" font-size={CHART_FONT_PX}>
				{#each chart.ticks as t (t.label)}
					<line x1={chart.axisLeft} x2={chart.width} y1={t.y} y2={t.y} class={t.y >= CHART_BASE ? 'axis' : 'grid'} />
					<text x="0" y={t.y + 5} class="tick">{t.label}</text>
				{/each}
				{#each chart.groups as g, i (i)}
					<rect x={g.need.x} y={g.need.y} width={g.need.w} height={g.need.h} class="need" />
					<rect x={g.got.x} y={g.got.y} width={g.got.w} height={g.got.h} class="got" />
					<text x={g.labelX} y={LABEL_Y} text-anchor="middle" class="tick">{g.label}</text>
				{/each}
			</svg>
		{/if}
	</div>
	<p class="fine">{rangeCaption(farm.monthly, farm.dataUntil)}</p>
	<details>
		<summary>{t('Show the numbers')}</summary>
		<table class="numbers">
			<caption class="visually-hidden">{t('Water you needed and received each month')}</caption>
			<thead><tr><th scope="col">{t('Month')}</th><th scope="col">{t('Needed')}</th><th scope="col">{t('Received')}</th></tr></thead>
			<tbody>
				{#each rows as r (r.label)}
					<tr><th scope="row">{r.label}</th><td>{r.need}</td><td>{r.got}</td></tr>
				{/each}
			</tbody>
		</table>
	</details>
</section>

<style>
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 16px;
		font-size: 14px;
		color: var(--text-2);
	}
	.legend > span {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.key {
		width: 12px;
		height: 12px;
		box-sizing: border-box;
	}
	.key.need {
		border: 1.5px solid var(--chart-axis);
	}
	.key.got {
		background: var(--series-1);
	}
	.plot {
		height: 152px;
		min-width: 0;
		overflow: hidden;
	}
	svg {
		display: block;
	}
	.grid {
		stroke: var(--chart-grid);
	}
	.axis {
		stroke: var(--chart-axis);
	}
	.tick {
		fill: var(--text-muted);
	}
	.need {
		fill: none;
		stroke: var(--chart-axis);
		stroke-width: 1.5;
	}
	.got {
		fill: var(--series-1);
	}
</style>
