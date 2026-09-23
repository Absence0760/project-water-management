<script lang="ts">
	// Daily time-series line chart on uPlot. One y-axis only: callers pass
	// series that share a unit. Colours come from the --series-N tokens so the
	// chart follows light/dark mode; the live legend doubles as the hover
	// read-out (crosshair + values for the hovered day).
	import { onDestroy, untrack } from 'svelte';
	import uPlot from 'uplot';
	import 'uplot/dist/uPlot.min.css';
	import { fmtNum } from '$lib/format/number';
	import { alignDaily, type ChartSeries } from './series';

	let {
		series,
		unit = '',
		height = 320,
		title
	}: { series: ChartSeries[]; unit?: string; height?: number; title: string } = $props();

	let host: HTMLDivElement | undefined = $state();
	let plot: uPlot | null = null;
	let width = $state(0);
	let themeTick = $state(0);

	const aligned = $derived(alignDaily(series));
	const hasData = $derived(aligned.ys.some((ys) => ys.some((v) => v !== null)));

	function token(name: string, fallback: string): string {
		if (!host) return fallback;
		return getComputedStyle(host).getPropertyValue(name).trim() || fallback;
	}

	function digitsFor(v: number) {
		const a = Math.abs(v);
		return a >= 100 ? 0 : a >= 1 ? 2 : 3;
	}

	function build() {
		plot?.destroy();
		plot = null;
		if (!host || width <= 0 || !hasData) return;
		const axisColor = token('--chart-axis', '#6c706c');
		const gridColor = token('--chart-grid', '#e4e6e3');
		const font = `12px ${token('--font-sans', 'system-ui')}`;
		const opts: uPlot.Options = {
			width,
			height,
			cursor: { drag: { x: true, y: false }, points: { size: 8 } },
			scales: { x: { time: true } },
			legend: { live: true },
			series: [
				{ label: 'Date', value: (_u, v) => (v == null ? '–' : new Date(v * 1000).toISOString().slice(0, 10)) },
				...series.map((s, i) => ({
					label: unit ? `${s.label} (${unit})` : s.label,
					stroke: token(`--series-${(i % 3) + 1}`, '#2a78d6'),
					width: 1.5,
					spanGaps: false,
					points: { show: false },
					value: (_u: uPlot, v: number | null) => (v == null ? '–' : fmtNum(v, digitsFor(v)))
				}))
			],
			axes: [
				{ stroke: axisColor, font, grid: { stroke: gridColor, width: 1 }, ticks: { stroke: gridColor } },
				{
					stroke: axisColor,
					font,
					size: 64,
					grid: { stroke: gridColor, width: 1 },
					ticks: { stroke: gridColor },
					values: (_u, vals) => vals.map((v) => (v == null ? '' : fmtNum(v, digitsFor(v), true))),
					label: unit || undefined,
					labelFont: font
				}
			]
		};
		plot = new uPlot(opts, [aligned.x, ...aligned.ys] as uPlot.AlignedData, host);
	}

	$effect(() => {
		if (!host) return;
		const ro = new ResizeObserver((entries) => {
			const w = Math.floor(entries[0]?.contentRect.width ?? 0);
			if (w !== width) width = w;
		});
		ro.observe(host);
		const mq = matchMedia('(prefers-color-scheme: dark)');
		const onTheme = () => themeTick++;
		mq.addEventListener('change', onTheme);
		return () => {
			ro.disconnect();
			mq.removeEventListener('change', onTheme);
		};
	});

	// Rebuild when data, unit, height or theme change…
	$effect(() => {
		void [aligned, unit, height, themeTick, hasData, host];
		untrack(build);
	});
	// …and only resize in place when the container width changes.
	$effect(() => {
		const w = width;
		untrack(() => {
			if (plot) plot.setSize({ width: w, height });
			else build();
		});
	});

	onDestroy(() => plot?.destroy());
</script>

<figure class="chart">
	<figcaption>{title}</figcaption>
	{#if !hasData}
		<p class="nodata">No data to plot.</p>
	{/if}
	<div class="plot" bind:this={host} role="img" aria-label="{title}: line chart of {series.map((s) => s.label).join(', ')}"></div>
	<p class="hint">Drag across the chart to zoom; double-click to reset.</p>
</figure>

<style>
	.chart {
		margin: 0;
	}
	figcaption {
		font-weight: 600;
		font-size: 0.9rem;
		margin-bottom: 0.4rem;
	}
	.plot {
		width: 100%;
		min-height: 20px;
	}
	.nodata {
		color: var(--text-muted);
		padding: 2rem 0;
		text-align: center;
	}
	.hint {
		font-size: 0.75rem;
		color: var(--text-muted);
		margin: 0.25rem 0 0;
	}
	.plot :global(.u-legend) {
		font-size: 0.8rem;
		color: var(--text-2);
		text-align: left;
	}
	.plot :global(.u-legend .u-marker) {
		width: 1em;
		height: 3px;
		border-radius: 2px;
	}
	.plot :global(.u-select) {
		background: color-mix(in srgb, var(--accent) 15%, transparent);
	}
	.plot :global(.u-cursor-x),
	.plot :global(.u-cursor-y) {
		border-color: var(--border-strong);
	}
</style>
