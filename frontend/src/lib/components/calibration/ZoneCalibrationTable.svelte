<!--
	Calibration zones in a run, the report and an evidence pack (issue #555 round 4, docs/ui.md § Runs & results):
	one row per zone, upstream first and the calibration site's own zone last, with its units, the parameters they
	ran on, the scores at its gauge and whether those are in sample by that zone's own fit. From an evidence pack,
	each zone's fit and its validation scores too. Rows: calibration/zoneStats.ts. Nothing when the run had no zone.
-->
<script lang="ts">
	import type { ZoneStatsRow } from '#lib/calibration/zoneStats.js';
	import HelpTip from '#lib/components/help/HelpTip.svelte';

	let {
		rows,
		headingLevel = 3
	}: {
		rows: readonly ZoneStatsRow[];
		headingLevel?: 3 | 4;
	} = $props();

	const uid = $props.id();
	const withFit = $derived(rows.some((r) => r.fit !== undefined));
</script>

{#if rows.length}
	<section class="zones" aria-labelledby="{uid}-h" data-testid="zone-calibration">
		<svelte:element this={`h${headingLevel}`} id="{uid}-h">Calibration zones <HelpTip key="calibration-zones" /></svelte:element>
		<p class="muted small">
			Each zone’s units ran on its own GR4J parameters, scored at its own gauge on its own window. Each zone’s scores are in sample only
			when that zone’s own parameters were fitted on those days.
		</p>
		<div class="table-wrap">
			<table class="data compact">
				<caption class="visually-hidden">Calibration zones, upstream first: parameters and scores at each zone’s gauge</caption>
				<thead>
					<tr>
						<th scope="col">Zone</th>
						<th scope="col" class="num">Units</th>
						<th scope="col">Parameters</th>
						<th scope="col" class="num">Days scored</th>
						<th scope="col" class="num">NSE</th>
						<th scope="col" class="num">KGE</th>
						<th scope="col" class="num">PBIAS %</th>
						<th scope="col">Scores are</th>
						{#if withFit}
							<th scope="col">Fit</th>
							<th scope="col" class="num">In sample</th>
							<th scope="col" class="num">Split-sample</th>
							<th scope="col" class="num">Dry → wet</th>
						{/if}
					</tr>
				</thead>
				<tbody>
					{#each rows as r (r.key)}
						<tr data-zone={r.key}>
							<th scope="row">{r.name}<span class="sub">{r.what}</span></th>
							<td class="num">{r.units}</td>
							<td>{r.params}</td>
							<td class="num">{r.days || '–'}</td>
							<td class="num">{r.nse}</td>
							<td class="num">{r.kge}</td>
							<td class="num">{r.pbias}</td>
							<td data-testid="zone-sample">{r.days ? (r.sample ?? 'not recorded') : 'no record in its window'}</td>
							{#if withFit}
								{#if r.fit}
									<td>{r.fit.description}</td>
									<td class="num">{r.fit.inSample}</td>
									<td class="num">{r.fit.splitSample}</td>
									<td class="num">{r.fit.dryToWet}</td>
								{:else}
									<td colspan="4" class="muted">No stored fit: not validated</td>
								{/if}
							{/if}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>
{/if}

<style>
	.zones {
		margin-top: 1rem;
	}
	.sub {
		display: block;
		font-weight: normal;
		color: var(--text-muted);
		font-size: var(--font-sm);
	}
</style>
