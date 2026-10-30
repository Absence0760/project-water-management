<!--
	Calibration locations in a run, the report and an evidence pack (issue #555 round 4; issue #659, docs/ui.md § Runs
	& results): one row per group, the headline location first, then the others upstream first, then the units on the
	catchment parameters, with its units (naming those that borrow its parameters or came by the rule for units outside
	every location), the parameters they ran on, the scores at its location and whether those are in sample by its own
	fit. From an evidence pack, each location's period, fit and validation scores too. Rows: calibration/zoneStats.ts.
	Nothing when the run had one parameter set.
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
	const withPeriod = $derived(rows.some((r) => r.period !== undefined));
</script>

{#if rows.length}
	<section class="zones" aria-labelledby="{uid}-h" data-testid="zone-calibration">
		<svelte:element this={`h${headingLevel}`} id="{uid}-h">Calibration locations <HelpTip key="calibration-zones" /></svelte:element>
		<p class="muted small">
			Each location’s units ran on its GR4J parameters, scored at that location on its own window: the headline’s scores are the calibration
			statistics above. A unit can borrow another location’s parameters. Each location’s scores are in sample only when its own parameters were
			fitted on those days.
		</p>
		<div class="table-wrap">
			<table class="data compact">
				<caption class="visually-hidden">Calibration locations, the headline first: parameters and scores at each location</caption>
				<thead>
					<tr>
						<th scope="col">Location</th>
						<th scope="col" class="num">Units</th>
						{#if withPeriod}<th scope="col">Period</th>{/if}
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
							<th scope="row">{r.name}<span class="sub">{r.what}</span>{#if r.sources}<span class="sub" data-testid="zone-sources">{r.sources}</span>{/if}</th>
							<td class="num">{r.units}</td>
							{#if withPeriod}<td>{r.period ?? '–'}</td>{/if}
							<td>{r.params}</td>
							<td class="num">{r.days || '–'}</td>
							<td class="num">{r.nse}</td>
							<td class="num">{r.kge}</td>
							<td class="num">{r.pbias}</td>
							<td data-testid="zone-sample">{!r.scored ? 'not a location: not scored' : r.days ? (r.sample ?? 'not recorded') : 'no record in its window'}</td>
							{#if withFit}
								{#if !r.scored}
									<td colspan="4" class="muted">No location: not fitted</td>
								{:else if r.fit}
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
