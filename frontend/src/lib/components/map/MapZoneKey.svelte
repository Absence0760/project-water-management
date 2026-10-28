<!--
	The Map key while the areas show calibration zones (issue #555, `measure=zone`; docs/maps.md § Calibration zones
	on the map): where the zones come from, then each zone in words with its unit count and the colour the map was
	given it (`data-colour`, with its token, so a test reads the colours without the map's pixels). Its own chunk,
	loaded only when the zones are shown (MapKeyRow).
-->
<script lang="ts">
	import { unitCount, type ZoneGroup } from '#lib/calibration/zoneGroups.js';
	import { zoneLegendRows } from './mapResults';

	let { zones, colours }: { zones: readonly ZoneGroup[]; colours: Readonly<Record<string, string>> } = $props();
	const uid = $props.id();
	const rows = $derived(zoneLegendRows(zones));
</script>

<p class="small muted caption" data-testid="map-zone-caption">
	Each unit’s area in the colour of its calibration zone: the units each ticked gauge calibrates, upstream first, then the calibration site’s. From the saved settings
	(Calibration → Calibration record, Calibrate at several gauges), not a run.
</p>
<div class="legend small" role="group" aria-labelledby="{uid}-zone-h" data-testid="map-zone-legend">
	<span class="key-h" id="{uid}-zone-h">Calibration zone</span>
	<ul class="legend-items">
		{#each rows as r (r.key)}
			<li class="legend-item" data-zone={r.key} data-token={r.token} data-colour={colours[r.token]}>
				<span class="sw" style:--c={colours[r.token]} aria-hidden="true"></span>
				<span>{r.text}{' '}<span class="muted">({unitCount(r.count)})</span></span>
			</li>
		{/each}
	</ul>
</div>

<style>
	.caption {
		margin: 0;
	}
	.legend,
	.legend-items {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.25rem;
		color: var(--text-2);
	}
	.legend-item {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: baseline;
		gap: 0.35rem;
	}
	.key-h {
		font-weight: 600;
		color: var(--text);
	}
	/* The area as the map fills it (RESULT_FILL_OPACITY over the ground), outlined in the zone's own colour, as a band's. */
	.sw {
		display: inline-block;
		width: 1rem;
		height: 0.75rem;
		border: 2px solid var(--c);
		background: color-mix(in srgb, var(--c) 75%, transparent);
	}
</style>
