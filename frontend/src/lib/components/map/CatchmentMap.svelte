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
	With a `draft` active (#326 C1, D1: drawing, placing or editing) the map is
	in drawing mode (draw/attachDrawing.ts): clicks and keys shape the draft,
	the features underneath stop taking clicks, and a crosshair marks the
	middle while the map has the keyboard focus (Enter adds a corner there;
	with the mouse over the map, Enter adds at the pointer instead, and the
	crosshair hides until an arrow key brings it back).
	Measuring (#326 A7) is the same mode with a MeasureDraft. With a glyphs
	URL the basemap draws place and water names (#326 A6), and `quaternaries`
	(the tab's layer toggle) draws the quaternary outlines under the features,
	a click inside one (with no feature there) picking it (`onquaternary`).
	`rivers` (the River network layer, #345) draws the network's reaches over
	them, dashed, a click on one (with no feature there) picking it (`onreach`).
	With a `terrainUrl` and `relief` on (the tab's Relief layer), the land is
	shaded from the DEM (docs/maps.md § Relief); turning it off or on changes
	the live map, and a DEM that can't be read drops the relief (`onreliefError`)
	and leaves everything else drawn.
	A start or divide proposal (`proposal` with `pieces`, #326 C3's follow-up)
	is drawn piece by piece, each with its number as a badge (hidden from
	assistive technology: the sheet's cards carry the numbers and are the
	key); the piece in `proposal.highlight` is lit, and a piece or badge under
	the pointer reports itself (`onpiecehover`, its name over the top-left
	corner) and a click on one opens its card (`onpiecepick`).
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
	import { onMount, untrack } from 'svelte';
	import type { MapFeature } from '$lib/api/types';
	import { boundsOf, boundsOfAll, KIND_LABEL } from './mapData';
	import { appIsDark, watchAppTheme } from './appTheme';
	import {
		basemapLayerIds,
		mapStyle,
		overlayColours,
		overlayData,
		PIECE_HIT_LAYER,
		labelColours,
		pieceTints,
		proposalColour,
		proposalData,
		QUATERNARY_HIT_LAYER,
		quaternaryData,
		RELIEF_LAYER,
		reliefBeforeId,
		reliefLayer,
		RIVER_NETWORK_HIT_LAYER,
		riverNetworkData,
		TERRAIN_SOURCE,
		terrainSource,
		type NetworkReach,
		type QuaternaryOutline
	} from './mapStyle';
	import type { MapGeometry, MapPosition } from '$lib/api/types';
	import { attachDrawing } from './draw/attachDrawing';
	import type { Draft } from './draw/draft.svelte';
	import { DRAFT_SOURCE, draftData, draftLayers } from './draw/drawLayers';
	import type { ProposalPiece } from './pieces';
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
		words = ENGLISH,
		draft = null,
		onstatus,
		glyphs = null,
		quaternaries = null,
		pickedQuaternary = null,
		onquaternary,
		rivers = null,
		pickedReach = null,
		onreach,
		terrainUrl = null,
		relief = false,
		onreliefError,
		proposal = null,
		onpiecehover,
		onpiecepick
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
		/** The shape being drawn, placed or edited (#326 C1): the map is in drawing mode while it is active. */
		draft?: Draft | null;
		/** The map's state, for the tab (no WebGL: drawing falls back to pasting and typed coordinates). */
		onstatus?: (s: 'loading' | 'ready' | 'failed') => void;
		/** What the map says, for a translated page (the farm view); English by default. */
		words?: MapWords;
		/** The glyphs URL, absolute (mapStyle.ts glyphsUrl): place and water names and the quaternaries' codes. Null: no labels, no glyphs fetched. */
		glyphs?: string | null;
		/** The quaternary outlines to draw (#326 A6); null or empty: none. */
		quaternaries?: readonly QuaternaryOutline[] | null;
		/** The quaternary picked in the tab's list, drawn heavier. */
		pickedQuaternary?: string | null;
		/** A click inside a quaternary where no feature is: its code. */
		onquaternary?: (code: string) => void;
		/** The river network's reaches to draw (#345); null or empty: none. */
		rivers?: readonly NetworkReach[] | null;
		/** The reach picked in the tab's list, drawn heavier. */
		pickedReach?: string | null;
		/** A click on a reach where no feature is: its key. */
		onreach?: (key: string) => void;
		/** The relief's PMTiles URL (PUBLIC_TERRAIN_URL); null: no relief can be drawn, no DEM fetched. */
		terrainUrl?: string | null;
		/** Shade the land from the DEM (the tab's Relief layer). */
		relief?: boolean;
		/** The DEM couldn't be read: the relief is dropped, the rest of the map stays. */
		onreliefError?: () => void;
		/**
		 * A delineated catchment waiting for a decision (#326 B-delineate): drawn dashed over the features, with its outlet.
		 * With `pieces` (a start or divide proposal, pieces.ts), each piece apart with its number, `highlight` the one lit.
		 */
		proposal?: { id: string; geometry: MapGeometry; outlet: MapPosition; pieces?: readonly ProposalPiece[]; highlight?: string | null } | null;
		/** The pointer is over a piece or its number (its key), or has left them (null). */
		onpiecehover?: (key: string | null) => void;
		/** A piece or its number was clicked (where no feature is): its key. */
		onpiecepick?: (key: string) => void;
	} = $props();

	let el: HTMLDivElement;
	let status = $state<'loading' | 'ready' | 'failed'>('loading');
	$effect(() => onstatus?.(status));
	const drawing = $derived(!!draft?.active);
	/** The map's canvas has the keyboard focus: the crosshair shows (drawing by keyboard). */
	let keyFocus = $state(false);
	/** Enter adds at the mouse pointer (over the map), not the crosshair: the crosshair hides. */
	let aimAtPointer = $state(false);
	let tilesNote = $state(false);
	/** The DEM couldn't be read: no relief from here on (the tab says so). */
	let reliefFailed = false;
	const reliefUrl = () => (relief && terrainUrl && !reliefFailed ? terrainUrl : null);
	type Lib = typeof import('./maplibre');
	let lib: Lib | null = null;
	let map: InstanceType<Lib['MapLibreMap']> | null = null;
	const markers = new Map<string, { marker: InstanceType<Lib['Marker']>; button: HTMLButtonElement; key: string }>();
	/** The proposal's pieces' numbers, by piece key. */
	const badges = new Map<string, { marker: InstanceType<Lib['Marker']>; el: HTMLSpanElement; key: string }>();
	/** The piece under the pointer: its name shows over the top-left corner. */
	let hoverPiece = $state<ProposalPiece | null>(null);
	function hoverOn(p: ProposalPiece | null) {
		if (p?.key === hoverPiece?.key) return;
		hoverPiece = p;
		onpiecehover?.(p?.key ?? null);
	}
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
			// A results colour (A1: a gauge's EWR met or missed) fills the marker's shape; its words are in the card, the grid and the legend.
			const tint = fills?.[f.id] ?? '';
			const key = `${f.kind}|${name}|${at.join(',')}|${tint}`;
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
			if (tint) {
				button.style.setProperty('--mk-fill', tint);
				button.dataset.fill = tint;
			}
			button.append(markerShape(f.kind));
			button.addEventListener('click', (e) => {
				e.stopPropagation();
				onselect(f.id);
			});
			const marker = new lib.Marker({ element: button }).setLngLat(at).addTo(map);
			markers.set(f.id, { marker, button, key });
		}
	}

	/** The proposal's pieces' numbers: one badge each, at a point inside its piece (or the unit's point), lit with its piece. */
	function syncBadges() {
		if (!map || !lib) return;
		const pieces = proposal?.pieces ?? [];
		const keep = new Set(pieces.map((p) => p.key));
		for (const [k, b] of badges) {
			if (!keep.has(k)) {
				b.marker.remove();
				badges.delete(k);
			}
		}
		const tints = pieceTints(dark);
		for (const p of pieces) {
			const sig = `${p.label}|${p.at.join(',')}|${p.tint}|${p.geometry ? 1 : 0}`;
			const had = badges.get(p.key);
			if (had && had.key === sig) {
				had.el.dataset.lit = String(p.key === proposal?.highlight);
				continue;
			}
			had?.marker.remove();
			const el = document.createElement('span');
			el.className = 'piece-badge';
			el.textContent = p.label;
			el.setAttribute('aria-hidden', 'true');
			el.dataset.piece = p.key;
			el.dataset.lit = String(p.key === proposal?.highlight);
			if (p.tint >= 0) el.style.setProperty('--piece-tint', tints[p.tint]!);
			el.addEventListener('mouseenter', () => !draft?.active && hoverOn(p));
			el.addEventListener('mouseleave', () => hoverOn(null));
			el.addEventListener('click', (e) => {
				e.stopPropagation();
				if (!draft?.active) onpiecepick?.(p.key);
			});
			// A unit with no land (a gauge, a user) has its number beside its point, not on it: its marker stays visible and clickable.
			const marker = new lib.Marker({ element: el, offset: p.geometry ? [0, 0] : [20, -20] })
				.setLngLat(p.at as [number, number])
				.addTo(map);
			badges.set(p.key, { marker, el, key: sig });
		}
	}

	/** The draft's source and layers, after every style load (a theme switch replaces the style). */
	function ensureDraft() {
		if (!map || map.getSource(DRAFT_SOURCE)) return;
		map.addSource(DRAFT_SOURCE, { type: 'geojson', data: draftData(draftView()) as never });
		for (const l of draftLayers(dark)) map.addLayer(l as never);
	}
	const draftView = () => {
		if (!draft?.active) return null;
		const split = draft.splitResult;
		return {
			shape: draft.shape,
			coords: draft.coords,
			phase: draft.phase,
			whole: draft.whole,
			cursor: draft.cursor,
			corner: draft.corner,
			snap: draft.snapHint?.at ?? null,
			parts: split && 'parts' in split ? split.parts : null
		};
	};

	function syncOverlay() {
		if (!map || status !== 'ready') return;
		const src = map.getSource('features') as { setData?: (d: unknown) => void } | undefined;
		src?.setData?.(overlayData(features, selectedId, fills));
		const qt = map.getSource('quaternaries') as { setData?: (d: unknown) => void } | undefined;
		qt?.setData?.(quaternaryData(quaternaries, pickedQuaternary));
		const pr = map.getSource('proposal') as { setData?: (d: unknown) => void } | undefined;
		pr?.setData?.(proposalData(proposal));
		const rn = map.getSource('rivers') as { setData?: (d: unknown) => void } | undefined;
		rn?.setData?.(riverNetworkData(rivers, pickedReach));
		syncMarkers();
		syncBadges();
	}

	/** Add or drop the relief on the live map, to match the Relief layer (a style load carries it already). */
	function syncRelief() {
		if (!map || status !== 'ready') return;
		const url = reliefUrl();
		const has = !!map.getLayer(RELIEF_LAYER);
		if (url && !has) {
			if (!map.getSource(TERRAIN_SOURCE)) map.addSource(TERRAIN_SOURCE, terrainSource(url) as never);
			map.addLayer(reliefLayer(dark) as never, reliefBeforeId(map.getStyle().layers.map((l) => l.id)));
		} else if (!url && has) {
			map.removeLayer(RELIEF_LAYER);
			map.removeSource(TERRAIN_SOURCE);
		}
	}

	onMount(() => {
		let disposed = false;
		let stopTheme: (() => void) | null = null;
		(async () => {
			try {
				lib = await import('./maplibre');
				if (tilesUrl || terrainUrl) await lib.usePmtiles();
				if (disposed) return;
				const styleNow = () =>
					mapStyle(tilesNote ? null : tilesUrl, dark, overlayData(features, selectedId, fills), {
						glyphs,
						quaternaries: quaternaryData(quaternaries, pickedQuaternary),
						rivers: riverNetworkData(rivers, pickedReach),
						terrain: reliefUrl(),
						proposal: proposalData(proposal)
					});
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
				m.on('error', (ev) => {
					const e = ev as unknown as { sourceId?: string; error?: { message?: string } };
					if (e.sourceId === 'basemap' && !tilesNote) {
						tilesNote = true;
						for (const id of basemapLayerIds(style)) if (m.getLayer(id)) m.removeLayer(id);
					} else if (e.sourceId === TERRAIN_SOURCE && !reliefFailed) {
						reliefFailed = true;
						if (m.getLayer(RELIEF_LAYER)) m.removeLayer(RELIEF_LAYER);
						onreliefError?.();
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
				m.on('style.load', () => {
					ensureDraft();
					syncOverlay();
				});
				m.on('load', () => {
					ensureDraft();
					m.on('click', OVERLAY_CLICKABLE, (e: { features?: { properties?: { id?: string } }[] }) => {
						// Drawing: a click shapes the draft, it doesn't pick what's under it.
						if (draft?.active) return;
						const id = e.features?.[0]?.properties?.id;
						if (id) onselect(id);
					});
					// A click on a reach picks it, else a click inside a quaternary picks that, unless a feature (or a marker, which stops the click) is there.
					m.on('click', (e: { point: { x: number; y: number } }) => {
						if (draft?.active) return;
						if (m.queryRenderedFeatures(e.point as never, { layers: OVERLAY_CLICKABLE.filter((l) => m.getLayer(l)) }).length) return;
						if (onpiecepick && m.getLayer(PIECE_HIT_LAYER)) {
							const key = m.queryRenderedFeatures(e.point as never, { layers: [PIECE_HIT_LAYER] })[0]?.properties?.key;
							if (typeof key === 'string') return onpiecepick(key);
						}
						if (onreach && m.getLayer(RIVER_NETWORK_HIT_LAYER)) {
							const key = m.queryRenderedFeatures(e.point as never, { layers: [RIVER_NETWORK_HIT_LAYER] })[0]?.properties?.key;
							if (typeof key === 'string') return onreach(key);
						}
						if (!onquaternary || !m.getLayer(QUATERNARY_HIT_LAYER)) return;
						const code = m.queryRenderedFeatures(e.point as never, { layers: [QUATERNARY_HIT_LAYER] })[0]?.properties?.code;
						if (typeof code === 'string') onquaternary(code);
					});
					for (const id of onreach ? [...OVERLAY_CLICKABLE, RIVER_NETWORK_HIT_LAYER] : OVERLAY_CLICKABLE) {
						m.on('mouseenter', id, () => {
							if (!draft?.active) m.getCanvas().style.cursor = 'pointer';
						});
						m.on('mouseleave', id, () => {
							if (!draft?.active) m.getCanvas().style.cursor = '';
						});
					}
					// A piece under the pointer lights its card, and says its name over the corner.
					m.on('mousemove', PIECE_HIT_LAYER, (e: { features?: { properties?: { key?: string } }[]; originalEvent?: Event }) => {
						// Over a number, the number's piece is the one meant (a gauge's number sits on the piece below it).
						if (draft?.active || (e.originalEvent?.target as Element | null)?.closest?.('.piece-badge')) return;
						const key = e.features?.[0]?.properties?.key;
						hoverOn(proposal?.pieces?.find((p) => p.key === key) ?? null);
						m.getCanvas().style.cursor = onpiecepick ? 'pointer' : '';
					});
					m.on('mouseleave', PIECE_HIT_LAYER, (e: { originalEvent?: Event }) => {
						if ((e.originalEvent as MouseEvent | undefined)?.relatedTarget instanceof Element && ((e.originalEvent as MouseEvent).relatedTarget as Element).closest('.piece-badge')) return;
						hoverOn(null);
						if (!draft?.active) m.getCanvas().style.cursor = '';
					});
					// The crosshair is for the keyboard: shown when the focus came by keyboard (focus-visible), not after a click.
					m.getCanvas().addEventListener('focus', () => (keyFocus = m.getCanvas().matches(':focus-visible')));
					m.getCanvas().addEventListener('keydown', () => (keyFocus = true));
					m.getCanvas().addEventListener('blur', () => (keyFocus = false));
					status = 'ready';
					syncMarkers();
					syncBadges();
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
			for (const b of badges.values()) b.marker.remove();
			badges.clear();
			map?.remove();
			map = null;
		};
	});

	// Redraw when the features or the selection change.
	$effect(() => {
		void features;
		void selectedId;
		void fills;
		void quaternaries;
		void pickedQuaternary;
		void proposal;
		void rivers;
		void pickedReach;
		syncOverlay();
	});

	// A new proposal is framed, so the editor sees all of what they are deciding on.
	let framedProposal: string | null = null;
	$effect(() => {
		const p = proposal;
		if (status !== 'ready' || !p || p.id === framedProposal) return;
		framedProposal = p.id;
		frame(boundsOf(p.geometry), 13);
	});

	// The Relief layer turned on or off.
	$effect(() => {
		void relief;
		void status;
		untrack(syncRelief);
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

	/** Frame a geometry (a pasted shape, a located point). */
	export function frameGeometry(g: MapGeometry) {
		frame(boundsOf(g), g.type === 'Point' ? 15 : 14);
	}

	/** Give the map the keyboard focus (entering drawing mode, so Enter adds a corner at once). */
	export function focusMap() {
		map?.getCanvas().focus();
	}

	// Drawing mode: on while the draft is active, off (and every handler gone) when it ends.
	$effect(() => {
		if (status !== 'ready' || !drawing || !map || !draft) return;
		const m = map;
		return untrack(() => attachDrawing(m as never, draft, el, (p) => (aimAtPointer = p)));
	});

	// Draw the draft as it changes.
	$effect(() => {
		const v = draftView();
		if (status !== 'ready' || !map) return;
		const src = map.getSource(DRAFT_SOURCE) as { setData?: (d: unknown) => void } | undefined;
		src?.setData?.(draftData(v));
	});

	/** With snapping on (#326 C2): how Enter snaps, and how to place exactly. */
	const snapKeys = (d: Draft) => (d.snapOn && d.snapTargets.length ? ' (on the nearest feature’s corner or edge within reach; Alt+Enter places it exactly)' : '');

	// The canvas says what the keys do while drawing.
	const keysHelp = $derived(
		!draft?.active
			? `${label}: ${words.keys}`
			: 'measuring' in draft
				? `${label}, measuring: the arrow keys move the map under the crosshair, Enter adds a point there, Backspace removes the last, Escape ends the measurement`
				: draft.shape === 'point'
					? `${label}, placing a point: the arrow keys move the map under the crosshair, Enter places the point there${snapKeys(draft)}, Escape cancels`
					: draft.phase === 'drawing'
						? `${label}, drawing: the arrow keys move the map under the crosshair, Enter adds a ${draft.cornerWord.one} there${snapKeys(draft)}, Backspace removes the last, Escape cancels (asking first once two are placed)`
						: `${label}, adjusting the drawing: the arrow keys pan, Escape cancels (asking first if it would discard your changes); pick a ${draft.cornerWord.one} on the map to remove it with Delete`
	);
	$effect(() => {
		const help = keysHelp;
		if (status === 'ready') map?.getCanvas().setAttribute('aria-label', help);
	});

	/** Where the crosshair is (the map's middle), for tests and the bar: the point Enter would add. */
	export function centre(): MapPosition | null {
		const c = map?.getCenter();
		return c ? [c.lng, c.lat] : null;
	}
</script>

<div
	class="map-wrap"
	class:fill
	class:drawing
	data-status={status}
	data-theme-drawn={dark ? 'dark' : 'light'}
	style:--mk-casing={colours.casing}
	style:--mk-other={colours.other}
	style:--mk-water={colours.water}
	style:--mk-selected={colours.selected}
	style:--mk-proposal={proposalColour(dark)}
	style:--mk-badge-text={labelColours(dark).text}
>
	<div class="map" role="region" aria-label={label} bind:this={el} data-testid="catchment-map" data-drawing={drawing ? draft?.phase : undefined}>
		{#if status === 'ready' && drawing && keyFocus && !aimAtPointer}
			<!-- Where Enter adds a corner: the map's middle; the arrow keys move the map under it. -->
			<span class="crosshair" aria-hidden="true" data-testid="map-crosshair"></span>
		{/if}
	</div>
	{#if status === 'ready' && hoverPiece && !drawing}
		<!-- Hidden from assistive tech, as the picked name: the sheet's cards say each piece's number and name. -->
		<p class="picked-name" aria-hidden="true" data-testid="map-piece-name">
			<span class="picked-kind">{hoverPiece.label === 'R' ? 'Proposed piece R' : `Proposed piece ${hoverPiece.label}`}</span>
			<span class="picked-label">{hoverPiece.name}</span>
		</p>
	{:else if status === 'ready' && picked && !drawing}
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
	/* Drawing: the points underneath stop taking clicks, so a click there places a corner. */
	.drawing .map :global(.map-marker) {
		pointer-events: none;
		opacity: 0.6;
	}
	/* The keyboard crosshair: the map's middle, in the picked colour with a casing, over the canvas but never taking a click. */
	.crosshair {
		position: absolute;
		z-index: 2;
		left: 50%;
		top: 50%;
		width: 28px;
		height: 28px;
		margin: -14px 0 0 -14px;
		pointer-events: none;
		background:
			linear-gradient(var(--mk-selected), var(--mk-selected)) center / 3px 100% no-repeat,
			linear-gradient(var(--mk-selected), var(--mk-selected)) center / 100% 3px no-repeat;
		filter: drop-shadow(0 0 1px var(--mk-casing)) drop-shadow(0 0 1px var(--mk-casing));
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
	/* A results colour (A1) wins over the kind's; the casing stays, so the marker keeps its 3:1 edge on the basemap. */
	.map :global(.map-marker[data-fill] .mk-shape) {
		fill: var(--mk-fill);
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
	/* A proposal piece's number (pieces.ts): its tint as a band under the number, on the casing, so it reads on any basemap; lit with its piece. */
	.map :global(.piece-badge) {
		display: grid;
		place-items: center;
		min-width: 24px;
		height: 24px;
		padding: 0 4px;
		box-sizing: border-box;
		border-radius: 12px;
		border: 2px solid var(--mk-proposal);
		background: linear-gradient(var(--mk-casing), var(--mk-casing)) padding-box;
		box-shadow: inset 0 -5px 0 var(--piece-tint, var(--mk-proposal));
		color: var(--mk-badge-text);
		font: 700 0.8rem/1 var(--font, system-ui, sans-serif);
		cursor: pointer;
	}
	.map :global(.piece-badge[data-lit='true']) {
		border-color: var(--mk-selected);
		border-width: 3px;
	}
	.drawing .map :global(.piece-badge) {
		pointer-events: none;
		opacity: 0.6;
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
