// The catchment map's style (mapStyle.ts): no basemap without a tiles URL, a
// self-hosted PMTiles basemap with its attribution and no glyphs with one,
// and overlay layers that tell features apart by more than colour.
import { describe, expect, it } from 'vitest';
import type { MapFeature } from '$lib/api/types';
import { BASEMAP_ATTRIBUTION, basemapLayerIds, basemapStyle, overlayColours, overlayData, overlayLayers } from './mapStyle';

/** Relative luminance and contrast ratio (WCAG 2.2). */
function lum(hex: string): number {
	const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
	return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
const contrast = (a: string, b: string) => {
	const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
	return (x! + 0.05) / (y! + 0.05);
};

describe('basemapStyle', () => {
	it('is a plain background with no tiles URL: nothing is fetched (a fresh clone, CI)', () => {
		const s = basemapStyle(null, false);
		expect(s.sources).toEqual({});
		expect(s.layers.map((l) => l.id)).toEqual(['background']);
		expect(basemapLayerIds(s)).toEqual([]);
	});

	it('reads one PMTiles file with the Protomaps attribution, and asks for no glyphs or sprite', () => {
		const s = basemapStyle('http://localhost:9002/tiles/south-africa.pmtiles', true);
		expect(s.sources.basemap).toEqual({ type: 'vector', url: 'pmtiles://http://localhost:9002/tiles/south-africa.pmtiles', attribution: BASEMAP_ATTRIBUTION });
		expect(s).not.toHaveProperty('glyphs');
		expect(s).not.toHaveProperty('sprite');
		expect(s.layers.some((l) => l.type === 'symbol')).toBe(false);
		expect(basemapLayerIds(s).length).toBeGreaterThan(3);
	});
});

describe('overlay', () => {
	it('draws the boundary dashed, other features dotted, parcels solid', () => {
		const layers = overlayLayers(false);
		const paint = (id: string) => layers.find((l) => l.id === id)!.paint as Record<string, unknown>;
		expect(paint('ov-boundary')['line-dasharray']).toEqual([4, 2]);
		expect(paint('ov-other-line')['line-dasharray']).toEqual([1, 1.5]);
		expect(paint('ov-parcel-line')).not.toHaveProperty('line-dasharray');
	});

	it('keeps every overlay colour at least 3:1 against the basemap’s land and background, light and dark', () => {
		for (const dark of [false, true]) {
			const c = overlayColours(dark);
			const grounds = dark ? ['#161917', '#1d211e'] : ['#eef0ea', '#e4e7df'];
			for (const colour of [c.boundary, c.parcel, c.water, c.other, c.selected]) for (const g of grounds) expect(contrast(colour, g), `${colour} on ${g}`).toBeGreaterThanOrEqual(3);
		}
	});

	it('feeds the source polygons and lines only (points are markers), marking the selected one', () => {
		const base = { name: '', nodeId: null, nodeName: null, properties: {}, center: [0, 0] as [number, number], sourceId: null, createdBy: null, createdAt: '', updatedAt: '' };
		const fs: MapFeature[] = [
			{ ...base, id: 'a', kind: 'gauge', geometry: { type: 'Point', coordinates: [0, 0] }, areaM2: null },
			{ ...base, id: 'b', kind: 'river', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, areaM2: null }
		];
		const d = overlayData(fs, 'b');
		expect(d.features.map((f) => f.properties)).toEqual([{ id: 'b', kind: 'river', name: '', selected: true }]);
	});
});
