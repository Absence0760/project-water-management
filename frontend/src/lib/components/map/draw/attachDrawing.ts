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
// corner (places or moves the point) at the crosshair, or, while the mouse
// is over the map (moved there since the map took the focus and since the
// last arrow key or touch), at the mouse pointer, where the person is
// looking; Backspace removes the
// last corner while drawing (the picked one after), Delete the picked one,
// Escape cancels (asking first when that would drop work: Draft.escape).
//
// Snapping (#326 C2, draw/snap.ts): with the draft's snapping on, every
// corner placed, dragged or inserted, and every point placed, lands on the
// nearest other feature's corner or edge within 12 px, by pointer or by
// Enter; Alt held with the click (or Alt+Enter) places it exactly where it
// is. Where it would snap shows as a ring while the pointer moves.
import type { MapPosition } from '$lib/api/types';
import type { Draft } from './draft.svelte';
import { DRAWN_RADIUS } from './drawLayers';
import { midpoints } from './shape';
import { SNAP_PX, snapPoint, type SnapHit } from './snap';

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
	unproject(point: [number, number]): LngLat;
	project(lngLat: [number, number]): Pt;
	doubleClickZoom: { enable(): void; disable(): void };
	dragPan: { enable(): void; disable(): void };
}

const at = (l: LngLat): MapPosition => [round(l.lng), round(l.lat)];
/** 7 decimals (~1 cm), the server's own rounding. */
const round = (v: number) => Math.round(v * 1e7) / 1e7;
/** How far beyond a drawn corner or middle (px) a click still hits it: well over a 24 px target (WCAG 2.5.8). */
const HIT = 12;

/**
 * What is under a screen point: a corner's index, an edge's middle, or
 * nothing. Read from the draft itself, projected to the screen, not from the
 * rendered `draft-corner`/`draft-mid` layers: MapLibre redraws those a frame
 * or more after each `setData`, so a click on the first corner right after
 * the last was placed could miss it and add another corner instead of
 * closing the shape (e2e map-draw.spec.ts, "with the mouse"). The same
 * corners and middles `draftData` draws (none for a whole pasted shape, the
 * middles only once drawn), reached as the rendered layers were: a drawn
 * circle (DRAWN_RADIUS) touching the HIT box around the click. The nearest
 * centre wins, a corner over any middle.
 */
function hitAt(map: DrawMap, draft: Draft, p: Pt): { corner: number } | { mid: number } | null {
	if (draft.whole) return null;
	const nearest = (points: readonly MapPosition[], r: number): number | null => {
		let best: number | null = null;
		let bestD = Infinity;
		for (let i = 0; i < points.length; i++) {
			const s = map.project([points[i]![0], points[i]![1]]);
			const dx = Math.abs(s.x - p.x);
			const dy = Math.abs(s.y - p.y);
			// The circle touches the box when its centre is within r of the box.
			const ox = Math.max(0, dx - HIT);
			const oy = Math.max(0, dy - HIT);
			if (ox * ox + oy * oy > r * r) continue;
			const d = dx * dx + dy * dy;
			if (d < bestD) {
				bestD = d;
				best = i;
			}
		}
		return best;
	};
	const corner = nearest(draft.coords, draft.shape === 'point' ? DRAWN_RADIUS.point : DRAWN_RADIUS.corner);
	if (corner !== null) return { corner };
	if (draft.phase === 'drawing') return null;
	const mids = midpoints(draft.shape, draft.coords);
	const mid = nearest(
		mids.map((m) => m.at),
		DRAWN_RADIUS.mid
	);
	return mid === null ? null : { mid: mids[mid]!.after };
}

/**
 * Attach the drawing mode to `map` while `draft` is active; returns the
 * detach. `keysOn` is the element whose keydown it reads (the map's box).
 * `onaim` hears where Enter adds: `true` at the mouse pointer, `false` at
 * the crosshair (the map's middle), so the map can hide the crosshair while
 * Enter won't use it.
 */
