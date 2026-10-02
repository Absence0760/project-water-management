// The hourly cap on tracing a dam, counted before the work
// (186_map_compute_throttle.sql; docs/security.md § Input handling › Tracing
// a dam). Every attempt counts, refused and failed ones too, per user across
// projects and per project, under a row lock so parallel requests are
// counted one by one. The elevation-model routes have their own cap
// (184_dem_attempt, delineation/attempt.ts).
import type { Context } from 'hono';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';

export type MapComputeKind = 'trace';

/** Attempts an hour: a trace, or the re-trace when a traced outline is saved (a few tiles and a flood fill each). */
export const MAP_COMPUTE_CAPS: Record<MapComputeKind, { perUser: number; perProject: number }> = {
	trace: { perUser: 600, perProject: 300 }
};

const WHAT: Record<MapComputeKind, string> = { trace: 'dam traces' };

/** Count one attempt of `kind` on project `projectId` by the signed-in user (an editor; the caller has checked): 429 with Retry-After past the cap. */
export async function countMapCompute(c: Context, db: Db, projectId: string, kind: MapComputeKind): Promise<void> {
	const cap = MAP_COMPUTE_CAPS[kind];
	const { rows } = await db.query<{ wait: number }>('SELECT app_map_compute_attempt($1, $2, $3, $4) AS wait', [projectId, kind, cap.perUser, cap.perProject]);
	const wait = rows[0]?.wait ?? 0;
	if (wait > 0) {
		c.header('Retry-After', String(wait));
		throw new ApiError(429, `Too many ${WHAT[kind]} in the last hour; try again in ${Math.ceil(wait / 60)} min.`);
	}
}
