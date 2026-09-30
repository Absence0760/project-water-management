// Pending jobs in the shared queue: what db-setup.ts's guard looks for after
// every DB test file, and how a file (or the guard) retires them. No imports
// from the app, so the per-file setup that uses it loads no app module before
// a test file's vi.mock.

/** A job a later file's tick could still claim: queued, retrying after a failure, or running (its lease runs out). */
export const PENDING = `status IN ('queued', 'failed', 'running')`;

/** What is pending, by kind, status and project, for the guard's message. */
export const PENDING_JOBS_SQL = `
	SELECT j.kind, j.status, p.name AS project, count(*)::int AS n
	FROM job j JOIN project p ON p.id = j.project_id
	WHERE j.${PENDING}
	GROUP BY j.kind, j.status, p.name
	ORDER BY j.kind, j.status, p.name`;

/**
 * Retire pending jobs as done without running them: test cleanup. Not a
 * DELETE: a pending sweep, outlook or yield row points at its job (ON DELETE
 * SET NULL), and its completion trigger refuses that change from anyone but
 * the person who asked for it.
 */
export const RETIRE_PENDING_JOBS_SQL = `UPDATE job SET status = 'done', finished_at = now(), locked_until = NULL, lease_token = NULL WHERE ${PENDING}`;
