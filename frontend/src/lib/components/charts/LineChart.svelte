<script lang="ts">
	// Line chart on uPlot. One y-axis only: callers pass series that share a
	// unit. Daily series (x = dates, UTC) by default; pass `xy` for any other
	// x axis (e.g. exceedance % for a flow-duration curve). Colours come from
	// the --series-N tokens so the chart follows light/dark mode; the live
	// legend doubles as the hover read-out.
	import { onDestroy, untrack, type Snippet } from 'svelte';
	import uPlot from 'uplot';
	import 'uplot/dist/uPlot.min.css';
	import { fmtNum, fmtReading } from '$lib/format/number';
	import { forceLightForPrint, restoreThemeAfterPrint } from '$lib/components/report/printTheme';
	import { alignDaily, bandSpan, chartName, fmtCompact, isolatedIndices, panWindow, printScale, type ChartSeries } from './series';

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
		windows,
		toolbar,
		caption,
		shade = [],
		shadeKey,
		lanes = [],
		lanesLabel = 'Flagged days',
		band,
		pannable = true,
		print = false,
		printWidth = 680,
		ready = $bindable(false)
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
		/**
		 * Daily charts: time windows offered as one switch (e.g. 30 days / 1
		 * year / All, `days: null` = the whole record), each ending on the last
		 * day, in place of the recentDays / Full period pair. Opens on the one
		 * whose days equal `recentDays` (else the last). The pressed button is
		 * the window shown; a zoom or pan releases it.
		 */
		windows?: readonly { label: string; days: number | null }[];
		toolbar?: Snippet;
		caption?: string;
		/** Daily charts: inclusive date ranges drawn as a tinted band behind the lines (say what they mean in `caption` or `shadeKey`). */
		shade?: { start: string; end: string }[];
		/**
		 * A text key for `shade` under the plot: a swatch, what the tint means,
		 * and one line per range, so it never rests on colour alone (the Runs
		 * hydrograph's calibration exclusions).
		 */
		shadeKey?: { label: string; items: string[] };
		/**
		 * Daily charts: day ranges drawn as thin strips along the foot of the
		 * plot, one strip per entry (top strip first), behind the lines, with a
		 * key under the plot listing each strip's `text` beside its swatch, so
		 * a strip reads by its place and its words as well as its colour (the
		 * observed flow's per-day quality flags, calibration/flowFlags.ts).
		 */
		lanes?: readonly { label: string; color: string; ranges: readonly { start: string; end: string }[]; text: string }[];
		/** The lanes key's heading. */
		lanesLabel?: string;
		/**
		 * Daily charts: one labelled band behind the lines from `from` (to `to`,
		 * else the end), hatched, named on the plot and in a text key under it,
		 * so it never rests on colour alone. The forecast days (WP-2.12).
		 */
		band?: { from: string; to?: string; label: string; note: string };
		/**
		 * Daily charts: Shift+drag moves the view through the record, with
		 * Earlier / Later buttons as the non-drag route (shown once there is
		 * somewhere to move to). A plain drag still draws a box to zoom into,
		 * as on every chart. On by default; `false` opts a daily chart out.
		 * With `windows`, Earlier / Later step by the whole window picked.
		 */
		pannable?: boolean;
		/**
		 * The printable report's static chart: a fixed printWidth × height box
		 * drawn at 2 device pixels per CSS pixel (printScale), no cursor, zoom
		 * or controls, the whole period, a plain legend, and redrawn in the
		 * light theme (synchronously) when the page prints.
		 */
		print?: boolean;
		printWidth?: number;
		/** True once the chart has drawn (or has nothing to draw); also the figure's data-ready. */
		ready?: boolean;
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
	const canWindow = $derived(!windows && !!recentDays && spanDays > recentDays * 1.2);
	// The window switch: which window was picked, and the x range it set (so a zoom or pan releases it).
	let picked = $state<number | null>(null);
	let pickedView = $state.raw<{ min: number; max: number } | null>(null);
	const activeWindow = $derived(
		picked !== null && view && pickedView && Math.abs(view.min - pickedView.min) < 1 && Math.abs(view.max - pickedView.max) < 1 ? picked : null
	);
	// The accessible name: what it shows, its series, its unit and its span (ui-playbook § 3, "Label every chart").
	const a11yName = $derived(chartName(title, series, unit, isTime ? aligned.x : null, xLabel));
	const dataLo = $derived(aligned.x[0] ?? 0);
	const dataHi = $derived(aligned.x[aligned.x.length - 1] ?? 0);
	const canPan = $derived(!print && isTime && pannable && !!view && view.max - view.min < dataHi - dataLo);
	// Print mode lays the plot out k times larger and scales it back into its box.
	const k = $derived(print ? printScale(devicePixelRatio) : 1);

	function token(name: string, fallback: string): string {
		if (!host) return fallback;
		return getComputedStyle(host).getPropertyValue(name).trim() || fallback;
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
			width: (s.width ?? 1.5) * k,
			show: print || (shownByLabel.get(s.label) ?? !s.hidden),
			spanGaps: false,
			// Gaps stay gaps; a lone reading between two gets a dot so it isn't lost.
			points: { show: false, filter: isolatedIndices(plotted[i] ?? []), size: 4 * k, width: 0, fill: stroke },
			value: (_u: uPlot, v: number | null) => fmtReading(v)
		};
		if (s.style === 'points') {
			return { ...base, width: 0, paths: () => null, points: { show: true, size: 3 * k, width: 0, fill: stroke, stroke } };
		}
		if (s.style === 'step' || s.style === 'dashed') {
			return {
				...base,
				dash: [6 * k, 4 * k],
				paths: s.style === 'step' ? uPlot.paths.stepped!({ align: 1 }) : undefined
			};
		}
		return base;
	}

	function build() {
		plot?.destroy();
		plot = null;
		const w = print ? printWidth : width;
		// Nothing to draw is a finished state too (the figure says "No data to plot").
		ready = !!host && !hasData;
		if (!host || w <= 0 || !hasData) return;
		const axisColor = token('--chart-axis', '#6c706c');
		const gridColor = token('--chart-grid', '#e4e6e3');
		const font = `${12 * k}px ${token('--font-sans', 'system-ui')}`;
		const narrow = w < 520;
		const opts: uPlot.Options = {
			width: w * k,
			height: height * k,
			tzDate: utc,
			cursor: print ? { show: false } : { drag: { x: true, y: false }, points: { size: 7 } },
			...(print ? { select: { show: false, left: 0, top: 0, width: 0, height: 0 } } : {}),
			hooks: {
				draw: [() => (ready = true)],
				...(isTime && (shade.length || band || lanes.length)
					? {
							drawClear: [
								(u: uPlot) => {
									if (shade.length) drawShade(u, withAlpha(token('--warning', '#8a5a00'), 0.16));
									if (lanes.length) drawLanes(u);
									if (band) drawBand(u, token('--series-4', '#7a4fc4'), token('--text', '#1f2421'));
								}
							]
						}
					: {}),
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
			legend: { show: !print, live: true },
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
					grid: { stroke: gridColor, width: k },
					ticks: { stroke: gridColor, size: 10 * k, width: 2 * k },
					gap: 5 * k,
					// Daily data: never tick more often than once a day (no "12am / 12pm").
					...(isTime
						? { space: Math.max(50, Math.ceil(w / Math.max(spanDays, 1))) * k, size: 50 * k }
						: { values: (_u, vals) => vals.map((v) => (v == null ? '' : (xFormat?.(v) ?? String(v)))), space: 50 * k, size: 50 * k }),
					label: isTime ? undefined : xLabel,
					labelFont: font,
					labelSize: isTime ? undefined : 20 * k
				},
				{
					stroke: axisColor,
					font,
					// Compact ticks (30 M, 250 k) keep the axis narrow, so the unit
					// label never collides with the numbers.
					size: (narrow ? 44 : 52) * k,
					gap: 4 * k,
					space: 30 * k,
					grid: { stroke: gridColor, width: k },
					ticks: { stroke: gridColor, size: 4 * k, width: 2 * k },
					// On a log scale keep only the decades, so the grid stays readable.
					filter: log ? (_u, splits) => splits.map((v) => (isDecade(v) ? v : null)) : undefined,
					values: (_u, vals) => vals.map((v) => (v == null ? '' : fmtCompact(v))),
					label: unit || undefined,
					labelFont: font,
					labelSize: 18 * k,
					labelGap: 2 * k
				}
			]
		};
		const prev = view;
		const data = [aligned.x, ...plotted] as uPlot.AlignedData;
		// Print mode draws at once (batch commits synchronously), so a redraw
		// in the light theme from a beforeprint listener lands before the page
		// is laid out for printing; uPlot otherwise draws in a microtask.
		plot = print
			? new uPlot(opts, data, (u, init) => {
					host!.appendChild(u.root);
					u.batch(() => init());
				})
			: new uPlot(opts, data, host);
		if (print) return;
		// A rebuild (log scale, units, theme) keeps the window the user was
		// looking at; a first build, or a window the new data doesn't cover,
		// opens on the recent period as before.
		if (isTime && prev && prev.min >= dataLo && prev.max <= dataHi && prev.max - prev.min < dataHi - dataLo) plot.setScale('x', prev);
		else if (windows?.length && isTime) {
			const open = windows.findIndex((w) => w.days === recentDays);
			applyWindow(picked ?? (open >= 0 ? open : windows.length - 1));
		} else if (canWindow) showRecent();
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

	/**
	 * Earlier / Later: move by half the visible window, or, on a chart with
	 * `windows`, by the whole window (30 days, a year), keeping that window's
	 * button pressed.
	 */
	function step(dir: -1 | 1) {
		if (!plot || !view) return;
		const next = panWindow(view.min, view.max, (dir * (view.max - view.min)) / (windows?.length ? 1 : 2), dataLo, dataHi);
		if (windows?.length && activeWindow !== null) pickedView = next;
		plot.setScale('x', next);
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

	/** A lane's height in CSS pixels (a 1 px gap above each strip keeps neighbours apart). */
	const LANE_H = 6;

	/** Each lane a strip LANE_H high along the plot's foot, the first on top, its ranges a day wide at each end. */
	function drawLanes(u: uPlot) {
		const { ctx, bbox } = u;
		// Canvas pixels: the print box's scale, else the screen's pixel ratio (uPlot draws at it).
		const px = print ? k : uPlot.pxRatio;
		const h = LANE_H * px;
		const top = bbox.top + bbox.height - lanes.length * h;
		ctx.save();
		lanes.forEach((lane, i) => {
			ctx.fillStyle = withAlpha(token(lane.color, '#6c706c'), 0.75);
			const y = top + i * h;
			for (const r of lane.ranges) {
				const x0 = Math.max(bbox.left, u.valToPos(epochSec(r.start), 'x', true));
				const x1 = Math.min(bbox.left + bbox.width, u.valToPos(epochSec(r.end) + 86_400, 'x', true));
				// At least a device pixel, so a lone flagged day shows on a decades-long view.
				if (x1 > bbox.left && x0 < bbox.left + bbox.width) ctx.fillRect(x0, y + px, Math.max(x1 - x0, px), h - px);
			}
		});
		ctx.restore();
	}

	/** The labelled band: a light tint with diagonal hatching (so it reads without colour), a dashed edge, its label at the top. */
	function drawBand(u: uPlot, color: string, text: string) {
		const span = band ? bandSpan(band, aligned.x) : null;
		if (!span || !band) return;
		const { ctx, bbox } = u;
		const x0 = Math.max(bbox.left, u.valToPos(span.start, 'x', true));
		const x1 = Math.min(bbox.left + bbox.width, u.valToPos(span.end, 'x', true));
		if (!(x1 > x0)) return;
		ctx.save();
		ctx.fillStyle = withAlpha(color, 0.1);
		ctx.fillRect(x0, bbox.top, x1 - x0, bbox.height);
		ctx.beginPath();
		ctx.rect(x0, bbox.top, x1 - x0, bbox.height);
		ctx.clip();
		ctx.strokeStyle = withAlpha(color, 0.28);
		ctx.lineWidth = k;
		for (let d = x0 - bbox.height; d < x1; d += 8 * k) {
			ctx.beginPath();
			ctx.moveTo(d, bbox.top + bbox.height);
			ctx.lineTo(d + bbox.height, bbox.top);
			ctx.stroke();
		}
		ctx.restore();
		ctx.save();
		ctx.strokeStyle = color;
		ctx.lineWidth = 1.5 * k;
		ctx.setLineDash([4 * k, 3 * k]);
		ctx.beginPath();
		ctx.moveTo(x0, bbox.top);
		ctx.lineTo(x0, bbox.top + bbox.height);
		ctx.stroke();
		ctx.fillStyle = text;
		ctx.font = `${12 * k}px system-ui, sans-serif`;
		ctx.textBaseline = 'top';
		if (x1 - x0 > 40 * k) ctx.fillText(band.label, x0 + 4 * k, bbox.top + 4 * k);
		ctx.restore();
	}

	function showRecent() {
		if (!plot || !recentDays || !aligned.x.length) return;
		const max = aligned.x[aligned.x.length - 1]!;
		plot.setScale('x', { min: max - recentDays * 86_400, max });
	}
	/** One of `windows`: its last N days (all of the record when shorter, or for `days: null`). */
	function applyWindow(i: number) {
		const w = windows?.[i];
		if (!plot || !w || !aligned.x.length) return;
		const max = dataHi;
		const min = w.days === null ? dataLo : Math.max(dataLo, max - w.days * 86_400);
		picked = i;
		// Compared with the view the setScale hook reports (uPlot applies it in a microtask).
		pickedView = { min, max };
		plot.setScale('x', { min, max });
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
		// Print mode prints light whatever the screen shows: switch the theme
		// and redraw synchronously before the browser lays the page out.
		const after = () => restoreThemeAfterPrint();
		const beforePrint = () => {
			forceLightForPrint();
			untrack(build);
		};
		if (print) {
			addEventListener('beforeprint', beforePrint);
			addEventListener('afterprint', after);
		}
		return () => {
			ro.disconnect();
			mq.removeEventListener('change', onTheme);
			mo.disconnect();
			removeEventListener('beforeprint', beforePrint);
			removeEventListener('afterprint', after);
		};
	});

	// Rebuild when data, unit, scale, height or theme change…
	$effect(() => {
		void [plotted, unit, height, themeTick, hasData, host, log, series, shade, band, lanes];
		untrack(build);
	});
	// …and only resize in place when the container width changes.
	$effect(() => {
		const w = width;
		untrack(() => {
			// A print-mode chart has a fixed box, whatever its container's width.
			if (print) {
				if (!plot) build();
				return;
			}
			if (plot) plot.setSize({ width: w, height });
			else build();
		});
	});

	onDestroy(() => plot?.destroy());
