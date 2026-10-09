// The catchment map's style (mapStyle.ts): no basemap without a tiles URL, a
// self-hosted PMTiles basemap with its attribution and no glyphs with one,
// and overlay layers that tell features apart by more than colour.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MapFeature } from '$lib/api/types';
import { PIECE_TINT_COUNT } from './pieces';
import { HYDRORIVERS_MAP_ATTRIBUTION } from '$lib/components/legal/dataCredits';
import {
	RIVERS_CREDIT_LAYER,
	RIVERS_CREDIT_SOURCE,
	riversCredit,
	escapeAttribution,
	terrainSource,
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
	PIECE_HIT_LAYER,
	pieceTints,
	proposalColour,
	proposalData,
	proposalLayers,
	quaternaryColour,
	quaternaryData,
	quaternaryLayers,
	RIVER_NETWORK_HIT_LAYER,
	riverNetworkColour,
	CHANNEL_OPACITY,
	channelColour,
	channelData,
	channelLayers,
	riverNetworkData,
	riverNetworkLayers,
	RELIEF_LAYER,
	reliefBeforeId,
	RESULT_FILL_OPACITY,
	TERRAIN_ATTRIBUTION,
	TERRAIN_SOURCE,
	withAlpha,
	unitsData,
	mapGridData,
	mapGridLayers,
	MAP_RAMP,
	chirpsData,
	chirpsColour,
	chirpsLayers,
	demGridData,
	demGridLayers,
	DEM_RAMP
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
			expect(s.layers.map((l) => l.id)).toEqual([...basemapStyle('x', dark).layers.map((l) => l.id), 'qt-fill', 'qt-line', 'rn-hit', 'rn-line', 'rn-picked-casing', 'rn-picked', 'dem-channels', ...overlayLayers(dark).map((l) => l.id), 'units-casing', 'units-line', 'chirps-cell', 'chirps-point', 'demgrid-point', 'mapgrid-point', ...proposalLayers(dark).map((l) => l.id)]);
			expect(s.layers[0]!.paint).toEqual({ 'background-color': basemapColours(dark).bg });
		}
		expect(mapStyle(null, false, data).sources).toEqual({
			quaternaries: { type: 'geojson', data: quaternaryData(null) },
			rivers: { type: 'geojson', data: riverNetworkData(null) },
			channels: { type: 'geojson', data: channelData(null) },
			features: { type: 'geojson', data },
			proposal: { type: 'geojson', data: proposalData(null) },
			units: { type: 'geojson', data: unitsData(null) },
			mapgrid: { type: 'geojson', data: mapGridData(null) },
			chirps: { type: 'geojson', data: chirpsData(null) },
			demgrid: { type: 'geojson', data: demGridData(null) }
		});
	});

	it('feeds the source polygons and lines only (points are markers), marking the selected one', () => {
		const base = { name: '', nodeId: null, nodeName: null, damPosition: null, properties: {}, center: [0, 0] as [number, number], sourceId: null, nonContributingM2: null, createdBy: null, createdAt: '', updatedAt: '' };
		const fs: MapFeature[] = [
			{ ...base, id: 'a', kind: 'gauge', geometry: { type: 'Point', coordinates: [0, 0] }, areaM2: null },
			{ ...base, id: 'b', kind: 'river', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, areaM2: null }
		];
		const d = overlayData(fs, 'b');
		expect(d.features.map((f) => f.properties)).toEqual([{ id: 'b', kind: 'river', name: '', selected: true }]);
	});

	it('carries a feature’s results colour only when fills names it', () => {
		const base = { name: '', nodeId: null, nodeName: null, damPosition: null, properties: {}, center: [0, 0] as [number, number], sourceId: null, nonContributingM2: null, createdBy: null, createdAt: '', updatedAt: '', areaM2: 1 };
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

	it('with glyphs but no tiles, labels only the quaternaries, the units and the MAP grid (there are no place names to draw)', () => {
		const s = mapStyle(null, false, data, { glyphs });
		expect(s.layers.filter((l) => l.type === 'symbol').map((l) => l.id)).toEqual(['qt-label', 'units-label', 'demgrid-label', 'mapgrid-label']);
		// Without glyphs: no text anywhere, the points and outlines still drawn.
		const bare = mapStyle(null, false, data);
		expect(bare.layers.filter((l) => l.type === 'symbol')).toEqual([]);
		expect(bare.layers.map((l) => l.id)).toEqual(expect.arrayContaining(['units-line', 'mapgrid-point', 'chirps-point']));
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

describe('the river network (#345)', () => {
	const line = { type: 'LineString' as const, coordinates: [[21.3, -33.66], [21.36, -33.74]] as [number, number][] };

	it('draws it dashed over the quaternaries and under the features, wider for a higher order, the picked reach on top in the selection colour', () => {
		const layers = riverNetworkLayers(false);
		expect(layers.map((l) => l.id)).toEqual([RIVER_NETWORK_HIT_LAYER, 'rn-line', 'rn-picked-casing', 'rn-picked']);
		const paint = layers[1]!.paint as Record<string, unknown>;
		expect(paint['line-dasharray']).toEqual([3, 1.5]);
		expect(paint['line-width']).toEqual(['interpolate', ['linear'], ['get', 'order'], 1, 1.25, 6, 3]);
		expect(layers[3]!.filter).toEqual(['==', ['get', 'picked'], true]);
		expect((layers[3]!.paint as Record<string, unknown>)['line-color']).toBe(overlayColours(false).selected);
		const ids = mapStyle(null, false, overlayData([], null)).layers.map((l) => l.id);
		expect(ids.indexOf('qt-line')).toBeLessThan(ids.indexOf('rn-line'));
		expect(ids.indexOf('rn-line')).toBeLessThan(ids.indexOf('ov-parcel-fill'));
	});

	it('links the relief’s credit to the Copernicus licence notice on the data sources page when given its URL', () => {
		const style = mapStyle(null, false, overlayData([], null), { terrain: '/tiles/terrain.pmtiles', dataSourcesHref: '/data-sources' });
		const attribution = (style.sources[TERRAIN_SOURCE] as { attribution: string }).attribution;
		expect(attribution).toContain(TERRAIN_ATTRIBUTION);
		expect(attribution).toContain('<a href="/data-sources#copernicus-dem">licence notice</a>');
		expect((mapStyle(null, false, overlayData([], null), { terrain: '/t.pmtiles' }).sources[TERRAIN_SOURCE] as { attribution: string }).attribution).toBe(TERRAIN_ATTRIBUTION);
	});

	it('credits HydroRIVERS on the attribution control only when asked: its own empty source and an invisible layer reading it', () => {
		const html = riversCredit('/data-sources', HYDRORIVERS_MAP_ATTRIBUTION);
		expect(html).toBe(`<a href="/data-sources#hydrorivers">${escapeAttribution(HYDRORIVERS_MAP_ATTRIBUTION)}</a>`);
		const credited = mapStyle(null, false, overlayData([], null), { riversCredit: html });
		expect(credited.sources[RIVERS_CREDIT_SOURCE]).toEqual({ type: 'geojson', data: { type: 'FeatureCollection', features: [] }, attribution: html });
		expect(credited.layers.find((l) => l.id === RIVERS_CREDIT_LAYER.id)).toEqual({ id: 'rivers-credit', type: 'line', source: RIVERS_CREDIT_SOURCE, paint: { 'line-opacity': 0 } });
		const plain = mapStyle(null, false, overlayData([], null), { riversCredit: null });
		expect(plain.sources[RIVERS_CREDIT_SOURCE]).toBeUndefined();
		expect(plain.layers.some((l) => l.id === RIVERS_CREDIT_LAYER.id)).toBe(false);
		// The river network's own source never carries it: it is in the style whether drawn or not.
		expect((credited.sources.rivers as Record<string, unknown>).attribution).toBeUndefined();
	});

	it('feeds each reach with its key and order (1 when not given), marking the picked one', () => {
		const d = riverNetworkData([{ key: 'synthetic:1', strahler: 3, geometry: line }, { key: 'synthetic:2', strahler: null, geometry: line }], 'synthetic:2');
		expect(d.features.map((f) => f.properties)).toEqual([
			{ key: 'synthetic:1', order: 3, picked: false },
			{ key: 'synthetic:2', order: 1, picked: true }
		]);
		expect(riverNetworkData(null).features).toEqual([]);
	});

	it('keeps the line at least 3:1 on the basemap, apart from every other stroke, and a step from the project’s own river blue', () => {
		for (const dark of [false, true]) {
			const r = riverNetworkColour(dark);
			const b = basemapColours(dark);
			for (const g of [b.bg, b.earth, b.water, b.green]) expect(contrast(r, g), `${r} on ${g}`).toBeGreaterThanOrEqual(3);
			const c = overlayColours(dark);
			for (const s of [c.boundary, c.parcel, c.other, c.selected, quaternaryColour(dark)]) expect(deltaE(r, s), `${r} vs ${s}`).toBeGreaterThanOrEqual(40);
			// Both are water: a different blue, told apart by the dash and width as well (WCAG 1.4.1).
			expect(deltaE(r, c.water)).toBeGreaterThanOrEqual(25);
		}
	});
});

describe('the elevation model’s channels', () => {
	it('draws each line with its area, wider for more, over the river network and under the features', () => {
		const d = channelData([{ coordinates: [[20, -33], [20.01, -33.01]], km2: 412.5 }]);
		expect(d.features[0]).toMatchObject({ properties: { km2: 412.5 }, geometry: { type: 'LineString' } });
		expect(channelData(null).features).toEqual([]);
		const ids = mapStyle(null, false, overlayData([], null)).layers.map((l) => l.id);
		expect(ids.indexOf('dem-channels')).toBeGreaterThan(ids.indexOf('rn-line'));
		expect(ids.indexOf('dem-channels')).toBeLessThan(ids.findIndex((i) => i.startsWith('ov-')));
	});

	it('dims the channels behind a delineated proposal under review, and draws them full while clicking', () => {
		const line = [{ coordinates: [[20, -33], [20.01, -33.01]] as [number, number][], km2: 3 }];
		expect(channelData(line).features[0].properties.dim).toBe(false);
		expect(channelData(line, true).features[0].properties.dim).toBe(true);
		const paint = channelLayers(false)[0].paint as Record<string, unknown>;
		expect(paint['line-opacity']).toEqual(['case', ['==', ['get', 'dim'], true], CHANNEL_OPACITY.dim, CHANNEL_OPACITY.on]);
		expect(CHANNEL_OPACITY.dim).toBeLessThan(CHANNEL_OPACITY.on);
		expect(CHANNEL_OPACITY.dim).toBeGreaterThan(0);
	});

	it('keeps the line at least 3:1 on the basemap and apart from every other stroke, the river network’s included', () => {
		for (const dark of [false, true]) {
			const r = channelColour(dark);
			const b = basemapColours(dark);
			for (const g of [b.bg, b.earth, b.water, b.green]) expect(contrast(r, g), `${r} on ${g}`).toBeGreaterThanOrEqual(3);
			const c = overlayColours(dark);
			for (const s of [c.boundary, c.parcel, c.water, c.other, c.selected, quaternaryColour(dark), riverNetworkColour(dark), proposalColour(dark)])
				expect(deltaE(r, s), `${r} vs ${s}, ${dark ? 'dark' : 'light'}`).toBeGreaterThanOrEqual(40);
		}
	});
});

describe('relief (shaded from a DEM)', () => {
	const tiles = 'http://localhost:9002/tiles/south-africa.pmtiles';
	const terrain = 'http://localhost:9002/tiles/terrain.pmtiles';
	const data = overlayData([], null);

	it('fetches no DEM and draws no relief without a terrain URL (the default: a fresh clone and CI)', () => {
		for (const t of [tiles, null]) {
			const s = mapStyle(t, false, data, { terrain: null });
			expect(s.sources).not.toHaveProperty(TERRAIN_SOURCE);
			expect(s.layers.some((l) => l.type === 'hillshade')).toBe(false);
		}
	});

	it('reads one Terrarium PMTiles file with the Copernicus notice the licence asks for', () => {
		const s = mapStyle(tiles, false, data, { terrain });
		expect(s.sources[TERRAIN_SOURCE]).toEqual({ type: 'raster-dem', url: `pmtiles://${terrain}`, encoding: 'terrarium', tileSize: 512, attribution: TERRAIN_ATTRIBUTION });
		// Copernicus DEM licence, Art. 6(b): the notice for adapted data, word for word.
		expect(TERRAIN_ATTRIBUTION).toContain('produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved');
	});

	it('shades over the land and land cover, under the water, roads, outlines, features and names', () => {
		for (const dark of [false, true]) {
			const ids = mapStyle(tiles, dark, data, { terrain, glyphs: 'http://localhost:9002/tiles/fonts/{fontstack}/{range}.pbf' }).layers.map((l) => l.id);
			const at = ids.indexOf(RELIEF_LAYER);
			for (const below of ['background', 'bm-earth', 'bm-landcover', 'bm-landuse']) expect(ids.indexOf(below), below).toBeLessThan(at);
			for (const above of ['bm-water', 'bm-roads', 'qt-line', 'ov-parcel-fill', 'ov-selected', 'bm-label-places']) expect(ids.indexOf(above), above).toBeGreaterThan(at);
		}
	});

	it('with no basemap, shades the plain background under the outlines and features', () => {
		const ids = mapStyle(null, false, data, { terrain }).layers.map((l) => l.id);
		expect(ids.slice(0, 3)).toEqual(['background', RELIEF_LAYER, 'qt-fill']);
	});

	it('is not a basemap layer: the basemap failing leaves the relief drawn', () => {
		expect(basemapLayerIds(mapStyle(tiles, false, data, { terrain }))).not.toContain(RELIEF_LAYER);
	});

	it('goes in before the water on a live map too, or on top of an empty one', () => {
		expect(reliefBeforeId(['background', 'bm-earth', 'bm-landcover', 'bm-landuse', 'bm-water', 'bm-roads'])).toBe('bm-water');
		expect(reliefBeforeId(['background', 'qt-fill', 'ov-casing'])).toBe('qt-fill');
		expect(reliefBeforeId([])).toBeUndefined();
	});

	it('keeps its shading translucent, so the basemap’s colours read through it', () => {
		for (const dark of [false, true]) {
			const l = mapStyle(null, dark, data, { terrain }).layers.find((x) => x.id === RELIEF_LAYER)!;
			const paint = l.paint as Record<string, unknown>;
			expect(paint['hillshade-exaggeration']).toBeLessThanOrEqual(0.5);
			for (const k of ['hillshade-shadow-color', 'hillshade-highlight-color', 'hillshade-accent-color']) {
				const alpha = Number(/rgba\([^)]*,\s*([\d.]+)\)/.exec(String(paint[k]))?.[1]);
				expect(alpha, k).toBeLessThanOrEqual(0.6);
			}
		}
	});
});

describe('a start or divide proposal’s pieces (#326 C3’s follow-up)', () => {
	const sq = (x: number) => ({ type: 'Polygon' as const, coordinates: [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 0]]] as [number, number][][] });
	const pieces = [
		{ key: 'a', label: '1', name: 'A', geometry: sq(0), at: [0.5, 0.3] as [number, number], tint: 0 },
		{ key: 'w', label: '2', name: 'Weir', geometry: null, at: [3, 3] as [number, number], tint: 1 },
		{ key: 'rest', label: 'R', name: 'Rest', geometry: sq(2), at: [2.5, 0.3] as [number, number], tint: -1 }
	];

	it('draws each piece with an outline on its own, with its key and tint and the lit one marked; a unit without land draws none', () => {
		const d = proposalData({ geometry: sq(0), outlet: [9, 9], pieces, highlight: 'rest' });
		expect(d.features.map((f) => [f.properties.part, f.properties.key, f.properties.tint, f.properties.lit])).toEqual([
			['piece', 'a', 0, false],
			['piece', 'rest', -1, true],
			['outlet', undefined, undefined, undefined]
		]);
	});

	it('fills each piece with its tint (the rest the proposal’s teal), lights the lit one in the selection colour, under the proposal’s dash', () => {
		for (const dark of [false, true]) {
			const layers = proposalLayers(dark);
			const fill = layers.find((l) => l.id === PIECE_HIT_LAYER)!;
			expect((fill.paint as Record<string, unknown>)['fill-color']).toEqual(['match', ['get', 'tint'], ...pieceTints(dark).flatMap((t, i) => [i, t]), proposalColour(dark)]);
			const lit = layers.find((l) => l.id === 'pr-lit')!;
			expect((lit.paint as Record<string, unknown>)['line-color']).toBe(overlayColours(dark).selected);
			const ids = layers.map((l) => l.id);
			expect(ids.indexOf(PIECE_HIT_LAYER)).toBeLessThan(ids.indexOf('pr-line'));
			expect(ids.indexOf('pr-line')).toBeLessThan(ids.indexOf('pr-lit'));
		}
	});

	it('has tints well apart from each other, and from every hue the map already gives a meaning, light and dark', () => {
		for (const dark of [false, true]) {
			const t = pieceTints(dark);
			expect(t).toHaveLength(PIECE_TINT_COUNT);
			for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) expect(deltaE(t[i]!, t[j]!), `${t[i]} vs ${t[j]}`).toBeGreaterThanOrEqual(20);
			// Never read as a parcel (green), water (blue), the boundary (amber) or the proposal's own teal.
			const c = overlayColours(dark);
			for (const x of t) for (const m of [c.parcel, c.water, c.boundary, proposalColour(dark)]) expect(deltaE(x, m), `${x} vs ${m}, ${dark ? 'dark' : 'light'}`).toBeGreaterThanOrEqual(25);
		}
	});

	it('writes the numbers in a colour that reads 4.5:1 on the badge’s casing, light and dark', () => {
		for (const dark of [false, true]) expect(contrast(labelColours(dark).text, overlayColours(dark).casing)).toBeGreaterThanOrEqual(4.5);
	});
});

