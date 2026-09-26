// Render tokens (023_reports.sql, docs/security.md § Render tokens): the
// headless report renderer's way in. 32 random bytes, handed to the renderer
// (in process, or on the render-requests queue in production), stored only as
// their SHA-256; single use, 5 minutes, for one project and one run, issued by
// and for the report's requester. POST /auth/render-session consumes one.
import { newToken } from '../auth/tokens.js';
import type { Db } from '../db/tx.js';

/**
 * Issue a render token as the transaction's user (a viewer of the project, or
 * RLS refuses). Commit before handing it out: the renderer consumes it on
 * another connection.
 */
export async function issueRenderToken(db: Db, projectId: string, runId: string): Promise<string> {
	const { token, hash } = newToken();
	await db.query(
		'INSERT INTO render_token (token_hash, user_id, project_id, run_id, expires_at) VALUES ($1, app_current_user_id(), $2, $3, now())',
		[hash, projectId, runId]
	);
	return token;
}

/** What a consumed token opens, or null (unknown, used or expired). Runs with no user. */
export async function consumeRenderToken(db: Db, hash: Buffer): Promise<{ userId: string; projectId: string; runId: string } | null> {
	const { rows } = await db.query<{ userId: string; projectId: string; runId: string }>(
		'SELECT user_id AS "userId", project_id AS "projectId", run_id AS "runId" FROM app_consume_render_token($1)',
		[hash]
	);
	return rows[0] ?? null;
}
