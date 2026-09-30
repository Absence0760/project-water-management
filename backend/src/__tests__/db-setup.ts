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
//
// Hook order: vitest runs after-hooks in reverse order of registration
// (`sequence.hooks: 'stack'`, the default since vitest 2, set explicitly in
// vitest.config.ts). A setup file registers before the test file, so this
// afterAll runs after the file's own afterAll cleanup, never before it.
// db-setup.db.test.ts checks that order (GUARD_RAN).
import pg from 'pg';
import { afterAll } from 'vitest';
import { assertNoPendingJobs, GUARD_RAN } from './pendingJobs.js';

afterAll(async () => {
	(globalThis as Record<symbol, unknown>)[GUARD_RAN] = true;
	const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await client.connect();
	try {
		await assertNoPendingJobs(client);
	} finally {
		await client.end();
	}
});
