// Runs one tick of the background-job worker against the checkout's e2e
// database, the way `pnpm dev:jobs:tick` does locally: the e2e backend has no
// worker process, so a spec that queues work (a feed's "Run now") runs it
// here, deterministically, then checks the UI. FEED_SOURCE stays at its
// default, fixtures: no network.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { APP_E2E_URL } from './env.ts';

const backendDir = fileURLToPath(new URL('../../backend/', import.meta.url));

/** Run every due job once; resolves with the worker's one-line summary. */
export async function runJobsTick(): Promise<string> {
	const { stdout } = await promisify(execFile)('pnpm', ['exec', 'tsx', 'src/jobs/worker.ts', '--once'], {
		cwd: backendDir,
		env: { ...process.env, DATABASE_URL: APP_E2E_URL, FEED_SOURCE: 'fixtures', JOB_TRANSPORT: 'inprocess' },
		timeout: 60_000
	});
	return stdout.trim();
}
