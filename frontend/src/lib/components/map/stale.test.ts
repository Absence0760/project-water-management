// Values accepted from the map that a map edit left stale (stale.ts, issue #646 F7/F8): each acceptance against the
// map now. Synthetic shapes and names only.
import { describe, expect, it } from 'vitest';
import type { MapAcceptances, MapFeature, MapFeatureKind, MapNodeArea, StartProposal } from '#lib/api/types.js';
import { boundaryOf, outlineChanged, restOfCatchment, staleValues, unitPolygonOf } from './stale';

const square = (x: number) => ({ type: 'Polygon' as const, coordinates: [[[x, -34], [x + 0.02, -34], [x + 0.02, -33.98], [x, -33.98], [x, -34]]] as [number, number][][] });
const feature = (id: string, kind: MapFeatureKind, over: Partial<MapFeature> = {}): MapFeature => ({
	id,
	kind,
	name: id,
	nodeId: null,
	nodeName: null,
	damPosition: null,
	geometry: square(21),
	properties: {},
	areaM2: 4e6,
	center: [21.01, -33.99],
	nonContributingM2: null,
	sourceId: null,
	createdBy: null,
	createdAt: '2026-10-01T00:00:00.000Z',
	updatedAt: '2026-10-01T00:00:00.000Z',
	...over
});
const unit = (id: string, over: Partial<MapNodeArea> = {}): MapNodeArea => ({ id, name: id.toUpperCase(), kind: 'farm', areaKm2: 4, areaSource: 'map', areaBasis: 'gross', areaFeatureId: null, ...over });
const stamp = (featureId: string, updatedAt = '2026-10-01T00:00:00.000Z', areaM2 = 4e6) => ({ featureId, updatedAt, areaM2 });
const none: MapAcceptances = { unitMap: [], unitRain: [], landCover: [], evaporation: [] };

describe('outlineChanged', () => {
	it('is another outline when the polygon is gone, another one, or edited with another area', () => {
		const f = feature('p', 'farm_parcel');
		expect(outlineChanged(stamp('p'), f)).toBe(false);
		expect(outlineChanged(stamp('p'), null)).toBe(true);
		expect(outlineChanged(stamp('q'), f)).toBe(true);
		expect(outlineChanged(stamp('p', '2026-09-01T00:00:00.000Z', 3e6), f)).toBe(true);
		// A rename or relink bumps updatedAt but keeps the area: the same outline.
		expect(outlineChanged(stamp('p', '2026-09-01T00:00:00.000Z', 4e6 + 0.4), f)).toBe(false);
	});
});

describe('unitPolygonOf and boundaryOf', () => {
	it('takes the area feature (a parcel or an other area) first, else the only linked parcel (backend unitPolygon.ts)', () => {
		const other = feature('o', 'other');
		const p1 = feature('p1', 'farm_parcel', { nodeId: 'a' });
		const p2 = feature('p2', 'farm_parcel', { nodeId: 'a' });
		expect(unitPolygonOf(unit('a', { areaFeatureId: 'o' }), [other, p1, p2])?.id).toBe('o');
		expect(unitPolygonOf(unit('a'), [p1])?.id).toBe('p1');
		expect(unitPolygonOf(unit('a'), [p1, p2])).toBeNull();
		expect(unitPolygonOf(unit('a', { areaFeatureId: 'gone' }), [])).toBeNull();
	});

	it('picks the oldest boundary, as the server does', () => {
		const late = feature('b2', 'catchment_boundary', { createdAt: '2026-10-02T00:00:00.000Z' });
		const early = feature('b1', 'catchment_boundary');
		expect(boundaryOf([late, early])?.id).toBe('b1');
		expect(boundaryOf([feature('p', 'farm_parcel')])).toBeNull();
	});
});

