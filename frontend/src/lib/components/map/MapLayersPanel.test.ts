// The Map tab's Layers box (MapLayers.svelte): the Relief toggle shows only
// with a DEM configured, with its note when on and its error when the DEM
// failed; the River network (#345; its toggle "Rivers (HydroRIVERS)", the DEM
// rivers beside it) lists its reaches, the picked one's facts
// and source, and Add for an editor only, or "On the map" once added. Server-rendered; the toggling itself (the URL) is mapLayers.test.ts's.
// (Not MapLayers.test.ts: mapLayers.test.ts differs from it only in case.)
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/projects/p?tab=map') } }));

import MapLayers from './MapLayers.svelte';
import Toggles from './EvaporationGridToggles.svelte';
import type { RiverReach } from '#lib/api/index.js';
import type { QuaternaryLayer } from './quaternaryLayer.svelte';
import { mapLabel, reachKey } from './mapLayers';
import type { RiverLayer } from './riverLayer.svelte';
import type { AreaFill } from './areaFill.svelte';
import { withoutComments } from '../__fixtures__/withoutComments';

// HelpTip links to the glossary under the app's base path.
vi.mock('$app/paths', () => ({ resolve: (p: string) => `/${p}`, asset: (f: string) => `/${f}` }));

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

	it('names the grid’s credit beside its source when they differ, once when they are the same (issue #560)', () => {
		const answer = (source: string, attribution: string) => ({
			bbox: [0, 0, 1, 1],
			dataset: { dataset: 'WAAS-SWCape-2007', source, version: 'v1.1 (March 2007)', attribution, cellDeg: 0.001, cells: 9, synthetic: false },
			datasets: [],
			cells: [[21.305, -33.645, 790]],
			tooDense: false,
			max: 5000
		});
		const grid = (a: unknown) => ({ on: true, zoomIn: false, error: null, answer: a, range: [790, 790], pick: () => {}, retry: () => {} }) as never;
		const waas = 'Mean annual rainfall surface for the Southwestern Cape. Prepared for the WAAS project by Beuster Clarke & Associates. March 2007, Version 1.1.';
		const same = props({ mapGrid: grid(answer(waas, waas)) });
		expect(same).toContain(`Source: ${waas.replaceAll('&', '&amp;')}`);
		expect(same).not.toContain('Credit:');
		expect(props({ mapGrid: grid(answer('A provincial surface', 'Its authors, 2007')) })).toContain('Source: A provincial surface. Credit: Its authors, 2007');
		// The synthetic grid's warning already says what its attribution would.
		expect(props({ mapGrid: grid({ ...answer('Invented grid', 'Synthetic test data'), dataset: { ...answer('Invented grid', 'Synthetic test data').dataset, synthetic: true } }) })).not.toContain('Credit:');
	});
});

