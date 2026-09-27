// Render tokens (023_reports.sql, docs/security.md § Render tokens): the
// headless report renderer's way in. 32 random bytes, handed to the renderer
// (in process, or on the render-requests queue in production), stored only as
// their SHA-256; single use, 5 minutes, for one project and one run (and, for
// an impact report, the baseline it compares against, 082), issued by and for
// the report's requester. POST /auth/render-session consumes one.
import { newToken } from '../auth/tokens.js';
import type { Db } from '../db/tx.js';

/**
 * Issue a render token as the transaction's user (a viewer of the project, or
 * RLS refuses; a baseline, `againstRunId`, must be a run they can read too).
 * Commit before handing it out: the renderer consumes it on another
 * connection.
 */
export async function issueRenderToken(db: Db, projectId: string, runId: string, againstRunId?: string): Promise<string> {
	const { token, hash } = newToken();
	await db.query(
		'INSERT INTO render_token (token_hash, user_id, project_id, run_id, against_run_id, expires_at) VALUES ($1, app_current_user_id(), $2, $3, $4, now())',
		[hash, projectId, runId, againstRunId ?? null]
	);
	return token;
}

export interface ConsumedRenderToken {
	userId: string;
	projectId: string;
	runId: string;
	/** An impact report's baseline; null for the plain report (or a baseline since deleted: the token went with it). */
	against: { projectId: string; runId: string } | null;
}

/** What a consumed token opens, or null (unknown, used or expired). Runs with no user. */
export async function consumeRenderToken(db: Db, hash: Buffer): Promise<ConsumedRenderToken | null> {
	const { rows } = await db.query<{ userId: string; projectId: string; runId: string; againstProjectId: string | null; againstRunId: string | null }>(
		`SELECT user_id AS "userId", project_id AS "projectId", run_id AS "runId",
			against_project_id AS "againstProjectId", against_run_id AS "againstRunId"
		 FROM app_consume_render_token($1)`,
		[hash]
	);
	const r = rows[0];
	if (!r) return null;
	const against = r.againstRunId && r.againstProjectId ? { projectId: r.againstProjectId, runId: r.againstRunId } : null;
	return { userId: r.userId, projectId: r.projectId, runId: r.runId, against };
}
