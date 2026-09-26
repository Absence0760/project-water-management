// Queueing an alert evaluation (roadmap WP-2.13): the `alert_eval` job, one
// pending per project (dedupe key 'alert_eval'), as the transaction's editor.
// Queued after an automatic or forecast run (jobs/handlers/rerun.ts), after a
// person publishes or changes the notice (publish/routes.ts), and when an
// editor changes the rules (alerts/routes.ts); the tick queues the scheduled
// checks itself (app_alert_schedule, jobs/runner.ts). Nothing is queued for a
// project with no alert switched on (alerts are opt-in per project).
import type { Db } from '../db/tx.js';
import { enqueueJob } from '../jobs/queue.js';
import { alertsOn } from './evaluate.js';

export const ALERT_EVAL_DEDUPE_KEY = 'alert_eval';
export const ALERT_EVAL_CAUSES = ['auto', 'forecast', 'publish', 'rules', 'schedule'] as const;
export type AlertEvalCause = (typeof ALERT_EVAL_CAUSES)[number];

/** Queue an evaluation in this transaction; returns the job (to wake the worker after commit), or null when alerts are off. */
export async function queueAlertEval(db: Db, projectId: string, cause: AlertEvalCause): Promise<{ id: string; created: boolean } | null> {
	if (!(await alertsOn(db, projectId))) return null;
	const { job, created } = await enqueueJob(db, { projectId, kind: 'alert_eval', payload: { cause }, dedupeKey: ALERT_EVAL_DEDUPE_KEY });
	return { id: job.id, created };
}
