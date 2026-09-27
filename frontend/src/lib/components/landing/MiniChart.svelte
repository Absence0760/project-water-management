<script lang="ts">
	// A small chart for the landing page's story (issue #57): one water year of
	// the example run by week (52 points from October), drawn as plain SVG so
	// the landing never loads the app's chart library. The figure carries a
	// text equivalent (`summary`); the drawing is hidden from assistive tech.
	//   bars   one series as bars (weekly rainfall)
	//   line   one series, with an optional reference line (a dam's full mark)
	//   pair   `values` against `against` (supply vs demand, flow vs the
	//          reserve), the weeks `values` falls below `against` shaded
	// `scale: 'sqrt'` gives low values room beside a flood peak (river flow).
	import { language, wordsLang } from '$lib/i18n/state.svelte';

	let {
		kind,
		values,
		against,
		ref,
		max,
		unit,
		label,
		againstLabel,
		summary,
		tone = 'water',
		scale = 'linear'
	}: {
		kind: 'bars' | 'line' | 'pair';
		values: readonly number[];
		against?: readonly number[];
		ref?: number;
		max?: number;
		unit: string;
		label: string;
		againstLabel?: string;
		summary: string;
		tone?: 'water' | 'rain';
		scale?: 'linear' | 'sqrt';
	} = $props();

	const W = 320;
	const H = 128;
	const PAD = { l: 6, r: 6, t: 14, b: 20 };
	const iw = W - PAD.l - PAD.r;
	const ih = H - PAD.t - PAD.b;

	const top = $derived(max ?? (Math.max(...values, ...(against ?? []), ref ?? 0) * 1.08 || 1));
	const x = (i: number, n: number) => PAD.l + (iw * i) / Math.max(n - 1, 1);
	const k = (v: number) => (scale === 'sqrt' ? Math.sqrt(Math.max(v, 0)) : v);
	const y = (v: number) => PAD.t + ih - (ih * k(Math.min(v, top))) / k(top);
	const path = (v: readonly number[]) => 'M' + v.map((p, i) => `${x(i, v.length).toFixed(1)} ${y(p).toFixed(1)}`).join(' L');
	const area = (v: readonly number[]) => `${path(v)} L${x(v.length - 1, v.length).toFixed(1)} ${PAD.t + ih} L${PAD.l} ${PAD.t + ih} Z`;

	/** Runs of weeks where `values` is below `against`, as [first, last] indices. */
	const short = $derived.by(() => {
		if (kind !== 'pair' || !against) return [];
		const runs: [number, number][] = [];
		values.forEach((v, i) => {
			if (v >= against[i]! - 1e-9) return;
			const last = runs[runs.length - 1];
			if (last && last[1] === i - 1) last[1] = i;
			else runs.push([i, i]);
		});
		return runs;
	});

	// Month ticks: the story's water year starts in October; weeks 0, 13, 26, 39.
	const months = $derived.by(() => {
		const f = new Intl.DateTimeFormat(language(wordsLang()).intl, { month: 'short', timeZone: 'UTC' });
		return [0, 13, 26, 39].map((w, k) => ({ w, text: f.format(Date.UTC(2001, 9 + k * 3, 1)) }));
	});
</script>

<figure class="chart {tone}">
	<svg viewBox="0 0 {W} {H}" aria-hidden="true" focusable="false">
		<line class="axis" x1={PAD.l} x2={W - PAD.r} y1={PAD.t + ih} y2={PAD.t + ih} />
		{#each short as [a, b] (a)}
			<rect class="short" x={x(a, values.length) - 2} y={PAD.t} width={x(b, values.length) - x(a, values.length) + 4} height={ih} />
		{/each}
		{#if kind === 'bars'}
			{#each values as v, i (i)}
				{#if v > 0}<rect class="bar" x={x(i, values.length) - 2} y={y(v)} width="4" height={PAD.t + ih - y(v)} rx="1" />{/if}
			{/each}
		{:else}
			<path class="fill" d={area(values)} />
			{#if against}<path class="against" d={path(against)} />{/if}
			<path class="line" d={path(values)} />
		{/if}
		{#if ref !== undefined}
			<line class="ref" x1={PAD.l} x2={W - PAD.r} y1={y(ref)} y2={y(ref)} />
		{/if}
		{#each months as m (m.w)}
			<text x={x(m.w, 52)} y={H - 5}>{m.text}</text>
		{/each}
		<text class="unit" x={PAD.l} y="9">{unit}</text>
	</svg>
	<figcaption>
		<span class="key"><i class="swatch line-swatch"></i>{label}</span>
		{#if againstLabel}<span class="key"><i class="swatch against-swatch"></i>{againstLabel}</span>{/if}
		<span class="summary">{summary}</span>
	</figcaption>
</figure>

<style>
	.chart {
		margin: 0;
		--c-line: var(--series-1);
		--c-against: var(--text-2);
	}
	.chart.rain {
		--c-line: var(--series-10);
	}
	svg {
		display: block;
		width: 100%;
		height: auto;
		overflow: visible;
	}
	.axis {
		stroke: var(--chart-axis);
		stroke-width: 1;
	}
	.bar {
		fill: var(--c-line);
	}
	.fill {
		fill: var(--c-line);
		opacity: 0.12;
	}
	.line {
		fill: none;
		stroke: var(--c-line);
		stroke-width: 2;
		stroke-linejoin: round;
	}
	.against {
		fill: none;
		stroke: var(--c-against);
		stroke-width: 1.5;
		stroke-dasharray: 4 3;
	}
	.ref {
		stroke: var(--c-against);
		stroke-width: 1.25;
		stroke-dasharray: 4 3;
	}
	.short {
		fill: var(--warning);
		opacity: 0.16;
	}
	text {
		fill: var(--text-muted);
		font-size: 10px;
		font-family: var(--font-sans);
	}
	figcaption {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.9rem;
		margin-top: 0.4rem;
		font-size: 0.8rem;
		color: var(--text-2);
	}
	.key {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}
	.swatch {
		display: inline-block;
		width: 14px;
		height: 0;
		border-top: 2px solid var(--c-line);
	}
	.against-swatch {
		border-top: 1.5px dashed var(--c-against);
	}
	.summary {
		flex-basis: 100%;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
</style>
