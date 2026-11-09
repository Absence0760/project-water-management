// The Map tab's layers (mapLayers.ts, issue #326 A6, the relief, the river network #345):
// `layers=` in the URL and the bbox the quaternaries and rivers are asked for around the features.
import { describe, expect, it } from 'vitest';
import type { MapFeature } from '#lib/api/types.js';
import {
	CHIRPS_MAX_POINTS,
	DEM_GRID_BBOX_MAX_DEG,
	demGridViewBbox,
	snappedViewBbox,
	chirpsCells,
	creditedFeature,
	jrcCreditedFeature,
	MAP_CREDIT_TEXT,
	mapCredits,
	creditedReach,
	channelsWanted,
	DEM_RIVERS_LAYER_LABEL,
	DEM_RIVERS_NOTE,
	demRiversLine,
	demRiversOffered,
	HYDRORIVERS_LAYER_LABEL,
	MAP_LAYERS,
	layerAsked,
	layersOn,
	layersStatus,
	MAP_GRID_BBOX_MAX_DEG,
	mapGridViewBbox,
	mapLabel,
	QUATERNARY_BBOX_MAX_DEG,
	quaternaryBbox,
	reachFacts,
	reachLabel,
	RIVER_BBOX_MAX_DEG,
	riverBbox,
	riverViewBbox,
	unitLabels,
	withLayer
} from './mapLayers';
import { square } from './layerTesting';

const poly = (x: number, y: number, d: number) =>
	({ id: 'p', kind: 'farm_parcel', geometry: { type: 'Polygon', coordinates: [[[x, y], [x + d, y], [x + d, y + d], [x, y]]] } }) as MapFeature;

describe('layers in the URL', () => {
	it('reads the known layers from `layers=`, ignoring others', () => {
		// The DEM rivers are on by default (DEFAULT_LAYERS): `-channels` turns them off.
		expect([...layersOn(new URLSearchParams('layers=quaternaries'))]).toEqual(['quaternaries', 'channels']);
		expect([...layersOn(new URLSearchParams('layers=satellite,quaternaries,-channels'))]).toEqual(['quaternaries']);
		expect([...layersOn(new URLSearchParams('tab=map'))]).toEqual(['channels']);
		expect(layersOn(new URLSearchParams('layers=-channels')).size).toBe(0);
	});

	it('turns a layer on and off keeping every other param, and drops `layers` when none is on', () => {
		const on = withLayer('?tab=map&feature=f1', 'quaternaries', true);
		expect(new URLSearchParams(on).get('layers')).toBe('quaternaries');
		expect(new URLSearchParams(on).get('feature')).toBe('f1');
		expect(withLayer(on, 'quaternaries', false)).toBe('?tab=map&feature=f1');
	});

	it('keeps the relief and the quaternaries apart, listed in a fixed order whichever went on first', () => {
		const both = withLayer(withLayer('?tab=map', 'relief', true), 'quaternaries', true);
		expect(new URLSearchParams(both).get('layers')).toBe('quaternaries,relief');
		expect([...layersOn(new URLSearchParams(both))]).toEqual(['quaternaries', 'channels', 'relief']);
		expect(new URLSearchParams(withLayer(both, 'quaternaries', false)).get('layers')).toBe('relief');
		const three = withLayer(both, 'rivers', true);
		expect(new URLSearchParams(three).get('layers')).toBe('quaternaries,rivers,relief');
	});

	it('takes the units, the MAP grid and the CHIRPS grid as layers, each on and off on its own', () => {
		const all = ['chirps', 'mapgrid', 'units'].reduce((q, l) => withLayer(q, l as 'units', true), '?tab=map');
		expect(new URLSearchParams(all).get('layers')).toBe('units,mapgrid,chirps');
		expect(new URLSearchParams(withLayer(all, 'mapgrid', false)).get('layers')).toBe('units,chirps');
		expect([...layersOn(new URLSearchParams('layers=chirps,units,-channels'))]).toEqual(['units', 'chirps']);
	});
});

