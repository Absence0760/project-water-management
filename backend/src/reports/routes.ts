// Server-side PDF reports (docs/api.md § Reports; WP-2.15 Phase B).
//
//   POST   /projects/:id/reports                        viewer   queue a PDF of a run, or its impact report (202 { jobId })
//   GET    /projects/:id/reports/:jobId                 viewer   its status
//   GET    /projects/:id/reports/:jobId/pdf             viewer   302 to a 60 s signed GET of the PDF once done (S3 locally, CloudFront in production)
//   GET    /projects/:id/report-schedules               viewer   the project's schedules
//   POST   /projects/:id/report-schedules               editor   add one
//   PATCH  /projects/:id/report-schedules/:scheduleId   editor   change one
//   DELETE /projects/:id/report-schedules/:scheduleId   editor   remove one
//   POST   /auth/render-session                         public   the renderer's token → a scoped session
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { issueSession } from '../auth/session.js';
import { parseToken } from '../auth/tokens.js';
import { type Db, withoutUser, withUser } from '../db/tx.js';
import { recordAudit } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError, mustChange } from '../http/errors.js';
import { wakeWorker } from '../jobs/wake.js';
import { requireRole, UUID } from '../projects/access.js';
import { isValidTimeZone, nextFireAt } from './due.js';
import { downloadUrl, REPORT_RETENTION_DAYS, reportFileName } from './storage.js';
import { DEFAULT_TIME_ZONE, localDate } from '../projects/timeZone.js';
import { createReport, membersAmong, recentReportCount, reportByJob, REPORTS_PER_HOUR } from './store.js';
import { consumeRenderToken } from './tokens.js';

const Uuid = z.string().uuid();

/** Most people one PDF (or schedule) is emailed to. */
export const MAX_RECIPIENTS = 20;
/** Most schedules per project. */
export const MAX_SCHEDULES = 10;

const CreateBody = z
	.object({
		/** The run to print; the latest when absent. */
		runId: Uuid.optional(),
		/**
		 * An impact report: the baseline "<projectId>:<runId>" (the report route's
		 * `against`, Compare runs' refs), a run the requester can read, possibly
		 * in another project. Needs `runId`.
		 */
		against: z.string().max(80).regex(/^[0-9a-fA-F-]{36}:[0-9a-fA-F-]{36}$/, 'expected <projectId>:<runId>').optional(),
		/** true: email me the link; a list: email these members (editors and owners only). */
		email: z.union([z.boolean(), z.array(Uuid).min(1).max(MAX_RECIPIENTS)]).optional()
	})
	.strict();

const Timing = {
	frequency: z.enum(['weekly', 'monthly']),
	weekday: z.number().int().min(1).max(7).nullable().optional(),
	monthDay: z.number().int().min(1).max(28).nullable().optional(),
	hour: z.number().int().min(0).max(23),
	timezone: z.string().trim().min(1).max(64).refine(isValidTimeZone, 'not a known time zone'),
	enabled: z.boolean().optional(),
	recipients: z.array(Uuid).min(1).max(MAX_RECIPIENTS)
};
const ScheduleBody = z.object(Timing).strict();
const SchedulePatch = z.object(Timing).partial().strict();

/** Each frequency's own day field, and nothing of the other's. */
function timing(t: { frequency: 'weekly' | 'monthly'; weekday?: number | null; monthDay?: number | null }) {
	if (t.frequency === 'weekly') {
		if (!t.weekday) throw new ApiError(400, 'a weekly schedule needs a weekday (1 = Monday … 7 = Sunday)');
		return { weekday: t.weekday, monthDay: null };
	}
	if (!t.monthDay) throw new ApiError(400, 'a monthly schedule needs a day of the month (1–28)');
	return { weekday: null, monthDay: t.monthDay };
}

export interface ScheduleView {
	id: string;
	frequency: 'weekly' | 'monthly';
	weekday: number | null;
	monthDay: number | null;
	hour: number;
	timezone: string;
	enabled: boolean;
	recipients: { userId: string; displayName: string; email: string }[];
	/** Display name of the editor it runs as (null once their account is gone). */
	actingUser: string | null;
	nextAt: string | null;
	lastSentFor: string | null;
	lastError: string | null;
	updatedAt: string;
}

