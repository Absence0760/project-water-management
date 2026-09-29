<!--
	The data-quality panel of a fit (calibration research CR-22, engine ≥
	1.22.0): the fitted record's days by quality flag and what the fit did with
	each, the scored days' rain by source, and what the record can't support.
	How wet the scored years were is the next block's (FitPanel's "How
	representative is the record"), not repeated here (issue #174). Rows and
	words come from ./dayQuality.ts.
-->
<script lang="ts">
	import type { DayQuality } from '@water-management/engine';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { dayQualityGist, flowRows, rainRows, ratingLine } from './dayQuality';

	let { quality }: { quality: DayQuality } = $props();

	const uid = $props.id();
	const rows = $derived(flowRows(quality));
	const rain = $derived(rainRows(quality));
</script>

<section class="dq" aria-labelledby="{uid}-h" data-testid="fit-data-quality">
	<h5 id="{uid}-h">Data quality of the scored record <HelpTip key="settings.qualityFlags" /> <span class="muted gist">{dayQualityGist(quality)}</span></h5>
	<p class="small">{ratingLine(quality)} The fit scores what the flags allow; the column “Fitted, all days” scores every observed day.</p>
	<div class="tables">
		<div class="table-wrap">
			<table class="data compact">
				<caption>Observed flow in the window, by quality flag</caption>
				<thead>
					<tr><th scope="col">Flag</th><th scope="col" class="num">Days</th><th scope="col" class="num">Share</th><th scope="col">In the fit</th></tr>
				</thead>
				<tbody>
					{#each rows as r (r.label)}
						<tr><th scope="row">{r.label}</th><td class="num">{r.days}</td><td class="num">{r.share}</td><td>{r.treatment}</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if rain}
			<div class="table-wrap">
				<table class="data compact">
					<caption>Rain on the scored days</caption>
					<thead>
						<tr><th scope="col">Source</th><th scope="col" class="num">Days</th><th scope="col" class="num">Share</th></tr>
					</thead>
					<tbody>
						{#each rain as r (r.label)}
							<tr><th scope="row">{r.label}</th><td class="num">{r.days}</td><td class="num">{r.share}</td></tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
	{#if quality.notes.length}
		<ul class="notes small" aria-label="What the record can’t support">
			{#each quality.notes as n (n)}<li>{n}</li>{/each}
		</ul>
	{/if}
</section>

<style>
	h5 {
		margin: 0.75rem 0 0.25rem;
		font-size: 0.9rem;
	}
	.gist {
		font-weight: 400;
		font-size: 0.8rem;
	}
	.tables {
		display: flex;
		flex-wrap: wrap;
		gap: 0 1.5rem;
		align-items: flex-start;
	}
	caption {
		text-align: left;
		font-weight: 500;
		padding-bottom: 0.25rem;
	}
	.notes {
		margin: 0.25rem 0 0;
		padding-left: 1.1rem;
	}
	.notes li {
		margin: 0.15rem 0;
	}
</style>
