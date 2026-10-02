// Pending jobs in the shared queue and pending notices (pack, erratum, alert
// emails): what db-setup.ts's guard looks for after every DB test file, and
// how a file (or the guard) retires them. No imports
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

/**
 * Pending notices: an email the tick will send to whoever the row names, from
 * any of the three notice queues. The tick sends every pending notice in the
 * shared database, not only its own file's, so one a file leaves behind lands
 * in a later file's outbox (alerts.db.test.ts counts every mail its tick
 * sends, and once got a "pack withdrawn" mail from write-routes.db.test.ts).
 * An alert delivery waiting for the digest counts too: the digest tick sends it.
 */
export const PENDING_NOTICES_SQL = `
	SELECT n.kind, n.status, p.name AS project, count(*)::int AS n
	FROM (
		SELECT 'pack_notice' AS kind, status, project_id FROM pack_notice WHERE status IN ('pending', 'sending')
		UNION ALL SELECT 'erratum_notice', status, project_id FROM erratum_notice WHERE status IN ('pending', 'sending')
		UNION ALL SELECT 'alert_delivery', status, project_id FROM alert_delivery WHERE status IN ('pending', 'digest', 'sending')
	) n JOIN project p ON p.id = n.project_id
	GROUP BY n.kind, n.status, p.name
	ORDER BY n.kind, n.status, p.name`;

/**
 * Settle pending notices as skipped without sending them: test cleanup, as
 * RETIRE_PENDING_JOBS_SQL is for jobs. One statement per queue; each takes an
 * optional extra condition (helpers.ts scopes it to a file's projects).
 */
export function settlePendingNoticesSql(where = ''): string[] {
	return [
		`UPDATE pack_notice SET status = 'skipped', settled_at = now(), locked_until = NULL, reason = 'test cleanup' WHERE status IN ('pending', 'sending') ${where}`,
		`UPDATE erratum_notice SET status = 'skipped', settled_at = now(), locked_until = NULL, reason = 'test cleanup' WHERE status IN ('pending', 'sending') ${where}`,
		`UPDATE alert_delivery SET status = 'skipped', locked_until = NULL, reason = 'test cleanup' WHERE status IN ('pending', 'digest', 'sending') ${where}`
	];
}

/** Set by db-setup.ts's afterAll when it runs: db-setup.db.test.ts checks that the file's own afterAll ran first. */
export const GUARD_RAN = Symbol.for('water-management.db-setup.guard-ran');

interface Queryable {
	query<R extends object = Record<string, unknown>>(sql: string): Promise<{ rows: R[] }>;
}

type Pending = { kind: string; status: string; project: string; n: number };
const listOf = (rows: Pending[]) => rows.map((r) => `${r.n} × ${r.kind} (${r.status}) in project "${r.project}"`).join('; ');

/**
 * The guard's check: throws (after retiring or settling them, so only the
 * file that left them fails) when any job or notice is pending, naming each
 * kind, status and project.
 */
export async function assertNothingPending(db: Queryable): Promise<void> {
	const { rows: jobs } = await db.query<Pending>(PENDING_JOBS_SQL);
	const { rows: notices } = await db.query<Pending>(PENDING_NOTICES_SQL);
	if (jobs.length) await db.query(RETIRE_PENDING_JOBS_SQL);
	if (notices.length) for (const sql of settlePendingNoticesSql()) await db.query(sql);
	const problems: string[] = [];
	if (jobs.length) {
		problems.push(
			`this test file left pending jobs in the shared queue: ${listOf(jobs)}. ` +
				'Run them (runTick) or retire them (helpers.ts retirePendingJobs) before the file ends, or a later file’s tick claims them'
		);
	}
	if (notices.length) {
		problems.push(
			`this test file left pending notices: ${listOf(notices)}. ` +
				'Send them (runTick) or settle them (helpers.ts settlePendingNotices) before the file ends, or a later file’s tick mails them'
		);
	}
	if (problems.length) throw new Error(`${problems.join('. ')} (src/__tests__/db-setup.ts).`);
}
