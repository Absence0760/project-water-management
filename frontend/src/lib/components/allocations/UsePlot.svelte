<script lang="ts">
	// The over/under-use chart (WP-3.10): the Allocations tab's (docs/ui.md
	// § Allocations) and the evidence report's § 5 (docs/allocations.md § In the
	// evidence report). One row per unit and water source, one mark per whole
	// water year at modelled use ÷ the registered volume; hollow for the
	// baseline (the tab's one run), filled for the application; a line at 100 %
	// and the tolerance band shaded behind it. One neutral hue: which side of
	// the band a mark falls on is read from its position, never a colour (G15).
	// An SVG with a <title> and a <desc> counting the years above the band
	// (every row's, when `allRows` folds it); the
	// same numbers are in the tables beside it for screen readers and print
	// (§8). `fit` (the tab) draws it at the width of its box, px for px, so its
	// text stays 11 px on a phone, where each row's label takes its own line;
	// the report's is a fixed 520-unit drawing scaled to the page, never
	// under 549 px (its 9 px text at 9.5 px), scrolling sideways on a phone.
	// Each label's full text and each mark's year and share are its tooltip.
	import { fmtNum } from '$lib/format/number';
	import { distinctShortNames } from '$lib/components/network/schematic';
	import { waterYearLabel } from './allocations';
	import { useSummary, type UseRow } from './usePlot';

	let {
		rows,
		axisMax,
		tolerance,
		title,
		caption,
		application,
		fit = false,
		allRows
	}: {
		rows: UseRow[];
		axisMax: number;
		/** The band around 100 % counted as within, 0–1; null when not recorded. */
		tolerance: number | null;
		title: string;
		caption: string;
		/** An application report: two marks a year. */
		application: boolean;
		/** Draw at the box's width (on screen), not a fixed drawing scaled to it (print). */
		fit?: boolean;
		/** Every row when `rows` is folded to the first few: the description counts them all and says how many are drawn. */
		allRows?: UseRow[];
	} = $props();

	const uid = $props.id();
	let boxW = $state(0);
	const W = $derived(fit ? Math.max(260, Math.round(boxW) || 0) : 520);
	/** Narrow (a phone): each row's label on its own line above its marks. */
	const stacked = $derived(fit && W < 480);
	const FONT = $derived(fit ? 11 : 9);
	const ROW = $derived(stacked ? 38 : fit ? 26 : 22);
	const LEFT = $derived(stacked ? 10 : fit ? Math.min(240, Math.round(W * 0.3)) : 170);
	const RIGHT = $derived(fit ? 16 : 12);
	const TOP = 6;
	/** The characters a label keeps before it is cut ("…"); the full name is in the table. */
	const labelMax = $derived(stacked ? Math.floor((W - 10) / (FONT * 0.6)) : fit ? Math.floor((LEFT - 8) / (FONT * 0.6)) : 34);
	const H = $derived(TOP + rows.length * ROW + FONT + 15);
	const x = (v: number) => LEFT + (Math.min(v, axisMax) / axisMax) * (W - LEFT - RIGHT);
	/** A row's marks: at its foot when stacked (the label above), else level with its label. */
	const y = (i: number) => TOP + i * ROW + (stacked ? ROW - 10 : ROW / 2);
	const labelY = (i: number) => (stacked ? TOP + i * ROW + FONT + 2 : y(i) + FONT * 0.38);
	const ticks = $derived([0, 0.5, 1, 1.5, 2, 2.5, 3].filter((t) => t <= axisMax + 1e-9));
	/** Hollow above the row's middle, filled below, so the two runs never sit on each other. */
	const dy = (run: 'baseline' | 'application') => (application ? (run === 'baseline' ? -4 : 4) : 0);
	/**
	 * Each row's label cut to fit: the name loses its end, unless that reads like another's (then its ending stays,
	 * `distinctShortNames`), and the source is always whole, so a unit's two rows stay apart. The full label is its
	 * tooltip and in the table.
	 */
	const shown = $derived.by(() => {
		const room = Math.max(8, labelMax - Math.max(0, ...rows.map((r) => r.suffix.length)));
		const names = distinctShortNames(
			rows.map((r) => r.name),
			room
		);
		return rows.map((r, i) => `${names[i]}${r.suffix}`);
	});
	const markTitle = (m: UseRow['marks'][number]) =>
		`${waterYearLabel(m.waterYear)}${application ? (m.run === 'baseline' ? ', baseline' : ', application') : ''}: ${m.clipped ? `above ${fmtNum(axisMax * 100, 0)} %, at ${fmtNum(m.ratio * 100, 0)} %` : `${fmtNum(m.ratio * 100, 0)} %`} of the registered volume`;
	/** Stacked (a phone), the band and the 100 % line are drawn in each row's strip only, never through its label. */
	const strips = $derived(stacked ? rows.map((_, i) => ({ y: y(i) - 8, h: 16 })) : [{ y: TOP - 2, h: rows.length * ROW + 4 }]);
	const summary = $derived.by(() => {
		const all = allRows ?? rows;
		const drawn = all.length > rows.length ? ` The chart draws the first ${fmtNum(rows.length)} of ${fmtNum(all.length)} units and water sources.` : '';
		return useSummary(all, tolerance, application) + drawn;
	});
