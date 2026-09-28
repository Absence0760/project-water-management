// How a worker hears that a job was queued (JOB_TRANSPORT). The job table is
// the source of truth for every transport: a wake-up only says "look at the
// table now", so a lost wake-up delays a job until the next poll or tick, and
// never loses it.
//
//   inprocess — default. The local worker (worker.ts, `pnpm dev:run:worker`)
//               polls every JOB_POLL_SECONDS and LISTENs on `job_queued`,
//               which the job table's insert trigger NOTIFYs at commit. So
//               wakeWorker() has nothing to do. Postgres only; no AWS.
//   memory    — tests: wakeWorker() runs a tick inline, deterministically.
//   sqs       — production: wakeWorker() sends a wake message to the `jobs`
//               queue (JOBS_QUEUE_URL), which triggers the worker Lambda
//               (lambda-worker.ts). An EventBridge tick every 5 minutes runs
//               the same tick, catching anything whose message was lost.
//
// Kept out of transport.ts: the memory transport imports the job runner, and
// a bundler follows that dynamic import, so any Lambda importing this module
// carries `pg`, every job handler and the engine. Only the API (the routes
// that enqueue) imports it; the fetcher and renderer Lambdas must not
// (lambda-fetcher.test.ts guards the fetcher's bundle).
import { sqs, wakeMessage } from './transport.js';

export const JOB_TRANSPORTS = ['inprocess', 'memory', 'sqs'] as const;
export type JobTransport = (typeof JOB_TRANSPORTS)[number];

export function jobTransport(value: string | undefined = process.env.JOB_TRANSPORT): JobTransport {
	const v = value?.trim() || 'inprocess';
	if (!(JOB_TRANSPORTS as readonly string[]).includes(v)) {
		throw new Error(`unknown JOB_TRANSPORT "${v}" (expected ${JOB_TRANSPORTS.join(', ')})`);
	}
	return v as JobTransport;
}

/**
 * Tell a worker a job was queued. Call after the enqueueing transaction
 * commits. Never throws: the job is already safe in the table, and the next
 * poll or tick runs it, so a failed wake-up is logged, not surfaced.
 */
export async function wakeWorker(jobId: string): Promise<void> {
	try {
		switch (jobTransport()) {
			case 'inprocess':
				return; // The insert trigger's NOTIFY already woke it.
			case 'memory': {
				const { runTick } = await import('./runner.js');
				await runTick();
				return;
			}
			case 'sqs': {
				const url = process.env.JOBS_QUEUE_URL;
				if (!url) throw new Error('JOBS_QUEUE_URL is not set');
				await (await sqs(url))(JSON.stringify(wakeMessage(jobId)));
				return;
			}
		}
	} catch (err) {
		console.error(`waking the job worker failed (job ${jobId} runs on the next tick):`, (err as Error).message);
	}
}
