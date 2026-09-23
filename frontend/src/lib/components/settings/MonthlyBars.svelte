<script lang="ts">
	// Small bar chart of 12 water-year monthly values (Oct → Sep), e.g. the
	// pragmatic EWR or A-pan evaporation. Decorative: the table beside it holds
	// the same numbers.
	import { fmtNum } from '$lib/format/number';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';

	let { values, unit, label }: { values: number[]; unit: string; label: string } = $props();

	const W = 360;
	const H = 110;
	const PAD_B = 16;
	const max = $derived(Math.max(1e-9, ...values.map((v) => v || 0)));
	const bw = W / 12;
</script>

<svg viewBox="0 0 {W} {H}" class="bars" role="img" aria-label="{label} by month (the table holds the values)">
	{#each values as v, i (i)}
		{@const h = ((v || 0) / max) * (H - PAD_B - 14)}
		<g>
			<title>{WATER_YEAR_MONTHS[i]}: {fmtNum(v, v < 10 ? 2 : 0)} {unit}</title>
			<rect x={i * bw + 3} y={H - PAD_B - h} width={bw - 6} height={Math.max(h, v > 0 ? 1 : 0)} rx="2" />
			<text x={i * bw + bw / 2} y={H - 3} class="m">{WATER_YEAR_MONTHS[i]![0]}</text>
		</g>
	{/each}
	<line x1="0" x2={W} y1={H - PAD_B} y2={H - PAD_B} class="base" />
	<text x="2" y="10" class="max">max {fmtNum(max, max < 10 ? 2 : 0)} {unit}</text>
</svg>

<style>
	.bars {
		width: 100%;
		max-width: 420px;
		height: auto;
		display: block;
	}
	rect {
		fill: var(--brand-outlet);
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
</style>
