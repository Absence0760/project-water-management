<!--
	"Nearest gauging stations" (issue #326 Part B "B-gauge"; docs/ui.md § Data
	feeds, docs/maps.md § Gauging stations): inside the Attach-a-feed form when
	the source is DWS, the river gauges nearest the catchment's outlet (the
	outflow gauge's point on the map, else the boundary's centre), each with its
	distance, river, record and source. "Use" only fills the station field
	(`onuse`); the owner still attaches the feed. Reads GET …/map/stations.
-->
<script lang="ts">
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { onMount } from 'svelte';
	import { api } from '$lib/api';
	import type { GaugeStationLookup } from '$lib/api/types';
	import { errorText } from './feeds';
	import { distanceText, emptyLine, pointLine, recordText } from './nearestGauges';

	let { projectId, current, onuse }: { projectId: string; current: string; onuse: (code: string) => void } = $props();

	const uid = $props.id();
	let lookup = $state<GaugeStationLookup | null>(null);
	let loadError = $state<string | null>(null);
	const synthetic = $derived(lookup?.stations.some((s) => s.synthetic) ?? false);

	onMount(async () => {
		try {
			lookup = await api.map.stations(projectId);
		} catch (e) {
			loadError = errorText(e);
		}
	});
</script>

<section class="nearest" aria-labelledby="{uid}-h" data-testid="nearest-gauges" data-ready={lookup || loadError ? 'true' : undefined}>
	<div class="head">
		<h4 id="{uid}-h">Nearest gauging stations <HelpTip key="dws-flow" label="About DWS gauges and the nearest stations" /></h4>
		{#if synthetic}<span class="badge badge-warn" title="The server's station list is the repository's invented sample, not DWS's catalogue">Sample stations</span>{/if}
	</div>
	{#if loadError}
		<p class="muted small" role="alert">Couldn’t look up the nearest stations: {loadError}</p>
	{:else if !lookup}
		<p class="muted small" role="status">Looking up the nearest stations…</p>
	{:else}
		<p class="muted small" data-testid="nearest-gauges-point">{pointLine(lookup)}</p>
		{#if emptyLine(lookup)}
			<p class="muted small">{emptyLine(lookup)}</p>
		{/if}
		{#if lookup.stations.length}
			<div class="table-wrap">
				<table class="data" aria-labelledby="{uid}-h" data-testid="nearest-gauges-table">
					<thead>
						<tr>
							<th scope="col">Station</th>
							<th scope="col">River</th>
							<th scope="col" class="num">Distance</th>
							<th scope="col">Record</th>
							<th scope="col"><span class="visually-hidden">Use</span></th>
						</tr>
					</thead>
					<tbody>
						{#each lookup.stations as s (s.code)}
							<tr data-code={s.code}>
								<th scope="row">
									<strong>{s.code}</strong>{#if s.name}{' '}{s.name}{/if}
									<span class="src muted">{s.source}</span>
								</th>
								<td>{s.river || '–'}</td>
								<td class="num">{distanceText(s.distanceKm)}</td>
								<td>{recordText(s)}</td>
								<td>
									{#if current.trim().toUpperCase() === s.code}
										<span class="chosen">In the field</span>
									{:else}
										<button type="button" class="btn btn-sm" aria-label="Use {s.code}" onclick={() => onuse(s.code)}>Use</button>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<p class="muted small">“Use” fills in the station below. Check the record covers the years you calibrate on, then attach the feed.</p>
		{/if}
	{/if}
</section>

<style>
	.nearest {
		margin: 0.5rem 0 0.75rem;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		align-items: baseline;
	}
	h4 {
		margin: 0 0 0.25rem;
		font-size: 0.9rem;
	}
	.nearest p {
		margin: 0.2rem 0;
		max-width: 75ch;
	}
	.src {
		display: block;
		font-weight: 400;
		font-size: 0.75rem;
		max-width: 40ch;
	}
	.chosen {
		font-size: 0.8rem;
		color: var(--text-2);
		white-space: nowrap;
	}
	.small {
		font-size: 0.8rem;
	}
</style>
