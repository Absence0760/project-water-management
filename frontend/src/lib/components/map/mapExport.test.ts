// Download GeoJSON (mapExport.ts, issue #326 A7): every feature as an RFC 7946
// Feature with its name, kind, node and area (and a licensed source's credit), nothing else, and a file name
// from the project's name and the day.
import { describe, expect, it } from 'vitest';
import type { MapFeature } from '$lib/api/types';
import { HYDRORIVERS_MAP_ATTRIBUTION } from '$lib/components/legal/dataCredits';
import { exportFileName, featuresGeoJson, geoJsonText } from './mapExport';

const base = { nodeId: null, nodeName: null, properties: { description: 'kept out' }, center: [0, 0] as [number, number], sourceId: 'src-1', createdBy: 'user-1', createdAt: '2026-10-01', updatedAt: '2026-10-01' };
const ring: [number, number][] = [[21.3, -33.7], [21.4, -33.7], [21.4, -33.6], [21.3, -33.7]];
const fs: MapFeature[] = [
	{ ...base, id: 'b', kind: 'catchment_boundary', name: 'Synthetic catchment', geometry: { type: 'Polygon', coordinates: [ring] }, areaM2: 61_234_567.891 },
	{ ...base, id: 'p', kind: 'farm_parcel', name: 'Upper farm', nodeId: 'n1', nodeName: 'Upper farm', geometry: { type: 'Polygon', coordinates: [ring] }, areaM2: 9_257_000 },
	{ ...base, id: 'g', kind: 'gauge', name: 'Weir', nodeId: 'n2', nodeName: 'Outflow weir', geometry: { type: 'Point', coordinates: [21.35, -33.65] }, areaM2: null },
	{ ...base, id: 'r', kind: 'river', name: '', geometry: { type: 'LineString', coordinates: [[21.3, -33.7], [21.4, -33.6]] }, areaM2: null }
] as MapFeature[];

describe('featuresGeoJson', () => {
	it('is a FeatureCollection of every feature, in order, geometries untouched (WGS84, no crs member)', () => {
		const fc = featuresGeoJson(fs);
		expect(fc.type).toBe('FeatureCollection');
		expect(fc).not.toHaveProperty('crs');
		expect(fc.features).toHaveLength(4);
		expect(fc.features.map((f) => f.geometry)).toEqual(fs.map((f) => f.geometry));
		expect(fc.features.every((f) => f.type === 'Feature')).toBe(true);
	});

	it('carries the name, kind, node and area only: no ids, sources, users or imported properties', () => {
		const props = featuresGeoJson(fs).features.map((f) => f.properties);
		expect(props).toEqual([
			{ name: 'Synthetic catchment', kind: 'catchment_boundary', node: null, areaKm2: 61.234568, areaHa: 6123.4568 },
			{ name: 'Upper farm', kind: 'farm_parcel', node: 'Upper farm', areaKm2: 9.257, areaHa: 925.7 },
			{ name: 'Weir', kind: 'gauge', node: 'Outflow weir', areaKm2: null, areaHa: null },
			{ name: '', kind: 'river', node: null, areaKm2: null, areaHa: null }
		]);
		expect(JSON.stringify(featuresGeoJson(fs))).not.toMatch(/src-1|user-1|kept out|"id"/);
	});

	it('carries a licensed source’s credit with the data drawn from it, and on no other feature', () => {
		const base = fs[3]!;
		const hydro = { ...base, properties: { ref: 'river-network:HydroRIVERS-v10:1050000001' } };
		const traced = { ...base, kind: 'dam' as const, properties: { description: 'Traced from JRC occurrence ≥ 50 %. Check it against the map. Source: EC JRC/Google.' } };
		const own = { ...base, properties: { description: 'Drawn by hand', ref: 'river-network:synthetic:9' } };
		const props = featuresGeoJson([hydro, traced, own]).features.map((f) => f.properties);
		expect(props.map((p) => p.credit)).toEqual([HYDRORIVERS_MAP_ATTRIBUTION, 'Source: EC JRC/Google', undefined]);
		expect(props[2]).not.toHaveProperty('credit');
		// The credit is all of the source that leaves: never the ref or the description itself.
		expect(JSON.stringify(props)).not.toMatch(/river-network|Traced from|Drawn by hand/);
	});

	it('writes compact JSON that parses back to the same collection', () => {
		const text = geoJsonText(fs);
		expect(text.endsWith('\n')).toBe(true);
		expect(JSON.parse(text)).toEqual(featuresGeoJson(fs));
		expect(JSON.parse(geoJsonText([]))).toEqual({ type: 'FeatureCollection', features: [] });
	});
});

describe('exportFileName', () => {
	it('names the file after the project and the day, plain and short', () => {
		expect(exportFileName('Example · Sandspruit', '2026-10-01')).toBe('example-sandspruit-map-2026-10-01.geojson');
		expect(exportFileName('Bérgrivier (upper)', '2026-10-01')).toBe('bergrivier-upper-map-2026-10-01.geojson');
		expect(exportFileName('  ', '2026-10-01')).toBe('catchment-map-2026-10-01.geojson');
		expect(exportFileName(null, '2026-10-01')).toBe('catchment-map-2026-10-01.geojson');
		expect(exportFileName('x'.repeat(100), '2026-10-01')).toBe(`${'x'.repeat(60)}-map-2026-10-01.geojson`);
	});
});
