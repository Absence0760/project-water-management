import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { UUID } from '../projects/access.js';
import { requireStepUp } from '../auth/stepUp.js';

/** Team roles, lowest first: viewer → project viewer, member → editor, admin → owner. */
export const TEAM_ROLES = ['viewer', 'member', 'admin'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

const RANK: Record<TeamRole, number> = { viewer: 0, member: 1, admin: 2 };

/** True when `role` is at least `min`. An unknown or missing role is never enough. */
export function hasTeamRole(role: string | null | undefined, min: TeamRole): boolean {
	const rank = role != null && Object.hasOwn(RANK, role) ? RANK[role as TeamRole] : undefined;
	return rank !== undefined && rank >= RANK[min];
}

/**
 * 404 unless the current user is in the team; 403 if their team role is below
 * `min` (`viewer` = any member of the team). Team admin's actions need
 * two-step sign-in (auth/stepUp.ts): 403 mfa_required / mfa_step_up after
 * the role check passes.
 */
export async function requireTeamRole(db: Db, teamId: string, min: TeamRole, notFound = 'not found'): Promise<TeamRole> {
	if (!UUID.test(teamId)) throw new ApiError(404, notFound);
	const { rows } = await db.query<{ role: string | null }>('SELECT app_team_role($1) AS role', [teamId]);
	const role = rows[0]?.role;
	if (!role) throw new ApiError(404, notFound);
	if (!hasTeamRole(role, min)) throw new ApiError(403, `requires team ${min}`);
	if (min === 'admin') await requireStepUp(db);
	return role as TeamRole;
}
