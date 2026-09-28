import { describe, expect, it } from 'vitest';
import { describeUser, userDemandOf } from './users';

describe('other water users in the Network tab (WP-1.33)', () => {
	it('reads a missing or short demand as zeros', () => {
		expect(userDemandOf({ userDemandM3Day: null })).toEqual(new Array(12).fill(0));
		expect(userDemandOf({ userDemandM3Day: [5, 6] })).toEqual([5, 6, ...new Array(10).fill(0)]);
	});

	it('describes priority, mean demand and return share', () => {
		expect(describeUser({ userDemandM3Day: new Array(12).fill(1200), userReturnPct: 0.4, userPriority: 'senior' })).toBe('senior · 1\u202f200 m³/day on average · 40 % returned');
		expect(describeUser({ userDemandM3Day: null, userReturnPct: 0, userPriority: 'junior' })).toBe('junior · no demand yet: enter it by month');
		expect(describeUser({ userDemandM3Day: new Array(12).fill(10) })).toBe('senior · 10 m³/day on average');
	});
});
