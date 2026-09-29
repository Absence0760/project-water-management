import { describe, expect, it } from 'vitest';
import { ROLE_LABEL, roleLabel, roleTitle } from './roleLabels';
import { ROLES, TEAM_ROLES } from './types';

describe('role labels (one set of names, #162)', () => {
	it('names team roles by the project role they give: viewer, editor, owner', () => {
		expect(TEAM_ROLES.map(roleLabel)).toEqual(['viewer', 'editor', 'owner']);
	});

	it('names project roles as they are, a contributor as an applicant', () => {
		expect(ROLES.map(roleLabel)).toEqual(['applicant', 'viewer', 'editor', 'owner']);
		expect(roleLabel('farmer')).toBe('farmer');
	});

	it('uses no other word for a role, so "member" and "admin" never show', () => {
		expect(new Set(Object.values(ROLE_LABEL))).toEqual(new Set(['farmer', 'applicant', 'viewer', 'editor', 'owner']));
	});

	it('shows an unknown value as sent and nothing for none', () => {
		expect(roleLabel('steward')).toBe('steward');
		expect(roleLabel('constructor')).toBe('constructor');
		expect(roleLabel(null)).toBe('');
		expect(roleLabel(undefined)).toBe('');
	});

	it('capitalises for a heading or list term', () => {
		expect(TEAM_ROLES.map(roleTitle)).toEqual(['Viewer', 'Editor', 'Owner']);
		expect(roleTitle(null)).toBe('');
	});
});
