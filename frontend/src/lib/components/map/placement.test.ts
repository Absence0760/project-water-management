import { describe, expect, it } from 'vitest';
import type { PointPlacement } from '$lib/api/types';
import { choiceFor, emptyPlacement, OUTLET_KEY, placedByMappedRivers, placementLine, withPlacement } from './placement';

const reach = { dataset: 'HydroRIVERS-v10', reachId: 11509680, upstreamKm2: 292.4, chosen: false };
const pl = (over: Partial<PointPlacement>): PointPlacement => ({ placedBy: 'snapped', larger: null, ...over });

describe('placementLine', () => {
	it('says how each point was put on the channel and how far it moved', () => {
		expect(placementLine(pl({}), 143)).toBe('On the nearest terrain channel, 143 m from the point.');
		// A plan from start-7 to start-14 (the mapped river's rules, gone since issue #472) still reads as it was placed.
		expect(placementLine(pl({ placedBy: 'matched', reach }), 602.4)).toBe('On the channel matching river reach 11509680 (292 km²), 602 m from the point.');
		expect(placementLine(pl({ placedBy: 'matched', reach: { ...reach, chosen: true } }), 40)).toBe('On the channel matching river reach 11509680 (292 km²), picked at the confluence, 40 m from the point.');
		expect(placementLine(pl({ placedBy: 'junction', reach: { ...reach, chosen: true } }), 120)).toBe('At the elevation model’s junction for river reach 11509680 (292 km²), picked at the confluence, 120 m from the point.');
		expect(placementLine(pl({ placedBy: 'larger' }), 382)).toBe('On the larger channel, as you chose, 382 m from the point.');
		expect(placementLine(pl({ placedBy: 'exact' }), 0)).toBe('On the delineated outlet, as Delineate placed it.');
		expect(placementLine(pl({ placedBy: 'polygon' }), null)).toBe('At the dam polygon’s most-drained cell (its outflow).');
		// An outline that only clips a much larger channel: the dam's own outflow (finding 9).
		expect(placementLine(pl({ placedBy: 'polygon', larger: { at: [20.5, -33.5], distanceM: 90, km2: 450, pointKm2: 0.04, outline: true } }), null)).toBe(
			'At the outflow of the dam’s own outline: a much larger channel (450 km²) only clips its edge, so the dam was taken as off that channel.'
		);
		expect(placementLine(pl({ placedBy: 'boundary' }), null)).toBe('At the most-drained cell inside the boundary.');
		// A unit's boundary (start-16): its outflow, where its order is read from.
		expect(placementLine(pl({ placedBy: 'unit' }), null)).toBe('Its boundary’s outflow: the most-drained cell inside it above the outlet, where its order is read from.');
	});

	it('says a dam was placed by the position marked on the map (194)', () => {
		expect(placementLine(pl({ placedBy: 'polygon', damPosition: 'off_channel' }), null)).toBe('On the river where the dam’s own outflow joins it, as marked: off-channel, so the dam takes only its own catchment’s runoff.');
		expect(placementLine(pl({ placedBy: 'polygon', damPosition: 'on_channel' }), null)).toBe('At the dam polygon’s most-drained cell, on the river, as marked.');
	});

	it('reads a plan from start-7 to start-14 as it was placed: snapped to the most-drained cell, with its unmatched-reach caveat', () => {
		expect(placementLine(pl({ reach, unmatched: true }), 143, 'start-14')).toBe('Snapped to the most-drained cell nearby, 143 m from the point: no channel near it matches river reach 11509680 (292 km²), so it may be on another stream.');
		expect(placementLine(pl({}), 143, 'start-7')).toBe('Snapped to the most-drained cell nearby, 143 m from the point.');
		// start-15 on (and no version given): the nearest terrain channel.
		expect(placementLine(pl({}), 143, 'start-15')).toBe('On the nearest terrain channel, 143 m from the point.');
		expect([placedByMappedRivers('start-14'), placedByMappedRivers('start-15'), placedByMappedRivers('start-16'), placedByMappedRivers(undefined), placedByMappedRivers('x')]).toEqual([true, false, false, false, false]);
	});

	it('keeps the old line for a proposal from before start-7', () => {
		expect(placementLine(undefined, 143)).toBe('Moved 143 m onto the river.');
		expect(placementLine(undefined, null)).toBeNull();
	});
});

describe('withPlacement and choiceFor', () => {
	it('adds the outlet gauge’s and each point’s choices, and only what is set', () => {
		const c = emptyPlacement();
		c.useLarger[OUTLET_KEY] = true;
		c.useLarger['p2'] = true;
		const body = withPlacement({ outletFeatureId: 'g', points: [{ featureId: 'p1', role: 'dam' as const }, { featureId: 'p2', role: 'dam' as const }] }, c);
		expect(body).toEqual({
			outletFeatureId: 'g',
			outletUseLarger: true,
			points: [
				{ featureId: 'p1', role: 'dam' },
				{ featureId: 'p2', role: 'dam', useLarger: true }
			]
		});
		expect(choiceFor(c, 'p1')).toEqual({});
	});

	it('sends no outlet choice when the outlet is the boundary’s own', () => {
		const c = emptyPlacement();
		c.useLarger[OUTLET_KEY] = true;
		expect(withPlacement({ outletFeatureId: null, points: [] }, c)).toEqual({ outletFeatureId: null, points: [] });
	});
});
