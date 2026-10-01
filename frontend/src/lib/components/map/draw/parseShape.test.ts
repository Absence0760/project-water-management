// Paste a shape (parseShape.ts): GeoJSON and WKT in, a geometry or a sentence saying what is wrong out.
import { describe, expect, it } from 'vitest';
import { parseShape } from './parseShape';

const ring = [
	[21.3, -33.6],
	[21.4, -33.6],
	[21.4, -33.7],
	[21.3, -33.6]
];

describe('parseShape: WKT', () => {
	it('reads a polygon, a line, a point and the multis', () => {
		expect(parseShape('POLYGON((21.30 -33.60, 21.40 -33.60, 21.40 -33.70, 21.30 -33.60))')).toEqual({ geometry: { type: 'Polygon', coordinates: [ring] } });
		expect(parseShape('linestring (21.3 -33.6, 21.4 -33.7)')).toEqual({ geometry: { type: 'LineString', coordinates: [ring[0], ring[2]] } });
		expect(parseShape('POINT(21.34 -33.62)')).toEqual({ geometry: { type: 'Point', coordinates: [21.34, -33.62] } });
		expect(parseShape('MULTIPOLYGON(((21.3 -33.6, 21.4 -33.6, 21.4 -33.7, 21.3 -33.6)))')).toEqual({ geometry: { type: 'MultiPolygon', coordinates: [[ring]] } });
		expect(parseShape('MULTILINESTRING((21.3 -33.6, 21.4 -33.7),(21.4 -33.6, 21.3 -33.7))')).toMatchObject({ geometry: { type: 'MultiLineString' } });
	});
	it('closes an outline left open, and takes SRID=4326', () => {
		expect(parseShape('SRID=4326;POLYGON((21.3 -33.6, 21.4 -33.6, 21.4 -33.7))')).toEqual({ geometry: { type: 'Polygon', coordinates: [ring] } });
	});
	it('refuses another SRID, 3D, projected coordinates, unbalanced brackets and unknown types', () => {
		expect(parseShape('SRID=22234;POINT(1 2)')).toEqual({ error: expect.stringMatching(/SRID 22234.*WGS84/) });
		expect(parseShape('POINT Z (21 -33 100)')).toEqual({ error: expect.stringMatching(/3D/) });
		expect(parseShape('POINT(-55000 3720000)')).toEqual({ error: expect.stringMatching(/looks projected/) });
		expect(parseShape('POLYGON((21 -33, 22 -33, 22 -34)')).toEqual({ error: expect.stringMatching(/brackets/) });
		expect(parseShape('MULTIPOINT((21 -33))')).toEqual({ error: expect.stringMatching(/MULTIPOINT/) });
		expect(parseShape('POINT EMPTY')).toEqual({ error: 'The shape is empty.' });
		expect(parseShape('hello')).toEqual({ error: expect.stringMatching(/Paste GeoJSON, or WKT/) });
		expect(parseShape('POINT(21 abc)')).toEqual({ error: expect.stringMatching(/isn’t a number/) });
		expect(parseShape('   ')).toEqual({ error: 'Paste a shape first.' });
	});
});

describe('parseShape: GeoJSON', () => {
	it('reads a geometry, a feature and a collection of one', () => {
		const g = { type: 'Polygon', coordinates: [ring] };
		expect(parseShape(JSON.stringify(g))).toEqual({ geometry: g });
		expect(parseShape(JSON.stringify({ type: 'Feature', properties: {}, geometry: g }))).toEqual({ geometry: g });
		expect(parseShape(JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: g }] }))).toEqual({ geometry: g });
	});
	it('refuses several features, bad JSON, a named projected CRS and a GeometryCollection', () => {
		const f = { type: 'Feature', geometry: { type: 'Point', coordinates: [21, -33] } };
		expect(parseShape(JSON.stringify({ type: 'FeatureCollection', features: [f, f] }))).toEqual({ error: expect.stringMatching(/holds 2 features/) });
		expect(parseShape('{"type":')).toEqual({ error: 'That looks like GeoJSON but isn’t valid JSON.' });
		expect(parseShape(JSON.stringify({ ...f, crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::32734' } } }))).toEqual({ error: expect.stringMatching(/EPSG::32734/) });
		expect(parseShape(JSON.stringify({ type: 'GeometryCollection', geometries: [] }))).toEqual({ error: expect.stringMatching(/GeometryCollection/) });
		expect(parseShape(JSON.stringify({ type: 'Point', coordinates: [21, -33, 5] }))).toEqual({ error: expect.stringMatching(/3D/) });
	});
});
