<!--
	The catchment map itself (issue #288, WP-3.12; docs/ui.md § Catchment map):
	the features over the basemap. MapLibre is a dynamic import (./maplibre.ts)
	made when this component mounts, so it never weighs on the workspace's
	first load. The map is never the only way to do anything: the tab's list
	and forms do everything it does. Points are buttons (focusable, ≥ 24 px,
	told apart by shape); the canvas is focusable for MapLibre's keyboard pan
	and zoom. Without WebGL the map says so and the list carries on; when the
	basemap tiles can't be read, the features stay drawn on a plain background.
	It follows the app's theme (appTheme.ts: data-theme, else the OS), redrawing
	basemap and overlay with setStyle; the picked feature's name shows over the
	map's top-left corner until the basemap has labels (#326 E9). The farm
	view's map (#326 A3) passes `words` in the reader's language: this file
	imports no catalogue (i18n/boundary.test.ts), so its own words are English.
-->
<script module lang="ts">
	import type { MapFeatureKind } from '$lib/api/types';

	/** Everything the map says in words (the farm view passes its own, translated). */
	export interface MapWords {
		loading: string;
		unavailable: string;
		tilesNote: string;
		/** After the map's name on the canvas, for the keyboard. */
		keys: string;
		kind: (k: MapFeatureKind) => string;
		/** The zoom buttons' names (MapLibre's own English when absent). */
		zoomIn?: string;
		zoomOut?: string;
	}
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import type { MapFeature } from '$lib/api/types';
	import { boundsOf, boundsOfAll, KIND_LABEL } from './mapData';
	import { appIsDark, watchAppTheme } from './appTheme';
	import { basemapLayerIds, mapStyle, overlayColours, overlayData } from './mapStyle';
	const ENGLISH: MapWords = {
		loading: 'Drawing the map…',
		unavailable: 'The map can’t be drawn in this browser (it needs WebGL). Everything on it is in the list, and every action works from there.',
		tilesNote: 'The basemap couldn’t be loaded, so the features are drawn on a plain background.',
		keys: 'use the arrow keys to pan, + and − to zoom',
		kind: (k) => KIND_LABEL[k]
	};

	let {
		features,
		selectedId = null,
		onselect,
		tilesUrl,
		label,
		fills,
		fill = false,
		words = ENGLISH
	}: {
		features: MapFeature[];
		selectedId?: string | null;
		onselect: (id: string) => void;
		/** The PMTiles basemap's URL; empty = no basemap, a plain background. */
		tilesUrl: string | null;
		/** The map region's accessible name. */
		label: string;
		/** Take the parent's height (a flex column) instead of the map's own fixed height. */
		fill?: boolean;
		/** Results colours by feature id (A1): a polygon listed here is filled with its colour instead of its kind's. */
		fills?: Readonly<Record<string, string>>;
		/** What the map says, for a translated page (the farm view); English by default. */
		words?: MapWords;
	} = $props();

	let el: HTMLDivElement;
	let status = $state<'loading' | 'ready' | 'failed'>('loading');
	let tilesNote = $state(false);
	type Lib = typeof import('./maplibre');
	let lib: Lib | null = null;
	let map: InstanceType<Lib['MapLibreMap']> | null = null;
	const markers = new Map<string, { marker: InstanceType<Lib['Marker']>; button: HTMLButtonElement; key: string }>();
	let dark = $state(typeof matchMedia === 'function' && typeof document !== 'undefined' && appIsDark());
	const colours = $derived(overlayColours(dark));
	const picked = $derived(selectedId ? features.find((f) => f.id === selectedId) : undefined);
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
			const name = f.name || words.kind(f.kind);
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
			button.setAttribute('aria-label', `${words.kind(f.kind)}: ${name}`);
			button.setAttribute('aria-pressed', String(f.id === selectedId));
			button.title = `${words.kind(f.kind)}: ${name}`;
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
		src?.setData?.(overlayData(features, selectedId, fills));
		syncMarkers();
	}

	onMount(() => {
		let disposed = false;
		let stopTheme: (() => void) | null = null;
		(async () => {
			try {
				lib = await import('./maplibre');
				if (tilesUrl) await lib.usePmtiles();
				if (disposed) return;
				const styleNow = () => mapStyle(tilesNote ? null : tilesUrl, dark, overlayData(features, selectedId, fills));
				const style = styleNow();
				const m = new lib.MapLibreMap({
					container: el,
					// Plain objects matching the style spec (mapStyle.ts keeps MapLibre out of the tab's chunk).
					style: style as never,
					attributionControl: false,
					bounds: boundsOfAll(features) ?? SA,
					fitBoundsOptions: { padding: 48, maxZoom: 13 },
					keyboard: true,
					...(words.zoomIn && words.zoomOut ? { locale: { 'NavigationControl.ZoomIn': words.zoomIn, 'NavigationControl.ZoomOut': words.zoomOut } } : {}),
					dragRotate: false,
					pitchWithRotate: false,
					touchPitch: false
				});
				map = m;
				m.addControl(new lib.NavigationControl({ showCompass: false }), 'top-right');
				// Always expanded: the basemap's licence must stay visible.
				m.addControl(new lib.AttributionControl({ compact: false }), 'bottom-right');
				m.getCanvas().setAttribute('aria-label', `${label}: ${words.keys}`);
				m.on('error', (ev) => {
					const e = ev as unknown as { sourceId?: string; error?: { message?: string } };
					if (e.sourceId === 'basemap' && !tilesNote) {
						tilesNote = true;
						for (const id of basemapLayerIds(style)) if (m.getLayer(id)) m.removeLayer(id);
					} else if (/webgl/i.test(e.error?.message ?? '')) {
						status = 'failed';
					}
				});
				// The app's theme changed: redraw basemap and overlay in it (the style carries the current features and selection).
				let drawnDark = dark;
				stopTheme = watchAppTheme(() => {
					dark = appIsDark();
					if (dark === drawnDark || disposed) return;
					drawnDark = dark;
					m.setStyle(styleNow() as never);
				});
				// A pick made while the new style loaded reaches it here.
				m.on('style.load', () => syncOverlay());
				m.on('load', () => {
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
			stopTheme?.();
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
		void fills;
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

<div
	class="map-wrap"
	class:fill
	data-status={status}
	data-theme-drawn={dark ? 'dark' : 'light'}
	style:--mk-casing={colours.casing}
	style:--mk-other={colours.other}
	style:--mk-water={colours.water}
	style:--mk-selected={colours.selected}
>
	<div class="map" role="region" aria-label={label} bind:this={el} data-testid="catchment-map"></div>
	{#if status === 'ready' && picked}
		<!-- Hidden from assistive tech: every way to pick (the list's buttons, a point's button) already says which is pressed; this repeats the name for the eye. -->
		<p class="picked-name" aria-hidden="true" data-testid="map-picked-name">
			<span class="picked-kind">{words.kind(picked.kind)}</span>
			<span class="picked-label">{picked.name || words.kind(picked.kind)}</span>
		</p>
	{/if}
	{#if status === 'loading'}
		<p class="map-state muted" role="status">{words.loading}</p>
	{:else if status === 'failed'}
		<p class="map-state alert alert-info slim" role="status" data-testid="map-unavailable">
			{words.unavailable}
		</p>
	{/if}
	{#if tilesNote}
		<p class="tiles-note small muted" role="status" data-testid="map-tiles-note">{words.tilesNote}</p>
	{/if}
</div>

<style>
	.map-wrap {
		position: relative;
	}
	.map-wrap.fill {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-height: 0;
	}
	/* Grows (or shrinks to its min-height) to the parent's height; where the parent isn't a sized flex column (a phone), the fixed height stands. */
	.map-wrap.fill .map {
		flex: 1 1 auto;
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
	/* The marker colours come from mapStyle.ts (overlayColours) as custom properties on .map-wrap, so they follow the app's theme as the map does. */
	.map :global(.mk-shape) {
		stroke: var(--mk-casing);
		stroke-width: 2.5;
		fill: var(--mk-other);
	}
	/* Gauges and dams are water: the rivers' blue, told apart by shape (▲, ●). */
	.map :global(.mk-gauge .mk-shape),
	.map :global(.mk-dam .mk-shape) {
		fill: var(--mk-water);
	}
	.map :global(.map-marker[aria-pressed='true'] .mk-shape) {
		stroke: var(--mk-selected);
		stroke-width: 4;
	}
	.map :global(.map-marker:focus-visible) {
		outline: 3px solid var(--focus);
		outline-offset: 2px;
		border-radius: 4px;
	}
	/* The picked feature's name (#326 E9), over the top-left corner (the zoom buttons are top right). */
	.picked-name {
		position: absolute;
		top: 0.6rem;
		left: 0.6rem;
		max-width: calc(100% - 5rem);
		margin: 0;
		padding: 0.25rem 0.55rem;
		display: flex;
		flex-direction: column;
		background: var(--surface);
		color: var(--text);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		box-shadow: var(--shadow);
		pointer-events: none;
		line-height: 1.3;
	}
	.picked-kind {
		font-size: 0.75rem;
		color: var(--text-muted);
	}
	.picked-label {
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
