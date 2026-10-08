<script lang="ts">
	// The project list's "Needs attention" strip (issue #17, docs/ui.md §
	// Project list): the catchments to look at first, most urgent first, each
	// with its reasons in words (outcomes.ts `attention`). Up to four cards
	// (fewer on a narrow page); the rest are a sort away. Colour repeats the
	// words, never replaces them.
	import { base } from '$app/paths';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import type { Flagged } from './outcomes';

	let {
		flagged,
		loading,
		failed,
		shown,
		allHref
	}: {
		flagged: Flagged[];
		loading: boolean;
		failed: boolean;
		/** Catchments in view (the owner filter and search applied). */
		shown: number;
		/** The list sorted by Needs attention first. */
		allHref: string;
	} = $props();

	const CARDS = 4;
	const cards = $derived(flagged.slice(0, CARDS));
	const more = $derived(flagged.length - cards.length);
</script>

<section class="attention" aria-labelledby="att-h-t" aria-busy={loading}>
	<div class="head">
		<h2 id="att-h"><span id="att-h-t">Needs attention</span> <HelpTip key="needs-attention" /></h2>
		{#if !loading && !failed}
			<span class="count" data-testid="attention-count">{flagged.length} of {shown}</span>
			{#if flagged.length}<a class="all" href={allHref} data-sveltekit-noscroll data-sveltekit-keepfocus
					>{more > 0 ? `Show all ${flagged.length}, most urgent first` : 'Sort the list by it'}</a
				>{/if}
		{/if}
	</div>
	{#if loading}
		<p class="line muted">Checking each catchment’s latest figures…</p>
	{:else if failed}
		<p class="line muted">The catchments’ figures couldn’t be loaded, so nothing is flagged. Reload the page to try again.</p>
	{:else if !flagged.length}
		<p class="line ok">
			Nothing needs attention: no EWR red or amber, no hydrological units short in their figures’ last week, no alerts firing, no failing feeds and no stale
			figures.
		</p>
	{:else}
		<ul class="cards">
			{#each cards as f (f.project.id)}
				{@const top = f.attention.reasons[0]!}
				<li class="card tone-{top.tone}">
					<a class="name" href="{base}/projects/{f.project.id}">{f.project.name}</a>
					<ul class="reasons">
						{#each f.attention.reasons.slice(0, 3) as r (r.text)}
							<li class="reason r-{r.tone}">{#if r.href}<a href={r.href}>{r.text}</a>{:else}{r.text}{/if}</li>
						{/each}
						{#if f.attention.reasons.length > 3}<li class="reason muted">and {f.attention.reasons.length - 3} more</li>{/if}
					</ul>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.attention {
		container: attention / inline-size;
		margin-bottom: 0.75rem;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.25rem 0.6rem;
		margin-bottom: 0.4rem;
	}
	h2 {
		font-size: 0.95rem;
		margin: 0;
	}
	.count {
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
	.all {
		margin-left: auto;
		font-size: 0.85rem;
	}
	.line {
		margin: 0;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		font-size: 0.875rem;
	}
	.ok {
		border-color: color-mix(in srgb, var(--success) 40%, transparent);
		background: var(--success-soft);
		color: var(--success);
	}
	.cards {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 0.6rem;
	}
	.card {
		min-width: 0;
		padding: 0.55rem 0.75rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-left-width: 4px;
		border-radius: var(--radius);
	}
	.tone-danger {
		border-left-color: var(--danger);
	}
	.tone-warn {
		border-left-color: var(--warning);
	}
	.name {
		display: block;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.reasons {
		list-style: none;
		margin: 0.25rem 0 0;
		padding: 0;
		font-size: 0.82rem;
	}
	.reason + .reason {
		margin-top: 0.1rem;
	}
	.r-danger,
	.r-danger a {
		color: var(--danger);
		font-weight: 600;
	}
	.r-warn {
		color: var(--warning);
	}
	/* Two cards a row on a mid-width page, one on a phone (and only the first three there). */
	@container attention (max-width: 760px) {
		.cards {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	@container attention (max-width: 460px) {
		.cards {
			grid-template-columns: minmax(0, 1fr);
		}
		.card:nth-child(n + 4) {
			display: none;
		}
	}
</style>
