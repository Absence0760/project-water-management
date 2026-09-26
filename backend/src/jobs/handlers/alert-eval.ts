// `alert_eval`: evaluate the project's alert rules as the editor who queued
// it (roadmap WP-2.13, alerts/evaluate.ts): open and clear alert events and
// queue a delivery per recipient of each newly opened one. The mails go out
// after this job commits, from the tick's send step (alerts/send.ts).
// Queued by alerts/queue.ts and by the tick's scheduled checks
// (app_alert_schedule).
import { z } from 'zod';
import { evaluateAlerts } from '../../alerts/evaluate.js';
import { ALERT_EVAL_CAUSES } from '../../alerts/queue.js';
import { defineHandler } from '../registry.js';

export const AlertEvalPayload = z.object({ cause: z.enum(ALERT_EVAL_CAUSES).default('schedule') }).strict();

export const alertEvalHandler = defineHandler({
	role: 'editor',
	payload: AlertEvalPayload,
	async run({ db, job }) {
		await evaluateAlerts(db, job.projectId);
	}
});
