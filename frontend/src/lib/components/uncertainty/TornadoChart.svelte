<!--
	The sensitivity runs' tornado (CR-21, docs/ui.md § Sensitivity runs): one
	row per factor, largest swing first, each with a bar from the central run to
	its low setting and one to its high setting, each named beside it. The
	central value is the vertical line, the decision threshold (when this
	metric has one) the dashed line. The panel's table gives the same numbers.
-->
<script lang="ts">
	import { TORNADO_METRICS, rowText, tornadoScale, type TornadoMetric, type TornadoRow } from './sensitivity';

	let {
		title,
		rows,
		central,
		metric,
		threshold = null
	}: { title: string; rows: TornadoRow[]; central: number | null; metric: TornadoMetric; threshold?: number | null } = $props();

	const uid = $props.id();
	const W = 560;
	const LABEL = 150;
	const RIGHT = 16;
	const TOP = 18;
	const ROW = 46;
	const m = $derived(TORNADO_METRICS[metric]);
	const scale = $derived(tornadoScale(rows, central, threshold));
	const H = $derived(TOP + rows.length * ROW + 34);
	const x = (v: number) => Math.round((LABEL + scale.at(v) * (W - LABEL - RIGHT)) * 10) / 10;
	const bar = (from: number | null, to: number | null) => {
		if (from === null || to === null) return null;
		const a = x(from);
		const b = x(to);
		return { x: Math.min(a, b), w: Math.max(Math.abs(b - a), 1.5) };
	};
</script>

<svg viewBox="0 0 {W} {H}" role="img" aria-labelledby="{uid}-t" data-testid="tornado">
	<title id="{uid}-t">
		{title}. Central run {m.fmt(central)}{metric === 'reserveRate' ? '' : ` ${m.unit}`}.{#if threshold !== null}{' '}Threshold {m.fmt(threshold)}.{/if}
		{#each rows as r (r.factor)}{' '}{rowText(r, metric)}{/each}
	</title>
	{#each scale.ticks as t (t)}
		<line class="grid" x1={x(t)} x2={x(t)} y1={TOP} y2={TOP + rows.length * ROW} />
		<text class="tick" x={x(t)} y={TOP + rows.length * ROW + 14} text-anchor="middle">{m.fmt(t)}</text>
	{/each}
	{#each rows as r, i (r.factor)}
		{@const y = TOP + i * ROW}
		{@const lo = bar(central, r.low)}
		{@const hi = bar(central, r.high)}
		<text class="name" x="0" y={y + 13}>{r.label}</text>
		<text class="setting" x={LABEL - 6} y={y + 27} text-anchor="end">{r.lowLabel}</text>
		<text class="setting" x={LABEL - 6} y={y + 41} text-anchor="end">{r.highLabel}</text>
		{#if lo}<rect class="low" x={lo.x} y={y + 18} width={lo.w} height="11" rx="1.5" />{/if}
		{#if hi}<rect class="high" x={hi.x} y={y + 32} width={hi.w} height="11" rx="1.5" />{/if}
	{/each}
	{#if central !== null}
		<line class="central" x1={x(central)} x2={x(central)} y1={TOP - 4} y2={TOP + rows.length * ROW} />
		<text class="central-l" x={x(central)} y={TOP - 7} text-anchor={scale.at(central) > 0.8 ? 'end' : scale.at(central) < 0.2 ? 'start' : 'middle'}>
			central {m.fmt(central)}
		</text>
	{/if}
	{#if threshold !== null}
		<line class="threshold" x1={x(threshold)} x2={x(threshold)} y1={TOP} y2={TOP + rows.length * ROW + 2} />
		<text class="threshold-l" x={x(threshold)} y={TOP + rows.length * ROW + 29} text-anchor={scale.at(threshold) > 0.8 ? 'end' : scale.at(threshold) < 0.2 ? 'start' : 'middle'}>
			threshold {m.fmt(threshold)}
		</text>
	{/if}
</svg>

<style>
	svg {
		width: 100%;
		max-width: 600px;
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
	.name {
		font-size: 12.5px;
		font-weight: 600;
		fill: var(--text);
	}
	.setting {
		font-size: 11px;
		fill: var(--text-muted);
	}
	.low {
		fill: var(--series-1);
	}
	.high {
		fill: var(--series-2);
	}
	.central {
		stroke: var(--text);
		stroke-width: 1.5;
	}
	.central-l {
		font-size: 11px;
		fill: var(--text);
	}
	.threshold {
		stroke: var(--danger);
		stroke-width: 1.5;
		stroke-dasharray: 5 4;
	}
	.threshold-l {
		font-size: 11px;
		fill: var(--danger);
	}
</style>
