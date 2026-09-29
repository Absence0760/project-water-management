<script lang="ts">
	// Summary → Supply by farm (issue #17 A1): every farm's share of its
	// irrigation demand supplied in the latest run, emptiest first
	// (supplyBars.ts), amber below the target and red below the low band,
	// as the Network's supply colours. The % is always written, so colour is
	// never the only cue. It shows the emptiest few and a "Show all" that
	// opens the rest in place: the card never scrolls inside itself, and a
	// catchment's sixty units don't push the rest of the Summary a screen down. A farm's name opens its farm drawer; `more` links to
	// Units & supply for the whole picture (issue #17).
	import type { FarmSummary } from '@water-management/engine';
	import { farmDrawerHref } from '$lib/components/crops/farmDrawer';
	import { BAND_LABEL } from '$lib/components/network/supplyColour';
	import { fmtPct } from '$lib/format/number';
	import { supplyBars } from './supplyBars';

	let {
		farms,
		modelFarmIds,
		more = null
	}: {
		farms: readonly FarmSummary[];
		modelFarmIds: ReadonlySet<string>;
		/** A link after the heading to the page with the whole picture (Units & supply). */
		more?: { href: string; label: string } | null;
	} = $props();

	/** Rows shown before "Show all". */
	const FIRST = 8;
	let showAll = $state(false);

	const rows = $derived(supplyBars(farms, modelFarmIds));
	const visible = $derived(showAll ? rows : rows.slice(0, FIRST));
	const bands = $derived(new Set(rows.map((r) => r.band)));
</script>

{#if rows.length}
	<section class="panel supply" aria-labelledby="supply-h">
		<div class="head">
			<h2 id="supply-h">Supply by hydrological unit</h2>
			{#if more}<a class="small" href={more.href}>{more.label}</a>{/if}
		</div>
		<!-- What the bars and the % measure (ui-playbook § 3, "Label every chart"). -->
		<p class="what" data-testid="supply-bars-what">Share of each hydrological unit's irrigation demand supplied, latest run</p>
		<ul class="rows" id="supply-rows">
			{#each visible as r (r.nodeId)}
				<li data-farm={r.nodeId} data-band={r.band}>
					{#if r.inModel}
						<a class="name" href={farmDrawerHref(null, r.nodeId)} title="Open {r.name}’s planted areas">{r.name}</a>
					{:else}
						<span class="name">{r.name}</span>
					{/if}
					<span class="bar" aria-hidden="true"><span class="fill {r.band}" style:width="{Math.min(1, Math.max(0, r.fraction ?? 0)) * 100}%"></span></span>
					<span class="pct">{r.fraction === null ? 'no demand' : fmtPct(r.fraction, 0)}</span>
				</li>
			{/each}
		</ul>
		{#if rows.length > FIRST}
			<button type="button" class="btn btn-sm more" aria-expanded={showAll} aria-controls="supply-rows" onclick={() => (showAll = !showAll)}>
				{showAll ? `Show the ${FIRST} emptiest` : `Show all ${rows.length} hydrological units`}
			</button>
		{/if}
		{#if bands.has('short') || bands.has('low')}
			<p class="key">
				{#if bands.has('short')}<span><i class="short" aria-hidden="true"></i>{BAND_LABEL.short}</span>{/if}
				{#if bands.has('low')}<span><i class="low" aria-hidden="true"></i>{BAND_LABEL.low}</span>{/if}
			</p>
		{/if}
	</section>
{/if}

<style>
	.supply {
		margin-bottom: 0;
	}
	.head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 0 0.75rem;
		margin: 0 0 0.6rem;
	}
	h2 {
		margin: 0;
		font-size: 1.05rem;
	}
	.what {
		margin: -0.35rem 0 0.5rem;
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.head a {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
	}
	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.4rem;
	}
	li {
		display: grid;
		grid-template-columns: minmax(4rem, 7.5rem) minmax(0, 1fr) 4.5rem;
		align-items: center;
		gap: 0.6rem;
		font-size: 0.85rem;
	}
	.more {
		margin-top: 0.6rem;
	}
	.name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* At least 24 px tall, the smallest target WCAG 2.5.8 allows. */
	a.name {
		display: block;
		line-height: 1.6rem;
		text-decoration: underline;
		text-decoration-color: var(--border-strong);
		text-underline-offset: 3px;
	}
	.bar {
		height: 0.5rem;
		border-radius: 999px;
		background: var(--surface-2);
		box-shadow: inset 0 0 0 1px var(--border);
		overflow: hidden;
	}
	.fill {
		display: block;
		height: 100%;
		background: var(--accent);
	}
	.fill.short,
	.key .short {
		background: var(--warning);
	}
	.fill.low,
	.key .low {
		background: var(--danger);
	}
	.pct {
		text-align: right;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	li[data-band='none'] .pct {
		color: var(--text-muted);
	}
	.key {
		display: flex;
		flex-wrap: wrap;
		gap: 0.2rem 0.9rem;
		margin: 0.6rem 0 0;
		font-size: 0.78rem;
		color: var(--text-muted);
	}
	.key i {
		display: inline-block;
		width: 0.7rem;
		height: 0.7rem;
		border-radius: 2px;
		margin-right: 0.3rem;
		vertical-align: -0.05rem;
	}
	@media (max-width: 640px) {
		li {
			min-height: 44px;
		}
		a.name {
			padding: 0.6rem 0;
		}
	}
	@media (forced-colors: active) {
		.bar {
			border: 1px solid CanvasText;
		}
		.fill {
			background: CanvasText;
		}
	}
</style>
