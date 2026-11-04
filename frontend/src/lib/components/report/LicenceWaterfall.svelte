<!--
	One year class's annual waterfall drawn as floating bars (issue #53 R7,
	docs/ui.md § Report, the operator's licence-impact mock-up 2026-11-03):
	natural flow from zero, each step taken from (or, when negative, added to)
	the running total, and the flow left from zero. A picture of the numbers
	the list beside it prints, so it is aria-hidden and the list is what a
	screen reader reads; every bar carries its value in words too. No EWR
	line: the requirement is daily (or monthly), not an annual volume, and the
	verdict comes from the months (planning-outputs.md §2 finding 5).
	Layout: ./licenceImpact.ts waterfallBars.
-->
<script lang="ts">
	import { waterfallBars, type WaterfallStep } from './licenceImpact';

	let { steps }: { steps: readonly WaterfallStep[] } = $props();

	// Labels alternate between two lines, so neighbours never touch. Small units, so the labels draw at ~11 px across the board's columns (the svg is never under 15rem).
	const W = 240;
	const H = 172;
	const TOP = 16;
	const BASE = 124;
	const layout = $derived(waterfallBars(steps));
	const y = (v: number) => BASE - (layout.max > 0 ? (v / layout.max) * (BASE - TOP) : 0);
	const slot = $derived(W / Math.max(layout.bars.length, 1));
</script>

<svg class="waterfall" viewBox="0 0 {W} {H}" aria-hidden="true" data-testid="waterfall-chart">
	<line class="axis" x1="0" x2={W} y1={BASE} y2={BASE} />
	{#each layout.bars as b, i (b.id)}
		{@const x = i * slot + slot * 0.18}
		{@const w = slot * 0.64}
		{@const top = Math.min(y(b.from), y(b.to))}
		{@const h = Math.max(Math.abs(y(b.from) - y(b.to)), 1)}
		<rect class="bar bar-{b.id}" {x} y={top} width={w} height={h} data-step={b.id}><title>{b.label}: {b.value}</title></rect>
		{#if i < layout.bars.length - 1}
			<line class="joint" x1={x + w} x2={(i + 1) * slot + slot * 0.18} y1={y(b.end)} y2={y(b.end)} />
		{/if}
		<text class="val" x={x + w / 2} y={top - 4} text-anchor="middle">{b.value}</text>
		<text class="lbl" x={x + w / 2} y={BASE + (i % 2 ? 26 : 14)} text-anchor="middle">{b.short}</text>
	{/each}
	<text class="unit" x={W / 2} y={H - 3} text-anchor="middle">{layout.unit}</text>
</svg>

<style>
	.waterfall {
		display: block;
		width: 100%;
		min-width: 15rem;
		max-width: 22rem;
		height: auto;
		margin: 0 0 0.4rem;
	}
	.axis {
		stroke: var(--border-strong);
	}
	.joint {
		stroke: var(--text-muted);
		stroke-dasharray: 2 2;
	}
	.bar-natural {
		fill: var(--text-muted);
	}
	.bar-existing {
		fill: var(--series-2);
	}
	.bar-proposed {
		fill: var(--series-5);
	}
	.bar-other {
		fill: var(--surface-2);
		stroke: var(--text-muted);
	}
	.bar-left {
		fill: var(--series-1);
	}
	.val,
	.lbl,
	.unit {
		fill: var(--text);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}
	.lbl,
	.unit {
		fill: var(--text-muted);
	}
	@media (forced-colors: active) {
		.bar {
			fill: CanvasText;
		}
		.bar-other {
			fill: Canvas;
			stroke: CanvasText;
		}
	}
</style>
