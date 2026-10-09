// How a draft is drawn on the catchment map (issue #326 C1; docs/maps.md §
// Drawing): one GeoJSON source, `draft`, and the layers over it, in the
// picked feature's colour so it reads as "this one, not saved yet". Pure (no
// MapLibre), so vitest checks it (drawLayers.test.ts); CatchmentMap adds
// them after every style load (a theme switch replaces the style).
import type { MapGeometry, MapPosition } from '$lib/api/types';
import { overlayColours, withAlpha } from '../mapStyle';
import { midpoints, type DraftShape } from './shape';

type Layer = Record<string, unknown> & { id: string; type: string };

export const DRAFT_SOURCE = 'draft';
/**
 * The corners and edge middles, drawn. A pointer grabs them by these sizes,
 * but attachDrawing.ts `hitAt` hit-tests the draft itself, not these layers
 * (MapLibre redraws them a frame or more after each setData), so what
 * draftData draws as a corner or a middle and what `hitAt` hits must change
 * together.
 */
export const DRAFT_CORNER_LAYER = 'draft-corner';
export const DRAFT_MID_LAYER = 'draft-mid';
/** The drawn radius (px) of a corner, the point and an edge's middle, each with its stroke: how far from its centre a click still lands on it. */
export const DRAWN_RADIUS = { corner: 8 + 3, point: 10 + 3, mid: 5 + 2 } as const;

/** The draft's layers, over everything else. */
export function draftLayers(dark: boolean): Layer[] {
	const c = overlayColours(dark);
	const src = { source: DRAFT_SOURCE };
	const role = (r: string) => ['==', ['get', 'role'], r];
	return [
		{ id: 'draft-fill', type: 'fill', ...src, filter: role('shape'), paint: { 'fill-color': withAlpha(c.selected, 0.15) } },
		{ id: 'draft-casing', type: 'line', ...src, filter: ['any', role('shape'), role('band')], paint: { 'line-color': c.casing, 'line-width': 6, 'line-opacity': 0.85 } },
		{ id: 'draft-line', type: 'line', ...src, filter: role('shape'), paint: { 'line-color': c.selected, 'line-width': 3 } },
		// The line from the last corner to the pointer while drawing: dashed, so it reads as "not placed yet".
		{ id: 'draft-band', type: 'line', ...src, filter: role('band'), paint: { 'line-color': c.selected, 'line-width': 2, 'line-dasharray': [2, 2] } },
		// A split's two parts (#326 C2): each filled lightly, its own edge dashed, so the cut reads before it is saved.
		{ id: 'draft-part-fill', type: 'fill', ...src, filter: role('part'), paint: { 'fill-color': ['case', ['==', ['get', 'part'], 1], withAlpha(c.selected, 0.28), withAlpha(c.casing, 0.35)] } },
		{ id: 'draft-part-line', type: 'line', ...src, filter: role('part'), paint: { 'line-color': c.selected, 'line-width': 1.5, 'line-dasharray': [3, 2] } },
		// Where a corner would snap (#326 C2): a hollow ring, larger than a corner so it reads around one.
		{ id: 'draft-snap', type: 'circle', ...src, filter: role('snap'), paint: { 'circle-radius': 11, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': c.selected, 'circle-stroke-width': 2.5 } },
		{ id: DRAFT_MID_LAYER, type: 'circle', ...src, filter: role('mid'), paint: { 'circle-radius': DRAWN_RADIUS.mid - 2, 'circle-color': c.casing, 'circle-stroke-color': c.selected, 'circle-stroke-width': 2 } },
		{
			id: DRAFT_CORNER_LAYER,
			type: 'circle',
			...src,
			filter: role('corner'),
			paint: {
				// ≥ 24 px across with its stroke (WCAG 2.5.8): a point is bigger still, the picked corner filled.
				'circle-radius': ['case', ['==', ['get', 'point'], true], DRAWN_RADIUS.point - 3, DRAWN_RADIUS.corner - 3],
				'circle-color': ['case', ['==', ['get', 'picked'], true], c.selected, c.casing],
				'circle-stroke-color': c.selected,
				'circle-stroke-width': 3
			}
		}
	];
}

export interface DraftView {
	shape: DraftShape;
	coords: readonly MapPosition[];
	phase: 'drawing' | 'review';
	/** A pasted shape of several parts, drawn whole with no corners. */
	whole: MapGeometry | null;
	cursor: MapPosition | null;
	corner: number | null;
	/** Where the pointer would snap (#326 C2), drawn as a ring. */
	snap?: MapPosition | null;
	/** A split's two parts, previewed under the cut (#326 C2). */
	parts?: readonly (readonly MapPosition[])[] | null;
}

type Out = { type: 'Feature'; properties: Record<string, unknown>; geometry: MapGeometry };

/** The `draft` source's data: the shape (or its line so far), the line to the pointer, its corners and, once closed, its edges' middles. */
export function draftData(d: DraftView | null) {
	const features: Out[] = [];
	const fc = () => ({ type: 'FeatureCollection' as const, features });
	if (!d) return fc();
	if (d.whole) {
		features.push({ type: 'Feature', properties: { role: 'shape' }, geometry: d.whole });
		return fc();
	}
	const c = d.coords;
	const drawing = d.phase === 'drawing';
	d.parts?.forEach((p, i) => features.push({ type: 'Feature', properties: { role: 'part', part: i }, geometry: { type: 'Polygon', coordinates: [[...p, p[0]!]] } }));
	if (d.shape === 'polygon' && c.length >= 3 && !drawing) features.push({ type: 'Feature', properties: { role: 'shape' }, geometry: { type: 'Polygon', coordinates: [[...c, c[0]!]] } });
	else if (d.shape !== 'point' && c.length >= 2) features.push({ type: 'Feature', properties: { role: 'shape' }, geometry: { type: 'LineString', coordinates: [...c] } });
	if (drawing && d.shape !== 'point' && d.cursor && c.length) {
		// To the pointer, and for a polygon back to the first corner, so the closing edge shows before the click.
		const band = d.shape === 'polygon' && c.length >= 2 ? [c[c.length - 1]!, d.cursor, c[0]!] : [c[c.length - 1]!, d.cursor];
		features.push({ type: 'Feature', properties: { role: 'band' }, geometry: { type: 'LineString', coordinates: band } });
	}
	if (!drawing) for (const m of midpoints(d.shape, c)) features.push({ type: 'Feature', properties: { role: 'mid', after: m.after }, geometry: { type: 'Point', coordinates: m.at } });
	c.forEach((p, i) => features.push({ type: 'Feature', properties: { role: 'corner', index: i, picked: i === d.corner, point: d.shape === 'point' }, geometry: { type: 'Point', coordinates: p } }));
	if (d.snap) features.push({ type: 'Feature', properties: { role: 'snap' }, geometry: { type: 'Point', coordinates: d.snap } });
	return fc();
}