describe('the DEM rivers beside HydroRIVERS', () => {
	it('is its own layer, `channels`, listed after the HydroRIVERS one, whose stored id stays `rivers`', () => {
		expect(MAP_LAYERS.indexOf('channels')).toBe(MAP_LAYERS.indexOf('rivers') + 1);
		// A saved or shared `layers=rivers` still turns HydroRIVERS on, whatever its toggle is called now.
		expect([...layersOn(new URLSearchParams('layers=rivers,-channels'))]).toEqual(['rivers']);
		const both = withLayer(withLayer('?tab=map', 'channels', true), 'rivers', true);
		expect(new URLSearchParams(both).get('layers')).toBe('rivers,channels');
		expect(new URLSearchParams(withLayer(both, 'rivers', false)).get('layers')).toBe('channels');
	});

	it('is on by default: off is `-channels` in the URL, on again `channels`, and a view saved as `layers=channels` before the default still means on', () => {
		expect(layersOn(new URLSearchParams('tab=map')).has('channels')).toBe(true);
		expect(layerAsked(new URLSearchParams('tab=map'), 'channels')).toBe(false);
		const off = withLayer('?tab=map', 'channels', false);
		expect(new URLSearchParams(off).get('layers')).toBe('-channels');
		expect(layersOn(new URLSearchParams(off)).has('channels')).toBe(false);
		// Another layer toggled keeps what the URL said of the default one.
		expect(new URLSearchParams(withLayer(off, 'relief', true)).get('layers')).toBe('-channels,relief');
		expect(new URLSearchParams(withLayer('?tab=map', 'relief', true)).get('layers')).toBe('relief');
		const again = withLayer(off, 'channels', true);
		expect(new URLSearchParams(again).get('layers')).toBe('channels');
		expect(layerAsked(new URLSearchParams(again), 'channels')).toBe(true);
		const saved = new URLSearchParams('layers=channels,units');
		expect([...layersOn(saved)]).toEqual(['channels', 'units']);
		expect(new URLSearchParams(withLayer('?layers=channels,units', 'units', false)).get('layers')).toBe('channels');
	});

	it('reads as a pair: the DEM’s rivers and HydroRIVERS’, the first saying it is what delineation follows', () => {
		expect(DEM_RIVERS_LAYER_LABEL).toBe('DEM rivers');
		expect(HYDRORIVERS_LAYER_LABEL).toBe('Rivers (HydroRIVERS)');
		expect(DEM_RIVERS_NOTE).toMatch(/^The rivers delineation follows, worked out from the elevation model/);
	});

	it('is offered to an editor whose server has an elevation model, and no one else', () => {
		expect(demRiversOffered(true, true)).toBe(true);
		// DEM_URL empty (the local default): not offered, as the DEM grid and the relief aren't.
		expect(demRiversOffered(true, false)).toBe(false);
		// The channels route is an editor's.
		expect(demRiversOffered(false, true)).toBe(false);
	});

	it('draws the channels with the layer on outside Delineate, with a tool on whatever the layer, and never without an elevation model', () => {
		expect(channelsWanted({ offered: true, layerOn: true, tool: false })).toBe(true);
		expect(channelsWanted({ offered: true, layerOn: false, tool: true })).toBe(true);
		expect(channelsWanted({ offered: true, layerOn: true, tool: true })).toBe(true);
		expect(channelsWanted({ offered: true, layerOn: false, tool: false })).toBe(false);
		expect(channelsWanted({ offered: false, layerOn: true, tool: true })).toBe(false);
	});

	it('says to zoom in past the widest view, and otherwise what is happening, failures as errors', () => {
		const s = { noView: false, zoomIn: false, error: null, loading: false, tileCount: 4 };
		expect(demRiversLine({ ...s, zoomIn: true })).toEqual({ text: 'Zoom in to about 35 km across to draw the DEM rivers.', kind: 'note' });
		expect(demRiversLine({ ...s, noView: true }).text).toMatch(/isn’t showing here/);
		expect(demRiversLine({ ...s, error: 'try again later.' })).toEqual({ text: 'The DEM rivers couldn’t be drawn: try again later.', kind: 'error' });
		expect(demRiversLine({ ...s, loading: true }).text).toBe('Drawing the DEM rivers…');
		expect(demRiversLine(s)).toEqual({ text: DEM_RIVERS_NOTE, kind: 'note' });
		// The layer's own hourly pool spent: said in words, as a note, never an error; delineation has its own.
		expect(demRiversLine({ ...s, paused: true })).toEqual({ text: 'DEM rivers paused for this hour; delineation still works.', kind: 'note' });
		expect(demRiversLine({ ...s, paused: true, zoomIn: true }).text).toMatch(/^Zoom in/);
	});
});

