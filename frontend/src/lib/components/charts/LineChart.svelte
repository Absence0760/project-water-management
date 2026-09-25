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
	import { alignDaily, fmtCompact, isolatedIndices, panWindow, type ChartSeries } from './series';

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
		caption,
		shade = [],
		pannable = false
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
		/** Daily charts: inclusive date ranges drawn as a tinted band behind the lines (say what they mean in `caption`). */
		shade?: { start: string; end: string }[];
		/**
		 * Daily charts: Shift+drag moves the view through the record, with
		 * Earlier / Later buttons as the non-drag route. A plain drag still
		 * draws a box to zoom into, as on every chart.
		 */
		pannable?: boolean;
	} = $props();

	let host: HTMLDivElement | undefined = $state();
	let plot: uPlot | null = null;
	let width = $state(0);
	let themeTick = $state(0);
	// Legend clicks, by series label, so a rebuild (log scale, units, theme)
	// keeps what the user switched on or off rather than resetting to `hidden`.
	const shownByLabel = new Map<string, boolean>();
	// The visible x range (epoch s), kept in step with the plot's scale.
	let view = $state<{ min: number; max: number } | null>(null);

	const isTime = $derived(!xy);
	const aligned = $derived(xy ?? alignDaily(series));
	const plotted = $derived(
		log ? aligned.ys.map((ys) => ys.map((v) => (v != null && v > 0 ? v : null))) : aligned.ys
	);
	const hasData = $derived(plotted.some((ys) => ys.some((v) => v !== null)));
	const spanDays = $derived(isTime && aligned.x.length ? (aligned.x[aligned.x.length - 1]! - aligned.x[0]!) / 86_400 : 0);
	const canWindow = $derived(!!recentDays && spanDays > recentDays * 1.2);
	const dataLo = $derived(aligned.x[0] ?? 0);
	const dataHi = $derived(aligned.x[aligned.x.length - 1] ?? 0);
	const canPan = $derived(isTime && pannable && !!view && view.max - view.min < dataHi - dataLo);

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
	const epochSec = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000;

	/** A hex colour token as rgba with the given alpha (canvas can't read color-mix). */
	function withAlpha(hex: string, alpha: number): string {
		const m = /^#([0-9a-f]{6})$/i.exec(hex);
		if (!m) return `rgba(200, 140, 40, ${alpha})`;
		const n = parseInt(m[1]!, 16);
		return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
	}

	function seriesOpts(s: ChartSeries, i: number): uPlot.Series {
		const stroke = token(s.color ?? `--series-${(i % 4) + 1}`, '#2a78d6');
		const base: uPlot.Series = {
			label: unit ? `${s.label} (${unit})` : s.label,
			stroke,
			width: s.width ?? 1.5,
			show: shownByLabel.get(s.label) ?? !s.hidden,
			spanGaps: false,
			// Gaps stay gaps; a lone reading between two gets a dot so it isn't lost.
			points: { show: false, filter: isolatedIndices(plotted[i] ?? []), size: 4, width: 0, fill: stroke },
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
			hooks: {
				...(isTime && shade.length ? { drawClear: [(u: uPlot) => drawShade(u, withAlpha(token('--warning', '#8a5a00'), 0.16))] } : {}),
				setScale: [
					(u: uPlot, key: string) => {
						if (key !== 'x') return;
						const { min, max } = u.scales.x!;
						view = min != null && max != null ? { min, max } : null;
					}
				],
				setSeries: [
					(u: uPlot, idx: number | null, o: uPlot.Series) => {
						if (idx != null && idx > 0 && o.show != null) shownByLabel.set(series[idx - 1]!.label, o.show);
					}
				]
			},
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
		const prev = view;
		plot = new uPlot(opts, [aligned.x, ...plotted] as uPlot.AlignedData, host);
		// A rebuild (log scale, units, theme) keeps the window the user was
		// looking at; a first build, or a window the new data doesn't cover,
		// opens on the recent period as before.
		if (isTime && prev && prev.min >= dataLo && prev.max <= dataHi && prev.max - prev.min < dataHi - dataLo) plot.setScale('x', prev);
		else if (canWindow) showRecent();
		if (isTime && pannable) attachPan(plot);
	}

	/** Shift+drag moves the view; a plain drag is left to uPlot's zoom box. */
	function attachPan(u: uPlot) {
		u.over.addEventListener('pointerdown', (e: PointerEvent) => {
			if (e.button !== 0 || !e.shiftKey || !canPan) return;
			const { min, max } = u.scales.x!;
			if (min == null || max == null) return;
			// Cancelling pointerdown suppresses the mouse events uPlot's zoom listens for.
			e.preventDefault();
			u.over.setPointerCapture(e.pointerId);
			const x0 = e.clientX;
			const perPx = (max - min) / Math.max(1, u.over.clientWidth);
			const move = (ev: PointerEvent) => u.setScale('x', panWindow(min, max, -(ev.clientX - x0) * perPx, dataLo, dataHi));
			const end = () => {
				u.over.removeEventListener('pointermove', move);
				u.over.removeEventListener('pointerup', end);
				u.over.removeEventListener('pointercancel', end);
			};
			u.over.addEventListener('pointermove', move);
			u.over.addEventListener('pointerup', end);
			u.over.addEventListener('pointercancel', end);
		});
	}

	/** Earlier / Later: move by half the visible window. */
	function step(dir: -1 | 1) {
		if (!plot || !view) return;
		plot.setScale('x', panWindow(view.min, view.max, (dir * (view.max - view.min)) / 2, dataLo, dataHi));
	}

	/** Tints each `shade` range over the full plot height, a day wide at each end. */
	function drawShade(u: uPlot, fill: string) {
		const { ctx, bbox } = u;
		ctx.save();
		ctx.fillStyle = fill;
		for (const r of shade) {
			const x0 = Math.max(bbox.left, u.valToPos(epochSec(r.start), 'x', true));
			const x1 = Math.min(bbox.left + bbox.width, u.valToPos(epochSec(r.end) + 86_400, 'x', true));
			if (x1 > x0) ctx.fillRect(x0, bbox.top, x1 - x0, bbox.height);
		}
		ctx.restore();
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
		void [plotted, unit, height, themeTick, hasData, host, log, series, shade];
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

<figure
	class="chart"
	data-shaded={shade.length || undefined}
	data-view-start={isTime && view ? isoDay(view.min) : undefined}
	data-view-end={isTime && view ? isoDay(view.max) : undefined}
>
	<figcaption class="head">
		<span class="ttl">{title}</span>
		<span class="tools">
			{#if toolbar}{@render toolbar()}{/if}
			{#if isTime && pannable && hasData}
				<span class="seg" role="group" aria-label="Move through the record">
					<button type="button" class="btn btn-sm" disabled={!canPan || view!.min <= dataLo} onclick={() => step(-1)}>◀ Earlier</button>
					<button type="button" class="btn btn-sm" disabled={!canPan || view!.max >= dataHi} onclick={() => step(1)}>Later ▶</button>
				</span>
			{/if}
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
		{#if caption}{caption}{' '}{/if}{#if isTime && pannable}Drag across the chart to zoom; Shift+drag, or Earlier / Later, to move through the record; double-click for the full period.{:else}Drag across the chart to zoom; double-click to reset.{/if}
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
	/* A switched-off series: uPlot fades it to 30 %, which fails text
	   contrast; strike it through in the muted text colour instead. */
	.plot :global(.u-legend .u-off > *) {
		opacity: 1;
	}
	.plot :global(.u-legend .u-off .u-label) {
		color: var(--text-muted);
		text-decoration: line-through;
	}
	.plot :global(.u-legend .u-off .u-marker) {
		opacity: 0.35;
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