async function listSchedules(db: Db, projectId: string, only?: string): Promise<ScheduleView[]> {
	const { rows } = await db.query<
		Omit<ScheduleView, 'nextAt' | 'recipients'> & { recipients: ScheduleView['recipients'] | null; anchorAt: Date; lastFiredFor: Date | null }
	>(
		`SELECT s.id, s.frequency, s.weekday, s.month_day AS "monthDay", s.hour, s.timezone, s.enabled,
			u.display_name AS "actingUser", s.last_fired_for AS "lastSentFor", s.last_fired_for AS "lastFiredFor", s.anchor_at AS "anchorAt",
			s.last_error AS "lastError", s.updated_at AS "updatedAt",
			(SELECT json_agg(json_build_object('userId', ru.id, 'displayName', ru.display_name, 'email', ru.email) ORDER BY ru.display_name)
			 FROM report_schedule_recipient r JOIN app_user ru ON ru.id = r.user_id WHERE r.schedule_id = s.id) AS recipients
		 FROM report_schedule s LEFT JOIN app_user u ON u.id = s.acting_user_id
		 WHERE s.project_id = $1 AND ($2::uuid IS NULL OR s.id = $2)
		 ORDER BY s.created_at, s.id`,
		[projectId, only ?? null]
	);
	const now = new Date();
	return rows.map(({ anchorAt, lastFiredFor, ...s }) => {
		void lastFiredFor;
		// The next time it will send: never before it was saved.
		const next = s.enabled ? nextFireAt(s, anchorAt > now ? anchorAt : now) : null;
		return { ...s, recipients: s.recipients ?? [], nextAt: next ? next.toISOString() : null };
	});
}

/** Recipients must be direct members of the project (the Sharing panel's list) who can read the report: not farmers. */
async function checkRecipients(db: Db, projectId: string, ids: string[]): Promise<string[]> {
	const unique = [...new Set(ids)];
	const members = await membersAmong(db, projectId, unique);
	if (members.length !== unique.length) throw new ApiError(400, 'every recipient must be a member of the project who can read its report (a viewer or above)');
	return unique;
}

async function setRecipients(db: Db, scheduleId: string, ids: string[]): Promise<void> {
	await db.query('DELETE FROM report_schedule_recipient WHERE schedule_id = $1 AND NOT (user_id = ANY($2::uuid[]))', [scheduleId, ids]);
	await db.query(
		`INSERT INTO report_schedule_recipient (schedule_id, user_id) SELECT $1, u FROM unnest($2::uuid[]) AS u ON CONFLICT DO NOTHING`,
		[scheduleId, ids]
	);
}

/** A schedule's timing as the history records it; recipients by count only (they are members' addresses). */
const scheduleSubject = (
	scheduleId: string,
	action: 'created' | 'changed' | 'removed',
	s: { frequency: string; hour: number; timezone: string; enabled: boolean },
	recipients?: number
) => ({ scheduleId, action, frequency: s.frequency, hour: s.hour, timezone: s.timezone, enabled: s.enabled, ...(recipients !== undefined ? { recipients } : {}) });

const scheduleId = (raw: string | undefined): string => {
	if (!raw || !UUID.test(raw)) throw new ApiError(404, 'not found');
	return raw;
};

