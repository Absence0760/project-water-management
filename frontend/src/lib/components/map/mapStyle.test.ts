// The catchment map's style (mapStyle.ts): no basemap without a tiles URL, a
// self-hosted PMTiles basemap with its attribution and no glyphs with one,
// and overlay layers that tell features apart by more than colour.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MapFeature } from '$lib/api/types';
import {
	BASEMAP_ATTRIBUTION,
	basemapColours,
	basemapLayerIds,
	basemapStyle,
	fillColour,
	glyphsUrl,
	LABEL_FONTS,
	labelColours,
	mapStyle,
	overlayColours,
	overlayData,
	overlayLayers,
	quaternaryColour,
	quaternaryData,
	quaternaryLayers,
	RESULT_FILL_OPACITY,
	withAlpha
} from './mapStyle';

/** Relative luminance and contrast ratio (WCAG 2.2). */
function lum(hex: string): number {
	const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
	return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
const contrast = (a: string, b: string) => {
	const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
	return (x! + 0.05) / (y! + 0.05);
};
/** CIE76 colour difference (ΔE*ab, D65): about 2 is just noticeable; the old parcel and river blues were 38 (light) and 23 (dark). */
function deltaE(a: string, b: string): number {
	const lab = (hex: string) => {
		const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number];
		const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
		const x = f((r * 0.4124 + g * 0.3576 + bl * 0.1805) / 0.95047);
		const y = f(r * 0.2126 + g * 0.7152 + bl * 0.0722);
		const z = f((r * 0.0193 + g * 0.1192 + bl * 0.9505) / 1.08883);
		return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
	};
	const [p, q] = [lab(a), lab(b)];
	return Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!);
}

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

	it('keeps every overlay colour at least 3:1 against the basemap’s background, land, water and land cover, light and dark', () => {
		for (const dark of [false, true]) {
			const c = overlayColours(dark);
			const b = basemapColours(dark);
			const grounds = [b.bg, b.earth, b.water, b.green];
			for (const colour of [c.boundary, c.parcel, c.water, c.other, c.selected]) for (const g of grounds) expect(contrast(colour, g), `${colour} on ${g}`).toBeGreaterThanOrEqual(3);
		}
	});

	it('keeps the casing at least 3:1 against every stroke it outlines, so a line still reads where the basemap matches it', () => {
		for (const dark of [false, true]) {
			const c = overlayColours(dark);
			for (const colour of [c.boundary, c.parcel, c.water, c.other, c.selected]) expect(contrast(colour, c.casing), `${colour} on its casing`).toBeGreaterThanOrEqual(3);
		}
	});

	it('gives parcels a hue clearly apart from the water blue of rivers and dams, and every stroke colour apart from every other (#326 E7)', () => {
		for (const dark of [false, true]) {
			const c = overlayColours(dark);
			expect(deltaE(c.parcel, c.water), dark ? 'dark' : 'light').toBeGreaterThanOrEqual(60);
			const strokes = { boundary: c.boundary, parcel: c.parcel, water: c.water, other: c.other, selected: c.selected };
			for (const [a, x] of Object.entries(strokes)) for (const [b, y] of Object.entries(strokes)) if (a < b) expect(deltaE(x, y), `${a} vs ${b}, ${dark ? 'dark' : 'light'}`).toBeGreaterThanOrEqual(40);
		}
	});

	it('fills a dam with the water blue, denser than a parcel’s fill, and gives the key every fill it draws', () => {
		for (const dark of [false, true]) {
			const c = overlayColours(dark);
			expect(c.damFill).toBe(withAlpha(c.water, 0.45));
			expect(c.parcelFill).toBe(withAlpha(c.parcel, 0.18));
			expect(c.otherFill).toBe(withAlpha(c.other, 0.18));
			const fill = overlayLayers(dark).find((l) => l.id === 'ov-parcel-fill')!.paint as Record<string, unknown>;
			expect(fill['fill-color']).toEqual(fillColour(c));
			expect(fill['fill-color']).toEqual(['to-color', ['get', 'fill'], ['match', ['get', 'kind'], 'dam', c.damFill, 'other', c.otherFill, c.parcelFill]]);
		}
		expect(withAlpha('#0047b3', 0.45)).toBe('rgba(0, 71, 179, 0.45)');
	});

	it('draws rivers thicker than parcel outlines, on a casing wider than the river', () => {
		const layers = overlayLayers(false);
		const paint = (id: string) => layers.find((l) => l.id === id)!.paint as Record<string, unknown>;
		expect(paint('ov-river')['line-width']).toBeGreaterThan(paint('ov-parcel-line')['line-width'] as number);
		expect(paint('ov-river')['line-color']).toBe(overlayColours(false).water);
		const casing = paint('ov-casing')['line-width'] as unknown[];
		const riverCasing = casing[casing.findIndex((x) => JSON.stringify(x) === JSON.stringify(['==', ['get', 'kind'], 'river'])) + 1] as number;
		expect(riverCasing).toBeGreaterThan(paint('ov-river')['line-width'] as number);
	});

	it('draws a results colour (fills, A1) over a polygon’s kind colour, a little translucent, and only where one is given', () => {
		const fill = overlayLayers(true).find((l) => l.id === 'ov-parcel-fill')!.paint as Record<string, unknown>;
		expect(fill['fill-opacity']).toEqual(['case', ['has', 'fill'], RESULT_FILL_OPACITY, 1]);
	});

	it('builds one style of basemap and overlay, so a theme switch redraws both and keeps the features', () => {
		const data = overlayData([], null);
		for (const dark of [false, true]) {
			const s = mapStyle('http://localhost:9002/tiles/x.pmtiles', dark, data);
			expect(s.sources.features).toEqual({ type: 'geojson', data });
			expect(s.sources.basemap).toBeDefined();
			expect(s.layers.map((l) => l.id)).toEqual([...basemapStyle('x', dark).layers.map((l) => l.id), 'qt-fill', 'qt-line', ...overlayLayers(dark).map((l) => l.id)]);
			expect(s.layers[0]!.paint).toEqual({ 'background-color': basemapColours(dark).bg });
		}
		expect(mapStyle(null, false, data).sources).toEqual({ quaternaries: { type: 'geojson', data: quaternaryData(null) }, features: { type: 'geojson', data } });
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

	it('carries a feature’s results colour only when fills names it', () => {
		const base = { name: '', nodeId: null, nodeName: null, properties: {}, center: [0, 0] as [number, number], sourceId: null, createdBy: null, createdAt: '', updatedAt: '', areaM2: 1 };
		const square: MapFeature['geometry'] = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
		const fs: MapFeature[] = [
			{ ...base, id: 'p1', kind: 'farm_parcel', geometry: square },
			{ ...base, id: 'p2', kind: 'farm_parcel', geometry: square }
		];
		expect(overlayData(fs, null, { p1: '#c0392b', gone: '#000000' }).features.map((f) => f.properties)).toEqual([
			{ id: 'p1', kind: 'farm_parcel', name: '', selected: false, fill: '#c0392b' },
			{ id: 'p2', kind: 'farm_parcel', name: '', selected: false }
		]);
		expect(overlayData(fs, null).features.every((f) => !('fill' in f.properties))).toBe(true);
	});
});