describe('unitLabels', () => {
	it('labels each farm parcel by its unit, else its own name, inside the polygon, sorted; other kinds are not units', () => {
		const a = { ...square('a', 21.3, -33.7, 'farm_parcel'), name: 'Lower polygon', nodeName: 'Lower unit', areaM2: 12_500_000 } as never;
		const b = { ...square('b', 21.4, -33.7, 'farm_parcel'), name: 'Middle', nodeName: null, areaM2: null } as never;
		const c = { ...square('c', 21.5, -33.7, 'farm_parcel'), name: '', nodeName: 'Alpha', areaM2: 1_000_000 } as never;
		const boundary = square('z', 21.2, -33.8, 'catchment_boundary');
		const got = unitLabels([a, b, c, boundary]);
		expect(got.map((u) => [u.featureId, u.label, u.polygonName, u.areaKm2])).toEqual([
			['c', 'Alpha', null, 1],
			['a', 'Lower unit', 'Lower polygon', 12.5],
			['b', 'Middle', null, null]
		]);
		const [x, y] = got[1]!.at;
		expect(x).toBeGreaterThan(21.3);
		expect(x).toBeLessThan(21.4);
		expect(y).toBeGreaterThan(-33.7);
		expect(y).toBeLessThan(-33.6);
	});
});

describe('mapGridViewBbox', () => {
	it('snaps the view outward to 0.02°, and gives nothing for a view wider than the server takes', () => {
		expect(mapGridViewBbox([21.301, -33.649, 21.329, -33.621])).toEqual([21.3, -33.66, 21.34, -33.62]);
		expect(mapGridViewBbox([20, -34, 20 + MAP_GRID_BBOX_MAX_DEG + 0.1, -33])).toBeNull();
		expect(mapGridViewBbox(null)).toBeNull();
		expect(mapLabel(812)).toBe('812 mm');
	});
});

describe('chirpsCells', () => {
	it('gives the CHIRPS v3 cells whose centres lie in view, from the grid alone: centres at 0.025 + k × 0.05', () => {
		const got = chirpsCells([19.2, -32.7, 19.3, -32.6])!;
		expect(got.map((c) => [c.lon, c.lat])).toEqual([
			[19.225, -32.675],
			[19.275, -32.675],
			[19.225, -32.625],
			[19.275, -32.625]
		]);
		expect(got[0]!.square).toEqual([19.2, -32.7, 19.25, -32.65]);
		// A centre on the view's edge is in it.
		expect(chirpsCells([19.225, -32.675, 19.225, -32.675])).toHaveLength(1);
	});

	it('gives nothing for a view holding more than the most points drawn, or no view', () => {
		expect(chirpsCells([18, -34, 21, -31])).toBeNull();
		expect(chirpsCells([19, -33, 19.5, -32.5])!.length).toBeLessThanOrEqual(CHIRPS_MAX_POINTS);
		expect(chirpsCells(null)).toBeNull();
	});
});

describe('layersStatus with more layers', () => {
	it('adds the other layers’ lines after the quaternaries’ and the reaches’', () => {
		const off = { on: false, idle: false, failed: false, count: null };
		expect(layersStatus(off, off, null, ['3 hydrological units labelled.', null, '20 CHIRPS grid points shown.'])).toBe('3 hydrological units labelled. 20 CHIRPS grid points shown.');
	});
});

describe('quaternaryBbox', () => {
	it('is null with nothing on the map', () => {
		expect(quaternaryBbox([])).toBeNull();
	});

	it('pads the features’ bounds by half their size, at least 0.1°', () => {
		expect(quaternaryBbox([poly(21.3, -33.7, 0.1)])).toEqual([21.2, -33.8, 21.5, -33.5]);
		expect(quaternaryBbox([poly(21.3, -33.7, 0.4)])).toEqual([21.1, -33.9, 21.9, -33.1]);
	});

	it('never asks for more than the server takes', () => {
		const [w, s, e, n] = quaternaryBbox([poly(18, -34, 6)])!;
		expect(e - w).toBeLessThanOrEqual(QUATERNARY_BBOX_MAX_DEG);
		expect(n - s).toBeLessThanOrEqual(QUATERNARY_BBOX_MAX_DEG);
	});
});

