// The role ranking behind requireRole (access.ts). `farmer` (019_farmer_role,
// WP-2.1) and `contributor` (044_contributor_role, WP-3.3) must rank below
// `viewer`, so every route that asks for viewer or above refuses them without
// naming the role (fail closed).
import { describe, expect, it } from 'vitest';
import { rank, type Role } from './access.js';

describe('role rank', () => {
	it('orders farmer < contributor < viewer < editor < owner, like the project_role enum', () => {
		const order: Role[] = ['farmer', 'contributor', 'viewer', 'editor', 'owner'];
		expect([...order].sort((a, b) => rank[a] - rank[b])).toEqual(order);
		expect(rank.farmer).toBeLessThan(rank.contributor);
		expect(rank.contributor).toBeLessThan(rank.viewer);
	});
});
