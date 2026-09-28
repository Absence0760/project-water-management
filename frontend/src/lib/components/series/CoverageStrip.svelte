<script lang="ts">
	// One cell per year (or month for short records), shaded by the share of
	// days that carry a value: solid = complete, pale = partly missing, red
	// outline = empty. The accessible name summarises it.
	import type { CoverageBin } from './coverage';

	let { bins, label, byMonth = false }: { bins: CoverageBin[]; label: string; byMonth?: boolean } = $props();

	const gaps = $derived(bins.filter((b) => b.frac < 0.999).length);
	const empty = $derived(bins.filter((b) => b.frac === 0).length);
	const unit = $derived(byMonth ? 'month' : 'year');
	const summary = $derived(
		`${label}: ${bins.length} ${unit}${bins.length === 1 ? '' : 's'}; ${gaps === 0 ? 'no gaps' : `${gaps} with missing days${empty ? `, ${empty} empty` : ''}`}`
	);
	const tip = (b: CoverageBin) => `${b.from} → ${b.to}: ${Math.round(b.frac * 100)} % of days present`;
</script>

<svg class="strip" viewBox="0 0 {Math.max(bins.length, 1)} 1" preserveAspectRatio="none" role="img" aria-label={summary}>
	{#each bins as b, i (b.from)}
		<rect x={i + 0.06} y="0" width="0.88" height="1" class={b.frac >= 0.999 ? 'full' : b.frac === 0 ? 'none' : 'part'} style:--f={b.frac}>
			<title>{tip(b)}</title>
		</rect>
	{/each}
</svg>

<style>
	.strip {
		display: block;
		width: 100%;
		min-width: 90px;
		height: 14px;
	}
	.full {
		fill: var(--brand-outlet);
	}
	.part {
		fill: color-mix(in srgb, var(--warning) 70%, transparent);
	}
	.none {
		fill: color-mix(in srgb, var(--danger) 55%, transparent);
	}
</style>
