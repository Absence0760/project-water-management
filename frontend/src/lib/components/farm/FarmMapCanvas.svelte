<script lang="ts">
	// The farm view's small map and its key (issue #326 A3; FarmMapCard.svelte
	// loads this as a chunk of its own, so neither it nor the shared map
	// component weighs on the farm page's first load, and MapLibre is a chunk
	// further down, CatchmentMap.svelte). The words come in from the card
	// (farmMap.ts, the reader's language); the colours are the map's own
	// (mapStyle.ts overlayColours) and, for the farm's land, its band's token
	// (farmMap.ts FARM_BAND_TOKEN), read again when the app's theme changes.
	import { onMount } from 'svelte';
	import type { ModelBand } from '@water-management/engine';
	import type { FarmMapFeature } from '$lib/api/types';
	import CatchmentMap from '$lib/components/map/CatchmentMap.svelte';
	import { appIsDark, watchAppTheme } from '$lib/components/map/appTheme';
	import { overlayColours } from '$lib/components/map/mapStyle';
	import { asMapFeatures, FARM_BAND_TOKEN, farmFills, mapWords, type LegendItem } from './farmMap';

	let {
		features,
		band,
		legend,
		label,
		legendLabel,
		tilesUrl
	}: { features: FarmMapFeature[]; band: ModelBand | null; legend: LegendItem[]; label: string; legendLabel: string; tilesUrl: string | null } = $props();

	let dark = $state(appIsDark());
	let selectedId = $state<string | null>(null);
	const drawn = $derived(asMapFeatures(features));
	const colours = $derived(overlayColours(dark));
	const readToken = (token: string) => getComputedStyle(document.documentElement).getPropertyValue(token).trim();
	const fills = $derived.by(() => {
		void dark;
		return farmFills(features, band, readToken);
	});
	const landColour = $derived(band ? `var(${FARM_BAND_TOKEN[band]})` : colours.parcel);

	onMount(() => watchAppTheme(() => (dark = appIsDark())));
</script>

<div class="farm-map">
	<CatchmentMap features={drawn} {selectedId} onselect={(id) => (selectedId = selectedId === id ? null : id)} {tilesUrl} {label} {fills} words={mapWords()} />
	<ul class="legend" aria-label={legendLabel} data-testid="farm-map-legend">
		{#each legend as item (item.kind)}
			<li
				><svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
					{#if item.kind === 'farm_parcel'}
						<rect x="2" y="3" width="14" height="12" rx="2" fill={landColour} stroke={colours.casing} stroke-width="1" />
					{:else if item.kind === 'dam'}
						<circle cx="9" cy="9" r="6.5" fill={colours.water} stroke={colours.casing} stroke-width="1.5" />
					{:else if item.kind === 'gauge'}
						<path d="M9 2 L16.5 16 L1.5 16 Z" fill={colours.water} stroke={colours.casing} stroke-width="1.5" />
					{:else if item.kind === 'river'}
						<path d="M1 12 C6 4 12 14 17 6" fill="none" stroke={colours.water} stroke-width="3" />
					{:else}
						<rect x="2" y="3" width="14" height="12" fill="none" stroke={colours.boundary} stroke-width="2" stroke-dasharray="4 2" />
					{/if}
				</svg><span>{item.label}</span>
			</li>
		{/each}
	</ul>
</div>

<style>
	/* Compact on a phone: the map is a glance at where the farm is, not a workspace. */
	.farm-map :global(.map) {
		height: 280px;
		min-height: 0;
	}
	.legend {
		list-style: none;
		margin: 8px 0 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 4px 16px;
		font-size: 14px;
		color: var(--text-2);
	}
	.legend li {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.legend svg {
		flex: none;
	}
</style>