describe('the map shares the app’s colours', () => {
	// MapLibre can't read CSS variables, so the parcel green repeats app.css's --success as hex. Pin it, so a token change can't leave the map behind.
	it('draws parcels in --success, light and dark', () => {
		const css = readFileSync(new URL('../../../app.css', import.meta.url), 'utf8');
		const values = [...css.matchAll(/--success:\s*(#[0-9a-f]{6})/gi)].map((m) => m[1]!.toLowerCase());
		expect(values.length).toBeGreaterThanOrEqual(2);
		expect(values[0]).toBe(overlayColours(false).parcel);
		for (const dark of values.slice(1)) expect(dark).toBe(overlayColours(true).parcel);
	});
});

describe('labels (#326 A6): self-hosted glyphs, none without a glyphs URL', () => {
	const tiles = 'http://localhost:9002/tiles/south-africa.pmtiles';
	const glyphs = 'http://localhost:9002/tiles/fonts/{fontstack}/{range}.pbf';
	const data = overlayData([], null);
	const fontsOf = (l: Record<string, unknown>): string[] => [...(JSON.stringify((l.layout as Record<string, unknown>)['text-font']).match(/Noto Sans \w+/g) ?? [])];

	it('asks for no glyphs and draws no symbol layer without a glyphs URL (the default: a fresh clone and CI fetch nothing)', () => {
		for (const t of [tiles, null]) {
			const s = mapStyle(t, false, data);
			expect(s).not.toHaveProperty('glyphs');
			expect(s.layers.some((l) => l.type === 'symbol')).toBe(false);
		}
	});

	it('with glyphs, draws place and water names over the features, and the quaternaries’ codes, in the self-hosted fonts only', () => {
		for (const dark of [false, true]) {
			const s = mapStyle(tiles, dark, data, { glyphs });
			expect(s.glyphs).toBe(glyphs);
			const ids = s.layers.map((l) => l.id);
			for (const id of ['bm-label-waterway', 'bm-label-water', 'bm-label-places', 'qt-label']) expect(ids).toContain(id);
			// Names sit above every feature layer, so a results fill never hides one.
			expect(ids.indexOf('bm-label-places')).toBeGreaterThan(ids.indexOf('ov-selected'));
			const fonts = new Set(s.layers.filter((l) => l.type === 'symbol').flatMap(fontsOf));
			expect([...fonts].every((f) => (Object.values(LABEL_FONTS) as string[]).includes(f))).toBe(true);
			// The basemap's names go with the basemap when its tiles fail.
			expect(basemapLayerIds(s)).toEqual(expect.arrayContaining(['bm-label-places', 'bm-label-water', 'bm-label-waterway']));
		}
	});

	it('with glyphs but no tiles, labels only the quaternaries (there are no place names to draw)', () => {
		const s = mapStyle(null, false, data, { glyphs });
		expect(s.layers.filter((l) => l.type === 'symbol').map((l) => l.id)).toEqual(['qt-label']);
	});

	it('keeps every label at least 4.5:1 against its halo and against every basemap colour, light and dark', () => {
		for (const dark of [false, true]) {
			const c = labelColours(dark);
			const b = basemapColours(dark);
			for (const text of [c.text, c.water, c.quaternary]) {
				expect(contrast(text, c.halo), `${text} on its halo`).toBeGreaterThanOrEqual(4.5);
				for (const g of [b.bg, b.earth, b.water, b.green]) expect(contrast(text, g), `${text} on ${g}`).toBeGreaterThanOrEqual(4.5);
			}
			const halo = mapStyle(tiles, dark, data, { glyphs }).layers.filter((l) => l.type === 'symbol').map((l) => (l.paint as Record<string, unknown>)['text-halo-width'] as number);
			expect(halo.every((w) => w >= 1)).toBe(true);
		}
	});

	it('makes a same-origin glyphs path absolute without encoding its braces, and takes empty as none', () => {
		expect(glyphsUrl('/tiles/fonts/{fontstack}/{range}.pbf', 'https://app.example.com')).toBe('https://app.example.com/tiles/fonts/{fontstack}/{range}.pbf');
		expect(glyphsUrl(glyphs, 'https://app.example.com')).toBe(glyphs);
		expect(glyphsUrl('  ', 'https://app.example.com')).toBeNull();
		expect(glyphsUrl(undefined, 'https://app.example.com')).toBeNull();
	});
});

describe('quaternary outlines (#326 A6)', () => {
	const ring = [[[21, -33.75], [21.25, -33.75], [21.25, -33.5], [21, -33.75]]] as [number, number][][];

	it('draws them dashed under the features, with the picked one heavier', () => {
		const { under, labels } = quaternaryLayers(false, false);
		expect(labels).toEqual([]);
		const line = under.find((l) => l.id === 'qt-line')!.paint as Record<string, unknown>;
		expect(line['line-dasharray']).toEqual([5, 2.5]);
		expect(line['line-width']).toEqual(['case', ['==', ['get', 'picked'], true], 3, 1.75]);
		const ids = mapStyle(null, false, overlayData([], null)).layers.map((l) => l.id);
		expect(ids.indexOf('qt-line')).toBeLessThan(ids.indexOf('ov-parcel-fill'));
	});

	it('feeds each outline with its code, marking the picked one', () => {
		const d = quaternaryData([{ code: 'Z01A', geometry: { type: 'Polygon', coordinates: ring } }, { code: 'Z01B', geometry: { type: 'Polygon', coordinates: ring } }], 'Z01B');
		expect(d.features.map((f) => f.properties)).toEqual([
			{ code: 'Z01A', picked: false },
			{ code: 'Z01B', picked: true }
		]);
		expect(quaternaryData(null).features).toEqual([]);
	});

	it('keeps the outline at least 3:1 on the basemap and clearly apart from every feature stroke', () => {
		for (const dark of [false, true]) {
			const q = quaternaryColour(dark);
			const b = basemapColours(dark);
			for (const g of [b.bg, b.earth, b.water, b.green]) expect(contrast(q, g), `${q} on ${g}`).toBeGreaterThanOrEqual(3);
			const c = overlayColours(dark);
			for (const s of [c.boundary, c.parcel, c.water, c.other]) expect(deltaE(q, s), `${q} vs ${s}`).toBeGreaterThanOrEqual(40);
		}
	});
});
