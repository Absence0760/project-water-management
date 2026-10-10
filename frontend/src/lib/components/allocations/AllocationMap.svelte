<!--
	The Allocations tab's map (issue #510, docs/allocations.md § The map): each
	hydrological unit's polygon (its linked farm_parcel on the Map tab, docs/maps.md
	§ Hydrological units layer) shaded by its band of modelled use ÷ registered
	volume (useMap.ts). This component is a dynamic import of AllocationsTab, and
	MapLibre a dynamic import of it (map/maplibre.ts, as CatchmentMap loads it),
	so neither weighs on the tab until the map is opened. The basemap is the Map
	tab's own (mapStyle.ts basemapStyle); it follows the app's theme.
	Each unit carries its % of registered as a button over its polygon (≥ 24 px,
	focusable, named with its figures): colour is never the only cue, and a
	click or Enter opens its comparison (`onpick`). Without WebGL the map says
	so and the list under it carries every unit.
-->
<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { appIsDark, watchAppTheme } from '$lib/components/map/appTheme';
	import { basemapLayerIds, basemapStyle, labelLayers, type Style } from '$lib/components/map/mapStyle';
	import { bandColours, HATCH_IMAGE, hatchPixels, useBounds, useLayers, useMapData, useSentence, USE_SOURCE_ID, type UseShading } from './useMap';

	let {
		shading,
		tilesUrl,
		glyphs = null,
		picked = null,
		period,
		onpick
	}: {
		shading: UseShading;
		/** The PMTiles basemap's URL; empty = a plain background. */
		tilesUrl: string | null;
		/** The glyphs URL (mapStyle.ts glyphsUrl): the basemap's place names. Null: none. */
		glyphs?: string | null;
		/** The unit whose comparison is open: its label is pressed. */
		picked?: string | null;
		/** The period in words ("the mean of 3 whole water years"), for each label's accessible name. */
		period: string;
		onpick: (nodeId: string) => void;
	} = $props();

	let el: HTMLDivElement;
	let status = $state<'loading' | 'ready' | 'failed'>('loading');
	let tilesNote = $state(false);
	let dark = $state(typeof matchMedia === 'function' && typeof document !== 'undefined' && appIsDark());
	type Lib = typeof import('$lib/components/map/maplibre');
	let lib: Lib | null = null;
	let map: InstanceType<Lib['MapLibreMap']> | null = null;
	const markers = new Map<string, { marker: InstanceType<Lib['Marker']>; button: HTMLButtonElement; key: string }>();
	/** South Africa, before there is anything to frame. */
	const SA: [[number, number], [number, number]] = [
		[16.3, -35],
		[33, -22]
	];
	const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

	function styleNow(): Style {
		const base = basemapStyle(tilesNote ? null : tilesUrl, dark);
		const style: Style = {
			...base,
			sources: { ...base.sources, [USE_SOURCE_ID]: { type: 'geojson', data: useMapData(shading) } },
			layers: [...base.layers, ...useLayers(dark), ...(glyphs && tilesUrl && !tilesNote ? labelLayers(dark) : [])]
		};
		if (glyphs && tilesUrl && !tilesNote) style.glyphs = glyphs;
		return style;
	}

	/** Each unit's label, a button at a point inside its polygon. */
	function syncMarkers() {
		if (!map || !lib) return;
		const colours = bandColours(dark);
		const units = [...shading.drawn.map((u) => ({ ...u, notInRun: false })), ...shading.notInRun.map((u) => ({ ...u, use: null, band: null, label: 'Not in this run', notInRun: true }))];
		const keep = new Set(units.filter((u) => u.at).map((u) => u.nodeId));
		for (const [id, m] of markers)
			if (!keep.has(id)) {
				m.marker.remove();
				markers.delete(id);
			}
		for (const u of units) {
			if (!u.at) continue;
			const c = u.band ? colours[u.band] : colours.none;
			const name = u.notInRun ? `${u.name}: not in this run (added since it ran)` : useSentence(u.name, u.use, period);
			const key = `${u.label}|${name}|${u.at.join(',')}|${c.fill}|${c.text}|${u.band}`;
			const had = markers.get(u.nodeId);
			if (had && had.key === key) {
				had.button.setAttribute('aria-pressed', String(u.nodeId === picked));
				continue;
			}
			had?.marker.remove();
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'use-label';
			button.textContent = u.label;
			button.dataset.node = u.nodeId;
			button.dataset.band = u.notInRun ? 'notinrun' : (u.band ?? 'nodata');
			button.setAttribute('aria-label', name);
			button.title = name;
			button.style.setProperty('--band-fill', u.band && u.band !== 'none' ? c.fill : 'var(--surface)');
			button.style.setProperty('--band-text', u.band && u.band !== 'none' ? c.text : 'var(--text)');
			if (u.notInRun) button.disabled = true;
			else {
				button.setAttribute('aria-pressed', String(u.nodeId === picked));
				button.addEventListener('click', (e) => {
					e.stopPropagation();
					onpick(u.nodeId);
				});
			}
			const marker = new lib.Marker({ element: button }).setLngLat(u.at as [number, number]).addTo(map);
			markers.set(u.nodeId, { marker, button, key });
		}
	}

	function syncData() {
		if (!map || status !== 'ready') return;
		(map.getSource(USE_SOURCE_ID) as { setData?: (d: unknown) => void } | undefined)?.setData?.(useMapData(shading));
		syncMarkers();
	}

	onMount(() => {
		let disposed = false;
		let stopTheme: (() => void) | null = null;
		(async () => {
			try {
				lib = await import('$lib/components/map/maplibre');
				if (tilesUrl) await lib.usePmtiles();
				if (disposed) return;
				const style = styleNow();
				const m = new lib.MapLibreMap({
					container: el,
					style: style as never,
					attributionControl: false,
					bounds: useBounds(shading) ?? SA,
					fitBoundsOptions: { padding: 48, maxZoom: 13 },
					keyboard: true,
					dragRotate: false,
					pitchWithRotate: false,
					touchPitch: false
				});
				map = m;
				m.addControl(new lib.NavigationControl({ showCompass: false }), 'top-right');
				// Always expanded: the basemap's licence must stay visible.
				m.addControl(new lib.AttributionControl({ compact: false }), 'bottom-right');
				// The hatching, whenever a style (the first, or a theme switch's) asks for it.
				m.on('styleimagemissing', (e: { id?: string }) => {
					if (e.id === HATCH_IMAGE && !m.hasImage(HATCH_IMAGE)) m.addImage(HATCH_IMAGE, hatchPixels(dark));
				});
				m.on('error', (ev) => {
					const e = ev as unknown as { sourceId?: string; error?: { message?: string } };
					if (e.sourceId === 'basemap' && !tilesNote) {
						tilesNote = true;
						for (const id of basemapLayerIds(style)) if (m.getLayer(id)) m.removeLayer(id);
					} else if (/webgl/i.test(e.error?.message ?? '')) status = 'failed';
				});
				let drawnDark = dark;
				stopTheme = watchAppTheme(() => {
					dark = appIsDark();
					if (dark === drawnDark || disposed) return;
					drawnDark = dark;
					if (m.hasImage(HATCH_IMAGE)) m.removeImage(HATCH_IMAGE);
					m.setStyle(styleNow() as never);
					untrack(syncMarkers);
				});
				m.on('load', () => {
					status = 'ready';
					syncMarkers();
				});
			} catch {
				if (!disposed) status = 'failed';
			}
		})();
		return () => {
			disposed = true;
			stopTheme?.();
			for (const m of markers.values()) m.marker.remove();
			markers.clear();
			map?.remove();
			map = null;
		};
	});

	// A new source, period or run: new shading. Reframe only when the polygons themselves change.
	let framed = '';
	$effect(() => {
		void shading;
		void period;
		void status;
		untrack(syncData);
		const b = useBounds(shading);
		const sig = JSON.stringify(b);
		if (map && status === 'ready' && b && sig !== framed) {
			if (framed) map.fitBounds(b, { padding: 48, maxZoom: 13, animate: !reduceMotion(), duration: reduceMotion() ? 0 : 600 });
			framed = sig;
		}
	});
	$effect(() => {
		void picked;
		for (const [id, m] of markers) if (!m.button.disabled) m.button.setAttribute('aria-pressed', String(id === picked));
	});
