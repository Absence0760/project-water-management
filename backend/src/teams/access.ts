import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { UUID } from '../projects/access.js';

export type TeamRole = 'member' | 'admin';

/** 404 unless the current user is in the team; 403 if `admin` is required and they aren't. */
export async function requireTeamRole(db: Db, teamId: string, min: TeamRole): Promise<TeamRole> {
	if (!UUID.test(teamId)) throw new ApiError(404, 'not found');
	const { rows } = await db.query<{ role: TeamRole | null }>('SELECT app_team_role($1) AS role', [teamId]);
	const role = rows[0]?.role;
	if (!role) throw new ApiError(404, 'not found');
	if (min === 'admin' && role !== 'admin') throw new ApiError(403, 'requires team admin');
	return role;
}
