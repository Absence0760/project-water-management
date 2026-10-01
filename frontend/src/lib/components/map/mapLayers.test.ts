// The Map tab's layers (mapLayers.ts, issue #326 A6): `layers=` in the URL and
// the bbox the quaternaries are asked for around the features.
import { describe, expect, it } from 'vitest';
import type { MapFeature } from '$lib/api/types';
import { layersOn, QUATERNARY_BBOX_MAX_DEG, quaternaryBbox, withLayer } from './mapLayers';

const poly = (x: number, y: number, d: number) =>
	({ id: 'p', kind: 'farm_parcel', geometry: { type: 'Polygon', coordinates: [[[x, y], [x + d, y], [x + d, y + d], [x, y]]] } }) as MapFeature;

describe('layers in the URL', () => {
	it('reads the known layers from `layers=`, ignoring others', () => {
		expect([...layersOn(new URLSearchParams('layers=quaternaries'))]).toEqual(['quaternaries']);
		expect([...layersOn(new URLSearchParams('layers=satellite,quaternaries'))]).toEqual(['quaternaries']);
		expect(layersOn(new URLSearchParams('tab=map')).size).toBe(0);
	});

	it('turns a layer on and off keeping every other param, and drops `layers` when none is on', () => {
		const on = withLayer('?tab=map&feature=f1', 'quaternaries', true);
		expect(new URLSearchParams(on).get('layers')).toBe('quaternaries');
		expect(new URLSearchParams(on).get('feature')).toBe('f1');
		expect(withLayer(on, 'quaternaries', false)).toBe('?tab=map&feature=f1');
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
