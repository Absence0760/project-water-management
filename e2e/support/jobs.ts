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
 * Run one tick that claims only `projects`' due jobs; resolves with the
 * worker's one-line summary.
 *
 * Scoped, because Playwright's workers share one e2e database: a tick that
 * claimed every due job ran another test's freshly queued job, and that test
 * saw "Running…" where it asserted "Queued" (yield.spec.ts, while another
 * yield test ticked). `worker.ts --once --project <id>` claims only those
 * projects' jobs (123_scoped_job_claim.sql); pass every project whose jobs
 * the test waits on. The purges and the alert sends stay global.
 *
 * A report_render job prints this checkout's e2e site (RENDER_SITE_URL /
 * RENDER_API_URL: the built site and the e2e API, not the dev servers) in the
 * worker's own headless Chromium, stores the PDF in the local MinIO
 * (`pnpm dev:s3:up`), and mails through Mailpit (`pnpm dev:mail:up`), with
 * links to the e2e site. Alert emails go to Mailpit too, their one-click
 * unsubscribe pointing at the e2e API (alerts-mailpit.spec.ts).
 *
 * `schedule: false` runs only jobs already queued: no feed, report or alert
 * schedule queues anything. Leave it on only where the test needs the
 * schedule (data-feeds.spec.ts, whose feeds are queued by it): the schedules
 * look at every project, so such a tick can queue another spec's due feed
 * (never run it: the claim is scoped).
 */
export async function runJobsTick({ projects, schedule = true }: { projects: [string, ...string[]]; schedule?: boolean }): Promise<string> {
	const args = ['exec', 'tsx', 'src/jobs/worker.ts', '--once', ...(schedule ? [] : ['--no-schedule']), ...projects.flatMap((id) => ['--project', id])];
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
