<!--
	The catchment map itself (issue #288, WP-3.12; docs/ui.md § Catchment map):
	the features over the basemap. MapLibre is a dynamic import (./maplibre.ts)
	made when this component mounts, so it never weighs on the workspace's
	first load. The map is never the only way to do anything: the tab's list
	and forms do everything it does. Points are buttons (focusable, ≥ 24 px,
	told apart by shape); the canvas is focusable for MapLibre's keyboard pan
	and zoom. Without WebGL the map says so and the list carries on; when the
	basemap tiles can't be read, the features stay drawn on a plain background.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import type { MapFeature } from '$lib/api/types';
	import { boundsOf, boundsOfAll, KIND_LABEL } from './mapData';
	import { basemapLayerIds, basemapStyle, overlayData, overlayLayers } from './mapStyle';

	let {
		features,
		selectedId = null,
		onselect,
		tilesUrl,
		label
	}: {
		features: MapFeature[];
		selectedId?: string | null;
		onselect: (id: string) => void;
		/** The PMTiles basemap's URL; empty = no basemap, a plain background. */
		tilesUrl: string | null;
		/** The map region's accessible name. */
		label: string;
	} = $props();

	let el: HTMLDivElement;
	let status = $state<'loading' | 'ready' | 'failed'>('loading');
	let tilesNote = $state(false);
	type Lib = typeof import('./maplibre');
	let lib: Lib | null = null;
	let map: InstanceType<Lib['MapLibreMap']> | null = null;
	const markers = new Map<string, { marker: InstanceType<Lib['Marker']>; button: HTMLButtonElement; key: string }>();
	const dark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
	const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
	/** South Africa, before there is anything to frame. */
	const SA: [[number, number], [number, number]] = [
		[16.3, -35],
		[33, -22]
	];

	const OVERLAY_CLICKABLE = ['ov-parcel-fill', 'ov-boundary', 'ov-parcel-line', 'ov-other-line', 'ov-river'];

	function frame(b: [[number, number], [number, number]], maxZoom = 13) {
		map?.fitBounds(b, { padding: 48, maxZoom, animate: !reduceMotion(), duration: reduceMotion() ? 0 : 600 });
	}

	const SVG = 'http://www.w3.org/2000/svg';
	/** A point's shape, by kind: a triangle for a gauge, a circle for a dam, a diamond for anything else. */
	function markerShape(kind: MapFeature['kind']): SVGSVGElement {
		const svg = document.createElementNS(SVG, 'svg');
		svg.setAttribute('viewBox', '0 0 28 28');
		svg.setAttribute('width', '28');
		svg.setAttribute('height', '28');
		svg.setAttribute('aria-hidden', 'true');
		const shape = document.createElementNS(SVG, kind === 'dam' ? 'circle' : 'path');
		if (kind === 'dam') {
			shape.setAttribute('cx', '14');
			shape.setAttribute('cy', '14');
			shape.setAttribute('r', '10.5');
		} else shape.setAttribute('d', kind === 'gauge' ? 'M14 2.5 L26 25 L2 25 Z' : 'M14 1.5 L26.5 14 L14 26.5 L1.5 14 Z');
		shape.setAttribute('class', 'mk-shape');
		svg.append(shape);
		return svg;
	}

	function syncMarkers() {
		if (!map || !lib) return;
		const points = features.filter((f) => f.geometry.type === 'Point');
		const keep = new Set(points.map((f) => f.id));
		for (const [id, m] of markers) {
			if (!keep.has(id)) {
				m.marker.remove();
				markers.delete(id);
			}
		}
		for (const f of points) {
			const at = f.geometry.coordinates as [number, number];
			const name = f.name || KIND_LABEL[f.kind];
			const key = `${f.kind}|${name}|${at.join(',')}`;
			const had = markers.get(f.id);
			if (had && had.key === key) {
				had.button.setAttribute('aria-pressed', String(f.id === selectedId));
				continue;
			}
			had?.marker.remove();
			const button = document.createElement('button');
			button.type = 'button';
			button.className = `map-marker mk-${f.kind}`;
			button.setAttribute('aria-label', `${KIND_LABEL[f.kind]}: ${name}`);
			button.setAttribute('aria-pressed', String(f.id === selectedId));
			button.title = `${KIND_LABEL[f.kind]}: ${name}`;
			button.append(markerShape(f.kind));
			button.addEventListener('click', (e) => {
				e.stopPropagation();
				onselect(f.id);
			});
			const marker = new lib.Marker({ element: button }).setLngLat(at).addTo(map);
			markers.set(f.id, { marker, button, key });
		}
	}

	function syncOverlay() {
		if (!map || status !== 'ready') return;
		const src = map.getSource('features') as { setData?: (d: unknown) => void } | undefined;
		src?.setData?.(overlayData(features, selectedId));
		syncMarkers();
	}

	onMount(() => {
		let disposed = false;
		(async () => {
			try {
				lib = await import('./maplibre');
				if (tilesUrl) await lib.usePmtiles();
				if (disposed) return;
				const style = basemapStyle(tilesUrl, dark);
				const m = new lib.MapLibreMap({
					container: el,
					// Plain objects matching the style spec (mapStyle.ts keeps MapLibre out of the tab's chunk).
					style: style as never,
					attributionControl: false,
					bounds: boundsOfAll(features) ?? SA,
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
				m.getCanvas().setAttribute('aria-label', `${label}: use the arrow keys to pan, + and − to zoom`);
				m.on('error', (ev) => {
					const e = ev as unknown as { sourceId?: string; error?: { message?: string } };
					if (e.sourceId === 'basemap' && !tilesNote) {
						tilesNote = true;
						for (const id of basemapLayerIds(style)) if (m.getLayer(id)) m.removeLayer(id);
					} else if (/webgl/i.test(e.error?.message ?? '')) {
						status = 'failed';
					}
				});
				m.on('load', () => {
					m.addSource('features', { type: 'geojson', data: overlayData(features, selectedId) as never });
					for (const layer of overlayLayers(dark)) m.addLayer(layer as never);
					m.on('click', OVERLAY_CLICKABLE, (e: { features?: { properties?: { id?: string } }[] }) => {
						const id = e.features?.[0]?.properties?.id;
						if (id) onselect(id);
					});
					for (const id of OVERLAY_CLICKABLE) {
						m.on('mouseenter', id, () => (m.getCanvas().style.cursor = 'pointer'));
						m.on('mouseleave', id, () => (m.getCanvas().style.cursor = ''));
					}
					status = 'ready';
					syncMarkers();
				});
			} catch {
				// No WebGL (a locked-down browser, some headless ones): the list does everything the map does.
				if (!disposed) status = 'failed';
			}
		})();
		return () => {
			disposed = true;
			for (const m of markers.values()) m.marker.remove();
			markers.clear();
			map?.remove();
			map = null;
		};
	});

	// Redraw when the features or the selection change.
	$effect(() => {
		void features;
		void selectedId;
		syncOverlay();
	});

	// Selecting in the list frames the feature (instantly under prefers-reduced-motion).
	let framed: string | null = null;
	$effect(() => {
		const id = selectedId;
		if (status !== 'ready' || !id || id === framed) return;
		const f = features.find((x) => x.id === id);
		if (!f) return;
		framed = id;
		frame(boundsOf(f.geometry), f.geometry.type === 'Point' ? 14 : 13);
	});

	/** Frame every feature (the "Show everything" button). */
	export function showAll() {
		frame(boundsOfAll(features) ?? SA);
	}
</script>

<div class="map-wrap" data-status={status}>
	<div class="map" role="region" aria-label={label} bind:this={el} data-testid="catchment-map"></div>
	{#if status === 'loading'}
		<p class="map-state muted" role="status">Drawing the map…</p>
	{:else if status === 'failed'}
		<p class="map-state alert alert-info slim" role="status" data-testid="map-unavailable">
			The map can’t be drawn in this browser (it needs WebGL). Everything on it is in the list, and every action works from there.
		</p>
	{/if}
	{#if tilesNote}
		<p class="tiles-note small muted" role="status" data-testid="map-tiles-note">The basemap couldn’t be loaded, so the features are drawn on a plain background.</p>
	{/if}
</div>

<style>
	.map-wrap {
		position: relative;
	}
	.map {
		height: min(60vh, 560px);
		min-height: 320px;
		border: 1px solid var(--border);
		border-radius: 8px;
		overflow: hidden;
		background: var(--surface-2, var(--bg));
	}
	@media (max-width: 700px) {
		.map {
			height: 50vh;
			min-height: 240px;
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
	/* Point markers: 28 × 28 px buttons (≥ 24, WCAG 2.5.8), told apart by shape (markerShape), each with a contrasting casing. */
	.map :global(.map-marker) {
		width: 28px;
		height: 28px;
		padding: 0;
		border: none;
		background: none;
		cursor: pointer;
		display: block;
	}
	.map :global(.map-marker svg) {
		display: block;
		overflow: visible;
	}
	.map :global(.mk-shape) {
		stroke: #ffffff;
		stroke-width: 2.5;
		fill: #3a3d3a;
	}
	.map :global(.mk-gauge .mk-shape) {
		fill: #0b4fa0;
	}
	.map :global(.mk-dam .mk-shape) {
		fill: #0b5a73;
	}
	.map :global(.map-marker[aria-pressed='true'] .mk-shape) {
		stroke: #b0006e;
		stroke-width: 4;
	}
	.map :global(.map-marker:focus-visible) {
		outline: 3px solid var(--focus);
		outline-offset: 2px;
		border-radius: 4px;
	}
	@media (prefers-color-scheme: dark) {
		.map :global(.mk-shape) {
			stroke: #000000;
			fill: #e0e0e0;
		}
		.map :global(.mk-gauge .mk-shape) {
			fill: #8ec7ff;
		}
		.map :global(.mk-dam .mk-shape) {
			fill: #7fd5e8;
		}
		.map :global(.map-marker[aria-pressed='true'] .mk-shape) {
			stroke: #ff8fd0;
		}
	}
</style>
