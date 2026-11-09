// The EWR page's months-met panel for the daily EWR in use (engine 1.116.0, docs/model.md §2.9h).
import { describe, expect, it } from 'vitest';
import { dailyMonthsMissing, dailyMonthsVerdict, rateClass, zeroRequirementText } from './dailyMonths';

describe('dailyMonthsVerdict', () => {
	it('says met in every, none, or how many of the complete months', () => {
		expect(dailyMonthsVerdict({ months: 0, met: 0, rate: null })).toBe('Not assessed: the run has no complete calendar month.');
		expect(dailyMonthsVerdict({ months: 24, met: 24, rate: 1 })).toBe('Met in every one of the 24 complete months.');
		expect(dailyMonthsVerdict({ months: 24, met: 0, rate: 0 })).toBe('Not met in any of the 24 complete months.');
		expect(dailyMonthsVerdict({ months: 24, met: 18, rate: 0.75 })).toMatch(/^Met in 18 of 24 months \(75\.0\s?%\); not met in 6\.$/);
	});
});

describe('zeroRequirementText', () => {
	it('says how many months met asked for nothing, and nothing when none did', () => {
		expect(zeroRequirementText({ zeroRequirementMonths: 0 })).toBeNull();
		expect(zeroRequirementText({ zeroRequirementMonths: 1 })).toBe('1 of the months met had a daily EWR of 0 all month: nothing was required, so it counts as met.');
		expect(zeroRequirementText({ zeroRequirementMonths: 3 })).toBe('3 of the months met had a daily EWR of 0 all month: nothing was required, so they count as met.');
	});
});

describe('dailyMonthsMissing', () => {
	it('an older run asks for a re-run; one kept from this reader says so instead', () => {
		expect(dailyMonthsMissing({})).toBe('Run the model again to see this for the daily EWR.');
		expect(dailyMonthsMissing({ allocations: { mode: 'cap', verdictsOnly: true } as never })).toMatch(/editors and owners only/);
	});
});

describe('rateClass', () => {
	it('all met, at least 80 %, fewer, or none', () => {
		expect([null, 1, 0.8, 0.79].map(rateClass)).toEqual(['none', 'good', 'ok', 'bad']);
	});
});
