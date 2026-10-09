// The Map tab's Layers box (MapLayers.svelte): the Relief toggle shows only
// with a DEM configured, with its note when on and its error when the DEM
// failed; the River network (#345) lists its reaches, the picked one's facts
// and source, and Add for an editor only, or "On the map" once added. Server-rendered; the toggling itself (the URL) is mapLayers.test.ts's.
// (Not MapLayers.test.ts: mapLayers.test.ts differs from it only in case.)
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/projects/p?tab=map') } }));

import MapLayers from './MapLayers.svelte';
import type { RiverReach } from '$lib/api';
import type { QuaternaryLayer } from './quaternaryLayer.svelte';
import { reachKey } from './mapLayers';
import type { RiverLayer } from './riverLayer.svelte';
import { withoutComments } from '../__fixtures__/withoutComments';

// HelpTip links to the glossary under the app's base path.
vi.mock('$app/paths', () => ({ base: '' }));

const quaternaries = { on: false } as unknown as QuaternaryLayer;
const riversOff = { on: false } as unknown as RiverLayer;
const html = (relief: { on: boolean; failed: boolean } | null) => render(MapLayers, { props: { quaternaries, rivers: riversOff, dark: false, relief } }).body;

const reach = (reachId: number, strahler: number, extra: Partial<RiverReach> = {}): RiverReach => ({
	dataset: 'synthetic',
	reachId,
	name: '',
	strahler,
	upstreamKm2: 655,
	lengthKm: 8.94,
	dischargeM3s: 1.84,
	synthetic: true,
	source: 'SYNTHETIC test data',
	geometry: { type: 'LineString', coordinates: [[21.3, -33.66], [21.36, -33.74]] },
	featureId: null,
	...extra
});
/** A River network layer that is on, with `reaches` loaded, `picked` picked and `added` already on the map. */
function riversOn(reaches: RiverReach[], picked: RiverReach | null, added: number[] = []): RiverLayer {
	return {
		on: true,
		nothingAround: false,
		error: null,
		answer: { bbox: [21, -34, 22, -33], reaches, truncated: false, datasets: [{ dataset: 'synthetic', count: reaches.length }] },
		picked: picked ? reachKey(picked) : null,
		pickedReach: picked,
		adding: null,
		addError: null,
		featureFor: (r: RiverReach) => (added.includes(r.reachId) ? { id: `f${r.reachId}` } : null)
	} as unknown as RiverLayer;
}
const riverHtml = (rivers: RiverLayer, canEdit: boolean) =>
	withoutComments(render(MapLayers, { props: { quaternaries, rivers, dark: false, canEdit, onshowfeature: () => {} } }).body);

describe('the Layers box’s Relief toggle', () => {
	it('is not offered without a DEM configured (a fresh clone, CI)', () => {
		expect(html(null)).not.toContain('data-testid="map-layer-relief"');
	});

	it('is offered, unchecked, with no note while off', () => {
		const b = html({ on: false, failed: false });
		expect(b).toMatch(/<input[^>]*type="checkbox"[^>]*data-testid="map-layer-relief"/);
		expect(b).not.toMatch(/<input[^>]*checked[^>]*data-testid="map-layer-relief"/);
		expect(b).not.toContain('map-relief-note');
	});

	it('says where the shading comes from while on', () => {
		const b = html({ on: true, failed: false });
		expect(b).toMatch(/<input[^>]*checked[^>]*data-testid="map-layer-relief"/);
		expect(b).toContain('Hills shaded from the Copernicus 30 m elevation model.');
	});

	it('says so, as an alert, when the DEM couldn’t be read', () => {
		const b = html({ on: true, failed: true });
		expect(b).toMatch(/role="alert"[^>]*data-testid="map-relief-error"/);
		expect(b).not.toContain('map-relief-note');
	});
});

describe('withoutComments', () => {
	it('drops every marker, nested or back to back, and keeps the text between', () => {
		expect(withoutComments('<!--[--><p>a<!--]--><!--[0-->b</p><!--]-->')).toBe('<p>ab</p>');
		expect(withoutComments('<!--<!---->x')).toBe('x');
		expect(withoutComments('x<!-- unclosed')).toBe('x');
	});
});

