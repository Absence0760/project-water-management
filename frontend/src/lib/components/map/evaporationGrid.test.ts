// The A-pan and S-pan grid layers' words (evaporationGrid.ts, docs/maps.md §
// A-pan and S-pan grids): two layers of their own in `layers=`, the picker's
// months in water-year order, and what a grid's values are.
import { describe, expect, it } from 'vitest';
import { EVAPORATION_GRID_LABEL, EVAPORATION_GRID_LAYER, EVAPORATION_GRID_MONTHS, evaporationGridWhat, evaporationMonthLabel, evaporationValueWords } from './evaporationGrid';
import { layersOn, MAP_LAYERS, withLayer } from './mapLayers';

describe('the A-pan and S-pan grid layers (docs/maps.md § A-pan and S-pan grids)', () => {
	it('are two layers of their own beside the MAP grid, each toggled alone in the URL', () => {
		expect(EVAPORATION_GRID_LAYER).toEqual({ apan: 'apangrid', span: 'spangrid' });
		expect(EVAPORATION_GRID_LABEL).toEqual({ apan: 'A-pan grid', span: 'S-pan grid' });
		expect(MAP_LAYERS.slice(MAP_LAYERS.indexOf('mapgrid'), MAP_LAYERS.indexOf('mapgrid') + 3)).toEqual(['mapgrid', 'apangrid', 'spangrid']);
		const both = withLayer(withLayer('?tab=map', 'spangrid', true), 'apangrid', true);
		expect(new URLSearchParams(both).get('layers')).toBe('apangrid,spangrid');
		const one = withLayer(both, 'apangrid', false);
		expect([...layersOn(new URLSearchParams(one))]).toEqual(expect.arrayContaining(['spangrid']));
		expect(layersOn(new URLSearchParams(one)).has('apangrid')).toBe(false);
	});

	it('offer the year’s total first, then the months in water-year order, each named', () => {
		expect(EVAPORATION_GRID_MONTHS).toEqual([null, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(EVAPORATION_GRID_MONTHS.map(evaporationMonthLabel).slice(0, 3)).toEqual(['Year (total)', 'October', 'November']);
		expect(evaporationValueWords(null)).toBe('mm a year');
		expect(evaporationValueWords(2)).toBe('mm in February (mean)');
	});

	it('say what a grid’s values are from its label, the S-pan grid a cross-check the model never uses', () => {
		expect(evaporationGridWhat({ kind: 'apan', label: 'modelled A-pan equivalent reference potential evaporation (WRC Atlas, not a measured pan)' })).toBe(
			'Modelled A-pan equivalent reference potential evaporation (WRC Atlas, not a measured pan).'
		);
		expect(evaporationGridWhat({ kind: 'span', label: 'Symons-pan (S-pan) evaporation' })).toBe('Symons-pan (S-pan) evaporation: a cross-check only, never used by the model.');
	});
});
