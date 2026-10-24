<!-- i18n-section: farm.chart -->
<script lang="ts">
	// The dam's month-end level over 12 months with the stop level dashed
	// (design §6.3, board 3). aria-hidden, with a summary sentence and a table
	// of every month behind "Show the numbers", like MonthlyChart.
	import type { FarmProjection } from '@water-management/engine';
	import { t } from '#lib/i18n/locale.svelte.js';
	import { CHART_FONT_PX, damChart, damRows, damSummary, LABEL_Y } from './chart';

	let { farm, caption }: { farm: FarmProjection; caption: string } = $props();
	let width = $state(0);
	const chart = $derived(width > 0 ? damChart(farm.monthly, farm.dataUntil, width, farm.damMinPct) : null);
</script>

<section class="card" aria-labelledby="yr-h">
	<h2 id="yr-h">{t('Last 12 months')}</h2>
	<!-- What the line is (ui-playbook § 3, "Label every chart"); the table's caption, reused, so it has its translation already. -->
	<p class="what" data-testid="dam-chart-what">{t('Dam level at the end of each month')}</p>
	<p class="visually-hidden">{damSummary(farm.monthly, farm.dataUntil)}</p>
	<div class="plot" bind:clientWidth={width}>
		{#if chart}
			<svg width={chart.width} height={chart.height} viewBox="0 0 {chart.width} {chart.height}" aria-hidden="true" font-size={CHART_FONT_PX}>
				{#each chart.ticks as t (t.label)}
					<line x1={chart.axisLeft} x2={chart.width} y1={t.y} y2={t.y} class="grid" />
				{/each}
				{#if chart.stopY != null}
					<line x1={chart.axisLeft} x2={chart.width} y1={chart.stopY} y2={chart.stopY} class="stop" />
				{/if}
				<polyline points={chart.points} class="line" />
				{#each chart.labels as l, i (i)}
					<text x={l.x} y={LABEL_Y} text-anchor="middle" class="tick">{l.label}</text>
				{/each}
				<!-- After the line: inside a narrow plot the labels sit over it. -->
				{#each chart.ticks as t (t.label)}
					<text x="0" y={chart.inside ? t.y - 4 : t.y + 5} class="tick value" class:inside={chart.inside}>{t.label}</text>
				{/each}
			</svg>
		{/if}
	</div>
	<p class="fine">{caption}</p>
	<details>
		<summary>{t('Show the numbers')}</summary>
		<table class="numbers">
			<caption class="visually-hidden">{t('Dam level at the end of each month')}</caption>
			<thead><tr><th scope="col">{t('Month')}</th><th scope="col">{t('Dam full')}</th></tr></thead>
			<tbody>
				{#each damRows(farm.monthly, farm.dataUntil) as r (r.label)}
					<tr><th scope="row">{r.label}</th><td>{r.pct}</td></tr>
				{/each}
			</tbody>
		</table>
	</details>
</section>

<style>
	.what {
		margin: 0;
		font-size: 14px;
		color: var(--text-2);
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
	.tick {
		fill: var(--text-muted);
	}
	/* Just above its grid line inside a narrow plot (chart.ts axisPlacement): a halo in the card's colour keeps it legible over a bar or the line. */
	.tick.inside {
		stroke: var(--surface);
		stroke-width: 4px;
		stroke-linejoin: round;
		paint-order: stroke;
	}
	.stop {
		stroke: var(--text-2);
		stroke-width: 1.5;
		stroke-dasharray: 5 4;
	}
	.line {
		fill: none;
		stroke: var(--brand-outlet);
		stroke-width: 2.5;
		stroke-linejoin: round;
	}
</style>
