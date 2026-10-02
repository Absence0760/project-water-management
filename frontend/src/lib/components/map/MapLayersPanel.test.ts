// The Map tab's Layers box (MapLayers.svelte): the Relief toggle shows only
// with a DEM configured, with its note when on and its error when the DEM
// failed. Server-rendered; the toggling itself (the URL) is mapLayers.test.ts's.
// (Not MapLayers.test.ts: mapLayers.test.ts differs from it only in case.)
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/projects/p?tab=map') } }));

import MapLayers from './MapLayers.svelte';
import type { QuaternaryLayer } from './quaternaryLayer.svelte';

const quaternaries = { on: false } as unknown as QuaternaryLayer;
const html = (relief: { on: boolean; failed: boolean } | null) => render(MapLayers, { props: { quaternaries, dark: false, relief } }).body;

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
