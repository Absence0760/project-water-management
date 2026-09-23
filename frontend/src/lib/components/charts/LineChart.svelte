<script lang="ts">
	// Line chart on uPlot. One y-axis only: callers pass series that share a
	// unit. Daily series (x = dates, UTC) by default; pass `xy` for any other
	// x axis (e.g. exceedance % for a flow-duration curve). Colours come from
	// the --series-N tokens so the chart follows light/dark mode; the live
	// legend doubles as the hover read-out.
	import { onDestroy, untrack, type Snippet } from 'svelte';
	import uPlot from 'uplot';
	import 'uplot/dist/uPlot.min.css';
	import { fmtNum } from '$lib/format/number';
	import { alignDaily, fmtCompact, type ChartSeries } from './series';

	let {
		series,
		unit = '',
		height = 320,
		title,
		xy,
		xLabel,
		xFormat,
		logToggle = false,
		log = $bindable(false),
		recentDays,
		recentLabel = 'Recent',
		toolbar,
		caption
	}: {
		series: ChartSeries[];
		unit?: string;
		height?: number;
		title: string;
		/** Non-date x axis; `series[i].values` are ignored and ys[i] used instead. */
		xy?: { x: number[]; ys: (number | null)[][] };
		xLabel?: string;
		xFormat?: (v: number) => string;
		/** Show a log-scale switch (flows span orders of magnitude). */
		logToggle?: boolean;
		log?: boolean;
		/** Daily charts longer than this open zoomed to the last N days, with a "Full period" button. */
		recentDays?: number;
		recentLabel?: string;
		toolbar?: Snippet;
		caption?: string;
	} = $props();

	let host: HTMLDivElement | undefined = $state();
	let plot: uPlot | null = null;
	let width = $state(0);
	let themeTick = $state(0);

	const isTime = $derived(!xy);
	const aligned = $derived(xy ?? alignDaily(series));
	const plotted = $derived(
		log ? aligned.ys.map((ys) => ys.map((v) => (v != null && v > 0 ? v : null))) : aligned.ys
	);
	const hasData = $derived(plotted.some((ys) => ys.some((v) => v !== null)));
	const spanDays = $derived(isTime && aligned.x.length ? (aligned.x[aligned.x.length - 1]! - aligned.x[0]!) / 86_400 : 0);
	const canWindow = $derived(!!recentDays && spanDays > recentDays * 1.2);

	function token(name: string, fallback: string): string {
		if (!host) return fallback;
		return getComputedStyle(host).getPropertyValue(name).trim() || fallback;
	}

	function digitsFor(v: number) {
		const a = Math.abs(v);
		return a >= 100 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 3 : 4;
	}

	const isDecade = (v: number) => v > 0 && Math.abs(Math.log10(v) - Math.round(Math.log10(v))) < 1e-9;
	const utc = (ts: number) => uPlot.tzDate(new Date(ts * 1e3), 'Etc/UTC');
	const isoDay = (v: number) => new Date(v * 1000).toISOString().slice(0, 10);

	function seriesOpts(s: ChartSeries, i: number): uPlot.Series {
		const stroke = token(s.color ?? `--series-${(i % 4) + 1}`, '#2a78d6');
		const base: uPlot.Series = {
			label: unit ? `${s.label} (${unit})` : s.label,
			stroke,
			width: s.width ?? 1.5,
			spanGaps: false,
			points: { show: false },
			value: (_u: uPlot, v: number | null) => (v == null ? '–' : fmtNum(v, digitsFor(v)))
		};
		if (s.style === 'points') {
			return { ...base, width: 0, paths: () => null, points: { show: true, size: 3, width: 0, fill: stroke, stroke } };
		}
		if (s.style === 'step' || s.style === 'dashed') {
			return {
				...base,
				dash: [6, 4],
				paths: s.style === 'step' ? uPlot.paths.stepped!({ align: 1 }) : undefined
			};
		}
		return base;
	}

	function build() {
		plot?.destroy();
		plot = null;
		if (!host || width <= 0 || !hasData) return;
		const axisColor = token('--chart-axis', '#6c706c');
		const gridColor = token('--chart-grid', '#e4e6e3');
		const font = `12px ${token('--font-sans', 'system-ui')}`;
		const narrow = width < 520;
		const opts: uPlot.Options = {
			width,
			height,
			tzDate: utc,
			cursor: { drag: { x: true, y: false }, points: { size: 7 } },
			scales: {
				x: isTime ? { time: true } : { time: false },
				y: log ? { distr: 3, log: 10 } : {}
			},
			legend: { live: true },
			series: [
				isTime
					? { label: 'Date', value: (_u, v) => (v == null ? '–' : isoDay(v)) }
					: { label: xLabel ?? 'x', value: (_u, v) => (v == null ? '–' : (xFormat?.(v) ?? fmtNum(v, 2))) },
				...series.map(seriesOpts)
			],
			axes: [
				{
					stroke: axisColor,
					font,
					grid: { stroke: gridColor, width: 1 },
					ticks: { stroke: gridColor },
					// Daily data: never tick more often than once a day (no "12am / 12pm").
					...(isTime
						? { space: Math.max(50, Math.ceil(width / Math.max(spanDays, 1))) }
						: { values: (_u, vals) => vals.map((v) => (v == null ? '' : (xFormat?.(v) ?? String(v)))) }),
					label: isTime ? undefined : xLabel,
					labelFont: font,
					labelSize: isTime ? undefined : 20
				},
				{
					stroke: axisColor,
					font,
					// Compact ticks (30 M, 250 k) keep the axis narrow, so the unit
					// label never collides with the numbers.
					size: narrow ? 44 : 52,
					gap: 4,
					grid: { stroke: gridColor, width: 1 },
					ticks: { stroke: gridColor, size: 4 },
					// On a log scale keep only the decades, so the grid stays readable.
					filter: log ? (_u, splits) => splits.map((v) => (isDecade(v) ? v : null)) : undefined,
					values: (_u, vals) => vals.map((v) => (v == null ? '' : fmtCompact(v))),
					label: unit || undefined,
					labelFont: font,
					labelSize: 18,
					labelGap: 2
				}
			]
		};
		plot = new uPlot(opts, [aligned.x, ...plotted] as uPlot.AlignedData, host);
		if (canWindow) showRecent();
	}

	function showRecent() {
		if (!plot || !recentDays || !aligned.x.length) return;
		const max = aligned.x[aligned.x.length - 1]!;
		plot.setScale('x', { min: max - recentDays * 86_400, max });
	}
	function showAll() {
		if (!plot || !aligned.x.length) return;
		plot.setScale('x', { min: aligned.x[0]!, max: aligned.x[aligned.x.length - 1]! });
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
		// An explicit theme switch sets data-theme on <html>.
		const mo = new MutationObserver(onTheme);
		mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
		return () => {
			ro.disconnect();
			mq.removeEventListener('change', onTheme);
			mo.disconnect();
		};
	});

	// Rebuild when data, unit, scale, height or theme change…
	$effect(() => {
		void [plotted, unit, height, themeTick, hasData, host, log, series];
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
	<figcaption class="head">
		<span class="ttl">{title}</span>
		<span class="tools">
			{#if toolbar}{@render toolbar()}{/if}
			{#if canWindow && hasData}
				<span class="seg" role="group" aria-label="Time window">
					<button type="button" class="btn btn-sm" onclick={showRecent}>{recentLabel}</button>
					<button type="button" class="btn btn-sm" onclick={showAll}>Full period</button>
				</span>
			{/if}
			{#if logToggle}
				<button type="button" class="btn btn-sm" aria-pressed={log} onclick={() => (log = !log)}>
					Log scale
				</button>
			{/if}
		</span>
	</figcaption>
	{#if !hasData}
		<p class="nodata">{log ? 'No positive values to plot on a log scale.' : 'No data to plot.'}</p>
	{/if}
	<div class="plot" bind:this={host} role="img" aria-label="{title}: line chart of {series.map((s) => s.label).join(', ')}"></div>
	<p class="hint">
		{#if caption}{caption}{' '}{/if}Drag across the chart to zoom; double-click to reset.
	</p>
</figure>

<style>
	.chart {
		margin: 0;
		min-width: 0;
		/* Chart-only colours beyond the shared --series-1..3 tokens. */
		--series-4: #7a4fc4;
		--chart-obs: #2e3230;
		--chart-ref: #b42318;
	}
	@media (prefers-color-scheme: dark) {
		:global(:root:not([data-theme='light'])) .chart {
			--series-4: #a98be6;
			--chart-obs: #e6e8e5;
			--chart-ref: #f07a70;
		}
	}
	:global(:root[data-theme='dark']) .chart {
		--series-4: #a98be6;
		--chart-obs: #e6e8e5;
		--chart-ref: #f07a70;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.4rem 0.75rem;
		margin-bottom: 0.4rem;
	}
	.ttl {
		font-weight: 600;
		font-size: 0.9rem;
	}
	.tools {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		align-items: center;
	}
	.seg {
		display: inline-flex;
	}
	.seg .btn {
		border-radius: 0;
	}
	.seg .btn:first-child {
		border-radius: var(--radius-sm) 0 0 var(--radius-sm);
	}
	.seg .btn:last-child {
		border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
		margin-left: -1px;
	}
	.tools :global(.btn[aria-pressed='true']) {
		background: var(--accent-soft);
		border-color: var(--accent);
		color: var(--accent);
	}
	@media (max-width: 640px) {
		.tools :global(.btn) {
			min-height: 44px;
		}
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
	.plot :global(.u-legend.u-inline tr) {
		margin-right: 0.9rem;
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
