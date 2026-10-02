// What the hourly caps on the elevation model's tools count (docs/security.md
// § The map, Delineation). A delineation, a start proposal and a division each
// route the DEM: seconds of CPU and up to about 0.5 GB on the API Lambda. The
// caps used to count only the proposals stored, so a click the DEM refused
// (422: too large, past the budget, no data) or a read that failed (503) cost
// the same compute and counted for nothing: an editor could ask for a
// too-large catchment again and again, each one the full 20 s budget. A
// refusal after the compute is now recorded in the audit log
// (`map.elevation_refused`, which tool and the reason; never the click) and
// counted with the stored proposals.
//
// Requests running at the same moment each see the count before any of them
// finishes, so a burst can pass the cap by at most the API Lambda's reserved
// concurrency (lambda_reserved_concurrency, 10); every request after it is
// counted.
import type { Db } from '../db/tx.js';
import { recordAudit } from '../history/record.js';

/** The tools that route the DEM, as `map.elevation_refused` names them. */
export type ElevationTool = 'delineation' | 'start' | 'divide';

/** Refusals of these tools in the last hour, in this project (visible to its editors under RLS). */
export async function refusedInLastHour(db: Db, projectId: string, tools: readonly ElevationTool[]): Promise<number> {
	const { rows } = await db.query<{ n: number }>(
		`SELECT count(*)::integer AS n FROM audit_event
		 WHERE project_id = $1 AND kind = 'map.elevation_refused' AND subject->>'tool' = ANY($2::text[]) AND created_at > now() - interval '1 hour'`,
		[projectId, tools]
	);
	return rows[0]!.n;
}

/** Record one refused or failed run of a tool, so the hourly cap counts it. `reason` is the refusal's code, or `unreadable` for a failed read. */
export async function recordRefused(db: Db, projectId: string, tool: ElevationTool, reason: string): Promise<void> {
	await recordAudit(db, projectId, 'map.elevation_refused', { tool, reason });
}
