// Per-file setup for the DB projects (db, perf-db), after setup.ts: every DB
// test file must leave nothing pending in the shared `job` table.
//
// The queue is global on purpose (claim, tick and purge aren't scoped to a
// project or a file), and the files share one database, run one after another.
// A queued or retrying job one file leaves behind is claimed by the next file
// that runs a tick, whose counts (`runTick().done`, feeds.db.test.ts) then
// depend on which files ran before it. So a file that queues a job (a re-run,
// a yield, an outlook, a sweep …) drains it (runTick) or retires it
// (helpers.ts retirePendingJobs) before it ends, and this hook fails the file
// that didn't, naming what it left, rather than the later file that trips over
// it. It then retires the leftovers itself, so only the leaking file fails.
// docs/testing.md § DB tests share the job queue.
import pg from 'pg';
import { afterAll } from 'vitest';
import { PENDING_JOBS_SQL, RETIRE_PENDING_JOBS_SQL } from './pendingJobs.js';

afterAll(async () => {
	const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await client.connect();
	try {
		const { rows } = await client.query<{ kind: string; status: string; project: string; n: number }>(PENDING_JOBS_SQL);
		if (!rows.length) return;
		await client.query(RETIRE_PENDING_JOBS_SQL);
		const list = rows.map((r) => `${r.n} × ${r.kind} (${r.status}) in project "${r.project}"`).join('; ');
		throw new Error(
			`this test file left pending jobs in the shared queue: ${list}. ` +
				'Run them (runTick) or retire them (helpers.ts retirePendingJobs) before the file ends, or a later file’s tick claims them (src/__tests__/db-setup.ts).'
		);
	} finally {
		await client.end();
	}
});
