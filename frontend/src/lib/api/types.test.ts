import { describe, expect, it } from 'vitest';
import { hasRole, hasTeamRole, TEAM_ROLES } from './types';

describe('team roles', () => {
	it('offers viewer, member and admin, lowest first (the role pickers follow this order)', () => {
		expect(TEAM_ROLES).toEqual(['viewer', 'member', 'admin']);
	});

	it('hasTeamRole orders viewer < member < admin', () => {
		expect(hasTeamRole('viewer', 'viewer')).toBe(true);
		expect(hasTeamRole('viewer', 'member')).toBe(false);
		expect(hasTeamRole('member', 'member')).toBe(true);
		expect(hasTeamRole('member', 'admin')).toBe(false);
		expect(hasTeamRole('admin', 'member')).toBe(true);
	});

	it('never treats a missing or unknown team role as a member', () => {
		for (const role of [null, undefined, '', 'owner', 'editor', 'Member', 'constructor']) {
			expect(hasTeamRole(role, 'viewer')).toBe(false);
			expect(hasTeamRole(role, 'member')).toBe(false);
		}
	});
});

describe('hasRole (project roles)', () => {
	it('orders viewer < editor < owner', () => {
		expect(hasRole('viewer', 'editor')).toBe(false);
		expect(hasRole('editor', 'editor')).toBe(true);
		expect(hasRole('owner', 'editor')).toBe(true);
		expect(hasRole(null, 'viewer')).toBe(false);
	});
	// WP-2.1: a farmer ranks below viewer, so every workspace control hides from them.
	it('ranks farmer below viewer', () => {
		expect(hasRole('farmer', 'viewer')).toBe(false);
		expect(hasRole('farmer', 'farmer')).toBe(true);
		expect(hasRole('viewer', 'farmer')).toBe(true);
	});
});
