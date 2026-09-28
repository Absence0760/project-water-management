import { describe, expect, it } from 'vitest';
import { hasTeamRole, TEAM_ROLES } from './access.js';

describe('hasTeamRole', () => {
	it('orders viewer < member < admin', () => {
		expect(TEAM_ROLES).toEqual(['viewer', 'member', 'admin']);
		expect(hasTeamRole('viewer', 'viewer')).toBe(true);
		expect(hasTeamRole('viewer', 'member')).toBe(false);
		expect(hasTeamRole('member', 'member')).toBe(true);
		expect(hasTeamRole('member', 'admin')).toBe(false);
		expect(hasTeamRole('admin', 'member')).toBe(true);
		expect(hasTeamRole('admin', 'admin')).toBe(true);
	});

	it('never lets a missing or unknown role through, not even as viewer', () => {
		for (const role of [null, undefined, '', 'owner', 'editor', 'Admin', 'toString', '__proto__']) {
			expect(hasTeamRole(role, 'viewer')).toBe(false);
		}
	});
});
