import type { FarmSummary, RunSummary, UserSummary } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { hasHumanImpacts, otherUsesLink, usersTableOnSupply } from './humanImpacts';

const farm = (over: Partial<FarmSummary> = {}) => ({ nodeId: 'f', name: 'Farm', ...over }) as FarmSummary;
const user = (over: Partial<UserSummary> = {}) => ({ nodeId: 'u', name: 'Town', ...over }) as UserSummary;

describe('hasHumanImpacts', () => {
	it('is false for a run with none of the tables', () => {
		expect(hasHumanImpacts({ farms: [farm()] })).toBe(false);
		expect(hasHumanImpacts({ farms: [farm({ demandObjects: [] })], users: [] })).toBe(false);
	});

	it('is true for land cover, a borehole, a demand object or another user', () => {
		expect(hasHumanImpacts({ farms: [], landCover: {} as RunSummary['landCover'] })).toBe(true);
		expect(hasHumanImpacts({ farms: [farm({ avgGroundwaterM3Day: 0 })] })).toBe(true);
		expect(hasHumanImpacts({ farms: [farm({ demandObjects: [{}] as FarmSummary['demandObjects'] })] })).toBe(true);
		expect(hasHumanImpacts({ farms: [], users: [user()] })).toBe(true);
		// A unit's river abstractions (engine 1.65.0).
		expect(hasHumanImpacts({ farms: [farm({ riverTakes: [{}] as FarmSummary['riverTakes'] })] }, false)).toBe(true);
		expect(otherUsesLink({ farms: [farm({ riverTakes: [{}] as FarmSummary['riverTakes'] })] })!.what).toBe('River abstractions');
	});

	it('leaves other users out when asked, but not a user’s borehole (issue #137)', () => {
		expect(hasHumanImpacts({ farms: [], users: [user()] }, false)).toBe(false);
		expect(hasHumanImpacts({ farms: [], users: [user({ avgGroundwaterM3Day: 10 })] }, false)).toBe(true);
		// Nor a user's pump (engine 1.58.0): the curtailment table has no pump columns.
		expect(hasHumanImpacts({ farms: [], users: [user({ avgPumpLimitedM3Day: 0 })] }, false)).toBe(true);
	});
});

describe('usersTableOnSupply', () => {
	it('is false when the curtailment table lists the other users, so Units & supply has one copy', () => {
		const listed = { curtailment: { otherUsers: [{ nodeId: 'u' }] } } as Pick<RunSummary, 'curtailment'>;
		expect(usersTableOnSupply(listed)).toBe(false);
	});
	it('is true for a run whose curtailment doesn’t list them (or has none)', () => {
		expect(usersTableOnSupply({})).toBe(true);
		expect(usersTableOnSupply({ curtailment: { otherUsers: [] } } as unknown as Pick<RunSummary, 'curtailment'>)).toBe(true);
	});
});

describe('otherUsesLink', () => {
	const listed = { otherUsers: [{ nodeId: 'u' }] } as RunSummary['curtailment'];
	it('is null for a run with none of the tables', () => {
		expect(otherUsesLink({ farms: [farm()] })).toBeNull();
	});
	it('names what the run has, in the Other uses section', () => {
		expect(otherUsesLink({ farms: [farm({ avgGroundwaterM3Day: 1 })], landCover: {} as RunSummary['landCover'] })).toEqual({
			hash: 'res-other-uses',
			what: 'Land cover and groundwater',
			where: 'Other uses on Units & supply'
		});
		expect(otherUsesLink({ farms: [farm({ demandObjects: [{}] as FarmSummary['demandObjects'] })], users: [user()] })!.what).toBe('Demand objects and other water users');
		expect(
			otherUsesLink({ farms: [farm({ avgGroundwaterM3Day: 1, demandObjects: [{}] as FarmSummary['demandObjects'] })], landCover: {} as RunSummary['landCover'], users: [user()] })!.what
		).toBe('Land cover, groundwater, demand objects and other water users');
	});
	it('leaves out other users the curtailment table lists, and points there when they are all there is', () => {
		expect(otherUsesLink({ farms: [], landCover: {} as RunSummary['landCover'], users: [user()], curtailment: listed })!.what).toBe('Land cover');
		expect(otherUsesLink({ farms: [], users: [user()], curtailment: listed })).toEqual({
			hash: 'res-curtailment',
			what: 'Other water users',
			where: 'the curtailment targets on Units & supply'
		});
		// A user's pump (engine 1.58.0) has its own table in Other uses.
		expect(otherUsesLink({ farms: [], users: [user({ avgPumpLimitedM3Day: 3 })], curtailment: listed })).toEqual({
			hash: 'res-other-uses',
			what: 'Other water users’ pumps',
			where: 'Other uses on Units & supply'
		});
	});
});