</script>

<figure class="uplot" class:fit bind:clientWidth={boxW} data-testid="use-plot" data-width={fit ? W : undefined}>
	<!-- A scroll box a keyboard can scroll (axe scrollable-region-focusable), as the preview tables. -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div class="scroll" class:fixed={!fit} tabindex={fit ? undefined : 0} role={fit ? undefined : 'region'} aria-label={fit ? undefined : title}>
	<svg viewBox="0 0 {W} {H}" role="img" aria-labelledby="{uid}-t" aria-describedby="{uid}-d" preserveAspectRatio="xMinYMin meet" style:font-size="{FONT}px">
		<title id="{uid}-t">{title}</title>
		<desc id="{uid}-d">{summary}</desc>
		{#each strips as st, k (k)}
			{#if tolerance !== null}
				<rect class="band" x={x(1 - tolerance)} y={st.y} width={x(1 + tolerance) - x(1 - tolerance)} height={st.h} />
			{/if}
			<line class="hundred" x1={x(1)} x2={x(1)} y1={st.y} y2={st.y + st.h} />
		{/each}
		{#each rows as r, i (r.key)}
			<text class="lbl" x={stacked ? LEFT : LEFT - 6} y={labelY(i)} text-anchor={stacked ? 'start' : 'end'}><title>{r.label}</title>{shown[i]}</text>
			<line class="row" x1={LEFT} x2={W - RIGHT} y1={y(i)} y2={y(i)} />
			{#each r.marks as m (`${m.run}-${m.waterYear}`)}
				{#if m.clipped}
					<path class="mark {m.run}" d="M {x(axisMax) - 6} {y(i) + dy(m.run) - 3.5} L {x(axisMax)} {y(i) + dy(m.run)} L {x(axisMax) - 6} {y(i) + dy(m.run) + 3.5} Z"><title>{markTitle(m)}</title></path>
				{:else}
					<circle class="mark {m.run}" cx={x(m.ratio)} cy={y(i) + dy(m.run)} r={fit ? 3.5 : 3}><title>{markTitle(m)}</title></circle>
				{/if}
			{/each}
		{/each}
		{#each ticks as t (t)}
			<text class="axis" x={x(t)} y={TOP + rows.length * ROW + FONT + 7} text-anchor={t === 0 && stacked ? 'start' : 'middle'}>{fmtNum(t * 100, 0)} %</text>
		{/each}
	</svg>
	</div>
	<figcaption>
		{caption} Each mark is one whole water year: modelled use ÷ the registered volume{application ? '; hollow: the baseline, filled: the application' : ''}. The line is 100 %{tolerance !== null
			? `; the shaded band ±${fmtNum(tolerance * 100, 0)} % is counted as within`
			: ''}; an arrowhead is a year above {fmtNum(axisMax * 100, 0)} %. Modelled, not metered.
	</figcaption>
</figure>

<style>
	.uplot {
		margin: 0.5rem 0;
		min-width: 0;
	}
	svg {
		width: 100%;
		max-width: 720px;
		height: auto;
		display: block;
	}
	/* The fixed drawing (the report) never draws its 9 px text under 9.5 px (520 × 9.5 / 9 = 549 px); narrower, as on a
	   phone, it scrolls sideways (ui-playbook § 3 "Never cut off, never too small"). */
	.fixed {
		overflow-x: auto;
	}
	.fixed svg {
		min-width: 549px;
	}
	@media print {
		.fixed {
			overflow: visible;
		}
		.fixed svg {
			min-width: 0;
		}
	}
	.fixed:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	/* On screen, drawn at the box's width, px for px (up to 900 px, past which the rows get too long to follow). */
	.fit {
		max-width: 900px;
	}
	.fit svg {
		max-width: none;
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
		fill: var(--text-muted);
	}
	/* On screen a halo in the ground's colour behind each label; not in print, where Chromium prints stroked text twice. */
	.fit .lbl {
		paint-order: stroke fill;
		stroke: var(--surface);
		stroke-width: 3px;
		stroke-linejoin: round;
	}
	figcaption {
		font-size: 0.8rem;
		color: var(--text-muted);
		max-width: 72ch;
	}
</style>