</script>

<figure
	class="chart"
	data-shaded={shade.length || undefined}
	data-lanes={(isTime && lanes.length) || undefined}
	data-band-from={band && isTime && bandSpan(band, aligned.x) ? band.from : undefined}
	data-view-start={isTime && view ? isoDay(view.min) : undefined}
	data-view-end={isTime && view ? isoDay(view.max) : undefined}
	data-ready={ready}
>
	<figcaption class="head">
		<span class="ttl">{title}</span>
		{#if print}
			<!-- A plain legend: the report has no cursor to read values from. -->
			<span class="key">
				{#each series as s (s.label)}<span><i class:dash={s.style === 'dashed' || s.style === 'step'} style:border-color="var({s.color ?? '--series-1'})"></i>{s.label}</span>{/each}
			</span>
		{:else}
		<span class="tools">
			{#if toolbar}{@render toolbar()}{/if}
			{#if isTime && pannable && hasData && (canWindow || canPan)}
				<span class="seg" role="group" aria-label="Move through the record">
					<button type="button" class="btn btn-sm" disabled={!canPan || view!.min <= dataLo} onclick={() => step(-1)}>◀ Earlier</button>
					<button type="button" class="btn btn-sm" disabled={!canPan || view!.max >= dataHi} onclick={() => step(1)}>Later ▶</button>
				</span>
			{/if}
			{#if windows?.length && isTime && hasData}
				<span class="seg" role="group" aria-label="Time window">
					{#each windows as w, i (w.label)}
						<button type="button" class="btn btn-sm" aria-pressed={activeWindow === i} onclick={() => applyWindow(i)}>{w.label}</button>
					{/each}
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
		{/if}
	</figcaption>
	{#if !hasData}
		<p class="nodata">{log ? 'No positive values to plot on a log scale.' : 'No data to plot.'}</p>
	{/if}
	{#if print && hasData}
		<!-- Fixed box: the plot is laid out k× larger and scaled back into it (printScale). -->
		<div class="print-box" data-scroll-region data-scroll-label={title}>
			<div
				class="plot print"
				bind:this={host}
				style:width="{printWidth}px"
				style:height="{height}px"
				style:--k={1 / k}
				role="img"
				aria-label={a11yName}
			></div>
		</div>
	{:else}
		<div class="plot" bind:this={host} role="img" aria-label={a11yName}></div>
	{/if}
	{#if shadeKey && shade.length && isTime && hasData}
		<div class="shade-key">
			<p><i aria-hidden="true"></i><strong>{shadeKey.label}</strong> (tinted)</p>
			<ul>
				{#each shadeKey.items as item (item)}<li>{item}</li>{/each}
			</ul>
		</div>
	{/if}
	{#if lanes.length && isTime && hasData}
		<div class="lane-key">
			<p><strong>{lanesLabel}</strong> (strips along the foot of the plot, top to bottom)</p>
			<ul>
				{#each lanes as lane (lane.label)}<li><i aria-hidden="true" style:background="var({lane.color})"></i>{lane.text}</li>{/each}
			</ul>
		</div>
	{/if}
	{#if band && isTime && hasData && bandSpan(band, aligned.x)}
		<p class="band-key"><i aria-hidden="true"></i><span><strong>{band.label}</strong> (hatched, from {band.from}): {band.note}</span></p>
	{/if}
	{#if print}
		{#if caption}<p class="hint">{caption}</p>{/if}
	{:else}
		<p class="hint">
			{#if caption}{caption}{' '}{/if}{#if isTime && pannable}Drag across the chart to zoom, then Shift+drag (or Earlier / Later) to move through the record; double-click for the full period.{:else}Drag across the chart to zoom; double-click to reset.{/if}
		</p>
	{/if}
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
	/* Print mode: a fixed box (scrolls sideways on a phone), the plot scaled into it. */
	.print-box {
		max-width: 100%;
		overflow-x: auto;
	}
	.plot.print {
		overflow: hidden;
	}
	.plot.print :global(.uplot) {
		transform: scale(var(--k));
		transform-origin: 0 0;
	}
	.key {
		display: flex;
		flex-wrap: wrap;
		gap: 0.2rem 0.9rem;
		font-size: 0.8rem;
		color: var(--text-2);
	}
	.key i {
		display: inline-block;
		width: 1.2em;
		margin-right: 0.35em;
		vertical-align: middle;
		border-top: 3px solid;
	}
	.key i.dash {
		border-top-style: dashed;
	}
	@media print {
		.print-box {
			overflow: visible;
		}
	}
	.shade-key {
		margin: 0.25rem 0 0;
		font-size: 0.8125rem;
	}
	.shade-key p {
		margin: 0;
		display: flex;
		gap: 0.4rem;
		align-items: baseline;
	}
	.shade-key i {
		flex: none;
		display: inline-block;
		width: 1.1rem;
		height: 0.7rem;
		/* The tint drawShade paints (--warning at 16 %), edged so it shows on any ground. */
		background: color-mix(in srgb, var(--warning) 16%, transparent);
		border: 1px solid var(--warning);
	}
	.shade-key ul {
		margin: 0.1rem 0 0 1.5rem;
		padding: 0 0 0 1rem;
		color: var(--text-2);
	}
	.lane-key {
		margin: 0.25rem 0 0;
		font-size: 0.8125rem;
	}
	.lane-key p {
		margin: 0;
	}
	.lane-key ul {
		margin: 0.1rem 0 0;
		padding: 0;
		list-style: none;
		color: var(--text-2);
	}
	.lane-key li {
		display: flex;
		gap: 0.4rem;
		align-items: baseline;
	}
	.lane-key i {
		flex: none;
		display: inline-block;
		width: 1.1rem;
		height: 0.35rem;
	}
	.band-key {
		margin: 0.25rem 0 0;
		font-size: 0.8125rem;
		display: flex;
		gap: 0.4rem;
		align-items: baseline;
	}
	.band-key i {
		flex: none;
		display: inline-block;
		width: 1.1rem;
		height: 0.7rem;
		border-left: 2px dashed var(--series-4);
		background: repeating-linear-gradient(
			135deg,
			color-mix(in srgb, var(--series-4) 30%, transparent) 0 1px,
			color-mix(in srgb, var(--series-4) 10%, transparent) 1px 6px
		);
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