describe('the delineation proposal (#326 B-delineate)', () => {
	const geometry = { type: 'Polygon' as const, coordinates: [[[20, -33], [21, -33], [21, -34], [20, -33]]] as [number, number][][] };
	const data = overlayData([], null);

	it('marks every other click as an outlet too (sub-catchments from clicks)', () => {
		const sqr = { type: 'Polygon' as const, coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] as [number, number][][] };
		const d = proposalData({ geometry: sqr, outlet: [0.5, 0], outlets: [[0.5, 0.5], [0.5, 0.9]], pieces: [{ key: '0', label: '1', name: 'Sub-catchment 1', geometry: sqr, at: [0.5, 0.5], tint: 0 }] });
		expect(d.features.filter((f) => f.properties.part === 'outlet').map((f) => (f.geometry as { coordinates: unknown }).coordinates)).toEqual([
			[0.5, 0],
			[0.5, 0.5],
			[0.5, 0.9]
		]);
	});

	it('draws nothing without a proposal, and the polygon and its outlet with one', () => {
		expect(proposalData(null).features).toEqual([]);
		const d = proposalData({ geometry, outlet: [20.5, -33.9] });
		expect(d.features.map((f) => [f.properties.part, f.geometry.type])).toEqual([
			['area', 'Polygon'],
			['outlet', 'Point']
		]);
	});

	it('is a source of every style, drawn over the features', () => {
		const st = mapStyle('https://x/t.pmtiles', false, data, { glyphs: 'https://x/{fontstack}/{range}.pbf', proposal: proposalData({ geometry, outlet: [20.5, -33.9] }) });
		expect(st.sources).toHaveProperty('proposal');
		const ids = st.layers.map((l) => l.id);
		expect(ids.indexOf('pr-line')).toBeGreaterThan(ids.indexOf('ov-boundary'));
		expect(mapStyle(null, false, data).sources).toHaveProperty('proposal');
	});

	it('is dashed short (never the boundary’s long dash), and its colour reads 3:1 on the basemap and its casing, light and dark', () => {
		for (const dark of [false, true]) {
			const line = proposalLayers(dark).find((l) => l.id === 'pr-line')!;
			expect((line.paint as Record<string, unknown>)['line-dasharray']).toEqual([1.5, 1.5]);
			const b = basemapColours(dark);
			const colour = proposalColour(dark);
			for (const g of [b.bg, b.earth, b.water, b.green]) expect(contrast(colour, g), `${colour} on ${g}`).toBeGreaterThanOrEqual(3);
			expect(contrast(colour, overlayColours(dark).casing)).toBeGreaterThanOrEqual(3);
		}
	});
});

