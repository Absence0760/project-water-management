// The name a reach gets for want of one, and telling it from a name someone gave (reachName.ts).
import { describe, expect, it } from 'vitest';
import { isUnnamedReach, unnamedReachName } from './reachName.js';

describe('unnamed reaches', () => {
	it('names a reach by its id', () => {
		expect(unnamedReachName(1050000001)).toBe('Reach 1050000001');
		expect(unnamedReachName('7')).toBe('Reach 7');
	});

	it('knows the name only when the ref is a river-network reach of the same id', () => {
		expect(isUnnamedReach('Reach 1050000001', 'river-network:HydroRIVERS-v10:1050000001')).toBe(true);
		// A dataset label with a colon in it still ends in the reach id.
		expect(isUnnamedReach('Reach 9', 'river-network:a:b:9')).toBe(true);
		expect(isUnnamedReach('Reach 9', 'river-network:HydroRIVERS-v10:8')).toBe(false);
		expect(isUnnamedReach('Sand river', 'river-network:HydroRIVERS-v10:9')).toBe(false);
		// Typed by hand, with no reference behind it.
		expect(isUnnamedReach('Reach 7', null)).toBe(false);
		expect(isUnnamedReach('Reach 7', undefined)).toBe(false);
		expect(isUnnamedReach('Reach 7', 'upload:7')).toBe(false);
	});
});
