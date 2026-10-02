// How a draft is drawn (drawLayers.ts): what the `draft` source holds in each phase.
import { describe, expect, it } from 'vitest';
import type { MapPosition } from '$lib/api/types';
import { DRAFT_CORNER_LAYER, DRAFT_MID_LAYER, draftData, draftLayers } from './drawLayers';

const c: MapPosition[] = [
	[21, -34],
	[22, -34],
	[22, -33]
];
const roles = (d: ReturnType<typeof draftData>) => d.features.map((f) => f.properties.role);

describe('draftData', () => {
	it('is empty with no draft', () => {
		expect(draftData(null).features).toEqual([]);
	});
	it('while drawing: the line so far, the band to the pointer back to the first corner, the corners, no middles', () => {
		const d = draftData({ shape: 'polygon', coords: c, phase: 'drawing', whole: null, cursor: [21, -33], corner: null });
		expect(roles(d)).toEqual(['shape', 'band', 'corner', 'corner', 'corner']);
		expect(d.features[0]!.geometry.type).toBe('LineString');
		expect(d.features[1]!.geometry).toEqual({ type: 'LineString', coordinates: [c[2], [21, -33], c[0]] });
	});
	it('once closed: the polygon, a middle per edge, the corners with the picked one marked', () => {
		const d = draftData({ shape: 'polygon', coords: c, phase: 'review', whole: null, cursor: null, corner: 1 });
		expect(roles(d)).toEqual(['shape', 'mid', 'mid', 'mid', 'corner', 'corner', 'corner']);
		expect(d.features[0]!.geometry.type).toBe('Polygon');
		expect(d.features.filter((f) => f.properties.picked).map((f) => f.properties.index)).toEqual([1]);
	});
	it('a point is one big corner; a pasted shape of several parts is drawn whole', () => {
		expect(draftData({ shape: 'point', coords: [c[0]!], phase: 'review', whole: null, cursor: null, corner: null }).features[0]!.properties).toMatchObject({ role: 'corner', point: true });
		const whole = { type: 'MultiLineString' as const, coordinates: [c, c] };
		expect(draftData({ shape: 'line', coords: [], phase: 'review', whole, cursor: null, corner: null }).features).toEqual([{ type: 'Feature', properties: { role: 'shape' }, geometry: whole }]);
	});
	it('draws where the pointer would snap as a ring, and a split’s two parts under the cut (#326 C2)', () => {
		const d = draftData({ shape: 'line', coords: [c[0]!, c[1]!], phase: 'review', whole: null, cursor: null, corner: null, snap: c[2]!, parts: [[c[0]!, c[1]!, c[2]!], [c[1]!, c[2]!, c[0]!]] });
		expect(d.features.filter((f) => f.properties.role === 'snap').map((f) => f.geometry)).toEqual([{ type: 'Point', coordinates: c[2] }]);
		const parts = d.features.filter((f) => f.properties.role === 'part');
		expect(parts.map((f) => f.properties.part)).toEqual([0, 1]);
		expect(parts[0]!.geometry).toEqual({ type: 'Polygon', coordinates: [[c[0], c[1], c[2], c[0]]] });
	});
});

describe('draftLayers', () => {
	it('has the corner and middle layers the pointer grabs, last so they draw on top', () => {
		for (const dark of [false, true]) expect(draftLayers(dark).slice(-2).map((l) => l.id)).toEqual([DRAFT_MID_LAYER, DRAFT_CORNER_LAYER]);
	});
});