export const reportRoutes = new Hono<AuthEnv>()
	.post('/:id/reports', async (c) => {
		const body = CreateBody.parse(await readJson(c));
		const id = c.req.param('id');
		const userId = c.get('userId');
		const result = await withUser(userId, async (db) => {
			const role = await requireRole(db, id, 'viewer');
			if ((await recentReportCount(db, id)) >= REPORTS_PER_HOUR) {
				throw new ApiError(429, `at most ${REPORTS_PER_HOUR} PDFs an hour per project: try again later`);
			}
			const { rows } = await db.query<{ id: string }>(
				body.runId
					? 'SELECT id FROM model_run WHERE project_id = $1 AND id = $2'
					: 'SELECT id FROM model_run WHERE project_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
				body.runId ? [id, body.runId] : [id]
			);
			const run = rows[0];
			if (!run) throw new ApiError(body.runId ? 404 : 409, body.runId ? 'no such run in this project' : 'the project has no runs to report on');
			let againstRunId: string | undefined;
			if (body.against !== undefined) {
				if (!body.runId) throw new ApiError(400, 'an impact report names its run (runId) as well as its baseline');
				const [againstProject, baseline] = body.against.split(':') as [string, string];
				if (!UUID.test(againstProject) || !UUID.test(baseline)) throw new ApiError(400, 'expected against as <projectId>:<runId>');
				if (baseline.toLowerCase() === run.id.toLowerCase()) throw new ApiError(400, 'the baseline is the run itself');
				// Under RLS as the requester: a baseline they can't read is "no such run", like Compare runs.
				const { rows: b } = await db.query<{ id: string }>(
					`SELECT id FROM model_run WHERE id = $1 AND project_id = $2 AND app_has_role(project_id, 'viewer')`,
					[baseline, againstProject]
				);
				if (!b[0]) throw new ApiError(404, "no such baseline run, or its project isn't shared with you");
				againstRunId = b[0].id;
			}
			let emailTo: string[] = [];
			if (body.email === true) emailTo = [userId];
			else if (Array.isArray(body.email)) {
				const others = body.email.filter((u) => u !== userId);
				// A viewer may email the PDF to themselves; sending it to others is an editor's call.
				if (others.length && role === 'viewer') throw new ApiError(403, 'only editors and owners can email a report to other members');
				emailTo = [...(body.email.includes(userId) ? [userId] : []), ...(await checkRecipients(db, id, others))];
			}
			return createReport(db, { projectId: id, runId: run.id, againstRunId, emailTo });
		});
		await wakeWorker(result.jobId);
		return c.json({ jobId: result.jobId }, 202);
	})
	.get('/:id/reports/:jobId', async (c) => {
		const id = c.req.param('id');
		const jobId = c.req.param('jobId');
		if (!UUID.test(jobId)) throw new ApiError(404, 'not found');
		const view = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			const v = await reportByJob(db, id, jobId);
			if (!v) throw new ApiError(404, 'not found');
			return v;
		});
		const { key: _key, ...report } = view;
		return c.json({ report });
	})
	// The download: a fresh, one-minute signed GET per click, behind the
	// session and the project's membership, so the only lasting link to a PDF
	// is this route (issue #126). In production it is a CloudFront signed URL
	// on the site's own /reports/* path, so the transfer too passes the WAF
	// (storage.ts downloadUrl). A redirect rather than streaming the bytes:
	// the API's Function URL buffers responses (6 MB, less after base64), and
	// streaming would hold a VPC Lambda open for every transfer.
	.get('/:id/reports/:jobId/pdf', async (c) => {
		const id = c.req.param('id');
		const jobId = c.req.param('jobId');
		if (!UUID.test(jobId)) throw new ApiError(404, 'not found');
		const { view, name, timeZone } = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			const v = await reportByJob(db, id, jobId);
			if (!v) throw new ApiError(404, 'not found');
			const { rows } = await db.query<{ name: string; timeZone: string }>('SELECT name, time_zone AS "timeZone" FROM project WHERE id = $1', [id]);
			return { view: v, name: rows[0]?.name ?? '', timeZone: rows[0]?.timeZone ?? DEFAULT_TIME_ZONE };
		});
		if (view.status !== 'done') throw new ApiError(409, 'the PDF is not ready');
		// The bucket's lifecycle deletes PDFs at REPORT_RETENTION_DAYS, a day before the row goes: say so, rather than redirect to S3's error.
		if (view.finishedAt && Date.now() - new Date(view.finishedAt).getTime() > REPORT_RETENTION_DAYS * 86_400_000) throw new ApiError(404, `the PDF has expired: PDFs are kept for ${REPORT_RETENTION_DAYS} days`);
		const url = await downloadUrl(view.key, reportFileName(name, localDate(new Date(view.finishedAt ?? Date.now()), timeZone)));
		c.header('Cache-Control', 'no-store');
		c.header('Referrer-Policy', 'no-referrer');
		return c.redirect(url, 302);
	})
	.get('/:id/report-schedules', async (c) => {
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			return c.json({ schedules: await listSchedules(db, id) });
		});
	})
	.post('/:id/report-schedules', async (c) => {
		const body = ScheduleBody.parse(await readJson(c));
		const id = c.req.param('id');
		const schedule = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			// Count and insert one schedule at a time per project, so concurrent adds can't pass the cap together.
			await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('report_schedule_cap:' || $1::text, 0))`, [id]);
			const { rows: n } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM report_schedule WHERE project_id = $1', [id]);
			if ((n[0]?.n ?? 0) >= MAX_SCHEDULES) throw new ApiError(409, `a project can have at most ${MAX_SCHEDULES} report schedules`);
			const recipients = await checkRecipients(db, id, body.recipients);
			const t = timing(body);
			const { rows } = await db.query<{ id: string }>(
				`INSERT INTO report_schedule (project_id, frequency, weekday, month_day, hour, timezone, enabled)
				 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
				[id, body.frequency, t.weekday, t.monthDay, body.hour, body.timezone, body.enabled ?? true]
			);
			await setRecipients(db, rows[0]!.id, recipients);
			const created = (await listSchedules(db, id, rows[0]!.id))[0]!;
			await recordAudit(db, id, 'report_schedule.configured', scheduleSubject(created.id, 'created', created, recipients.length));
			return created;
		});
		return c.json({ schedule }, 201);
	})
	.patch('/:id/report-schedules/:scheduleId', async (c) => {
		const body = SchedulePatch.parse(await readJson(c));
		const id = c.req.param('id');
		const sid = scheduleId(c.req.param('scheduleId'));
		const schedule = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const { rows: cur } = await db.query<{ frequency: 'weekly' | 'monthly'; weekday: number | null; monthDay: number | null; hour: number; timezone: string; enabled: boolean }>(
				`SELECT frequency, weekday, month_day AS "monthDay", hour, timezone, enabled FROM report_schedule WHERE id = $1 AND project_id = $2`,
				[sid, id]
			);
			if (!cur[0]) throw new ApiError(404, 'not found');
			const next = { ...cur[0], ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) } as typeof cur[0];
			const t = timing(next);
			// Saving makes the saver the schedule's acting user (the trigger), whatever changed.
			const changed = await db.query(
				`UPDATE report_schedule SET frequency = $3, weekday = $4, month_day = $5, hour = $6, timezone = $7, enabled = $8
				 WHERE id = $1 AND project_id = $2`,
				[sid, id, next.frequency, t.weekday, t.monthDay, next.hour, next.timezone, next.enabled]
			);
			mustChange(changed);
			if (body.recipients) await setRecipients(db, sid, await checkRecipients(db, id, body.recipients));
			const updated = (await listSchedules(db, id, sid))[0]!;
			await recordAudit(db, id, 'report_schedule.configured', scheduleSubject(sid, 'changed', next, body.recipients?.length));
			return updated;
		});
		return c.json({ schedule });
	})
	.delete('/:id/report-schedules/:scheduleId', async (c) => {
		const id = c.req.param('id');
		const sid = scheduleId(c.req.param('scheduleId'));
		await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const { rows } = await db.query<{ frequency: string; hour: number; timezone: string; enabled: boolean }>(
				'DELETE FROM report_schedule WHERE id = $1 AND project_id = $2 RETURNING frequency, hour, timezone, enabled',
				[sid, id]
			);
			if (!rows[0]) throw new ApiError(404, 'not found');
			await recordAudit(db, id, 'report_schedule.configured', scheduleSubject(sid, 'removed', rows[0]));
		});
		return c.body(null, 204);
	});

