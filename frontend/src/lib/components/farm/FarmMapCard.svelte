<!-- i18n-section: farm.map -->
<script lang="ts">
	// "Your hydrological unit on the map" (issue #326 A3, decision D-A1/A3;
	// docs/ui.md § Farmer view): the farm's own land and dam, with the
	// boundary, rivers and gauges to find the way, from GET …/farm/:nodeId/map.
	// Nothing at all when the farm has no land or dam on the map. Everything
	// the map shows is said in words first (farmMap.ts farmMapCard); the map
	// itself is a chunk of its own (FarmMapCanvas.svelte), loaded only once
	// there is something to draw. The card is ready (data-ready) once the map
	// has drawn or said why it can't (no WebGL), or its chunk failed: the
	// page's own ready state doesn't wait for the map, which draws after it.
	// It draws without basemap tiles too: only the farm's features, on the
	// plain background the note under the lines describes.
	import { PUBLIC_TILES_URL } from '$app/env/public';
	import type { FarmProjection } from '@water-management/engine';
	import { api, type FarmMapFeature } from '#lib/api/index.js';
	import ChunkFailed from '#lib/components/common/ChunkFailed.svelte';
	import Rich from '#lib/i18n/Rich.svelte';
	import { t } from '#lib/i18n/locale.svelte.js';
	import { farmMapCard, showsMap } from './farmMap';

	let { projectId, farm }: { projectId: string; farm: FarmProjection } = $props();

	const tilesUrl = PUBLIC_TILES_URL?.trim() || null;
	let features = $state<FarmMapFeature[] | null>(null);
	let failed = $state(false);
	/** The map's own state: 'loading' until it has drawn ('ready'), or can't ('failed'); a failed chunk is settled too. */
	let mapStatus = $state<'loading' | 'ready' | 'failed'>('loading');
	// The farm's id alone, so a refreshed view of the same farm doesn't fetch the map again.
	const nodeId = $derived(farm.nodeId);

	$effect(() => {
		const [p, n] = [projectId, nodeId];
		let live = true;
		features = null;
		failed = false;
		mapStatus = 'loading';
		api.farm.map(p, n).then(
			(r) => {
				if (live) features = r.features;
			},
			() => {
				if (live) failed = true;
			}
		);
		return () => {
			live = false;
		};
	});

	/** The map's chunk, loaded once; a failed load settles the card (its ChunkFailed line says so) and is tried again next time. */
	let canvasChunk: Promise<typeof import('./FarmMapCanvas.svelte')> | null = null;
	function canvas() {
		canvasChunk ??= import('./FarmMapCanvas.svelte').catch((err: unknown) => {
			canvasChunk = null;
			mapStatus = 'failed';
			throw err;
		});
		return canvasChunk;
	}

	const vm = $derived(features && showsMap(features) ? farmMapCard(features, farm) : null);
</script>

{#if failed}
	<p class="fine" role="status" data-testid="farm-map-failed">{t('The map of your hydrological unit could not be loaded. Check your connection, then reload the page.')}</p>
{:else if vm && features}
	<section class="card" aria-labelledby="map-h" data-testid="farm-map" data-ready={mapStatus !== 'loading'}>
		<h2 id="map-h">{vm.heading}</h2>
		<p>{vm.about}</p>
		{#if vm.status}<p><Rich text={vm.status} /></p>{/if}
		<ul class="lines" data-testid="farm-map-lines">
			{#each vm.lines as line, i (i)}<li>{line}</li>{/each}
		</ul>
		<p class="fine">{vm.place}</p>
		{#if !tilesUrl}<p class="fine">{t('There is no background map here, so only these are drawn.')}</p>{/if}
		{#await canvas() then { default: FarmMapCanvas }}
			<FarmMapCanvas {features} band={farm.river.band} legend={vm.legend} label={vm.label} legendLabel={t('Key')} {tilesUrl} onstatus={(s) => (mapStatus = s)} />
		{:catch}
			<ChunkFailed text={t('The map could not be loaded. Check your connection, then reload the page.')} reload={t('Reload page')} />
		{/await}
	</section>
{/if}

<style>
	.lines {
		margin: 0;
		padding-left: 20px;
	}
</style>
