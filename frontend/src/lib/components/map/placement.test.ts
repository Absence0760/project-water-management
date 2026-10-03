import { describe, expect, it } from 'vitest';
import { ApiError } from '$lib/api/client';
import type { ConfluencePoint, PointPlacement } from '$lib/api/types';
import { choiceFor, confluencePointsOf, damShareLines, emptyPlacement, OUTLET_KEY, placementLine, withPlacement } from './placement';

const reach = { dataset: 'HydroRIVERS-v10', reachId: 11509680, upstreamKm2: 292.4, chosen: false };
const pl = (over: Partial<PointPlacement>): PointPlacement => ({ placedBy: 'snapped', reach: null, larger: null, unmatched: false, ...over });

describe('placementLine', () => {
	it('says how each point was put on the channel, on which reach and how far it moved', () => {
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
	});

	it('words a marked dam’s two shares, and nothing for an unmarked one (194)', () => {
		expect(damShareLines(undefined, 4e6)).toBeNull();
		expect(damShareLines({ pctUpstreamToDam: 1, pctRunoffToDam: 1, damCatchmentM2: null }, 4e6)).toEqual({
			runoff: 'All of its own runoff reaches the dam (its area ends at the wall).',
			upstream: 'Upstream inflow to dam 100 %: on the river, as marked on the map, so it catches everything coming down.'
		});
		expect(damShareLines({ pctUpstreamToDam: 0, pctRunoffToDam: 0.025, damCatchmentM2: 0.1e6 }, 4e6)).toEqual({
			runoff: '2.5 % of its runoff reaches the dam: the 0.10 km² draining to the dam’s own outflow, of the unit’s 4.00 km²; the rest passes it by.',
			upstream: 'Upstream inflow to dam 0 %: off-channel, as marked on the map, so the river passes it by; River to dam fills it.'
		});
	});

	it('says a dam was placed by the position marked on the map (194)', () => {
		expect(placementLine(pl({ placedBy: 'polygon', damPosition: 'off_channel' }), null)).toBe('On the river where the dam’s own outflow joins it, as marked: off-channel, so the dam takes only its own catchment’s runoff.');
		expect(placementLine(pl({ placedBy: 'polygon', damPosition: 'on_channel' }), null)).toBe('At the dam polygon’s most-drained cell, on the river, as marked.');
	});

	it('names an unmatched reach beside a snapped point, and keeps the old line for a proposal from before start-7', () => {
		expect(placementLine(pl({ reach, unmatched: true }), 143)).toBe('Snapped to the most-drained cell nearby, 143 m from the point: no channel near it matches river reach 11509680 (292 km²), so it may be on another stream.');
		expect(placementLine(pl({}), 143)).toBe('Snapped to the most-drained cell nearby, 143 m from the point.');
		expect(placementLine(undefined, 143)).toBe('Moved 143 m onto the river.');
		expect(placementLine(undefined, null)).toBeNull();
	});
});

describe('withPlacement and choiceFor', () => {
	it('adds the outlet gauge’s and each point’s choices, and only what is set', () => {
		const c = emptyPlacement();
		c.reaches[OUTLET_KEY] = { dataset: 'd', reachId: 1 };
		c.useLarger['p2'] = true;
		const body = withPlacement({ outletFeatureId: 'g', points: [{ featureId: 'p1', role: 'dam' as const }, { featureId: 'p2', role: 'dam' as const }] }, c);
		expect(body).toEqual({
			outletFeatureId: 'g',
			outletReach: { dataset: 'd', reachId: 1 },
			points: [
				{ featureId: 'p1', role: 'dam' },
				{ featureId: 'p2', role: 'dam', useLarger: true }
			]
		});
		expect(choiceFor(c, 'p1')).toEqual({});
	});

	it('sends no outlet choice when the outlet is the boundary’s own', () => {
		const c = emptyPlacement();
		c.reaches[OUTLET_KEY] = { dataset: 'd', reachId: 1 };
		c.useLarger[OUTLET_KEY] = true;
		expect(withPlacement({ outletFeatureId: null, points: [] }, c)).toEqual({ outletFeatureId: null, points: [] });
	});
});

describe('confluencePointsOf', () => {
	it('reads the points a 422 confluence asks about, and nothing from any other error', () => {
		const points: ConfluencePoint[] = [{ featureId: '', name: 'Weir', choices: [{ dataset: 'd', reachId: 1, upstreamKm2: 50, distanceM: 30, role: 'above', label: 'the tributary above the junction' }] }];
		expect(confluencePointsOf(new ApiError(422, 'at a confluence', { reason: 'confluence', points }))).toEqual(points);
		expect(confluencePointsOf(new ApiError(422, 'too large', { reason: 'too_large' }))).toBeNull();
		expect(confluencePointsOf(new ApiError(400, 'x', { reason: 'confluence', points }))).toBeNull();
		expect(confluencePointsOf(new Error('x'))).toBeNull();
	});
});