describe('riverViewBbox', () => {
	it('snaps the view outward to the grid, and refuses no view, a broken one or one wider than the server takes', () => {
		expect(riverViewBbox([21.03, -28.62, 21.48, -28.31])).toEqual([21, -28.65, 21.5, -28.3]);
		expect(riverViewBbox([21, -28.65, 21.5, -28.3])).toEqual([21, -28.65, 21.5, -28.3]);
		expect(riverViewBbox(null)).toBeNull();
		expect(riverViewBbox([Number.NaN, -28, 21, -27])).toBeNull();
		expect(riverViewBbox([20, -29, 20 + RIVER_BBOX_MAX_DEG + 0.01, -28])).toBeNull();
		expect(riverViewBbox([20, -29, 21, -29 + RIVER_BBOX_MAX_DEG + 0.01])).toBeNull();
		const b = riverViewBbox([20.01, -29.99, 21.99, -28.01])!;
		expect(b[2] - b[0]).toBeLessThanOrEqual(RIVER_BBOX_MAX_DEG);
	});
});

describe('riverBbox', () => {
	it('pads like the quaternaries’ but never asks for more than the river route takes (2°)', () => {
		expect(riverBbox([])).toBeNull();
		expect(riverBbox([poly(21.3, -33.7, 0.1)])).toEqual([21.2, -33.8, 21.5, -33.5]);
		const [w, s, e, n] = riverBbox([poly(18, -34, 6)])!;
		expect(e - w).toBeLessThanOrEqual(RIVER_BBOX_MAX_DEG);
		expect(n - s).toBeLessThanOrEqual(RIVER_BBOX_MAX_DEG);
	});
});

describe('reachLabel and reachFacts', () => {
	it('names a reach by its name, else its id, and says only the facts the source gives', () => {
		expect(reachLabel({ name: '', reachId: 90000002 })).toBe('Reach 90000002');
		expect(reachLabel({ name: 'Sandspruit', reachId: 7 })).toBe('Sandspruit');
		expect(reachFacts({ strahler: 3, upstreamKm2: 655, lengthKm: 8.94, dischargeM3s: 1.84 })).toEqual(['Strahler order 3', '655 km² upstream', '8.9 km long', 'modelled mean flow 1.84 m³/s']);
		expect(reachFacts({ strahler: null, upstreamKm2: 54.9, lengthKm: null, dischargeM3s: null })).toEqual(['54.9 km² upstream']);
	});
});

describe('creditedReach', () => {
	it('is a reach from HydroRIVERS (by its dataset label or source line), never the synthetic network', () => {
		expect(creditedReach({ dataset: 'HydroRIVERS-v10', source: 'HydroRIVERS v1.0', synthetic: false })).toBe(true);
		expect(creditedReach({ dataset: 'rivers-af', source: 'HydroSHEDS HydroRIVERS v1.0, © WWF', synthetic: false })).toBe(true);
		expect(creditedReach({ dataset: 'synthetic', source: 'synthetic river network', synthetic: true })).toBe(false);
		// A synthetic set is never credited, whatever it is called.
		expect(creditedReach({ dataset: 'HydroRIVERS-test', source: '', synthetic: true })).toBe(false);
		expect(creditedReach({ dataset: 'my-rivers', source: 'surveyed by the WUA', synthetic: false })).toBe(false);
	});
});

describe('creditedFeature', () => {
	it('is a river feature added from a HydroRIVERS reach (its ref), nothing else', () => {
		expect(creditedFeature({ kind: 'river', properties: { ref: 'river-network:HydroRIVERS-v10:1050012345' } })).toBe(true);
		expect(creditedFeature({ kind: 'river', properties: { ref: 'river-network:synthetic:90000001' } })).toBe(false);
		expect(creditedFeature({ kind: 'river', properties: {} })).toBe(false);
		expect(creditedFeature({ kind: 'river', properties: null } as never)).toBe(false);
		expect(creditedFeature({ kind: 'other', properties: { ref: 'river-network:HydroRIVERS-v10:1' } })).toBe(false);
		// The farm map's flag from the server (farmMap.ts asMapFeatures).
		expect(creditedFeature({ kind: 'river', properties: { credit: 'hydrorivers' } })).toBe(true);
	});
});