</script>

<div class="map-wrap" data-status={status} data-theme-drawn={dark ? 'dark' : 'light'} data-testid="allocation-map">
	<div class="map" role="region" aria-label="Hydrological units shaded by modelled use against the registered volume" bind:this={el}></div>
	{#if status === 'loading'}
		<p class="map-state muted" role="status">Drawing the map…</p>
	{:else if status === 'failed'}
		<p class="map-state alert alert-info slim" role="status" data-testid="allocation-map-unavailable">
			The map can’t be drawn in this browser (it needs WebGL). Every unit and its figures are in the list below and in the comparison above.
		</p>
	{/if}
	{#if tilesNote}
		<p class="tiles-note small muted" role="status">The basemap couldn’t be loaded, so the units are drawn on a plain background.</p>
	{/if}
</div>

<style>
	.map-wrap {
		position: relative;
	}
	.map {
		height: min(60vh, 520px);
		min-height: 320px;
		border: 1px solid var(--border);
		border-radius: 8px;
		overflow: hidden;
		background: var(--surface-2, var(--bg));
	}
	@media (max-width: 700px) {
		.map {
			height: 50vh;
			min-height: 260px;
		}
	}
	.map-state {
		position: absolute;
		inset: 0.75rem 0.75rem auto 0.75rem;
		margin: 0;
	}
	.tiles-note {
		margin: 0.4rem 0 0;
	}
	.map :global(.maplibregl-canvas:focus-visible) {
		outline: 3px solid var(--focus);
		outline-offset: -3px;
	}
	/* A unit's label: its % of registered on its band's colour (the text at 4.5:1 on it, useMap.test.ts), with a casing so it reads on any fill. */
	.map :global(.use-label) {
		min-width: 24px;
		min-height: 24px;
		padding: 0.1rem 0.45rem;
		border: 2px solid var(--text);
		border-radius: 999px;
		background: var(--band-fill);
		color: var(--band-text);
		font: 700 0.8rem/1.2 var(--font, system-ui, sans-serif);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		cursor: pointer;
		box-shadow: 0 0 0 1px var(--surface);
	}
	.map :global(.use-label[data-band='unregistered']) {
		background:
			repeating-linear-gradient(45deg, transparent 0 4px, color-mix(in srgb, var(--text) 30%, transparent) 4px 6px),
			var(--band-fill);
	}
	.map :global(.use-label[data-band='notinrun']),
	.map :global(.use-label[data-band='nodata']) {
		border-style: dashed;
		cursor: default;
		font-weight: 600;
	}
	.map :global(.use-label[aria-pressed='true']) {
		outline: 3px solid var(--accent);
		outline-offset: 1px;
	}
	.map :global(.use-label:focus-visible) {
		outline: 3px solid var(--focus);
		outline-offset: 2px;
	}
	@media (forced-colors: active) {
		.map :global(.use-label) {
			border-color: CanvasText;
		}
	}
</style>