describe('the Layers box’s River network', () => {
	it('is offered, unchecked, with nothing listed while off', () => {
		const b = html(null);
		expect(b).toMatch(/<input[^>]*type="checkbox"[^>]*data-testid="map-layer-rivers"/);
		expect(b).not.toContain('data-testid="map-rivers"');
	});

	it('lists the reaches, says they are synthetic, and shows only the first twelve until Show all', () => {
		const reaches = Array.from({ length: 14 }, (_, i) => reach(90000001 + i, 3 - Math.min(2, Math.floor(i / 5))));
		const b = riverHtml(riversOn(reaches, null), true);
		expect(b).toContain('14 reaches around the catchment, the biggest first, from synthetic.');
		expect(b).toContain('Synthetic test data, never real rivers.');
		expect(b.match(/aria-pressed=/g)).toHaveLength(12);
		expect(b).toContain('Show all 14');
		expect(b).not.toContain('map-reach-picked');
	});

	it('shows the picked reach’s facts and source, and Add for an editor', () => {
		const r = reach(90000002, 3);
		const b = riverHtml(riversOn([r], r), true);
		expect(b).toContain('Reach 90000002</strong>: Strahler order 3, 655 km² upstream, 8.9 km long, modelled mean flow 1.84 m³/s.');
		expect(b).toContain('Source: SYNTHETIC test data');
		expect(b).toContain('data-testid="map-reach-add"');
	});

	it('shows no Add to a viewer, and "On the map" once the reach was added', () => {
		const r = reach(90000002, 3);
		expect(riverHtml(riversOn([r], r), false)).not.toContain('map-reach-add');
		const added = riverHtml(riversOn([r], r, [90000002]), true);
		expect(added).not.toContain('map-reach-add');
		expect(added).toContain('On the map as a river.');
		expect(added).toContain('data-testid="map-reach-show"');
		expect(added).toMatch(/>Reach 90000002<span[^>]*> · order 3<\/span><span[^>]*> · 655 km²<\/span><span[^>]*> · on the map<\/span>/);
	});

	it('says when no network is loaded', () => {
		const none = { ...riversOn([], null), answer: { bbox: [21, -34, 22, -33], reaches: [], truncated: false, datasets: [] } } as unknown as RiverLayer;
		expect(riverHtml(none, true)).toContain('No river network is loaded');
	});
});

