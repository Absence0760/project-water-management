<script lang="ts">
	// Interval plot for paired changes (docs/design/evidence-report.md §5 D-U8):
	// a bar for 5–95 %, a dot for the median, a tick for the nominated run's
	// own difference, a thin zero line; one neutral hue, direction read from
	// the side of zero, never from a colour (G15). An SVG with a <title>, and
	// the same numbers in a table beside it for screen readers and print (§8).
	import type { Band } from '@water-management/engine';
	import { signed } from './format';

	let {
		rows,
		title,
		caption,
		digits = 0,
		unit = ''
	}: {
		rows: { label: string; band: Band | null; run: number | null }[];
		title: string;
		caption: string;
		digits?: number;
		unit?: string;
	} = $props();

	const uid = $props.id();
	const W = 340;
	const ROW = 16;
	const LEFT = 38;
	const RIGHT = 10;
	const TOP = 6;
	const H = $derived(TOP + rows.length * ROW + 22);

	const extent = $derived.by(() => {
		let lo = 0;
		let hi = 0;
		for (const r of rows) {
			for (const v of [r.band?.p5, r.band?.p95, r.band?.p50, r.run]) {
				if (typeof v === 'number' && Number.isFinite(v)) ((lo = Math.min(lo, v)), (hi = Math.max(hi, v)));
			}
		}
		if (lo === hi) return [lo - 1, hi + 1] as const;
		const pad = (hi - lo) * 0.06;
		return [lo - pad, hi + pad] as const;
	});
	const x = (v: number) => LEFT + ((v - extent[0]) / (extent[1] - extent[0])) * (W - LEFT - RIGHT);
	const y = (i: number) => TOP + i * ROW + ROW / 2;
	const ticks = $derived([extent[0], 0, extent[1]].filter((v, i, a) => a.indexOf(v) === i));
</script>

<figure class="iplot">
	<svg viewBox="0 0 {W} {H}" role="img" aria-labelledby="{uid}-t" preserveAspectRatio="xMinYMin meet">
		<title id="{uid}-t">{title}</title>
		<line class="zero" x1={x(0)} x2={x(0)} y1={TOP - 2} y2={TOP + rows.length * ROW + 2} />
		{#each rows as r, i (i)}
			<text class="lbl" x={LEFT - 6} y={y(i) + 3.5} text-anchor="end">{r.label}</text>
			{#if r.band && r.band.p5 !== null && r.band.p95 !== null}
				<line class="bar" x1={x(r.band.p5)} x2={x(r.band.p95)} y1={y(i)} y2={y(i)} />
			{/if}
			{#if r.band && r.band.p50 !== null}<circle class="dot" cx={x(r.band.p50)} cy={y(i)} r="3" />{/if}
			{#if r.run !== null}<line class="run" x1={x(r.run)} x2={x(r.run)} y1={y(i) - 5} y2={y(i) + 5} />{/if}
		{/each}
		{#each ticks as t (t)}
			<text class="axis" x={x(t)} y={TOP + rows.length * ROW + 14} text-anchor="middle">{t === 0 ? '0' : signed(t, digits)}</text>
		{/each}
	</svg>
	<figcaption>{caption} Dot: median; bar: 5–95 %; tick: the nominated run's own difference{unit ? ` (${unit})` : ''}. Right of zero, the application is worse.</figcaption>
</figure>

<style>
	.iplot {
		margin: 0;
	}
	svg {
		width: 100%;
		max-width: 520px;
		height: auto;
		display: block;
	}
	.zero {
		stroke: var(--chart-axis);
		stroke-width: 0.8;
	}
	.bar {
		stroke: var(--text);
		stroke-width: 2.4;
		opacity: 0.55;
	}
	.dot {
		fill: var(--text);
	}
	.run {
		stroke: var(--text);
		stroke-width: 1.2;
	}
	.lbl,
	.axis {
		font-size: 9px;
		fill: var(--text-muted);
	}
	figcaption {
		font-size: 0.8rem;
		color: var(--text-muted);
		max-width: 72ch;
	}
</style>