describe('jrcCreditedFeature and mapCredits (issue #523 C6)', () => {
	const traced = 'Traced from JRC GSW v1.5 (trace-dam-2): water in at least 25 % of the observations, clicked at 33.6900° S, 21.5100° E. Check it against the map. Source: EC JRC/Google.';
	const reach = { kind: 'river' as const, properties: { ref: 'river-network:HydroRIVERS-v10:1050012345' } };
	const dam = { kind: 'dam' as const, properties: { description: traced } };
	const drawn = { kind: 'dam' as const, properties: {} };

	it('is a feature traced from JRC Global Surface Water: its description names the source, or the farm map’s flag', () => {
		expect(jrcCreditedFeature(dam)).toBe(true);
		expect(jrcCreditedFeature({ properties: { credit: 'jrc-water' } })).toBe(true);
		// The synthetic raster names no source; a drawn dam, a null properties, HydroRIVERS' flag: none.
		expect(jrcCreditedFeature({ properties: { description: 'Traced from Synthetic water occurrence (trace-dam-2): water in at least 25 %.' } })).toBe(false);
		expect(jrcCreditedFeature(drawn)).toBe(false);
		expect(jrcCreditedFeature({ properties: null } as never)).toBe(false);
		expect(jrcCreditedFeature({ properties: { credit: 'hydrorivers' } })).toBe(false);
	});

	it('lists each licensed source drawn once, HydroRIVERS then JRC, and nothing when nothing licensed is drawn', () => {
		expect(mapCredits([])).toEqual([]);
		expect(mapCredits([drawn, { kind: 'river', properties: {} }])).toEqual([]);
		expect(mapCredits([reach, reach])).toEqual(['hydrorivers']);
		expect(mapCredits([dam])).toEqual(['jrc-water']);
		expect(mapCredits([dam, drawn, reach])).toEqual(['hydrorivers', 'jrc-water']);
		// The River network layer drawing HydroRIVERS reaches credits it with no feature from it.
		expect(mapCredits([dam], true)).toEqual(['hydrorivers', 'jrc-water']);
		// The farm map's flags (farmMap.ts asMapFeatures).
		expect(mapCredits([{ kind: 'dam', properties: { credit: 'jrc-water' } }, { kind: 'river', properties: { credit: 'hydrorivers' } }])).toEqual(['hydrorivers', 'jrc-water']);
	});

	it('credits the Southwestern Cape MAP surface while the MAP grid layer draws a grid stored with its credit line (issue #560)', () => {
		const waas = 'Mean annual rainfall surface for the Southwestern Cape. Prepared for the WAAS project by Beuster Clarke & Associates. March 2007, Version 1.1.';
		expect(mapCredits([], false, waas)).toEqual(['waas-map']);
		expect(mapCredits([dam, reach], false, waas)).toEqual(['hydrorivers', 'jrc-water', 'waas-map']);
		// No grid drawn, the synthetic grid, or another grid's line: no credit.
		expect(mapCredits([], false, null)).toEqual([]);
		expect(mapCredits([], false, 'Synthetic MAP grid (invented rainfall over region Z), water-management test fixture')).toEqual([]);
		expect(mapCredits([], false, `${waas} (edited)`)).toEqual([]);
		expect(MAP_CREDIT_TEXT['waas-map']).toBe('MAP grid: WAAS (2007), Beuster Clarke & Associates');
	});

	it('credits the Lynch (2004) grid while the MAP grid layer draws a grid stored with the Atlas’s citation', () => {
		const lynch = 'Schulze, R.E. and Lynch, S.D. 2007. Annual Precipitation. In: Schulze, R.E. (Ed). South African Atlas of Climatology and Agrohydrology. WRC Report 1489/1/06, Section 6.2';
		expect(mapCredits([], false, lynch)).toEqual(['lynch-map']);
		expect(mapCredits([dam, reach], false, lynch)).toEqual(['hydrorivers', 'jrc-water', 'lynch-map']);
		expect(mapCredits([], false, `${lynch}.`)).toEqual([]);
		expect(MAP_CREDIT_TEXT['lynch-map']).toBe('MAP grid: Lynch (2004), WRC Atlas');
	});

	it('credits the WRC Atlas’s A-pan grid while its layer draws a grid stored with its citation, linking to its own section', () => {
		const apan = 'Schulze, R.E. and Maharaj, M. 2007. A-Pan Equivalent Reference Potential Evaporation. In: Schulze, R.E. (Ed). South African Atlas of Climatology and Agrohydrology. WRC Report 1489/1/06';
		const lynch = 'Schulze, R.E. and Lynch, S.D. 2007. Annual Precipitation. In: Schulze, R.E. (Ed). South African Atlas of Climatology and Agrohydrology. WRC Report 1489/1/06, Section 6.2';
		expect(mapCredits([], false, null, [apan])).toEqual(['atlas-apan']);
		expect(mapCredits([dam], false, lynch, [apan])).toEqual(['jrc-water', 'lynch-map', 'atlas-apan']);
		// Nothing drawn, or a grid with another credit line (an operator's own, the synthetic one): no Atlas credit.
		expect(mapCredits([], false, null, [null])).toEqual([]);
		expect(mapCredits([], false, null, ['Invented A-pan grid', `${apan}.`])).toEqual([]);
		expect(MAP_CREDIT_TEXT['atlas-apan']).toBe('A-pan grid: WRC Atlas (modelled)');
		// One credit per licensed source the map draws: no S-pan grid credit since the option was removed (issue #738).
		expect(Object.keys(MAP_CREDIT_TEXT)).toEqual(['hydrorivers', 'jrc-water', 'waas-map', 'lynch-map', 'atlas-apan']);
	});

	it('words each credit for the attribution control: the JRC line names the source as JRC asks and says the outline was modified', () => {
		expect(MAP_CREDIT_TEXT['jrc-water']).toBe('Dam outline: traced from JRC Global Surface Water (Source: EC JRC/Google), modified');
		expect(MAP_CREDIT_TEXT.hydrorivers).toMatch(/^Rivers: HydroRIVERS/);
	});
});

