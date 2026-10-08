import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { requireProjectStepUp } from '../auth/stepUp.js';

/**
 * `farmer` (019_farmer_role, WP-2.1) and `contributor` (044_contributor_role,
 * WP-3.3, a licence applicant) rank below `viewer`, so every existing
 * `requireRole(…, 'viewer')` answers them 403: routes are closed to them
 * unless they ask for 'farmer' or 'contributor' explicitly (fail closed).
 * Same order as the project_role enum.
 */
export type Role = 'farmer' | 'contributor' | 'viewer' | 'editor' | 'owner';
export const rank: Record<Role, number> = { farmer: -2, contributor: -1, viewer: 0, editor: 1, owner: 2 };

/**
 * Explicit role check for clear 404/403 responses. RLS enforces the same rules
 * underneath, so a missed call here fails closed, not open.
 *  - not a member (or no such project) → 404, never revealing existence
 *  - member below `min`                → 403
 *  - `min` owner, without a second factor on a project that requires one
 *    (its setting or its team's) → 403 mfa_required / mfa_step_up (auth/stepUp.ts)
 */
export async function requireRole(db: Db, projectId: string, min: Role): Promise<Role> {
	if (!UUID.test(projectId)) throw new ApiError(404, 'not found');
	// Effective role: direct membership or via the project's team (002_teams).
	const { rows } = await db.query<{ role: Role | null }>('SELECT app_project_role($1) AS role', [projectId]);
	const role = rows[0]?.role;
	if (!role) throw new ApiError(404, 'not found');
	if (rank[role] < rank[min]) throw new ApiError(403, `requires ${min} role`);
	if (min === 'owner') await requireProjectStepUp(db, projectId);
	return role;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
