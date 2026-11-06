import { describe, expect, it } from 'vitest';
import type { MapPosition } from '#lib/api/types.js';
import { unitInsideBoundary } from './unitHint';

describe('one catchment clicked inside the boundary (unitInsideBoundary)', () => {
	const square = (x: number, y: number, s: number): MapPosition[] => [
		[x, y],
		[x + s, y],
		[x + s, y + s],
		[x, y + s],
		[x, y]
	];
	const boundary = { name: 'Upper catchment', areaM2: 19_930_000, geometry: { type: 'Polygon' as const, coordinates: [square(20, -34, 1)] } };

	it('an outlet inside: the boundary named, with its area', () => {
		expect(unitInsideBoundary({ outlet: [20.5, -33.5] }, boundary)).toEqual({ name: 'Upper catchment', areaKm2: 19.93 });
	});
	it('an outlet outside, or no boundary: nothing to say', () => {
		expect(unitInsideBoundary({ outlet: [21.5, -33.5] }, boundary)).toBeNull();
		expect(unitInsideBoundary({ outlet: [20.5, -33.5] }, null)).toBeNull();
	});
	it('a hole is outside; any part of a multipolygon counts; an unnamed boundary', () => {
		const holed = { ...boundary, geometry: { type: 'Polygon' as const, coordinates: [square(20, -34, 1), square(20.4, -33.6, 0.2)] } };
		expect(unitInsideBoundary({ outlet: [20.5, -33.5] }, holed)).toBeNull();
		const multi = { name: '', areaM2: null, geometry: { type: 'MultiPolygon' as const, coordinates: [[square(10, -10, 1)], [square(20, -34, 1)]] } };
		expect(unitInsideBoundary({ outlet: [20.5, -33.5] }, multi)).toEqual({ name: 'the catchment boundary', areaKm2: null });
	});
});
