// The pure parts of Start from the map's units drawn as their boundaries (start-16, #523 C1; #90 "Abstraction points from
// Start from the map / Divide"): which unit each dam and abstraction point is part of, the rest beside the boundaries, the
// boundary's area against the elevation model's, and a stored plan from before.
import { describe, expect, it } from 'vitest';
import type { Geometry } from '../geo/geojson.js';
import { assignMembers, boundaryCheck, madeBeforeBoundaries, restBesideBoundaries } from './start.js';

const square = (x0: number, y0: number, x1: number, y1: number): Geometry => ({ type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] });
const pt = (x: number, y: number): Geometry => ({ type: 'Point', coordinates: [x, y] });

describe('assignMembers', () => {
	const units = [
		{ key: 'upper', geometry: square(20, -33.5, 21, -33) },
		{ key: 'lower', geometry: square(20, -34, 21, -33.5) }
	];
	it('makes each dam part of the composite dam, and each abstraction point the river pump, of the unit whose boundary holds it', () => {
		const r = assignMembers(
			units,
			[
				{ featureId: 'd1', name: 'Top dam', role: 'dam', geometry: pt(20.5, -33.2) },
				{ featureId: 'p1', name: 'Top pump', role: 'abstraction', geometry: pt(20.6, -33.3) },
				// A dam drawn as its outline: by its centre.
				{ featureId: 'd2', name: 'Low dam', role: 'dam', geometry: square(20.4, -33.8, 20.5, -33.7) }
			],
			null
		);
		expect(r.byUnit.get('upper')).toEqual([
			{ featureId: 'd1', name: 'Top dam', role: 'dam' },
			{ featureId: 'p1', name: 'Top pump', role: 'abstraction' }
		]);
		expect(r.byUnit.get('lower')).toEqual([{ featureId: 'd2', name: 'Low dam', role: 'dam' }]);
		expect(r.rest).toEqual([]);
		expect(r.dropped).toEqual([]);
	});

	it('puts a point in no unit’s boundary with the rest of the catchment, and drops one outside the catchment boundary', () => {
		const boundary = square(19, -35, 22, -32);
		const r = assignMembers(
			units,
			[
				{ featureId: 'in', name: 'Side pump', role: 'abstraction', geometry: pt(21.5, -33.5) },
				{ featureId: 'out', name: 'Far dam', role: 'dam', geometry: pt(25, -33.5) }
			],
			boundary
		);
		expect(r.rest).toEqual([{ featureId: 'in', name: 'Side pump', role: 'abstraction' }]);
		expect(r.dropped).toEqual([{ featureId: 'out', name: 'Far dam', reason: 'is outside the catchment boundary' }]);
		// Without a catchment boundary nothing is outside it: the far dam is with the rest too.
		expect(assignMembers(units, [{ featureId: 'out', name: 'Far dam', role: 'dam', geometry: pt(25, -33.5) }], null).rest).toHaveLength(1);
	});
});

describe('restBesideBoundaries', () => {
	it('is the catchment less the units’ boundaries, never below nothing, and unknown without a catchment area', () => {
		expect(restBesideBoundaries(100e6, [40e6, 50e6])).toEqual({ areaM2: 10e6, warning: null });
		// A few per cent over (boundaries drawn a little past the ridge): nothing left, no warning.
		expect(restBesideBoundaries(100e6, [50e6, 55e6])).toEqual({ areaM2: 0, warning: null });
		expect(restBesideBoundaries(null, [40e6])).toEqual({ areaM2: null, warning: null });
	});
	it('warns when the boundaries add up past the catchment by more than a tenth', () => {
		const r = restBesideBoundaries(100e6, [60e6, 60e6]);
		expect(r.areaM2).toBe(0);
		expect(r.warning).toBe('The units’ boundaries add up to 120.00 km², more than the catchment’s 100.00 km²: do they overlap, or reach past the catchment? Check them on the map.');
	});
});

describe('boundaryCheck', () => {
	it('says nothing within a tenth, or with no elevation model’s figure', () => {
		expect(boundaryCheck('Upper', 10e6, 10.9e6)).toBeNull();
		expect(boundaryCheck('Upper', 10e6, undefined)).toBeNull();
		expect(boundaryCheck('Upper', null, 5e6)).toBeNull();
	});
	it('names the unit and both areas when they differ by more, the boundary’s kept', () => {
		expect(boundaryCheck('Upper', 10e6, 12e6)).toBe(
			'Upper’s boundary is 10.00 km², but what drains to its outflow and to no unit above it is 12.00 km² on the elevation model. The area follows your boundary; check it, and the units around it, against the map.'
		);
	});
});

describe('madeBeforeBoundaries', () => {
	it('tells a stored plan with a unit at a dam or an abstraction point (before start-16) from one of boundaries', () => {
		expect(madeBeforeBoundaries([{ role: 'dam' }, { role: 'gauge' }])).toBe(true);
		expect(madeBeforeBoundaries([{ role: 'abstraction' }])).toBe(true);
		expect(madeBeforeBoundaries([{ role: 'unit' }, { role: 'user' }, { role: 'gauge' }])).toBe(false);
		expect(madeBeforeBoundaries([])).toBe(false);
	});
});
