<!--
	A run's "Rain gaps filled from other products" (engine ≥ 1.101.0, issue
	#604, docs/model.md §2.4b *Gap-filling product*; docs/ui.md § Calibration):
	what settings.gapRain chose, each product's (and IMERG version's) days,
	rain as read and as used and its fit, its double-mass breaks, the runs of
	days each filled with IMERG's version (summary.gapRain.segments, the
	per-day rain_source codes 5 and 6), and the credits their values carry.
	Shown when the summary carries summary.gapRain. Its own chunk.
-->
<script lang="ts">
	import { waterYearLabel, type GapRainInfo, type RainCredit } from '@water-management/engine';
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import { fmtDay, fmtNum } from '#lib/format/number.js';
	import { gapRainChoiceText } from '#lib/components/series/gapRain.js';

	let { info, credits = [] }: { info: GapRainInfo; credits?: readonly RainCredit[] } = $props();

	const uid = $props.id();
	const FOLD = 8;
	let allSegments = $state(false);
	const segments = $derived(allSegments ? info.segments : info.segments.slice(0, FOLD));
	const breaks = (p: GapRainInfo['products'][number]) =>
		p.doubleMass ? p.doubleMass.breaks.map((b) => `after ${waterYearLabel(b.afterWaterYear)} (${b.slopeBefore.toFixed(2)} → ${b.slopeAfter.toFixed(2)})`).join('; ') || 'none' : 'not checked';
</script>

<section aria-labelledby="{uid}-h" data-testid="run-gap-rain">
	<h3 id="{uid}-h">Rain gaps filled from other products <HelpTip key="settings.gapRain" /></h3>
	<p class="muted small">
		Blank catchment-rain days took {gapRainChoiceText(info)}; CHIRPS filled {fmtNum(info.chirpsDays)} of them.{#if info.imergLate && info.tailFrom}
			IMERG Late could fill from {fmtDay(info.tailFrom)}, the day after the last reading of the products before it.{/if} Each product is corrected to the catchment rain on its
		own fit; these choices are provisional, pending the hydrologist’s review.
	</p>
	<div class="table-wrap">
		<table class="data compact">
			<caption class="visually-hidden">Each gap-filling product: the days it filled and its rain</caption>
			<thead>
				<tr>
					<th scope="col">Product</th>
					<th scope="col" class="num">Days filled</th>
					<th scope="col" class="num">As read<br /><span class="u">mm</span></th>
					<th scope="col" class="num">Used<br /><span class="u">mm</span></th>
					<th scope="col" class="num">Pooled factor<br /><span class="u">×</span></th>
					<th scope="col">Double-mass breaks</th>
				</tr>
			</thead>
			<tbody>
				{#each info.products as p (p.key)}
					<tr>
						<th scope="row">{p.label}{#if !p.present}<span class="muted"> (none in the run’s input)</span>{/if}</th>
						<td class="num">{fmtNum(p.days)}</td>
						<td class="num">{fmtNum(p.rawMm, 1)}</td>
						<td class="num">{fmtNum(p.mm, 1)}</td>
						<td class="num">{p.correction?.pooled.factor == null ? '–' : fmtNum(p.correction.pooled.factor, 2)}</td>
						<td>{breaks(p)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	{#if info.segments.length}
		<h4>Which product filled which days</h4>
		<ul class="segments" data-testid="run-gap-rain-segments">
			{#each segments as s (`${s.from}-${s.product}-${s.version}`)}
				<li>{fmtDay(s.from)}{s.to !== s.from ? ` – ${fmtDay(s.to)}` : ''}: {s.product === 'era5l' ? 'ERA5-Land' : `IMERG Late ${s.version ?? ''}`.trim()}</li>
			{/each}
		</ul>
		{#if info.segments.length > FOLD}
			<button type="button" class="btn btn-sm" aria-expanded={allSegments} onclick={() => (allSegments = !allSegments)}>
				{allSegments ? `Show only the first ${FOLD} runs of days` : `Show all ${info.segments.length} runs of days`}
			</button>
		{/if}
	{/if}
	{#if credits.length}
		<ul class="credits muted" data-testid="run-gap-rain-credits" aria-label="Rain data credits">
			{#each credits as c (c.product)}{#each c.lines as l (l)}<li><strong>{c.name}:</strong> {l}</li>{/each}{/each}
		</ul>
	{/if}
</section>

<style>
	h3 {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		margin: 0 0 0.4rem;
	}
	h4 {
		font-size: 0.9rem;
		margin: 0.75rem 0 0.3rem;
	}
	.segments {
		margin: 0;
		padding-left: 1.1rem;
		font-size: 0.875rem;
	}
	.credits {
		margin: 0.75rem 0 0;
		padding-left: 1.1rem;
		font-size: var(--font-sm);
		max-width: 100ch;
	}
</style>