describe('the Layers box’s Hydrological units, MAP grid and CHIRPS grid toggles', () => {
	const props = (extra: Record<string, unknown>) => withoutComments(render(MapLayers, { props: { quaternaries, rivers: riversOff, dark: false, onshowfeature: () => {}, ...extra } }).body);
	const at: [number, number] = [21.3, -33.6];

	it('offers none of them unless the tab passes them, and each unchecked while off', () => {
		expect(props({})).not.toMatch(/map-layer-(units|mapgrid|chirps)/);
		const off = props({ units: { on: false, labels: [] }, chirps: { on: false, cells: null } });
		expect(off).toMatch(/<input[^>]*type="checkbox"[^>]*data-testid="map-layer-units"/);
		expect(off).not.toMatch(/<input[^>]*checked[^>]*data-testid="map-layer-units"/);
		expect(off).not.toContain('map-units-summary');
	});

	it('lists the units it labels, each by its unit with its polygon’s own name and area, and says when there are none', () => {
		const b = props({ units: { on: true, labels: [{ featureId: 'f1', label: 'Lower unit', polygonName: 'Lower polygon', areaKm2: 12.5, at }] } });
		expect(b).toContain('1 unit, each outlined and named on the map.');
		expect(b).toContain('Lower unit');
		expect(b).toContain('“Lower polygon”');
		expect(b).toContain('12.5 km²');
		expect(props({ units: { on: true, labels: [] } })).toContain('No hydrological unit polygons on the map yet');
		// Without the map's fonts, the list is where the names are read.
		expect(props({ units: { on: true, labels: [{ featureId: 'f1', label: 'A', polygonName: null, areaKm2: null, at }] }, labels: false })).toContain('read the names below');
	});

	it('says how many CHIRPS points are in view, or to zoom in', () => {
		const cells = [{ lon: 19.225, lat: -32.675, square: [19.2, -32.7, 19.25, -32.65] }];
		expect(props({ chirps: { on: true, cells } })).toContain('1 CHIRPS v3 grid point in view, each the centre of a 0.05° cell');
		expect(props({ chirps: { on: true, cells: null } })).toContain('Zoom in to see the CHIRPS grid');
	});

	it('shows the MAP grid’s points from one dataset with their range and source, a picker when there are two, and each other state', () => {
		const ds = (dataset: string, cellDeg: number, synthetic = false) => ({ dataset, source: `Source of ${dataset}`, version: '1', attribution: 'a', cellDeg, cells: 9, synthetic });
		const grid = (answer: unknown, extra: Record<string, unknown> = {}) =>
			({ on: true, zoomIn: false, error: null, answer, range: [612, 790], pick: () => {}, retry: () => {}, ...extra }) as never;
		const two = { bbox: [0, 0, 1, 1], dataset: ds('synthetic', 0.01, true), datasets: [ds('coarse-test', 0.25), ds('synthetic', 0.01, true)], cells: [[21.305, -33.645, 790], [21.315, -33.645, 612]], tooDense: false, max: 5000 };
		const b = props({ mapGrid: grid(two) });
		expect(b).toContain('2 points in view from synthetic (0.01° cells): 612 mm to 790 mm.');
		expect(b).toContain('Synthetic test data, never real rainfall.');
		expect(b).toContain('Source: Source of synthetic');
		expect(b).toContain('data-testid="map-mapgrid-dataset"');
		expect(props({ mapGrid: grid({ ...two, datasets: [two.dataset] }) })).not.toContain('map-mapgrid-dataset');
		expect(props({ mapGrid: grid({ ...two, cells: [], tooDense: true }) })).toMatch(/This view holds more than 5.000 of the grid’s points/);
		expect(props({ mapGrid: grid({ ...two, dataset: null, datasets: [] }) })).toContain('No MAP grid is loaded');
		expect(props({ mapGrid: grid(null, { zoomIn: true }) })).toContain('Zoom in to see the MAP grid');
		expect(props({ mapGrid: grid(null, { error: 'offline' }) })).toContain('The MAP grid couldn’t be loaded: offline');
	});
});

describe('the Layers box’s DEM grid toggle', () => {
	const grid = (answer: unknown, extra: Record<string, unknown> = {}) => ({ on: true, zoomIn: false, error: null, answer, range: [640, 812], retry: () => {}, ...extra }) as never;
	const html_ = (demGrid: unknown) => withoutComments(render(MapLayers, { props: { quaternaries, rivers: riversOff, dark: false, demGrid: demGrid as never } }).body);
	const ok = { bbox: [0, 0, 1, 1], dataset: { label: 'Synthetic DEM 1', attribution: '', zoom: 10 }, stride: 10, cellM: 32, points: [[20.71, -33.43, 812], [20.72, -33.43, 640]], tooDense: false, max: 5000 };

	it('is offered only when the tab passes it, and says what is drawn, how far apart, the range and the source', () => {
		expect(html_(null)).not.toContain('map-layer-demgrid');
		const b = html_(grid(ok));
		expect(b).toContain('2 points in view: every 10th cell of the elevation model each way (cells about 32 m, so a point every 320 m), 640 m to 812 m.');
		expect(b).toContain('Source: Synthetic DEM 1');
	});

	it('says to zoom in, too dense, nothing in view, or the error', () => {
		expect(html_(grid(null, { zoomIn: true }))).toContain('Zoom in to see the DEM grid');
		expect(html_(grid({ ...ok, points: [], tooDense: true }))).toMatch(/This view holds more than 5.000 of the grid’s points/);
		expect(html_(grid({ ...ok, points: [] }))).toContain('The elevation model has no cell in this view.');
		expect(html_(grid(null, { error: 'The DEM grid is off: the server has no elevation model (DEM_URL is empty).' }))).toContain('no elevation model');
	});
});
