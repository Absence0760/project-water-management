<script lang="ts">
	// Small bar chart of 12 water-year monthly values (Oct → Sep), e.g. the
	// pragmatic EWR or A-pan evaporation. Decorative: the table beside it holds
	// the same numbers. Pass `stacks` instead of `values` for stacked bars (one
	// part per series, bottom first) with a legend; each stack takes a CSS
	// colour, and the bar height is the parts' sum. `width`/`height` draw it
	// at a caller's measured size (the Crops page's chart card), so it fills
	// the card without scaling its text; the default is a small fixed figure.
	import { fmtNum } from '$lib/format/number';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';

	type Stack = { id: string; name: string; values: number[]; color: string };
	let {
		values = [],
		stacks,
		unit,
		label,
		ariaLabel,
		caption,
		width,
		height
	}: {
		values?: number[];
		stacks?: Stack[];
		unit: string;
		/** What the bars are ("Pragmatic EWR"): the accessible name's start and the one-series legend. */
		label: string;
		ariaLabel?: string;
		/**
		 * The chart's visible title, for a chart with no panel heading of its own
		 * right above it (ui-playbook § 3, "Label every chart"): "Pragmatic EWR by
		 * month, Oct–Sep, m³/day". The Crops page's chart has its card's heading.
		 */
		caption?: string;
		width?: number;
		height?: number;
	} = $props();

	const fit = $derived(width !== undefined);
	const W = $derived(Math.max(240, width ?? 360));
	const H = $derived(height ?? 110);
	const PAD_B = 16;
	const series = $derived<Stack[]>(stacks ?? [{ id: 'v', name: label, values, color: 'var(--brand-outlet)' }]);
	const totals = $derived(WATER_YEAR_MONTHS.map((_, i) => series.reduce((s, x) => s + Math.max(0, x.values[i] || 0), 0)));
	const max = $derived(Math.max(1e-9, ...totals));
	const bw = $derived(W / 12);
	const scale = (v: number) => (v / max) * (H - PAD_B - 14);
	const fmt = (v: number) => fmtNum(v, v < 10 ? 2 : 0);
	/** Each month's parts, bottom up: [series index, value, y, height]. */
	const parts = $derived(
		WATER_YEAR_MONTHS.map((_, i) => {
			let top = H - PAD_B;
			return series.map((s, k) => {
				const v = Math.max(0, s.values[i] || 0);
				const h = scale(v);
				top -= h;
				return { k, v, y: top, h };
			});
		})
	);
</script>

{#if caption}<p class="cap" data-testid="monthly-bars-caption">{caption}</p>{/if}
<svg viewBox="0 0 {W} {H}" class="bars" class:fit role="img" aria-label={ariaLabel ?? `${label} by month (the table holds the values)`}>
	{#each parts as month, i (i)}
		<g>
			<title>{WATER_YEAR_MONTHS[i]}: {fmt(totals[i]!)} {unit}</title>
			{#each month as p (p.k)}
				{#if p.v > 0 || !stacks}
					<rect
						x={i * bw + 3}
						y={p.y}
						width={bw - 6}
						height={Math.max(p.h, p.v > 0 ? 1 : 0)}
						rx={stacks ? 0 : 2}
						style="fill: {series[p.k]!.color}"
						class:part={!!stacks}
					>
						{#if stacks}<title>{WATER_YEAR_MONTHS[i]}, {series[p.k]!.name}: {fmt(p.v)} {unit}</title>{/if}
					</rect>
				{/if}
			{/each}
			<text x={i * bw + bw / 2} y={H - 3} class="m">{fit && bw >= 28 ? WATER_YEAR_MONTHS[i] : WATER_YEAR_MONTHS[i]![0]}</text>
		</g>
	{/each}
	<line x1="0" x2={W} y1={H - PAD_B} y2={H - PAD_B} class="base" />
	<text x="2" y="10" class="max">max {fmt(max)} {unit}</text>
</svg>
{#if stacks}
	<ul class="legend" class:fit aria-hidden="true">
		{#each series as s (s.id)}<li><span class="key" style="background: {s.color}"></span>{s.name}</li>{/each}
	</ul>
{/if}

<style>
	.cap {
		margin: 0 0 0.3rem;
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text-2);
	}
	.bars {
		width: 100%;
		max-width: 420px;
		height: auto;
		display: block;
	}
	.fit,
	.legend.fit {
		max-width: none;
	}
	/* A thin surface-coloured gap between stacked parts, so neighbouring colours
	   stay apart without relying on hue alone. */
	.part {
		stroke: var(--surface);
		stroke-width: 1;
	}
	.base {
		stroke: var(--border-strong);
	}
	.m {
		font-size: 10px;
		text-anchor: middle;
		fill: var(--text-muted);
	}
	.max {
		font-size: 10px;
		fill: var(--text-muted);
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.9rem;
		margin: 0.4rem 0 0;
		padding: 0;
		list-style: none;
		font-size: 0.75rem;
		color: var(--text-2);
		max-width: 420px;
	}
	.legend li {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.key {
		flex: none;
		width: 0.7rem;
		height: 0.7rem;
		border-radius: 2px;
	}
</style>
