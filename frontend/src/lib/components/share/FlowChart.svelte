<!-- i18n-section: share.chart -->
<script lang="ts">
	// The river's monthly mean flow at the outlet against its ecological
	// reserve, on the /share page (WP-2.3 phase 2). Inline SVG at the card's
	// rendered width, like the farm view's MonthlyChart and DamChart. The chart
	// is aria-hidden; a visually hidden sentence sums it up and "Show the
	// numbers" is a table of every month drawn.
	import { CHART_FONT_PX, LABEL_Y } from '$lib/components/farm/chartGeometry';
	import { t } from '$lib/i18n/locale.svelte';
	import { flowCaption, flowChart, flowRows, flowSummary, type FlowMonth } from './chart';

	let { months }: { months: FlowMonth[] } = $props();
	let width = $state(0);
	const chart = $derived(width > 0 ? flowChart(months, width) : null);
</script>

<section class="card" aria-labelledby="flow-h">
	<h2 id="flow-h">{t('River flow each month, in m³ a day')}</h2>
	<p class="visually-hidden">{flowSummary(months)}</p>
	<div class="legend" aria-hidden="true">
		<span><span class="key flow"></span>{t('Flow at the outlet')}</span>
		<span><span class="key ewr"></span>{t('Ecological reserve')}</span>
	</div>
	<div class="plot" bind:clientWidth={width}>
		{#if chart}
			<svg width={chart.width} height={chart.height} viewBox="0 0 {chart.width} {chart.height}" aria-hidden="true" font-size={CHART_FONT_PX}>
				{#each chart.ticks as t, i (i)}
					<line x1={chart.axisLeft} x2={chart.width} y1={t.y} y2={t.y} class={i === chart.ticks.length - 1 ? 'axis' : 'grid'} />
					<text x="0" y={t.y + 5} class="tick">{t.label}</text>
				{/each}
				{#each chart.ewr as pts, i (i)}<polyline points={pts} class="ewr" />{/each}
				{#each chart.flow as pts, i (i)}<polyline points={pts} class="flow" />{/each}
				{#each chart.labels as l, i (i)}
					<text x={l.x} y={LABEL_Y} text-anchor="middle" class="tick">{l.label}</text>
				{/each}
			</svg>
		{/if}
	</div>
	<p class="fine">{flowCaption(months)}</p>
	<details>
		<summary>{t('Show the numbers')}</summary>
		<table class="numbers">
			<caption class="visually-hidden">{t('Mean flow at the outlet and the ecological reserve each month, in m³ a day')}</caption>
			<thead><tr><th scope="col">{t('Month')}</th><th scope="col">{t('Flow')}</th><th scope="col">{t('Reserve')}</th></tr></thead>
			<tbody>
				{#each flowRows(months) as r (r.label)}
					<tr><th scope="row">{r.label}</th><td>{r.flow}</td><td>{r.ewr}</td></tr>
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
		width: 16px;
		height: 0;
		border-top: 3px solid var(--series-1);
	}
	.key.ewr {
		border-top: 2px dashed var(--chart-axis);
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
	polyline {
		fill: none;
		stroke-linejoin: round;
		stroke-linecap: round;
	}
	.flow {
		stroke: var(--series-1);
		stroke-width: 2.5;
	}
	.ewr {
		stroke: var(--chart-axis);
		stroke-width: 1.5;
		stroke-dasharray: 5 4;
	}
</style>
