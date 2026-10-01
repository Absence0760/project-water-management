// The local job worker (JOB_TRANSPORT=inprocess, the default):
//
//   pnpm dev:run:worker    loop: a tick every JOB_POLL_SECONDS (15), and at
//                          once when LISTEN job_queued fires (the job
//                          table's insert trigger NOTIFYs at commit)
//   pnpm dev:jobs:tick     one tick, print what it did, exit (scripts, e2e)
//   pnpm dev:feeds:run     one tick that first queues EVERY enabled data feed,
//                          due or not, then runs it all and exits (--all-feeds)
//   --once --no-schedule   one tick that only runs jobs already queued: no
//                          feed or report schedule queues anything (e2e specs
//                          that queue their own work, so they never run
//                          another spec's feed)
//   --once --project <id>  (repeatable) one tick that claims only those
//                          projects' jobs: the e2e suite's tick
//                          (e2e/support/jobs.ts), so a test never runs, or
//                          sees running, a job another test queued in the
//                          shared e2e database
//
// It connects as water_app (DATABASE_URL), like the API, and runs each job as
// its acting user (runner.ts). Killing it mid-job is safe: the job's lease
// runs out (JOB_LEASE_SECONDS) and the next tick claims it again.
//
// A local Node entry, like server.ts: it loads the dev env files. The
// production worker is lambda-worker.ts, which must never import this file.
import { loadDevEnv } from '../config/devEnv.js';
loadDevEnv();

import pg from 'pg';
import { closePool } from '../db/pool.js';
import { projectArgs } from './args.js';
import { envInt, runTick, type TickResult } from './runner.js';

const summary = (r: TickResult) =>
	(r.feeds ? `feeds: ${r.feeds.queued} queued${r.feeds.refused ? `, ${r.feeds.refused} refused` : ''}; ` : '') +
	(r.reports?.queued || r.reports?.skipped ? `scheduled reports: ${r.reports.queued} queued${r.reports.skipped ? `, ${r.reports.skipped} skipped` : ''}; ` : '') +
	(r.alerts?.sent || r.alerts?.skipped || r.alerts?.failed ? `alerts: ${r.alerts.sent} sent, ${r.alerts.skipped} skipped, ${r.alerts.failed} failed; ` : '') +
	(r.packNotices?.sent || r.packNotices?.skipped || r.packNotices?.failed
		? `pack notices: ${r.packNotices.sent} sent, ${r.packNotices.skipped} skipped, ${r.packNotices.failed} failed; `
		: '') +
	`claimed ${r.claimed}: ${r.done} done, ${r.failed} failed, ${r.dead} dead, ${r.lost} lost; purged ${r.purged}; ` +
	`${r.stats.due} due, ${r.stats.running} running`;

if (process.argv.includes('--once')) {
	try {
		const schedule = !process.argv.includes('--no-schedule');
		const projectIds = projectArgs(process.argv);
		console.log(
			summary(await runTick({ allFeeds: process.argv.includes('--all-feeds'), feeds: schedule, reports: schedule, alerts: schedule, projectIds }))
		);
	} finally {
		await closePool();
	}
} else {
	// The loop is the whole queue's worker; a scope belongs to a single tick.
	if (projectArgs(process.argv)) throw new Error('--project scopes a single tick: use it with --once');
	await loop();
}

async function loop(): Promise<void> {
	const pollMs = envInt(process.env.JOB_POLL_SECONDS, 15) * 1000;
	let stopping = false;
	let ticking: Promise<void> | undefined;
	let again = false;

	// One tick at a time; a wake-up during a tick runs another right after.
	const tick = () => {
		if (stopping) return;
		if (ticking) {
			again = true;
			return;
		}
		ticking = runTick()
			.then((r) => {
				if (r.claimed || r.alerts?.sent || r.alerts?.failed) console.log(summary(r));
			})
			.catch((err) => console.error('job tick failed:', (err as Error).message))
			.finally(() => {
				ticking = undefined;
				if (again) {
					again = false;
					tick();
				}
			});
	};

	let listener: pg.Client | undefined;
	const listen = async () => {
		if (stopping) return;
		const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
		client.on('notification', tick);
		client.on('error', (err) => {
			console.error('job listener lost its connection; polling until it reconnects:', err.message);
			listener = undefined;
			client.end().catch(() => {});
			setTimeout(() => void listen(), 5000);
		});
		try {
			await client.connect();
			await client.query('LISTEN job_queued');
			listener = client;
		} catch (err) {
			console.error('job listener could not connect; retrying:', (err as Error).message);
			client.end().catch(() => {});
			setTimeout(() => void listen(), 5000);
		}
	};

	await listen();
	const timer = setInterval(tick, pollMs);
	tick();
	console.log(`Job worker running (JOB_TRANSPORT=inprocess): polling every ${pollMs / 1000} s and on LISTEN job_queued`);

	const stop = async () => {
		if (stopping) return;
		stopping = true;
		clearInterval(timer);
		await ticking;
		await listener?.end().catch(() => {});
		await closePool();
		process.exit(0);
	};
	process.on('SIGINT', () => void stop());
	process.on('SIGTERM', () => void stop());
}