export function attachDrawing(map: DrawMap, draft: Draft, keysOn: HTMLElement, onaim?: (atPointer: boolean) => void): () => void {
	let dragging: number | null = null;
	const canvas = map.getCanvas();
	/** The mouse over the map (a screen point, so a zoom under it still reads right), or null: Enter adds at the crosshair. */
	let pointer: Pt | null = null;
	const aim = (p: Pt | null) => {
		if (!!p !== !!pointer) onaim?.(!!p);
		pointer = p;
	};
	/** A touch, and the mouse events a browser makes up after a tap for a while: never the pointer. */
	let touchedAt = -Infinity;
	const TOUCH_GHOST_MS = 1000;
	const onMouseMove = (e: Ev) => {
		if (performance.now() - touchedAt > TOUCH_GHOST_MS) aim(e.point);
	};
	const onTouch = () => {
		touchedAt = performance.now();
		aim(null);
	};
	const onMouseOut = () => {
		aim(null);
		draft.snapHint = null;
	};
	// The focus arriving (a Tab to the map, Place a point's button): the crosshair, until the mouse moves over the map.
	const onFocus = () => aim(null);

	/** Where a screen point places a corner: on another feature's corner or edge within reach (snapping on, Alt not held), else where it is. */
	const placeAt = (pt: Pt, raw: MapPosition, exact: boolean): { p: MapPosition; hit: SnapHit | null } => {
		if (exact || !draft.snapOn || !draft.snapTargets.length) return { p: raw, hit: null };
		const a = map.unproject([pt.x - SNAP_PX, pt.y - SNAP_PX]);
		const b = map.unproject([pt.x + SNAP_PX, pt.y + SNAP_PX]);
		const box = [Math.min(a.lng, b.lng), Math.min(a.lat, b.lat), Math.max(a.lng, b.lng), Math.max(a.lat, b.lat)] as const;
		const hit = snapPoint(pt, draft.snapTargets, (q) => map.project([q[0], q[1]]), SNAP_PX, box);
		return hit ? { p: hit.at, hit } : { p: raw, hit: null };
	};
	const altOf = (e: Ev) => !!(e.originalEvent as MouseEvent | undefined)?.altKey;
	const placed = (e: Ev) => placeAt(e.point, at(e.lngLat), altOf(e));

	const onClick = (e: Ev) => {
		if (!draft.active || dragging !== null) return;
		const hit = hitAt(map, draft, e.point);
		if (draft.phase === 'drawing' && draft.shape !== 'point') {
			const n = draft.coords.length;
			if (hit && 'corner' in hit) {
				// On a corner: the first closes a polygon, the last (a second click there) finishes; any other adds nothing.
				if (draft.canFinish && ((draft.shape === 'polygon' && hit.corner === 0) || hit.corner === n - 1)) draft.finish();
				return;
			}
			const s = placed(e);
			draft.add(s.p, s.hit);
			return;
		}
		if (hit && 'mid' in hit) draft.insertCorner(hit.mid, placed(e).p);
		else if (hit && 'corner' in hit) draft.corner = hit.corner;
		else if (draft.shape === 'point') {
			const s = placed(e);
			draft.add(s.p, s.hit);
		} else draft.corner = null;
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
			const s = placed(e);
			draft.snapHint = s.hit;
			draft.moveCorner(dragging, s.p);
			return;
		}
		if (draft.phase === 'drawing' && draft.shape !== 'point') {
			const s = placed(e);
			draft.snapHint = s.hit;
			draft.cursor = s.p;
			canvas.style.cursor = 'crosshair';
			return;
		}
		draft.snapHint = draft.shape === 'point' ? placed(e).hit : null;
		const hit = draft.phase === 'review' ? hitAt(map, draft, e.point) : null;
		canvas.style.cursor = hit ? ('corner' in hit ? 'move' : 'copy') : draft.shape === 'point' ? 'crosshair' : '';
	};

	const startDrag = (e: Ev) => {
		if (!draft.active || draft.phase !== 'review' || draft.whole) return;
		if (e.points && e.points.length > 1) return;
		const hit = hitAt(map, draft, e.point);
		if (!hit || !('corner' in hit)) return;
		e.preventDefault();
		map.dragPan.disable();
		draft.beginChange();
		draft.corner = hit.corner;
		dragging = hit.corner;
	};
	const endDrag = () => {
		if (dragging === null) return;
		draft.snapHint = null;
		// The click that ends a drag isn't a click on the map.
		setTimeout(() => (dragging = null), 0);
		map.dragPan.enable();
	};

	const onKey = (e: KeyboardEvent) => {
		// Alt+Enter places exactly, without snapping; any other key with Alt, Ctrl or Meta is the browser's.
		if (!draft.active || e.target !== canvas || (e.altKey && e.key !== 'Enter') || e.ctrlKey || e.metaKey) return;
		// The arrow keys move the map under the crosshair: from then, Enter adds there, until the mouse moves again.
		if (e.key.startsWith('Arrow')) {
			aim(null);
			return;
		}
		const c = pointer ? map.unproject([pointer.x, pointer.y]) : map.getCenter();
		if (e.key === 'Enter') {
			if (draft.shape === 'point' || draft.phase === 'drawing') {
				const pt = pointer ?? map.project([c.lng, c.lat]);
				const s = placeAt(pt, at(c), e.altKey);
				draft.add(s.p, s.hit);
			} else return;
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
	map.on('mousemove', onMouseMove);
	map.on('mouseout', onMouseOut);
	map.on('touchstart', onTouch);
	canvas.addEventListener('focus', onFocus);
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
		map.off('mousemove', onMouseMove);
		map.off('mouseout', onMouseOut);
		map.off('touchstart', onTouch);
		canvas.removeEventListener('focus', onFocus);
		map.off('touchmove', onMove);
		map.off('mousedown', startDrag);
		map.off('touchstart', startDrag);
		map.off('mouseup', endDrag);
		map.off('touchend', endDrag);
		keysOn.removeEventListener('keydown', onKey, true);
		map.doubleClickZoom.enable();
		map.dragPan.enable();
		canvas.style.cursor = '';
		aim(null);
	};
}
