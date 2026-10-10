import { describe, expect, it } from 'vitest';
import { describeUser, userDemandOf, userPriorityNote, userPumpNote } from './users';

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

describe('an other water user’s priority note (issue #507)', () => {
	it('says a senior user, the default, holds back every unit upstream', () => {
		const senior = 'Senior is the default. Every hydrological unit upstream passes its demand before filling its dam or irrigating, so adding a senior user changes what the farms upstream get.';
		expect(userPriorityNote('senior')).toBe(senior);
		expect(userPriorityNote(undefined)).toBe(senior);
		expect(userPriorityNote('junior')).toBe('It takes only what reaches it; the hydrological units upstream are not held back for it.');
	});
});

describe('an other water user’s pump (engine 1.58.0)', () => {
	it('names the pump capacity in the one-line description when set', () => {
		expect(describeUser({ userDemandM3Day: new Array(12).fill(1200), userReturnPct: 0, pumpCapacityM3Day: 800 })).toBe('senior · 1\u202f200 m³/day on average · pump 800 m³/day');
		expect(describeUser({ userDemandM3Day: new Array(12).fill(10), pumpCapacityM3Day: 0 })).toBe('senior · 10 m³/day on average · pump 0 m³/day');
		expect(describeUser({ userDemandM3Day: new Array(12).fill(10), pumpCapacityM3Day: null })).toBe('senior · 10 m³/day on average');
	});

	it('says what blank, 0 and a capacity mean, and that units upstream pass no more than a senior user’s pump takes', () => {
		expect(userPumpNote({ pumpCapacityM3Day: null })).toMatch(/^Blank is no limit/);
		expect(userPumpNote({ pumpCapacityM3Day: 0 })).toMatch(/takes nothing from the river/);
		expect(userPumpNote({ pumpCapacityM3Day: 1200 })).toBe('It takes at most 1\u202f200 m³/day from the river; units upstream pass no more than that for it. Or enter the pumps and their rate to work it out.');
		expect(userPumpNote({ pumpCapacityM3Day: 1200, userPriority: 'junior' }, true)).toBe('It takes at most 1\u202f200 m³/day from the river.');
	});
});