describe('attribution HTML (MapLibre sets it as innerHTML)', () => {
	it('escapes every value put into it, so no text can become markup', () => {
		expect(escapeAttribution(`<img src=x onerror="a()">&'`)).toBe('&#60;img src=x onerror=&#34;a()&#34;&#62;&#38;&#39;');
		const html = riversCredit('" onmouseover="x', '<b>credit</b>');
		expect(html).not.toMatch(/<b>|" onmouseover/);
		expect(terrainSource('/t.pmtiles', '"><script>').attribution).not.toContain('<script>');
	});
});

describe('hydrological units, the MAP grid and the CHIRPS grid (docs/maps.md)', () => {
	const square: MapFeature['geometry'] = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
	const base = { name: '', nodeId: null, nodeName: null, damPosition: null, properties: {}, center: [0.5, 0.5] as [number, number], sourceId: null, nonContributingM2: null, createdBy: null, createdAt: '', updatedAt: '', areaM2: 1 };

	it('feeds the units source each labelled unit’s outline and its label point, nothing while off', () => {
		const fs: MapFeature[] = [
			{ ...base, id: 'u1', kind: 'farm_parcel', geometry: square },
			{ ...base, id: 'b', kind: 'catchment_boundary', geometry: square }
		];
		expect(unitsData(null, fs).features).toEqual([]);
		const d = unitsData([{ featureId: 'u1', label: 'Upper unit', at: [0.5, 0.5] }], fs);
		expect(d.features).toEqual([
			{ type: 'Feature', properties: { role: 'outline' }, geometry: square },
			{ type: 'Feature', properties: { role: 'label', label: 'Upper unit' }, geometry: { type: 'Point', coordinates: [0.5, 0.5] } }
		]);
	});

	it('feeds the MAP grid source each point with its MAP and its label in whole mm', () => {
		expect(mapGridData([{ lon: 21.305, lat: -33.645, mapMm: 812.4 }]).features).toEqual([
			{ type: 'Feature', properties: { mm: 812.4, label: '812 mm' }, geometry: { type: 'Point', coordinates: [21.305, -33.645] } }
		]);
		expect(mapGridData(null).features).toEqual([]);
	});

	it('colours the MAP points on a rising ramp, each ringed in the halo colour so both ends read on either basemap', () => {
		const [point] = mapGridLayers(false, false).over;
		expect(point!.paint).toMatchObject({ 'circle-stroke-color': labelColours(false).halo, 'circle-stroke-width': 1 });
		expect(MAP_RAMP.map(([mm]) => mm)).toEqual([...MAP_RAMP.map(([mm]) => mm)].sort((a, b) => a - b));
		for (const dark of [false, true]) {
			const halo = labelColours(dark).halo;
			// Each end of the ramp stands apart from the ring round it, or the ring from the basemap (WCAG 1.4.11, 3:1).
			const ends = [MAP_RAMP[0]![1], MAP_RAMP[MAP_RAMP.length - 1]![1]];
			for (const g of [basemapColours(dark).earth, basemapColours(dark).bg]) {
				expect(Math.max(...ends.map((c) => contrast(c, halo)), contrast(halo, g)), `ramp on ${g}`).toBeGreaterThanOrEqual(3);
			}
		}
	});

	it('feeds the CHIRPS source each cell’s square and its centre, in an orange that stands out from the land (3:1)', () => {
		const d = chirpsData([{ lon: 19.225, lat: -32.675, square: [19.2, -32.7, 19.25, -32.65] }]);
		expect(d.features.map((f) => [f.properties.role, f.geometry.type])).toEqual([
			['cell', 'Polygon'],
			['point', 'Point']
		]);
		expect(d.features[0]!.geometry.coordinates).toEqual([[[19.2, -32.7], [19.25, -32.7], [19.25, -32.65], [19.2, -32.65], [19.2, -32.7]]]);
		for (const dark of [false, true]) {
			for (const g of [basemapColours(dark).bg, basemapColours(dark).earth, basemapColours(dark).green]) {
				expect(contrast(chirpsColour(dark), g), `CHIRPS on ${g}`).toBeGreaterThanOrEqual(3);
			}
		}
		expect(chirpsLayers(false).map((l) => l.id)).toEqual(['chirps-cell', 'chirps-point']);
	});
});

describe('the DEM grid (docs/maps.md § DEM grid)', () => {
	it('feeds each sampled cell with its elevation and a whole-metre label, nothing while off', () => {
		expect(demGridData(null).features).toEqual([]);
		expect(demGridData([{ lon: 20.71, lat: -33.43, elevationM: 812.4 }]).features).toEqual([
			{ type: 'Feature', properties: { m: 812.4, label: '812 m' }, geometry: { type: 'Point', coordinates: [20.71, -33.43] } }
		]);
	});

	it('colours the points on a rising ramp apart from the MAP grid’s, ringed in the halo colour, labels only with glyphs', () => {
		expect(DEM_RAMP.map(([m]) => m)).toEqual([...DEM_RAMP.map(([m]) => m)].sort((a, b) => a - b));
		expect(DEM_RAMP.map(([, c]) => c)).not.toEqual(expect.arrayContaining(MAP_RAMP.map(([, c]) => c)));
		const { over, labels } = demGridLayers(false, true);
		expect(over[0]!.paint).toMatchObject({ 'circle-stroke-color': labelColours(false).halo });
		expect(labels.map((l) => l.id)).toEqual(['demgrid-label']);
		expect(demGridLayers(false, false).labels).toEqual([]);
	});
});