describe('layersStatus (the Layers box’s one status region, WCAG 4.1.3)', () => {
	const off = { on: false, idle: false, failed: false, count: null };
	const loading = { on: true, idle: false, failed: false, count: null };
	it('says each layer loading, then how many it shows, then the reach picked', () => {
		expect(layersStatus(off, off, null)).toBe('');
		expect(layersStatus(loading, loading, null)).toBe('Loading the quaternaries… Loading the river network…');
		expect(layersStatus({ ...loading, count: 1 }, { ...loading, count: 10 }, 'Reach 3')).toBe('1 quaternary shown. 10 reaches shown. Picked Reach 3.');
		expect(layersStatus(off, { ...loading, count: 1 }, null)).toBe('1 reach shown.');
	});
	it('says nothing for a layer with nothing around or that failed (its own alert says it), nor a pick with the rivers off', () => {
		expect(layersStatus({ ...loading, idle: true }, { ...loading, failed: true }, null)).toBe('');
		expect(layersStatus(off, off, 'Reach 3')).toBe('');
	});
});

describe('snappedViewBbox and demGridViewBbox', () => {
	it('snaps a view outward to the step and refuses one past the widest, as every view-asked layer does', () => {
		expect(snappedViewBbox([20.701, -33.449, 20.779, -33.421], 0.01, 0.5)).toEqual([20.7, -33.45, 20.78, -33.42]);
		expect(snappedViewBbox([20, -34, 21, -33], 0.01, 0.5)).toBeNull();
		expect(snappedViewBbox(null, 0.01, 0.5)).toBeNull();
		expect(demGridViewBbox([20.701, -33.449, 20.779, -33.421])).toEqual([20.7, -33.45, 20.78, -33.42]);
		expect(demGridViewBbox([20, -34, 20 + DEM_GRID_BBOX_MAX_DEG + 0.1, -33.9])).toBeNull();
	});

	it('takes the DEM grid as a layer of its own in the URL', () => {
		expect(new URLSearchParams(withLayer('?tab=map', 'demgrid', true)).get('layers')).toBe('demgrid');
	});
});
