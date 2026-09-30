// The report side of the job queue's tick (jobs/runner.ts), with no user
// context, crossing projects only through SECURITY DEFINER functions
// (023_reports.sql):
//
//   scheduleDueReports   every tick: for each report schedule whose time has
//                        come (reports/due.ts), claim that time and queue a
//                        render of the project's latest run, as the
//                        schedule's acting user, under RLS, emailed to its
//                        recipients. The claim makes it once per time, and the
//                        job's dedupe key (schedule + time) backs that up.
//   acceptRenderResult   the production worker, for each `render-results`
//                        message: queue the follow-up report_render job that
//                        records the answer, as the report's requester.
//   acceptPackRenderResult  the same for an evidence pack's answer: the
//                        follow-up pack_render job, as the acting user of the
//                        pack's render request (119_pack_render).
//   purgeReports         every tick: rows older than 8 days (a day past the
//                        bucket's lifecycle); locally their PDFs too.
import { withoutUser, withUser } from '../db/tx.js';
import { enqueueJob } from '../jobs/queue.js';
import type { PackRenderResultMessage, RenderResultMessage } from '../jobs/transport.js';
import { dueFireAt } from './due.js';
import { deletePdf, REPORT_RETENTION_DAYS, reportKey, storageKind } from './storage.js';
import { createReport } from './store.js';

export interface ReportScheduleResult {
	queued: number;
	/** Due times that queued nothing (no runs, the acting user lost access): recorded on the schedule. */
	skipped: number;
}

interface ScheduleRow {
	id: string;
	projectId: string;
	actingUserId: string;
	frequency: 'weekly' | 'monthly';
	weekday: number | null;
	monthDay: number | null;
	hour: number;
	timezone: string;
	anchorAt: Date;
	lastFiredFor: Date | null;
}

/** Fixed reasons a due time queued nothing (shown to the project's members). */
export const SCHEDULE_NO_RUNS = 'the project had no runs to report on';
export const SCHEDULE_NO_ACCESS = 'the editor who saved this schedule can no longer edit the project: an editor must save it again';

export async function scheduleDueReports(now = new Date()): Promise<ReportScheduleResult> {
	const { rows } = await withoutUser((db) =>
		db.query<ScheduleRow>(
			`SELECT id, project_id AS "projectId", acting_user_id AS "actingUserId", frequency, weekday, month_day AS "monthDay",
				hour, timezone, anchor_at AS "anchorAt", last_fired_for AS "lastFiredFor"
			 FROM app_report_schedules_to_check()`
		)
	);
	const out: ReportScheduleResult = { queued: 0, skipped: 0 };
	for (const s of rows) {
		let fire: Date | null;
		try {
			fire = dueFireAt(s, now);
		} catch {
			continue; // A zone this runtime doesn't know (the API validates it on save).
		}
		if (!fire) continue;
		const claimed = await withoutUser(async (db) => {
			const { rows: c } = await db.query<{ ok: boolean }>('SELECT app_claim_report_schedule($1, $2) AS ok', [s.id, fire]);
			return c[0]?.ok === true;
		});
		if (!claimed) continue;
		const outcome = await withUser(s.actingUserId, async (db) => {
			const { rows: role } = await db.query<{ ok: boolean }>(`SELECT app_has_role($1, 'editor') AS ok`, [s.projectId]);
			if (!role[0]?.ok) return SCHEDULE_NO_ACCESS;
			const { rows: run } = await db.query<{ id: string }>(
				'SELECT id FROM model_run WHERE project_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
				[s.projectId]
			);
			if (!run[0]) return SCHEDULE_NO_RUNS;
			const { rows: to } = await db.query<{ userId: string }>('SELECT user_id AS "userId" FROM report_schedule_recipient WHERE schedule_id = $1', [s.id]);
			await createReport(db, {
				projectId: s.projectId,
				runId: run[0].id,
				emailTo: to.map((r) => r.userId),
				scheduleId: s.id,
				dedupeKey: `report_schedule:${s.id}:${fire!.toISOString()}`
			});
			return null;
		});
		if (outcome) {
			await withoutUser((db) => db.query('SELECT app_report_schedule_failed($1, $2)', [s.id, outcome]));
			out.skipped++;
		} else out.queued++;
	}
	return out;
}

/** What became of a render-results message. */
export type RenderAcceptance = 'queued' | 'unknown_report' | 'refused';

export async function acceptRenderResult(msg: RenderResultMessage): Promise<RenderAcceptance> {
	const { rows } = await withoutUser((db) =>
		db.query<{ projectId: string; requestedBy: string }>('SELECT project_id AS "projectId", requested_by AS "requestedBy" FROM app_report_render_target($1)', [
			msg.reportId
		])
	);
	const target = rows[0];
	// Purged, already answered, or not a report that is waiting.
	if (!target) return 'unknown_report';
	try {
		await withUser(target.requestedBy, (db) =>
			enqueueJob(db, {
				projectId: target.projectId,
				kind: 'report_render',
				payload: { reportId: msg.reportId, result: msg.result },
				dedupeKey: `report_result:${msg.reportId}`
			})
		);
		return 'queued';
	} catch (err) {
		if ((err as { code?: string }).code !== '42501') throw err;
		return 'refused';
	}
}

/** What became of a pack's render-results message. */
export type PackRenderAcceptance = 'queued' | 'unknown_pack' | 'refused';

export async function acceptPackRenderResult(msg: PackRenderResultMessage): Promise<PackRenderAcceptance> {
	const { rows } = await withoutUser((db) =>
		db.query<{ projectId: string; actingUserId: string }>('SELECT project_id AS "projectId", acting_user_id AS "actingUserId" FROM app_pack_render_target($1)', [msg.packId])
	);
	const target = rows[0];
	// A draft, a pack whose PDF is recorded already, or one with no render asked for.
	if (!target) return 'unknown_pack';
	try {
		await withUser(target.actingUserId, (db) =>
			enqueueJob(db, {
				projectId: target.projectId,
				kind: 'pack_render',
				payload: { packId: msg.packId, result: msg.result },
				// Redelivered answers collapse while one is pending; the first recorded stands anyway (app_record_pack_pdf).
				dedupeKey: `pack_result:${msg.packId}`
			})
		);
		return 'queued';
	} catch (err) {
		if ((err as { code?: string }).code !== '42501') throw err;
		return 'refused';
	}
}

/** Days a report row is kept: a day past the bucket's lifecycle. */
export const REPORT_ROW_DAYS = REPORT_RETENTION_DAYS + 1;

export async function purgeReports(days = REPORT_ROW_DAYS): Promise<number> {
	const { rows } = await withoutUser((db) =>
		db.query<{ projectId: string; id: string }>('SELECT project_id AS "projectId", id FROM app_purge_reports(make_interval(days => $1))', [days])
	);
	// Production's bucket lifecycle deletes the PDFs; MinIO has none configured.
	if (storageKind() === 'local') {
		for (const r of rows) await deletePdf(reportKey(r.projectId, r.id)).catch(() => {});
	}
	return rows.length;
}