const INVALID_TOKEN = 'this render token is invalid, used or expired';

/**
 * The headless renderer's sign-in (reports/render.ts). Public: the token is
 * the credential. It is consumed whatever happens next, and the session it
 * gives reads one project and one run as the requester (reports/scope.ts),
 * who must still be able to see both (and an impact report's baseline).
 */
export const renderSessionRoutes = new Hono<AuthEnv>().post('/render-session', async (c) => {
	const body = z.object({ token: z.string().max(200) }).strict().parse(await readJson(c));
	const hash = parseToken(body.token);
	// Coded (render_token_refused): the renderer treats only this refusal as final (reports/render.ts).
	if (!hash) throw ApiError.coded(400, 'render_token_refused', INVALID_TOKEN);
	const t = await withoutUser((db) => consumeRenderToken(db, hash));
	if (!t) throw ApiError.coded(400, 'render_token_refused', INVALID_TOKEN);
	await withUser(t.userId, async (db) => {
		// The run, and an impact report's baseline, both still readable by the requester (RLS: model_run is theirs).
		const { rows } = await db.query<{ ok: boolean }>(
			`SELECT app_has_role($1, 'viewer') AND EXISTS (SELECT 1 FROM model_run WHERE id = $2 AND project_id = $1)
				AND ($4::uuid IS NULL OR (app_has_role($3, 'viewer') AND EXISTS (SELECT 1 FROM model_run WHERE id = $4 AND project_id = $3))) AS ok`,
			[t.projectId, t.runId, t.against?.projectId ?? null, t.against?.runId ?? null]
		);
		if (!rows[0]?.ok) throw ApiError.coded(403, 'render_token_refused', 'the requester can no longer see this report');
	});
	await issueSession(c, t.userId, { projectId: t.projectId, runId: t.runId, ...(t.against ? { against: t.against } : {}) });
	return c.json({ ok: true });
});