describe('staleValues', () => {
	const p = feature('p', 'farm_parcel', { nodeId: 'a' });
	const redrawn = feature('p', 'farm_parcel', { nodeId: 'a', updatedAt: '2026-10-05T00:00:00.000Z', areaM2: 5e6 });
	const bd = feature('bd', 'catchment_boundary', { areaM2: 50e6 });
	const accepted: MapAcceptances = {
		unitMap: [{ nodeId: 'a', polygon: stamp('p') }],
		unitRain: [{ nodeId: 'a', featureId: 'p', updatedAt: '2026-10-01T00:00:00.000Z', areaKm2: 4 }],
		landCover: [{ nodeId: 'a', cropId: 'c', cropName: 'Citrus', polygons: [stamp('p')] }],
		evaporation: [
			{ target: 'pe', boundary: stamp('bd', '2026-10-01T00:00:00.000Z', 50e6) },
			{ target: 'apan', boundary: null }
		]
	};

	it('is empty while every outline is the one read, and without acceptances', () => {
		expect(staleValues([p, bd], [unit('a')], accepted)).toEqual([]);
		expect(staleValues([redrawn, bd], [unit('a')], none)).toEqual([]);
		expect(staleValues([redrawn, bd], [unit('a')], undefined)).toEqual([]);
	});

	it('names the unit’s MAP, rain and land cover after its polygon is redrawn, and the evaporation after the boundary is', () => {
		const bd2 = { ...bd, updatedAt: '2026-10-06T00:00:00.000Z', areaM2: 52e6 };
		expect(staleValues([redrawn, bd2], [unit('a')], accepted)).toEqual([
			{ kind: 'unit-map', nodeId: 'a', featureId: 'p' },
			{ kind: 'unit-rain', nodeId: 'a', featureId: 'p' },
			{ kind: 'land-cover', nodeId: 'a', featureId: 'p', what: 'Citrus' },
			// The A-pan row from before 273 records no boundary: nothing to compare.
			{ kind: 'evaporation', nodeId: null, featureId: 'bd', what: 'GR4J’s PE' }
		]);
	});

	it('compares the rain mark at its 0.001 km², and skips units no longer in the model', () => {
		const nudged = { ...p, updatedAt: '2026-10-05T00:00:00.000Z', areaM2: 4e6 + 200 };
		expect(staleValues([nudged, bd], [unit('a')], { ...none, unitRain: accepted.unitRain })).toEqual([]);
		expect(staleValues([redrawn, bd], [unit('z')], accepted)).toEqual([]);
	});
});

describe('restOfCatchment', () => {
	const plan = { rest: { name: 'Rest of the catchment', areaM2: 30e6, geometry: null }, catchment: { areaM2: null, boundaryAreaM2: 200e6 } };
	const applied = (decision: unknown, over: Record<string, unknown> = {}) => ({ mode: 'start', status: 'applied', plan: { ...plan, ...over }, decision }) as unknown as StartProposal;

	it('reads the rest Start kept with its area beside units’ boundaries', () => {
		expect(restOfCatchment([applied({ rest: { nodeId: 'r', area: true } })])).toEqual({ nodeId: 'r', takenKm2: 30, boundaryKm2Then: 200 });
	});

	it('is null without an applied Start, a rest kept without its area, an effective area or a rest with an outline', () => {
		expect(restOfCatchment(null)).toBeNull();
		expect(restOfCatchment([{ ...applied({ rest: { nodeId: 'r', area: true } }), status: 'proposed' }])).toBeNull();
		expect(restOfCatchment([applied({ rest: { nodeId: 'r', area: false } })])).toBeNull();
		expect(restOfCatchment([applied({ rest: { nodeId: 'r', area: true, areaBasis: 'effective' } })])).toBeNull();
		expect(restOfCatchment([applied({ rest: { nodeId: 'r', area: true } }, { rest: { ...plan.rest, geometry: square(21) } })])).toBeNull();
		expect(restOfCatchment([applied(null)])).toBeNull();
	});
});
