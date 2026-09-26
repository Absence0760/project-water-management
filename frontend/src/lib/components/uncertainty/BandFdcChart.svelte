<!--
	One month's flow-duration curve of simulated outflow as a 5–95 % band with
	its median, against the month's EWR (docs/ui.md § Uncertainty bands). A
	month is picked from the select; the table beside it gives the numbers.
-->
<script lang="ts">
	import type { EnsembleBands } from '@water-management/engine';
	import { monthName } from '$lib/format/months';
	import { fdcChart, pointsBelowEwr, sig } from './bands';

	let { fdc, points: exceedance }: { fdc: EnsembleBands['fdc']; points: number[] } = $props();

	const uid = $props.id();
	let month = $state(0);
	const W = 520;
	const H = 240;
	const m = $derived(fdc[month]!);
	const chart = $derived(fdcChart(m.points, exceedance, m.ewrM3Day, W, H));
	const below = $derived(pointsBelowEwr(m.points, m.ewrM3Day));
</script>

<div class="fdc">
	<div class="field">
		<label for="{uid}-m">Month</label>
		<select id="{uid}-m" bind:value={month}>
			{#each fdc as f, i (f.month)}<option value={i}>{monthName(f.month)}</option>{/each}
		</select>
	</div>
	<svg viewBox="0 0 {W} {H}" role="img" aria-labelledby="{uid}-t">
		<title id="{uid}-t">
			{monthName(m.month)} flow-duration band of simulated outflow against the EWR of {sig(m.ewrM3Day)} m³/day: the median lies below the EWR at {below} of {exceedance.length}
			exceedance points.
		</title>
		{#each chart.yTicks as t (t.y)}
			<line class="grid" x1="56" x2={W - 10} y1={t.y} y2={t.y} />
			<text class="tick" x="50" y={t.y + 4} text-anchor="end">{t.label}</text>
		{/each}
		{#each chart.xTicks as t (t.x)}
			<text class="tick" x={t.x} y={H - 8} text-anchor="middle">{t.label}</text>
		{/each}
		{#if chart.band}<path class="band" d={chart.band} />{/if}
		{#if chart.median}<path class="median" d={chart.median} />{/if}
		{#if chart.ewrY !== null}
			<line class="ewr" x1="56" x2={W - 10} y1={chart.ewrY} y2={chart.ewrY} />
			<text class="ewr-l" x={W - 12} y={chart.ewrY - 4} text-anchor="end">EWR {sig(m.ewrM3Day)} m³/day</text>
		{/if}
	</svg>
	<p class="muted small">
		Exceedance (% of {monthName(m.month)} days the flow is at least this) against simulated outflow, m³/day on a log scale. Shaded: 5–95 % of the kept
		parameter sets; line: their median.
	</p>
</div>

<style>
	.fdc svg {
		width: 100%;
		max-width: 560px;
		height: auto;
		display: block;
	}
	.grid {
		stroke: var(--chart-grid);
		stroke-width: 1;
	}
	.tick {
		font-size: 11px;
		fill: var(--chart-axis);
	}
	.band {
		fill: var(--accent-soft);
		stroke: var(--accent);
		stroke-width: 0.5;
	}
	.median {
		fill: none;
		stroke: var(--accent);
		stroke-width: 2;
	}
	.ewr {
		stroke: var(--danger);
		stroke-width: 1.5;
		stroke-dasharray: 5 4;
	}
	.ewr-l {
		font-size: 11px;
		fill: var(--danger);
	}
	.field {
		max-width: 12rem;
	}
</style>
