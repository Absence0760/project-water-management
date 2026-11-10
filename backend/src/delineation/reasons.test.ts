import { describe, expect, it } from 'vitest';
import { REASON_MAX } from '../history/record.js';
import { divideReason, startReason } from './reasons.js';

// 60 areas taken effective, each with a 100-character name: far past REASON_MAX if listed whole.
const many = Array.from({ length: 60 }, (_, i) => `Unit ${i} ${'y'.repeat(100)}`.slice(0, 100));

describe('divideReason', () => {
	it('reads as before when it fits', () => {
		expect(divideReason({ areas: 2, effective: [], orders: 3, gauges: 1, newUnits: 1, restAdded: false, dataset: 'Synthetic DEM', methodVersion: 'start-18' })).toBe(
			'Divided from the map: 2 areas (gross), 3 drains-into, 1 gauge added, 1 unit added from Synthetic DEM, start-18'
		);
		expect(divideReason({ areas: 3, effective: ['Dam', 'Rest'], orders: 0, gauges: 0, newUnits: 0, restAdded: true, dataset: 'Synthetic DEM', methodVersion: 'start-18' })).toBe(
			'Divided from the map: 3 areas (gross; effective, without what drains into pans: Dam, Rest), 0 drains-into, the rest of the catchment added from Synthetic DEM, start-18'
		);
	});

	it('keeps the elevation model and method version whole with 60 effective areas, counting the names it leaves out (issue #763)', () => {
		const text = divideReason({ areas: 61, effective: many, orders: 60, gauges: 4, newUnits: 2, restAdded: true, dataset: 'Copernicus GLO-30', methodVersion: 'start-18' });
		expect(text.length).toBeLessThanOrEqual(REASON_MAX);
		expect(text).toMatch(/^Divided from the map: 61 areas \(gross; effective, without what drains into pans: Unit 0 y+, .* and \d+ more\), 60 drains-into, 4 gauges added, 2 units added, the rest of the catchment added from Copernicus GLO-30, start-18$/);
		expect(text).not.toContain('…');
	});
});

describe('startReason', () => {
	it('reads as before when it fits', () => {
		expect(startReason({ units: 4, areas: 2, effective: [], orders: 1, dataset: 'Synthetic DEM', methodVersion: 'start-18' })).toBe(
			'Started from the map: 4 hydrological units; 2 areas (gross) and 1 drains-into from Synthetic DEM, start-18'
		);
		expect(startReason({ units: 2, areas: 1, effective: ['A'], orders: 0, dataset: null, methodVersion: 'start-18' })).toBe(
			'Started from the map: 2 hydrological units; 1 area (effective, without what drains into pans) and 0 drains-into from the points as placed'
		);
	});

	it('keeps the elevation model and method version whole with 60 effective areas (issue #763)', () => {
		const text = startReason({ units: 62, areas: 61, effective: many, orders: 60, dataset: 'Copernicus GLO-30', methodVersion: 'start-18' });
		expect(text.length).toBeLessThanOrEqual(REASON_MAX);
		expect(text).toMatch(/ and \d+ more\) and 60 drains-into from Copernicus GLO-30, start-18$/);
		expect(text).not.toContain('…');
	});

	it('counts the names when not even one fits beside a long dataset label', () => {
		const text = startReason({ units: 62, areas: 61, effective: many, orders: 60, dataset: 'D'.repeat(350), methodVersion: 'start-18' });
		expect(text.length).toBeLessThanOrEqual(REASON_MAX);
		expect(text).toContain('without what drains into pans: 60 areas)');
		expect(text.endsWith(`from ${'D'.repeat(350)}, start-18`)).toBe(true);
	});
});
