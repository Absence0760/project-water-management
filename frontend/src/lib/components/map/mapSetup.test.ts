import { describe, expect, it } from 'vitest';
import { mapSetupSteps, setupCount } from './mapSetup';

describe('mapSetupSteps', () => {
	it('with no boundary: both steps to do, whatever the feeds say', () => {
		for (const rain of [null, 'none', 'current', 'error'] as const) {
			const steps = mapSetupSteps({ boundaryName: null, rain })!;
			expect(steps.map((s) => [s.id, s.done])).toEqual([
				['boundary', false],
				['rain', false]
			]);
			expect(setupCount(steps)).toBe('0 of 2');
		}
	});
	it('with no boundary: the step leads with Delineate when the server has an elevation model, as the empty map does', () => {
		expect(mapSetupSteps({ boundaryName: null, rain: null, canDelineate: true })![0]!.detail).toBe(
			'No catchment boundary yet. Delineate it from its outlet on the river, draw it on the map, or upload it as a GeoJSON file (WGS84).'
		);
		expect(mapSetupSteps({ boundaryName: null, rain: null })![0]!.detail).toBe('No catchment boundary yet. Draw it on the map, or upload it as a GeoJSON file (WGS84).');
	});
	it('with a boundary and no feed reading it (or one reading it before a redraw): one of two', () => {
		const none = mapSetupSteps({ boundaryName: 'Upper catchment', rain: 'none' })!;
		expect(setupCount(none)).toBe('1 of 2');
		expect(none[0]!.detail).toBe('Upper catchment is on the map.');
		expect(none[1]!.detail).toBe('No rain feed reads this catchment boundary yet.');
		expect(mapSetupSteps({ boundaryName: '', rain: 'changed' })![1]!.detail).toBe('The boundary changed since the rain feed took its cells.');
	});
	it('nothing once every step is done, nor while the feeds are still read or failed to load', () => {
		expect(mapSetupSteps({ boundaryName: 'B', rain: 'current' })).toBeNull();
		expect(mapSetupSteps({ boundaryName: 'B', rain: null })).toBeNull();
		expect(mapSetupSteps({ boundaryName: 'B', rain: 'error' })).toBeNull();
	});
});
