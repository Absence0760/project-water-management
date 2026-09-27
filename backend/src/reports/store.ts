// The report table (023_reports.sql): queue a PDF, read its status, and
// record a finished render, each as the transaction's user under RLS.
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/tx.js';
import { enqueueJob, type JobStatus } from '../jobs/queue.js';
import { reportReadyMail, sitePage } from '../mail/templates.js';
import { trySendMail } from '../mail/transport.js';
import { reportKey } from './storage.js';

/** A report job is worth a couple of retries (a browser crash), not the default five. */
export const REPORT_MAX_ATTEMPTS = 3;

/** On-demand PDFs one user may ask for per project per hour. */
export const REPORTS_PER_HOUR = 10;

export interface CreateReport {
	projectId: string;
	runId: string;
	/** An impact report's baseline run (the caller checked the requester can read it; so does report_enqueue). */
	againstRunId?: string;
	/** User ids to email the link to (checked by the caller; filtered to members again at send time). */
	emailTo: string[];
	scheduleId?: string;
	/** A scheduled period's key: a second enqueue for it returns the first (jobs/queue.ts). */
	dedupeKey?: string;
}

/** Queue a render: its job and its report row, in the caller's transaction. */
export async function createReport(db: Db, o: CreateReport): Promise<{ jobId: string; created: boolean }> {
	const reportId = randomUUID();
	const { job, created } = await enqueueJob(db, {
		projectId: o.projectId,
		kind: 'report_render',
		payload: { reportId },
		dedupeKey: o.dedupeKey,
		maxAttempts: REPORT_MAX_ATTEMPTS
	});
	if (!created) return { jobId: job.id, created };
	await db.query(
		`INSERT INTO report (id, project_id, run_id, job_id, schedule_id, requested_by, email_to, impact, against_run_id)
		 VALUES ($1, $2, $3, $4, $5, app_current_user_id(), $6::uuid[], $7, $8)`,
		[reportId, o.projectId, o.runId, job.id, o.scheduleId ?? null, [...new Set(o.emailTo)], o.againstRunId !== undefined, o.againstRunId ?? null]
	);
	return { jobId: job.id, created };
}

/** What a viewer sees of a report. */
export type ReportState = 'queued' | 'rendering' | 'retrying' | 'done' | 'failed';

export interface ReportView {
	jobId: string;
	status: ReportState;
	runId: string | null;
	/** An impact report (the run against a baseline). The baseline itself isn't shown: it may be a project other viewers can't see. */
	impact: boolean;
	scheduled: boolean;
	pages: number | null;
	createdAt: string;
	finishedAt: string | null;
	/** Why it failed or is being retried (the job's sanitised error), or an email problem after a good render. */
	error: string | null;
	/** How many people the link was emailed to (asked for; members only). */
	emailed: number;
}

export interface ReportRow {
	id: string;
	projectId: string;
	runId: string | null;
	/** An impact report; its baseline is againstRunId (null once deleted). */
	impact: boolean;
	againstRunId: string | null;
	jobId: string | null;
	scheduleId: string | null;
	requestedBy: string;
	emailTo: string[];
	status: 'queued' | 'rendering' | 'done' | 'failed';
	pages: number | null;
	bytes: number | null;
	error: string | null;
	createdAt: string;
	finishedAt: string | null;
}

const REPORT_COLS = `r.id, r.project_id AS "projectId", r.run_id AS "runId", r.impact, r.against_run_id AS "againstRunId", r.job_id AS "jobId", r.schedule_id AS "scheduleId",
	r.requested_by AS "requestedBy", r.email_to AS "emailTo", r.status, r.pages, r.bytes, r.error,
	r.created_at AS "createdAt", r.finished_at AS "finishedAt"`;

/** A report of the project, by id (RLS: viewer). */
export async function loadReport(db: Db, projectId: string, reportId: string): Promise<ReportRow | null> {
	const { rows } = await db.query<ReportRow>(`SELECT ${REPORT_COLS} FROM report r WHERE r.id = $1 AND r.project_id = $2`, [reportId, projectId]);
	return rows[0] ?? null;
}

/**
 * A report handed to the renderer Lambda that hasn't answered in this long
 * is shown as failed (its message was lost or dead-lettered, which alarms).
 */
export const RENDER_ANSWER_WITHIN_MS = 60 * 60 * 1000;

/** The status the API shows: the report's own, or its job's while the render hasn't finished. */
export function reportState(reportStatus: ReportRow['status'], jobStatus: JobStatus | null, createdAt: Date, now = new Date()): ReportState {
	if (reportStatus === 'done' || reportStatus === 'failed') return reportStatus;
	if (jobStatus === 'dead' || jobStatus === null) return 'failed';
	if (jobStatus === 'failed') return 'retrying';
	if (reportStatus === 'rendering' && now.getTime() - createdAt.getTime() > RENDER_ANSWER_WITHIN_MS) return 'failed';
	if (jobStatus === 'running' || reportStatus === 'rendering') return 'rendering';
	return 'queued';
}

