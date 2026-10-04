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
import { riverNetworkColours } from './mapStyle';
import type { RiverLayer } from './riverLayer.svelte';

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
/**
 * Svelte's hydration markers (`<!--[-->`, `<!--]-->`, …) cut out, so the markup
 * reads as a person sees its text. Split at every opener, each piece keeping
 * what follows its closer: no marker survives, however they sit together.
 */
function withoutComments(html: string): string {
	const [head, ...rest] = html.split('<!--');
	return head + rest.map((piece) => (piece.includes('-->') ? piece.slice(piece.indexOf('-->') + 3) : '')).join('');
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

	it('keys each dataset in view to its map colour when there is more than one, and not for one', () => {
		expect(riverHtml(riversOn([reach(1, 3)], null), true)).not.toContain('map-rivers-key');
		const datasets = [{ dataset: 'DWS-rivs500k', count: 1 }, { dataset: 'HydroRIVERS-v10', count: 1 }];
		const two = { ...riversOn([], null), answer: { bbox: [21, -34, 22, -33], reaches: [reach(1, 3, { dataset: 'HydroRIVERS-v10', synthetic: false }), reach(2, 2, { dataset: 'DWS-rivs500k', synthetic: false })], truncated: false, datasets } } as unknown as RiverLayer;
		const b = riverHtml(two, true);
		const key = b.slice(b.indexOf('data-testid="map-rivers-key"'), b.indexOf('</ul>', b.indexOf('data-testid="map-rivers-key"')));
		expect(b).toMatch(/<ul[^>]*aria-label="River network colours"[^>]*data-testid="map-rivers-key"/);
		const [first, second] = riverNetworkColours(false);
		// In the answer's order, each with the colour its place among the loaded datasets gives it.
		expect(key).toMatch(new RegExp(`--rn: ${second}[^>]*></span>HydroRIVERS-v10</li>.*--rn: ${first}[^>]*></span>DWS-rivs500k</li>`));
	});

	it('says when no network is loaded', () => {
		const none = { ...riversOn([], null), answer: { bbox: [21, -34, 22, -33], reaches: [], truncated: false, datasets: [] } } as unknown as RiverLayer;
		expect(riverHtml(none, true)).toContain('No river network is loaded');
	});
});
