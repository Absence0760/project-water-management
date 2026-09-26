import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';

/**
 * `farmer` (019_farmer_role, WP-2.1) ranks below `viewer`, so every existing
 * `requireRole(…, 'viewer')` answers a farmer 403: routes are closed to
 * farmers unless they ask for 'farmer' explicitly (fail closed).
 */
export type Role = 'farmer' | 'viewer' | 'editor' | 'owner';
export const rank: Record<Role, number> = { farmer: -1, viewer: 0, editor: 1, owner: 2 };

/**
 * Explicit role check for clear 404/403 responses. RLS enforces the same rules
 * underneath, so a missed call here fails closed, not open.
 *  - not a member (or no such project) → 404, never revealing existence
 *  - member below `min`                → 403
 */
export async function requireRole(db: Db, projectId: string, min: Role): Promise<Role> {
	if (!UUID.test(projectId)) throw new ApiError(404, 'not found');
	// Effective role: direct membership or via the project's team (002_teams).
	const { rows } = await db.query<{ role: Role | null }>('SELECT app_project_role($1) AS role', [projectId]);
	const role = rows[0]?.role;
	if (!role) throw new ApiError(404, 'not found');
	if (rank[role] < rank[min]) throw new ApiError(403, `requires ${min} role`);
	return role;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