/** A report by its job id (RLS: viewer), with its key for a download link. */
export async function reportByJob(db: Db, projectId: string, jobId: string): Promise<(ReportView & { key: string }) | null> {
	const { rows } = await db.query<ReportRow & { jobStatus: JobStatus | null; jobError: string | null }>(
		`SELECT ${REPORT_COLS}, j.status AS "jobStatus", j.last_error AS "jobError"
		 FROM report r LEFT JOIN job j ON j.id = r.job_id
		 WHERE r.project_id = $1 AND r.job_id = $2`,
		[projectId, jobId]
	);
	const r = rows[0];
	if (!r) return null;
	const status = reportState(r.status, r.jobStatus, new Date(r.createdAt));
	return {
		jobId,
		status,
		runId: r.runId,
		impact: r.impact,
		scheduled: r.scheduleId !== null,
		pages: r.pages,
		createdAt: r.createdAt,
		finishedAt: r.finishedAt,
		error:
			status === 'done' || r.status === 'failed'
				? r.error
				: status === 'failed' || status === 'retrying'
					? (r.jobError ?? (r.status === 'rendering' ? 'the renderer did not answer' : 'the render did not finish'))
					: null,
		emailed: r.emailTo.length,
		key: reportKey(r.projectId, r.id)
	};
}

/** Reports this user asked for in the project in the last hour (the on-demand rate limit). */
export async function recentReportCount(db: Db, projectId: string): Promise<number> {
	// Count and insert one request at a time per user and project (the lock is
	// held to commit), so a burst of requests can't all pass the cap together.
	await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('report_cap:' || $1::text || ':' || app_current_user_id()::text, 0))`, [projectId]);
	const { rows } = await db.query<{ n: number }>(
		`SELECT count(*)::int AS n FROM report WHERE project_id = $1 AND requested_by = app_current_user_id()
		   AND schedule_id IS NULL AND created_at > now() - interval '1 hour'`,
		[projectId]
	);
	return rows[0]?.n ?? 0;
}

/**
 * Direct members of the project among `userIds` who can read its report
 * (viewer or above: never a farmer), with their addresses (RLS: viewer).
 */
export async function membersAmong(db: Db, projectId: string, userIds: string[]): Promise<{ id: string; email: string }[]> {
	if (!userIds.length) return [];
	const { rows } = await db.query<{ id: string; email: string }>(
		`SELECT u.id, u.email FROM project_member m JOIN app_user u ON u.id = m.user_id
		 WHERE m.project_id = $1 AND m.user_id = ANY($2::uuid[]) AND m.role >= 'viewer' ORDER BY u.email`,
		[projectId, userIds]
	);
	return rows;
}

/** Record the renderer Lambda's failure on the report (production; the job that applies it succeeds). */
export async function failReport(db: Db, report: ReportRow, error: string): Promise<void> {
	await db.query(`UPDATE report SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [report.id, error.slice(0, 500)]);
}

/**
 * Record a finished render and email its link, in the job's transaction (as
 * the requester). The recipients are resolved now: the requester themselves
 * if they asked, and anyone else only while still a member of the project.
 * A mail that fails doesn't fail the job (the PDF is there to download); the
 * report says so.
 */
export async function finishReport(db: Db, report: ReportRow, r: { pages: number; bytes: number }): Promise<void> {
	await db.query(`UPDATE report SET status = 'done', pages = $2, bytes = $3, finished_at = now(), error = NULL WHERE id = $1`, [report.id, r.pages, r.bytes]);
	if (!report.emailTo.length || !report.jobId) return;
	const { rows: facts } = await db.query<{ projectName: string; runName: string | null; requestedBy: string; requesterEmail: string }>(
		`SELECT p.name AS "projectName", COALESCE(NULLIF(mr.label, ''), 'of ' || to_char(mr.created_at AT TIME ZONE app_time_zone(p.time_zone), 'DD Mon YYYY')) AS "runName",
			u.display_name AS "requestedBy", u.email AS "requesterEmail"
		 FROM project p JOIN app_user u ON u.id = $3 LEFT JOIN model_run mr ON mr.id = $2
		 WHERE p.id = $1`,
		[report.projectId, report.runId, report.requestedBy]
	);
	const f = facts[0];
	if (!f) return;
	const to = await membersAmong(db, report.projectId, report.emailTo.filter((id) => id !== report.requestedBy));
	if (report.emailTo.includes(report.requestedBy)) to.unshift({ id: report.requestedBy, email: f.requesterEmail });
	const link = sitePage(`/projects/${report.projectId}/reports/${report.jobId}`);
	let failed = 0;
	for (const r2 of to) {
		const ok = await trySendMail(
			reportReadyMail(r2.email, link, { projectName: f.projectName, runName: f.runName ?? 'that was deleted', pages: r.pages, requestedBy: f.requestedBy, scheduled: report.scheduleId !== null, impact: report.impact })
		);
		if (!ok) failed++;
	}
	if (failed) {
		await db.query('UPDATE report SET error = $2 WHERE id = $1', [report.id, `the email to ${failed} of ${to.length} recipients could not be sent`]);
	}
}
