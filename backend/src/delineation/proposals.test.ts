import { describe, expect, it } from 'vitest';
import type { Delineation } from './delineate.js';
import { checkNote } from './proposals.js';

const base = { areaM2: 81e6 } as Delineation;

describe('checkNote', () => {
	it('says nothing for a plain proposal', () => {
		expect(checkNote(base)).toBeNull();
	});

	it('names a nearby reach no channel matched', () => {
		expect(checkNote({ ...base, unmatched: { reach: 'reach 7 of HydroRIVERS-v10', reachKm2: 1169 } })).toMatch(/^The river network has reach 7 of HydroRIVERS-v10 near this point, draining about 1[\s ]169 km²/);
	});

	it('flags an outlet a confluence’s junction moved far from the point (issue #390, the hydrologist persona’s finding 12)', () => {
		expect(checkNote({ ...base, farJunction: { reach: 'reach 7 of HydroRIVERS-v10', movedM: 2087 } })).toBe(
			"The outlet was moved 2.1 km from the point to keep it on reach 7 of HydroRIVERS-v10's side of a confluence: the elevation model's rivers meet away from where the river network joins them. A gauge or weir that far from its site records another catchment, so check the outlet against the map."
		);
	});
});
