// The catchment map's helpers (mapData.ts): labels, bounds, the coordinates
// form's parsing and an import refusal's problems.
import { describe, expect, it } from 'vitest';
import type { MapFeature, MapNodeArea } from '$lib/api/types';
import { alreadyAccepted, areaTargets, areaText, boundsOf, boundsOfAll, featureSummary, importProblems, parseDegrees, positionText, problemText } from './mapData';

const feature = (over: Partial<MapFeature>): MapFeature => ({
	id: 'f1',
	kind: 'farm_parcel',
	name: 'Parcel',
	nodeId: null,
	nodeName: null,
	geometry: { type: 'Polygon', coordinates: [[[21, -34], [22, -34], [22, -33], [21, -33], [21, -34]]] },
	properties: {},
	areaM2: 12_345_678,
	center: [21.5, -33.5],
	sourceId: null,
	createdBy: null,
	createdAt: '2026-10-01T00:00:00Z',
	updatedAt: '2026-10-01T00:00:00Z',
	...over
});

describe('areaText and positionText', () => {
	it('gives hectares below 1 km², km² with 3 decimals below 10 km² and 2 above', () => {
		expect(areaText(null)).toBe('–');
		expect(areaText(250_000)).toBe('25.00 ha');
		expect(areaText(1_234_567)).toBe('1.235 km²');
		expect(areaText(12_345_678)).toBe('12.35 km²');
	});
	it('writes a position with its hemispheres', () => {
		expect(positionText([21.34, -33.6123])).toBe('33.6123° S, 21.3400° E');
		expect(positionText([-0.5, 51.5])).toBe('51.5000° N, 0.5000° W');
	});
});

describe('featureSummary', () => {
	it('says where a point is, how big a polygon is, and how many lines a river has', () => {
		expect(featureSummary(feature({ geometry: { type: 'Point', coordinates: [21.3, -33.6] }, areaM2: null }))).toBe('33.6000° S, 21.3000° E');
		expect(featureSummary(feature({}))).toBe('12.35 km²');
		expect(featureSummary(feature({ geometry: { type: 'MultiPolygon', coordinates: [[], []] } }))).toBe('12.35 km² in 2 parts');
		expect(featureSummary(feature({ geometry: { type: 'MultiLineString', coordinates: [[], [], []] }, areaM2: null }))).toBe('3 lines');
	});
});

describe('bounds', () => {
	it('frames one geometry and all of them', () => {
		expect(boundsOf(feature({}).geometry)).toEqual([
			[21, -34],
			[22, -33]
		]);
		const point = feature({ id: 'p', geometry: { type: 'Point', coordinates: [25, -30] } });
		expect(boundsOfAll([feature({}), point])).toEqual([
			[21, -34],
			[25, -30]
		]);
		expect(boundsOfAll([])).toBeNull();
	});
});

describe('parseDegrees', () => {
	it('reads decimal degrees, a hemisphere letter, a decimal comma and a degree sign', () => {
		expect(parseDegrees('-33.61', 'lat')).toEqual({ value: -33.61 });
		expect(parseDegrees('33.61 S', 'lat')).toEqual({ value: -33.61 });
		expect(parseDegrees('33,61s', 'lat')).toEqual({ value: -33.61 });
		expect(parseDegrees('21.34° E', 'lon')).toEqual({ value: 21.34 });
		expect(parseDegrees('18 W', 'lon')).toEqual({ value: -18 });
	});
	it('refuses blanks, words, the wrong hemisphere letter and out-of-range values', () => {
		expect(parseDegrees('', 'lat')).toEqual({ error: 'Enter the latitude.' });
		expect(parseDegrees('south', 'lat')).toMatchObject({ error: expect.stringMatching(/decimal degrees/) });
		expect(parseDegrees('33 E', 'lat')).toEqual({ error: 'Latitude takes N or S.' });
		expect(parseDegrees('95', 'lat')).toEqual({ error: 'Latitude is between −90 and 90.' });
		expect(parseDegrees('181', 'lon')).toEqual({ error: 'Longitude is between −180 and 180.' });
	});
});

describe('import problems', () => {
	it('keeps the per-feature problems of a 422 and words them', () => {
		const ps = importProblems([{ feature: 2, message: 'has 3D coordinates (an elevation); export the file in 2D' }, { feature: null, message: 'The file has no features.' }, 'junk']);
		expect(ps.map(problemText)).toEqual(['Feature 2 has 3D coordinates (an elevation); export the file in 2D.', 'The file has no features.']);
		expect(importProblems({ error: 'x' })).toEqual([]);
	});
});

describe('area targets', () => {
	const nodes: MapNodeArea[] = [
		{ id: 'a', name: 'Farm A', kind: 'farm', areaKm2: 12.345678, areaSource: 'map', areaFeatureId: 'f1' },
		{ id: 'w', name: 'Weir', kind: 'gauge', areaKm2: 0, areaSource: 'typed', areaFeatureId: null },
		{ id: 'u', name: 'Town', kind: 'user', areaKm2: 0, areaSource: 'typed', areaFeatureId: null }
	];
	it('offers only farms, and knows when a feature’s area is the one in use', () => {
		expect(areaTargets(nodes).map((n) => n.id)).toEqual(['a']);
		expect(alreadyAccepted(nodes[0]!, feature({}))).toBe(true);
		expect(alreadyAccepted(nodes[0]!, feature({ areaM2: 13e6 }))).toBe(false);
		expect(alreadyAccepted({ ...nodes[0]!, areaSource: 'typed' }, feature({}))).toBe(false);
	});
});
