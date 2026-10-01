// "A known engine bug may affect your results" emails: the known-defect
// procedure's notice (issue #103, Gate D; docs/legal/known-defect-procedure.md,
// 150_erratum_notices.sql). The pattern is the pack notices'
// (evidence/notices.ts):
//
//   1. Swept by the worker's tick (sweepErrata): the engine's ENGINE_ERRATA,
//      generated from docs/engine-errata.md, goes to app_erratum_sweep, which
//      looks at the runs only for an erratum it hasn't swept with that range
//      and queues one erratum_notice per erratum, project and owner whose
//      project holds a run the erratum may affect. So a new erratum is mailed
//      on the first tick after the deploy that carries it, once.
//   2. Sent by the same tick (sendErratumNotices), each built in a
//      transaction *as its recipient* (withUser), under RLS: still an owner
//      now, a confirmed address that SES hasn't suppressed since, and the
//      project's name as they may read it. The mail goes out after that
//      transaction; the outcome is recorded in the worker's own context. A
//      transport error is retried on the next tick (3 attempts in all); a
//      worker that dies mid-send leaves the notice failed, never sent twice.
//
// The erratum's words come from the engine's list, not the database: the
// claim carries its id only.
import { ENGINE_ERRATA, type Erratum } from '@water-management/engine';
import { type Db, withoutUser, withUser } from '../db/tx.js';
import { NOTICE_SUPPRESSED } from '../evidence/notices.js';
import { logEvent } from '../logging/logEvent.js';
import { safeError } from '../logging/safeError.js';
import { erratumNoticeMail } from '../mail/templates.js';
import { sendMail, type Mail } from '../mail/transport.js';

/** Settled notices are kept this long, then the tick deletes them (app_purge_erratum_notices). */
export const ERRATUM_NOTICE_RETENTION_DAYS = 30;

const LEASE = '10 minutes';

/**
 * Queue the notices of every erratum not yet swept with its current range
 * (the worker's own context). Returns how many were queued; 0 on a tick
 * where the list is unchanged, at one primary-key lookup per erratum.
 */
export async function sweepErrata(errata: readonly Erratum[] = ENGINE_ERRATA): Promise<number> {
	const list = errata.map((e) => ({ id: e.id, keyedOn: e.keyedOn, firstAffected: e.firstAffected, fixedIn: e.fixedIn }));
	const { rows } = await withoutUser((db) => db.query<{ n: number }>('SELECT app_erratum_sweep($1::jsonb) AS n', [JSON.stringify(list)]));
	return rows[0]?.n ?? 0;
}

export interface ClaimedErratumNotice {
	erratum_id: string;
	project_id: string;
	user_id: string;
	run_count: number;
}

export interface ErratumNoticeResult {
	sent: number;
	skipped: number;
	failed: number;
}

type Prepared = { mail: Mail } | { skip: string };

/** One notice's mail, built as its recipient (the transaction's user), or why not. */
export async function prepareErratumNotice(db: Db, c: ClaimedErratumNotice, errata: readonly Erratum[] = ENGINE_ERRATA): Promise<Prepared> {
	const erratum = errata.find((e) => e.id === c.erratum_id);
	if (!erratum) return { skip: 'the erratum is no longer listed' };
	const { rows } = await db.query<{ email: string; verified: boolean; suppressed: boolean; role: string | null; project: string | null }>(
		`SELECT u.email, u.email_verified_at IS NOT NULL AS verified, u.mail_suppressed_at IS NOT NULL AS suppressed,
			app_project_role($1)::text AS role, (SELECT p.name FROM project p WHERE p.id = $1) AS project
		 FROM app_user u WHERE u.id = app_current_user_id()`,
		[c.project_id]
	);
	const me = rows[0];
	if (!me?.verified || !me.project) return { skip: 'no longer a member, or no confirmed address' };
	if (me.suppressed) return { skip: NOTICE_SUPPRESSED };
	// The audience again, now: an owner (or the project's team admin, 094).
	if (me.role !== 'owner') return { skip: 'no longer an owner of the project' };
	return {
		mail: erratumNoticeMail(me.email, { projectId: c.project_id, projectName: me.project, erratum, runCount: c.run_count })
	};
}

const finish = (c: ClaimedErratumNotice, status: 'sent' | 'skipped' | 'retry', reason: string | null = null) =>
	withoutUser((db) => db.query('SELECT app_erratum_notice_finish($1, $2, $3, $4, $5)', [c.erratum_id, c.project_id, c.user_id, status, reason]));

/** Never the raw error text (SES writes the address into it): its name and code only. */
const failureReason = (err: unknown) => `send failed (${safeError(err).error})`;

async function deliver(c: ClaimedErratumNotice, r: ErratumNoticeResult, errata: readonly Erratum[]): Promise<void> {
	let p: Prepared;
	try {
		p = await withUser(c.user_id, (db) => prepareErratumNotice(db, c, errata), { readOnly: true });
	} catch (err) {
		logEvent('error', { event: 'erratum_notice_prepare_failed', erratumId: c.erratum_id, ...safeError(err) });
		await finish(c, 'retry', failureReason(err));
		r.failed++;
		return;
	}
	if ('skip' in p) {
		await finish(c, 'skipped', p.skip);
		r.skipped++;
		return;
	}
	try {
		await sendMail(p.mail);
	} catch (err) {
		// The line the mail-send-failed alarm counts (infra/alarms.tf), as trySendMail's: kind and error code only.
		logEvent('error', { event: 'mail_send_failed', kind: 'erratum_notice', ...safeError(err) });
		await finish(c, 'retry', failureReason(err));
		r.failed++;
		return;
	}
	await finish(c, 'sent');
	r.sent++;
}

/** Send the pending notices (see the header). Every transport's tick ends here, after the pack notices. */
export async function sendErratumNotices({ limit = 100, errata = ENGINE_ERRATA }: { limit?: number; errata?: readonly Erratum[] } = {}): Promise<ErratumNoticeResult> {
	const r: ErratumNoticeResult = { sent: 0, skipped: 0, failed: 0 };
	const { rows } = await withoutUser((db) =>
		db.query<ClaimedErratumNotice>('SELECT erratum_id, project_id, user_id, run_count FROM app_erratum_notice_claim($1, $2::interval)', [limit, LEASE])
	);
	for (const c of rows) await deliver(c, r, errata);
	return r;
}

/** Delete settled notices older than the retention (the tick). */
export async function purgeErratumNotices(days = ERRATUM_NOTICE_RETENTION_DAYS): Promise<number> {
	const { rows } = await withoutUser((db) => db.query<{ n: number }>('SELECT app_purge_erratum_notices(make_interval(days => $1)) AS n', [days]));
	return rows[0]?.n ?? 0;
}
