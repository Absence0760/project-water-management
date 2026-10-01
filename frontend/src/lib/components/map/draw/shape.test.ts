// A drawing's shape (shape.ts): the geometry a draft saves as, what stops it saving, editing an existing feature's corners.
import { describe, expect, it } from 'vitest';
import type { MapPosition } from '$lib/api/types';
import { canFinish, distinctCorners, draftProblem, DRAW_CHOICES, editableCorners, geometryOf, KINDS_FOR_SHAPE, midpoints, outlineCrosses, shapeOf, withoutCorner } from './shape';

const square: MapPosition[] = [
	[21, -34],
	[22, -34],
	[22, -33],
	[21, -33]
];

describe('geometryOf', () => {
	it('closes a polygon and drops a corner repeated by a double click', () => {
		expect(geometryOf('polygon', [...square.slice(0, 3), square[2]!, square[3]!])).toEqual({ type: 'Polygon', coordinates: [[...square, square[0]]] });
	});
	it('is null with too few corners', () => {
		expect(geometryOf('polygon', square.slice(0, 2))).toBeNull();
		expect(geometryOf('line', [square[0]!, square[0]!])).toBeNull();
		expect(geometryOf('point', [])).toBeNull();
	});
	it('makes a line and a point', () => {
		expect(geometryOf('line', square.slice(0, 2))).toEqual({ type: 'LineString', coordinates: square.slice(0, 2) });
		expect(geometryOf('point', [[21.3, -33.6]])).toEqual({ type: 'Point', coordinates: [21.3, -33.6] });
	});
});

describe('draftProblem', () => {
	it('accepts a square, a line of two points and a placed point', () => {
		expect(draftProblem('polygon', square)).toBeNull();
		expect(draftProblem('line', square.slice(0, 2))).toBeNull();
		expect(draftProblem('point', [[21, -33]])).toBeNull();
	});
	it('says what is missing', () => {
		expect(draftProblem('polygon', square.slice(0, 2))).toBe('A shape needs at least three corners.');
		expect(draftProblem('line', square.slice(0, 1))).toBe('A line needs at least two points.');
		expect(draftProblem('point', [])).toBe('Place the point first.');
	});
	it('refuses corners in a line and an outline that crosses itself (a bow tie)', () => {
		expect(draftProblem('polygon', [[21, -34], [21.5, -34], [22, -34]])).toMatch(/no area/);
		const bowTie: MapPosition[] = [square[0]!, square[2]!, square[1]!, square[3]!];
		expect(outlineCrosses(bowTie)).toBe(true);
		expect(draftProblem('polygon', bowTie)).toMatch(/crosses itself/);
		expect(outlineCrosses(square)).toBe(false);
	});
	it('can finish once it has the corners its shape needs', () => {
		expect(canFinish('polygon', square.slice(0, 2))).toBe(false);
		expect(canFinish('polygon', square.slice(0, 3))).toBe(true);
		expect(canFinish('line', [square[0]!, square[0]!])).toBe(false);
	});
});

describe('editing an existing feature', () => {
	it('opens a single-ring polygon, a line and a point corner by corner', () => {
		expect(editableCorners({ type: 'Polygon', coordinates: [[...square, square[0]!]] })).toEqual({ shape: 'polygon', coords: square });
		expect(editableCorners({ type: 'MultiPolygon', coordinates: [[[...square, square[0]!]]] })).toEqual({ shape: 'polygon', coords: square });
		expect(editableCorners({ type: 'LineString', coordinates: square })).toEqual({ shape: 'line', coords: square });
		expect(editableCorners({ type: 'Point', coordinates: [21, -33] })).toEqual({ shape: 'point', coords: [[21, -33]] });
	});
	it('leaves a shape of several parts or with a hole whole', () => {
		const ring = [...square, square[0]!];
		expect(editableCorners({ type: 'MultiPolygon', coordinates: [[ring], [ring]] })).toBeNull();
		expect(editableCorners({ type: 'Polygon', coordinates: [ring, ring] })).toBeNull();
		expect(editableCorners({ type: 'MultiLineString', coordinates: [square, square] })).toBeNull();
	});
	it('puts a middle on every edge, the polygon’s closing edge too', () => {
		expect(midpoints('polygon', square).map((m) => m.after)).toEqual([0, 1, 2, 3]);
		expect(midpoints('polygon', square)[3]!.at).toEqual([21, -33.5]);
		expect(midpoints('line', square).length).toBe(3);
		expect(midpoints('point', [[21, -33]])).toEqual([]);
	});
	it('removes a corner only while the shape keeps enough', () => {
		expect(withoutCorner('polygon', square, 1)).toEqual([square[0], square[2], square[3]]);
		expect(withoutCorner('polygon', square.slice(0, 3), 0)).toBeNull();
		expect(withoutCorner('line', square.slice(0, 2), 0)).toBeNull();
	});
	it('drops the closing repeat when asked', () => {
		expect(distinctCorners([...square, square[0]!], true)).toEqual(square);
	});
});

describe('the draw choices', () => {
	it('each draws a kind the server takes in that shape', () => {
		for (const c of DRAW_CHOICES) expect(KINDS_FOR_SHAPE[c.shape]).toContain(c.kind);
		expect(shapeOf({ type: 'MultiLineString', coordinates: [square] })).toBe('line');
	});
});
