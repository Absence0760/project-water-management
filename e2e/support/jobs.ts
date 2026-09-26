// Runs one tick of the background-job worker against the checkout's e2e
// database, the way `pnpm dev:jobs:tick` does locally: the e2e backend has no
// worker process, so a spec that queues work (a feed's "Run now") runs it
// here, deterministically, then checks the UI. FEED_SOURCE stays at its
// default, fixtures: no network.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { API_URL, APP_E2E_URL, WEB_URL } from './env.ts';

const backendDir = fileURLToPath(new URL('../../backend/', import.meta.url));

/**
 * Run every due job once; resolves with the worker's one-line summary.
 *
 * A report_render job prints this checkout's e2e site (RENDER_SITE_URL /
 * RENDER_API_URL: the built site and the e2e API, not the dev servers) in the
 * worker's own headless Chromium, stores the PDF in the local MinIO
 * (`pnpm dev:s3:up`), and mails through Mailpit (`pnpm dev:mail:up`), with
 * links to the e2e site. Alert emails go to Mailpit too, their one-click
 * unsubscribe pointing at the e2e API (alerts-mailpit.spec.ts).
 *
 * `schedule: false` runs only jobs already queued: no feed or report
 * schedule queues anything, so a spec that queues its own work (a yield)
 * never runs another spec's feed mid-test.
 */
export async function runJobsTick({ schedule = true }: { schedule?: boolean } = {}): Promise<string> {
	const args = ['exec', 'tsx', 'src/jobs/worker.ts', '--once', ...(schedule ? [] : ['--no-schedule'])];
	const { stdout } = await promisify(execFile)('pnpm', args, {
		cwd: backendDir,
		env: {
			...process.env,
			DATABASE_URL: APP_E2E_URL,
			FEED_SOURCE: 'fixtures',
			JOB_TRANSPORT: 'inprocess',
			REPORT_RENDERER: 'inline',
			RENDER_SITE_URL: WEB_URL,
			RENDER_API_URL: API_URL,
			SITE_URL: WEB_URL,
			// Alert emails' RFC 8058 one-click address: this checkout's e2e API.
			API_PUBLIC_URL: API_URL,
			STORAGE: 'local',
			MAIL_TRANSPORT: 'smtp'
		},
		timeout: 60_000
	});
	return stdout.trim();
}

/**
 * Stand in for an SES bounce or complaint for `email`, the way `pnpm
 * dev:mail:bounce` does locally (backend/scripts/mail-bounce.ts): the event
 * SES would publish, through the worker's own handler, against the e2e
 * database. The account's alert emails pause, behind the banner.
 */
export async function simulateBounce(email: string, kind: 'bounce' | 'complaint' = 'bounce'): Promise<string> {
	const { stdout } = await promisify(execFile)('pnpm', ['exec', 'tsx', 'scripts/mail-bounce.ts', email, ...(kind === 'complaint' ? ['--complaint'] : [])], {
		cwd: backendDir,
		env: { ...process.env, DATABASE_URL: APP_E2E_URL },
		timeout: 60_000
	});
	return stdout.trim();
}
