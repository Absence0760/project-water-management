<script lang="ts">
	// The over/under-use chart of the evidence report's § 5 (WP-3.10,
	// docs/allocations.md § In the evidence report): one row per unit and
	// water source, one mark per whole water year at modelled use ÷ the
	// registered volume; hollow for the baseline, filled for the application;
	// a line at 100 % and the tolerance band shaded behind it. One neutral hue:
	// which side of the band a mark falls on is read from its position, never
	// a colour (G15). An SVG with a <title>; the same numbers are in the
	// tables under it for screen readers and print (§8).
	import { fmtNum } from '$lib/format/number';
	import type { UseRow } from './registeredUse';

	let {
		rows,
		axisMax,
		tolerance,
		title,
		caption,
		application
	}: {
		rows: UseRow[];
		axisMax: number;
		/** The band around 100 % counted as within, 0–1; null when not recorded. */
		tolerance: number | null;
		title: string;
		caption: string;
		/** An application report: two marks a year. */
		application: boolean;
	} = $props();

	const uid = $props.id();
	const W = 520;
	const ROW = 22;
	const LEFT = 170;
	const RIGHT = 12;
	const TOP = 6;
	const H = $derived(TOP + rows.length * ROW + 24);
	const x = (v: number) => LEFT + (Math.min(v, axisMax) / axisMax) * (W - LEFT - RIGHT);
	const y = (i: number) => TOP + i * ROW + ROW / 2;
	const ticks = $derived([0, 0.5, 1, 1.5, 2, 2.5, 3].filter((t) => t <= axisMax + 1e-9));
	/** Hollow above the row's middle, filled below, so the two runs never sit on each other. */
	const dy = (run: 'baseline' | 'application') => (application ? (run === 'baseline' ? -4 : 4) : 0);
</script>

<figure class="uplot">
	<svg viewBox="0 0 {W} {H}" role="img" aria-labelledby="{uid}-t" preserveAspectRatio="xMinYMin meet">
		<title id="{uid}-t">{title}</title>
		{#if tolerance !== null}
			<rect class="band" x={x(1 - tolerance)} y={TOP - 2} width={x(1 + tolerance) - x(1 - tolerance)} height={rows.length * ROW + 4} />
		{/if}
		<line class="hundred" x1={x(1)} x2={x(1)} y1={TOP - 2} y2={TOP + rows.length * ROW + 2} />
		{#each rows as r, i (r.key)}
			<text class="lbl" x={LEFT - 6} y={y(i) + 3.5} text-anchor="end">{r.label.length > 34 ? `${r.label.slice(0, 33)}…` : r.label}</text>
			<line class="row" x1={LEFT} x2={W - RIGHT} y1={y(i)} y2={y(i)} />
			{#each r.marks as m (`${m.run}-${m.waterYear}`)}
				{#if m.clipped}
					<path class="mark {m.run}" d="M {x(axisMax) - 6} {y(i) + dy(m.run) - 3.5} L {x(axisMax)} {y(i) + dy(m.run)} L {x(axisMax) - 6} {y(i) + dy(m.run) + 3.5} Z" />
				{:else}
					<circle class="mark {m.run}" cx={x(m.ratio)} cy={y(i) + dy(m.run)} r="3" />
				{/if}
			{/each}
		{/each}
		{#each ticks as t (t)}
			<text class="axis" x={x(t)} y={TOP + rows.length * ROW + 16} text-anchor="middle">{fmtNum(t * 100, 0)} %</text>
		{/each}
	</svg>
	<figcaption>
		{caption} Each mark is one whole water year: modelled use ÷ the registered volume{application ? '; hollow: the baseline, filled: the application' : ''}. The line is 100 %{tolerance !== null
			? `; the shaded band ±${fmtNum(tolerance * 100, 0)} % is counted as within`
			: ''}; an arrowhead is a year above {fmtNum(axisMax * 100, 0)} %. Modelled, not metered.
	</figcaption>
</figure>

<style>
	.uplot {
		margin: 0.5rem 0;
	}
	svg {
		width: 100%;
		max-width: 720px;
		height: auto;
		display: block;
	}
	.band {
		fill: var(--text);
		opacity: 0.08;
	}
	.hundred {
		stroke: var(--chart-axis);
		stroke-width: 1;
	}
	.row {
		stroke: var(--border);
		stroke-width: 0.6;
	}
	.mark {
		stroke: var(--text);
		stroke-width: 1.2;
	}
	.mark.baseline {
		fill: var(--surface);
	}
	.mark.application {
		fill: var(--text);
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
