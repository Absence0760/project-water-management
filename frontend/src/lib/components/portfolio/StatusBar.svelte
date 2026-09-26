<script lang="ts">
	// A team's catchments by EWR status as one stacked bar, worst first, with
	// the counts written beside it ("1 red, 4 green"). The bar is decoration:
	// the words are what a screen reader (and anyone who can't tell the
	// colours apart) reads.
	import type { PortfolioEwrStatus } from '$lib/api/types';
	import { STATUS_ORDER, statusSummary } from './portfolio';

	let { counts, empty = 'No catchments yet' }: { counts: Record<PortfolioEwrStatus, number>; empty?: string } = $props();

	const total = $derived(STATUS_ORDER.reduce((n, s) => n + counts[s], 0));
	const words = $derived(statusSummary(counts));
</script>

<div class="status-bar">
	{#if total}
		<div class="bar" aria-hidden="true">
			{#each STATUS_ORDER.filter((s) => counts[s]) as s (s)}<span class="seg seg-{s}" style:flex-grow={counts[s]}></span>{/each}
		</div>
		<span class="words">{words}</span>
	{:else}
		<span class="words muted">{empty}</span>
	{/if}
</div>

<style>
	.status-bar {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		min-width: 0;
	}
	.bar {
		display: flex;
		gap: 2px;
		height: 0.55rem;
		border-radius: 999px;
		overflow: hidden;
	}
	.seg {
		flex-basis: 0;
		min-width: 0.4rem;
	}
	.seg-red {
		background: var(--danger);
	}
	.seg-amber {
		background: var(--warning);
	}
	.seg-green {
		background: var(--success);
	}
	.seg-unknown {
		background: repeating-linear-gradient(135deg, var(--border-strong) 0 3px, transparent 3px 6px);
		box-shadow: inset 0 0 0 1px var(--border-strong);
	}
	.words {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text-2);
	}
</style>