describe('the Layers box’s A-pan and S-pan grid toggles (docs/maps.md § A-pan and S-pan grids)', () => {
	const props = ({ evaporationGrids, ...extra }: Record<string, unknown>) =>
		withoutComments(render(MapLayers, { props: { quaternaries, rivers: riversOff, dark: false, ...(evaporationGrids ? { evaporationGrids: { grids: evaporationGrids as never, Toggles } } : {}), ...extra } }).body);
	const atlasApan = {
		dataset: 'Atlas-Apan-2007',
		kind: 'apan',
		label: 'modelled A-pan equivalent reference potential evaporation (WRC Atlas, not a measured pan)',
		source: 'Modelled A-pan equivalent (WRC Atlas, Schulze and Maharaj): invented here',
		version: '1',
		method: 'm',
		attribution: 'Schulze and Maharaj 2007',
		firstYear: 1950,
		lastYear: 1999,
		cellDeg: 0.016666666667,
		synthetic: false
	};
	const span = { ...atlasApan, dataset: 'Atlas-Span-2007', kind: 'span', label: 'Symons-pan (S-pan) evaporation', source: 'CCWR S-pan grids, invented here', attribution: 'Schulze 2007' };
	const answer = (dataset: unknown, extra: Record<string, unknown> = {}) => ({
		bbox: [0, 0, 1, 1],
		kind: (dataset as { kind?: string } | null)?.kind ?? 'apan',
		month: null,
		dataset,
		datasets: dataset ? [dataset] : [],
		cells: [
			[21.30833, -33.69167, 1812],
			[21.325, -33.69167, 1840]
		],
		tooDense: false,
		max: 5000,
		...extra
	});
	const layer = (kind: 'apan' | 'span', a: unknown, extra: Record<string, unknown> = {}) =>
		({ kind, on: true, zoomIn: false, error: null, answer: a, month: null, range: [1812, 1840], status: null, pick: () => {}, pickMonth: () => {}, retry: () => {}, ...extra }) as never;
	const off = (kind: 'apan' | 'span') => layer(kind, null, { on: false });

	it('offers two toggles of their own, beside the MAP grid, unchecked while off', () => {
		expect(props({})).not.toMatch(/map-layer-(apangrid|spangrid)/);
		const b = props({ evaporationGrids: [off('apan'), off('span')] });
		expect(b).toMatch(/<input[^>]*type="checkbox"[^>]*data-testid="map-layer-apangrid"/);
		expect(b).toMatch(/<input[^>]*type="checkbox"[^>]*data-testid="map-layer-spangrid"/);
		expect(b).not.toMatch(/<input[^>]*checked[^>]*data-testid="map-layer-(apan|span)grid"/);
		expect(b).toContain('A-pan grid');
		expect(b).toContain('S-pan grid');
		expect(b).not.toContain('map-apangrid-summary');
	});

	it('draws the A-pan grid’s year totals with their range, names it CCWR A-pan, says modelled, not measured, and credits the source', () => {
		const b = props({ evaporationGrids: [layer('apan', answer(atlasApan)), off('span')] });
		expect(b).toContain(`2 points in view from CCWR A-pan (0.017° cells, 1950–1999 means), mm a year: ${mapLabel(1812)} to ${mapLabel(1840)}.`);
		const src = b.match(/data-testid="map-apangrid-source">([^<]*)</)![1]!;
		expect(src).toMatch(/^\s*Modelled A-pan equivalent reference potential evaporation \(WRC Atlas, not a measured pan\)\. Source: /);
		expect(src).toContain('Credit: Schulze and Maharaj 2007');
		expect(b).not.toContain('Synthetic test data');
	});

	it('says "means for no stated period" for a grid whose source states none, never "null–null" (issue #755)', () => {
		const b = props({ evaporationGrids: [layer('apan', answer({ ...atlasApan, firstYear: null, lastYear: null })), off('span')] });
		expect(b).toContain(`2 points in view from CCWR A-pan (0.017° cells, means for no stated period), mm a year: ${mapLabel(1812)} to ${mapLabel(1840)}.`);
		expect(b.match(/data-testid="map-apangrid-summary"[^>]*>([^<]*)</)![1]).not.toMatch(/null|NaN/);
	});

	it('says the S-pan grid is a cross-check only, never used by the model', () => {
		const b = props({ evaporationGrids: [off('apan'), layer('span', answer(span))] });
		expect(b).toMatch(/data-testid="map-spangrid-source">\s*Symons-pan \(S-pan\) evaporation: a cross-check only, never used by the model\. Source: CCWR S-pan grids/);
	});

	it('offers the year’s total first, then the months October to September, and names the month the values are', () => {
		const b = props({ evaporationGrids: [layer('apan', answer(atlasApan, { month: 3 }), { month: 3 }), off('span')] });
		const picker = b.match(/<select[^>]*data-testid="map-apangrid-month"[^>]*>([\s\S]*?)<\/select>/)![1]!;
		expect([...picker.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1])).toEqual([
			'Year (total)',
			'October',
			'November',
			'December',
			'January',
			'February',
			'March',
			'April',
			'May',
			'June',
			'July',
			'August',
			'September'
		]);
		expect(b).toContain('mm in March (mean)');
	});

	it('says so, with a reload, when the layers’ own chunk failed to load', () => {
		const b = withoutComments(render(MapLayers, { props: { quaternaries, rivers: riversOff, dark: false, evaporationGrids: 'failed' } }).body);
		expect(b).toContain('The A-pan and S-pan grid layers');
		expect(b).toContain('Reload page');
		expect(b).not.toContain('map-layer-apangrid');
	});

	it('says plainly when no grid of its kind is loaded, and each other state', () => {
		expect(props({ evaporationGrids: [layer('apan', answer(null)), off('span')] })).toContain('There’s no A-pan grid on this server yet, so there is nothing to draw.');
		expect(props({ evaporationGrids: [off('apan'), layer('span', answer(null, { kind: 'span' }))] })).toContain('There’s no S-pan grid on this server yet, so there is nothing to draw.');
		expect(props({ evaporationGrids: [layer('apan', null, { zoomIn: true }), off('span')] })).toContain('Zoom in to see the A-pan grid');
		expect(props({ evaporationGrids: [layer('apan', null, { error: 'offline' }), off('span')] })).toContain('The A-pan grid couldn’t be loaded: offline');
		expect(props({ evaporationGrids: [layer('apan', answer(atlasApan, { cells: [], tooDense: true })), off('span')] })).toMatch(/This view holds more than 5.000 of the grid’s points/);
		expect(props({ evaporationGrids: [layer('apan', answer(atlasApan, { cells: [] })), off('span')] })).toContain('The grid has no point in this view.');
		const twoSets = props({ evaporationGrids: [layer('apan', answer(atlasApan, { datasets: [atlasApan, { ...atlasApan, dataset: 'synthetic-apan', synthetic: true }] })), off('span')] });
		expect(twoSets).toContain('data-testid="map-apangrid-dataset"');
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

describe('the Layers box’s DEM rivers toggle, beside HydroRIVERS', () => {
	const state = { noView: false, zoomIn: false, error: null, loading: false, tileCount: 4, retry: () => {} };
	const html_ = (demRivers: unknown) => withoutComments(render(MapLayers, { props: { quaternaries, rivers: riversOff, dark: false, demRivers: demRivers as never } }).body);

	it('pairs the two river layers by name: HydroRIVERS’ toggle reads “Rivers (HydroRIVERS)”, its id still `rivers`', () => {
		const b = html_({ on: false, layer: state });
		expect(b).toMatch(/data-testid="map-layer-rivers"[^>]*>[\s\S]*?Rivers \(HydroRIVERS\)/);
		expect(b).toMatch(/data-testid="map-layer-channels"[^>]*>[\s\S]*?DEM rivers/);
	});

	it('is not offered without an elevation model, or to a viewer (the tab passes null)', () => {
		expect(html_(null)).not.toContain('map-layer-channels');
	});

	it('is unchecked with nothing said while off', () => {
		const b = html_({ on: false, layer: state });
		expect(b).not.toMatch(/<input[^>]*checked[^>]*data-testid="map-layer-channels"/);
		expect(b).not.toContain('data-testid="map-channels"');
	});

	it('says what the lines are while drawn, and to zoom in past about 35 km instead of drawing nothing in silence', () => {
		const drawn = html_({ on: true, layer: state });
		expect(drawn).toMatch(/<input[^>]*checked[^>]*data-testid="map-layer-channels"/);
		expect(drawn).toContain('The rivers delineation follows, worked out from the elevation model');
		expect(drawn).toContain('data-state="drawn"');
		expect(drawn).toContain('DEM rivers drawn.');
		const zoom = html_({ on: true, layer: { ...state, zoomIn: true } });
		expect(zoom).toContain('Zoom in to about 35 km across to draw the DEM rivers.');
		expect(zoom).toContain('data-state="zoom"');
		expect(zoom).not.toContain('DEM rivers drawn.');
	});

	it('says the DEM rivers are paused for the hour, in words and not as an alert, when their own pool is spent', () => {
		const b = html_({ on: true, layer: { ...state, paused: true } });
		expect(b).toContain('data-state="paused"');
		expect(b).toContain('DEM rivers paused for this hour; delineation still works.');
		expect(b).not.toContain('role="alert"');
		expect(b).not.toContain('DEM rivers drawn.');
	});

	it('says why they couldn’t be drawn, as an alert with Try again', () => {
		const b = html_({ on: true, layer: { ...state, error: 'You have asked the elevation model 60 times in the last hour; try again later.' } });
		expect(b).toMatch(/role="alert"[^>]*>The DEM rivers couldn’t be drawn: You have asked the elevation model 60 times/);
		expect(b).toContain('data-retry');
	});
});

describe('the Layers box’s Area fill slider', () => {
	it('is offered only when the tab passes it, at its percentage, with a note on what it fills', () => {
		const render_ = (areaFill: unknown) => withoutComments(render(MapLayers, { props: { quaternaries, rivers: riversOff, dark: false, areaFill: areaFill as AreaFill | null } }).body);
		expect(render_(null)).not.toContain('map-area-fill');
		const b = render_({ percent: 40, scale: 0.4, set: () => {} });
		expect(b).toMatch(/<input[^>]*type="range"[^>]*data-testid="map-area-fill-slider"/);
		expect(b).toMatch(/aria-valuetext="40 %"/);
		expect(b).toMatch(/<span[^>]*aria-hidden="true"[^>]*data-testid="map-area-fill-value"[^>]*>40 %<\/span>/);
		// One live region in the box (WCAG 4.1.3): the slider's value is no second one.
		expect(b).not.toContain('<output');
		expect(b).toContain('outlines stay');
	});
});
