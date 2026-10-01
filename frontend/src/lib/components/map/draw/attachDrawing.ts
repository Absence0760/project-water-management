// The map's drawing mode (issue #326 C1, D1; docs/maps.md § Drawing): turns
// clicks, drags and keys on the MapLibre map into Draft calls. A small mode
// of our own on MapLibre's events rather than a drawing library (maps.md says
// why). Loaded with CatchmentMap, never before.
//
// Pointer: a click adds a corner (places a point); a click on the first
// corner closes a polygon, on the last finishes a line, and a double click
// finishes either. Once drawn: drag a corner (or the point) to move it, click
// an edge's middle to add one, click a corner to pick it (Delete removes it);
// a click elsewhere moves a point there.
// Keyboard, from the map's focus: the arrow keys pan the map under a
// crosshair at its middle (MapLibre's own keyboard handler), Enter adds a
// corner (places or moves the point) at the crosshair, Backspace removes the
// last corner while drawing (the picked one after), Delete the picked one,
// Escape cancels (asking first when that would drop work: Draft.escape).
import type { MapPosition } from '$lib/api/types';
import type { Draft } from './draft.svelte';
import { DRAFT_CORNER_LAYER, DRAFT_MID_LAYER } from './drawLayers';

type LngLat = { lng: number; lat: number };
type Pt = { x: number; y: number };
interface Ev {
	lngLat: LngLat;
	point: Pt;
	preventDefault(): void;
	originalEvent?: Event;
	points?: Pt[];
}
/** The parts of a MapLibre map this uses (typed loosely: maplibre-gl's types stay out of this module). */
export interface DrawMap {
	on(type: string, layerOrListener: unknown, listener?: unknown): unknown;
	off(type: string, layerOrListener: unknown, listener?: unknown): unknown;
	getCanvas(): HTMLCanvasElement;
	getCenter(): LngLat;
	queryRenderedFeatures(geometry: [Pt, Pt] | Pt, options: { layers: string[] }): { properties?: Record<string, unknown> }[];
	doubleClickZoom: { enable(): void; disable(): void };
	dragPan: { enable(): void; disable(): void };
	getLayer(id: string): unknown;
}

const at = (l: LngLat): MapPosition => [round(l.lng), round(l.lat)];
/** 7 decimals (~1 cm), the server's own rounding. */
const round = (v: number) => Math.round(v * 1e7) / 1e7;
/** How far from a corner or a middle (px) a click still hits it: a 24 px target (WCAG 2.5.8). */
const HIT = 12;

/** What is under a screen point: a corner's index, an edge's middle, or nothing. */
function hitAt(map: DrawMap, p: Pt): { corner: number } | { mid: number } | null {
	const layers = [DRAFT_CORNER_LAYER, DRAFT_MID_LAYER].filter((l) => map.getLayer(l));
	if (!layers.length) return null;
	const hits = map.queryRenderedFeatures(
		[
			{ x: p.x - HIT, y: p.y - HIT },
			{ x: p.x + HIT, y: p.y + HIT }
		],
		{ layers }
	);
	const corner = hits.find((h) => h.properties?.role === 'corner');
	if (corner) return { corner: Number(corner.properties!.index) };
	const mid = hits.find((h) => h.properties?.role === 'mid');
	if (mid) return { mid: Number(mid.properties!.after) };
	return null;
}

/**
 * Attach the drawing mode to `map` while `draft` is active; returns the
 * detach. `keysOn` is the element whose keydown it reads (the map's box).
 */
export function attachDrawing(map: DrawMap, draft: Draft, keysOn: HTMLElement): () => void {
	let dragging: number | null = null;
	const canvas = map.getCanvas();

	const onClick = (e: Ev) => {
		if (!draft.active || dragging !== null) return;
		const hit = hitAt(map, e.point);
		if (draft.phase === 'drawing' && draft.shape !== 'point') {
			const n = draft.coords.length;
			if (hit && 'corner' in hit) {
				// On a corner: the first closes a polygon, the last (a second click there) finishes; any other adds nothing.
				if (draft.canFinish && ((draft.shape === 'polygon' && hit.corner === 0) || hit.corner === n - 1)) draft.finish();
				return;
			}
			draft.add(at(e.lngLat));
			return;
		}
		if (hit && 'mid' in hit) draft.insertCorner(hit.mid, at(e.lngLat));
		else if (hit && 'corner' in hit) draft.corner = hit.corner;
		else if (draft.shape === 'point') draft.add(at(e.lngLat));
		else draft.corner = null;
	};

	const onDblClick = (e: Ev) => {
		if (draft.active && draft.phase === 'drawing') {
			e.preventDefault();
			draft.finish();
		}
	};

	const onMove = (e: Ev) => {
		if (!draft.active) return;
		if (dragging !== null) {
			draft.moveCorner(dragging, at(e.lngLat));
			return;
		}
		if (draft.phase === 'drawing' && draft.shape !== 'point') {
			draft.cursor = at(e.lngLat);
			canvas.style.cursor = 'crosshair';
			return;
		}
		const hit = draft.phase === 'review' ? hitAt(map, e.point) : null;
		canvas.style.cursor = hit ? ('corner' in hit ? 'move' : 'copy') : draft.shape === 'point' ? 'crosshair' : '';
	};

	const startDrag = (e: Ev) => {
		if (!draft.active || draft.phase !== 'review' || draft.whole) return;
		if (e.points && e.points.length > 1) return;
		const hit = hitAt(map, e.point);
		if (!hit || !('corner' in hit)) return;
		e.preventDefault();
		map.dragPan.disable();
		draft.beginChange();
		draft.corner = hit.corner;
		dragging = hit.corner;
	};
	const endDrag = () => {
		if (dragging === null) return;
		// The click that ends a drag isn't a click on the map.
		setTimeout(() => (dragging = null), 0);
		map.dragPan.enable();
	};

	const onKey = (e: KeyboardEvent) => {
		if (!draft.active || e.target !== canvas || e.altKey || e.ctrlKey || e.metaKey) return;
		const c = map.getCenter();
		if (e.key === 'Enter') {
			if (draft.shape === 'point' || draft.phase === 'drawing') draft.add(at(c));
			else return;
		} else if (e.key === 'Backspace') {
			if (draft.phase === 'drawing') draft.undo();
			else if (draft.corner !== null) draft.removeCorner(draft.corner);
			else return;
		} else if (e.key === 'Delete') {
			if (draft.corner === null) return;
			draft.removeCorner(draft.corner);
		} else if (e.key === 'Escape') {
			void draft.escape();
		} else return;
		e.preventDefault();
		e.stopPropagation();
	};

	map.doubleClickZoom.disable();
	map.on('click', onClick);
	map.on('dblclick', onDblClick);
	map.on('mousemove', onMove);
	map.on('touchmove', onMove);
	map.on('mousedown', startDrag);
	map.on('touchstart', startDrag);
	map.on('mouseup', endDrag);
	map.on('touchend', endDrag);
	keysOn.addEventListener('keydown', onKey, true);
	return () => {
		map.off('click', onClick);
		map.off('dblclick', onDblClick);
		map.off('mousemove', onMove);
		map.off('touchmove', onMove);
		map.off('mousedown', startDrag);
		map.off('touchstart', startDrag);
		map.off('mouseup', endDrag);
		map.off('touchend', endDrag);
		keysOn.removeEventListener('keydown', onKey, true);
		map.doubleClickZoom.enable();
		map.dragPan.enable();
		canvas.style.cursor = '';
	};
}
